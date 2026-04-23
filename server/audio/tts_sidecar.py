#!/usr/bin/env python3
"""Qwen3-TTS VoiceDesign sidecar — text-to-speech with prompt-based voice + tone control via MLX.

Reads JSON Lines from stdin, synthesizes speech, writes JSON Lines to stdout.

Protocol:
  Request:  {"id": "tts-1", "text": "Hallo Welt",
             "voice_prompt": "optional override of static voice identity",
             "emotion_prompt": "optional per-message tone, e.g. 'sanft und traurig'"}
  Per-chunk (one per sentence, emitted before final response):
            {"type": "chunk_audio", "id": "tts-1", "chunk": 0, "total": 3,
             "sentence": "Hallo Welt", "audio": "<base64-wav>"}
  Response: {"id": "tts-1", "audio_base64": "UklGR...", "duration_secs": 2.3}
  Error:    {"id": "tts-1", "error": "reason"}

The VoiceDesign variant synthesizes voice identity entirely from the instruct
string. The sidecar keeps a default voice_prompt loaded from
~/.tms-terminal/voice_prompt.txt at startup; each request can override it
and/or append an emotion_prompt that modulates the tone for that message.
"""

import sys
import json
import base64
import os
import re
import io
import wave

import numpy as np
import soundfile as sf
import mlx.core as mx

MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16"
SAMPLE_RATE = 24000  # Qwen3-TTS output rate
LANGUAGE = "German"

VOICE_PROMPT_PATH = os.path.expanduser("~/.tms-terminal/voice_prompt.txt")

# Fallback used if the config file is missing. Describes Rem from Re:Zero —
# soft, caring, loyal young female, politely restrained. Users can override
# by editing ~/.tms-terminal/voice_prompt.txt.
DEFAULT_VOICE_PROMPT = (
    "Junge weibliche Stimme einer Siebzehnjährigen, sanft und leicht hoch "
    "gelegen, warm und fürsorglich, mit präziser höflicher Diktion und ruhiger "
    "Zurückhaltung. Eine liebevolle, treue Wärme liegt in der Stimme, dezent "
    "melancholisch, mit einer stillen inneren Stärke. Die Sprechweise ist "
    "gepflegt und rücksichtsvoll, nie laut oder aufbrausend — selbst in "
    "Momenten der Freude oder Sorge bleibt sie gedämpft und intim."
)


def load_default_voice_prompt() -> str:
    try:
        if os.path.exists(VOICE_PROMPT_PATH):
            text = open(VOICE_PROMPT_PATH, encoding="utf-8").read().strip()
            if text:
                return text
    except OSError:
        pass
    return DEFAULT_VOICE_PROMPT


def split_sentences(text: str) -> list[str]:
    """Split text into sentences for per-chunk synthesis."""
    parts = re.split(r'(?<=[.!?])\s+', text.strip())
    sentences = [p.strip() for p in parts if p.strip()]
    return sentences if sentences else [text.strip()]


def mx_audio_to_wav_bytes(audio: mx.array) -> bytes:
    """Convert an MLX audio array (float32, mono, 24kHz) to WAV bytes."""
    arr = np.array(audio, copy=False)
    # Flatten to 1-D mono if model returns shape [1, N] or similar
    arr = np.squeeze(arr)
    if arr.dtype != np.float32:
        arr = arr.astype(np.float32)
    buf = io.BytesIO()
    sf.write(buf, arr, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _concat_wav_chunks(chunks: list[bytes]) -> bytes:
    """Concatenate multiple WAV byte-strings into a single WAV."""
    if not chunks:
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(b'')
        return buf.getvalue()
    if len(chunks) == 1:
        return chunks[0]

    with wave.open(io.BytesIO(chunks[0]), 'rb') as first:
        params = first.getparams()
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as out_wav:
        out_wav.setparams(params)
        for chunk in chunks:
            with wave.open(io.BytesIO(chunk), 'rb') as src:
                out_wav.writeframes(src.readframes(src.getnframes()))
    return buf.getvalue()


def compose_instruct(voice_prompt: str, emotion_prompt: str) -> str:
    voice_prompt = (voice_prompt or "").strip()
    emotion_prompt = (emotion_prompt or "").strip()
    if voice_prompt and emotion_prompt:
        return f"{voice_prompt} {emotion_prompt}"
    return voice_prompt or emotion_prompt


def synth_sentence(model, sentence: str, instruct: str) -> bytes:
    """Synthesize a single sentence and return raw WAV bytes."""
    results = list(model.generate_voice_design(
        text=sentence,
        instruct=instruct,
        language=LANGUAGE,
    ))
    if not results:
        raise RuntimeError("No audio generated for sentence chunk")
    # The generator may yield multiple chunks; concatenate them.
    pieces = [mx_audio_to_wav_bytes(r.audio) for r in results if getattr(r, "audio", None) is not None]
    if not pieces:
        raise RuntimeError("Generator produced no audio arrays")
    return _concat_wav_chunks(pieces)


def main():
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.write("[tts-sidecar] Starting Qwen3-TTS VoiceDesign-1.7B sidecar (MLX)...\n")
    sys.stderr.flush()

    default_voice_prompt = load_default_voice_prompt()
    sys.stderr.write(f"[tts-sidecar] Voice prompt: {len(default_voice_prompt)} chars "
                     f"({'from ' + VOICE_PROMPT_PATH if os.path.exists(VOICE_PROMPT_PATH) else 'default (Rem)'})\n")
    sys.stderr.flush()

    try:
        from mlx_audio.tts.utils import load_model
    except ImportError as e:
        sys.stderr.write(f"[tts-sidecar] Missing: {e}. Install: pip install mlx-audio\n")
        sys.stderr.flush()
        sys.exit(1)

    sys.stderr.write(f"[tts-sidecar] Loading model {MODEL}...\n")
    sys.stderr.flush()
    try:
        model = load_model(MODEL)
    except Exception as e:
        sys.stderr.write(f"[tts-sidecar] Failed to load model: {e}\n")
        sys.stderr.flush()
        sys.exit(1)

    # Warmup — first generation is always slower due to JIT + weight materialization
    try:
        warmup_instruct = compose_instruct(default_voice_prompt, "")
        _ = synth_sentence(model, "Test.", warmup_instruct)
    except Exception as e:
        sys.stderr.write(f"[tts-sidecar] Warmup note: {e}\n")
        sys.stderr.flush()

    sys.stderr.write("[tts-sidecar] Ready for requests.\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        req_id = req.get("id", "unknown")
        text = req.get("text", "").strip()
        if not text:
            print(json.dumps({"id": req_id, "error": "No text provided"}))
            continue

        voice_prompt = req.get("voice_prompt") or default_voice_prompt
        emotion_prompt = req.get("emotion_prompt") or ""
        instruct = compose_instruct(voice_prompt, emotion_prompt)

        sys.stderr.write(f"[tts-sidecar] {req_id}: {len(text)} chars; "
                         f"emotion={repr(emotion_prompt[:60]) if emotion_prompt else '(none)'}\n")
        sys.stderr.flush()

        try:
            sentences = split_sentences(text)
            total = len(sentences)
            sys.stderr.write(f"[tts-sidecar] {req_id}: {total} sentence(s)\n")
            sys.stderr.flush()

            all_chunks: list[bytes] = []
            total_duration = 0.0

            for chunk_idx, sentence in enumerate(sentences):
                sys.stderr.write(f"[tts-sidecar] {req_id}: chunk {chunk_idx}/{total} — {repr(sentence[:40])}\n")
                sys.stderr.flush()

                wav_bytes = synth_sentence(model, sentence, instruct)

                try:
                    with wave.open(io.BytesIO(wav_bytes), 'rb') as w:
                        chunk_duration = w.getnframes() / w.getframerate()
                except Exception:
                    chunk_duration = 0.0
                total_duration += chunk_duration

                sys.stdout.write(json.dumps({
                    "type": "chunk_audio",
                    "id": req_id,
                    "chunk": chunk_idx,
                    "total": total,
                    "sentence": sentence,
                    "audio": base64.b64encode(wav_bytes).decode("ascii"),
                }) + "\n")
                sys.stdout.flush()

                all_chunks.append(wav_bytes)

            combined_bytes = _concat_wav_chunks(all_chunks)
            audio_b64 = base64.b64encode(combined_bytes).decode("ascii")
            print(json.dumps({
                "id": req_id,
                "audio_base64": audio_b64,
                "duration_secs": round(total_duration, 2),
            }))
            sys.stderr.write(f"[tts-sidecar] {req_id}: done — {total_duration:.1f}s total\n")
            sys.stderr.flush()

        except Exception as e:
            print(json.dumps({"id": req_id, "error": str(e)}))
            sys.stderr.write(f"[tts-sidecar] {req_id}: error — {e}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()
