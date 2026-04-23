#!/usr/bin/env python3
"""Qwen3-TTS Base sidecar — text-to-speech with reference-audio voice cloning via MLX.

Reads JSON Lines from stdin, synthesizes speech, writes JSON Lines to stdout.

Protocol:
  Request:  {"id": "tts-1", "text": "Hallo Welt"}
  Per-chunk (one per sentence, emitted before final response):
            {"type": "chunk_audio", "id": "tts-1", "chunk": 0, "total": 3,
             "sentence": "Hallo Welt", "audio": "<base64-wav>"}
  Response: {"id": "tts-1", "audio_base64": "UklGR...", "duration_secs": 2.3}
  Error:    {"id": "tts-1", "error": "reason"}

Uses the Qwen3-TTS 1.7B Base variant with zero-shot voice cloning from
~/.tms-terminal/voice_24k_15s.wav (and its optional .txt transcript). Base
does not support instruct-style tone control — the voice is fully determined
by the reference audio. For dynamic tone control, switch to the VoiceDesign
variant and wire emotion_prompt (see git history).
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

MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"
SAMPLE_RATE = 24000  # Qwen3-TTS output rate

VOICE_REF_PATH = os.path.expanduser("~/.tms-terminal/voice_24k_15s.wav")
VOICE_REF_TEXT_PATH = VOICE_REF_PATH.replace(".wav", ".txt")


def split_sentences(text: str) -> list[str]:
    """Split text into sentences for per-chunk synthesis."""
    parts = re.split(r'(?<=[.!?])\s+', text.strip())
    sentences = [p.strip() for p in parts if p.strip()]
    return sentences if sentences else [text.strip()]


def mx_audio_to_wav_bytes(audio: mx.array) -> bytes:
    """Convert an MLX audio array (float32, mono, 24kHz) to WAV bytes."""
    arr = np.array(audio, copy=False)
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


def synth_sentence(model, sentence: str, ref_audio, ref_text: str) -> bytes:
    """Synthesize a single sentence using reference-audio cloning."""
    # Lead with "... " so Qwen3-TTS gets a stable prosody anchor at the start.
    results = list(model.generate(
        text="... " + sentence,
        ref_audio=ref_audio,
        ref_text=ref_text[:200] if ref_text else "",
    ))
    if not results:
        raise RuntimeError("No audio generated for sentence chunk")
    pieces = [mx_audio_to_wav_bytes(r.audio) for r in results if getattr(r, "audio", None) is not None]
    if not pieces:
        raise RuntimeError("Generator produced no audio arrays")
    return _concat_wav_chunks(pieces)


def main():
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.write("[tts-sidecar] Starting Qwen3-TTS Base-1.7B sidecar (MLX)...\n")
    sys.stderr.flush()

    ref_audio = VOICE_REF_PATH if os.path.exists(VOICE_REF_PATH) else None
    ref_text = ""
    if ref_audio:
        sys.stderr.write(f"[tts-sidecar] Voice reference: {VOICE_REF_PATH}\n")
        if os.path.exists(VOICE_REF_TEXT_PATH):
            ref_text = open(VOICE_REF_TEXT_PATH, encoding="utf-8").read().strip()
            sys.stderr.write(f"[tts-sidecar] Reference text: {len(ref_text)} chars\n")
    else:
        sys.stderr.write(f"[tts-sidecar] WARN: reference audio missing at {VOICE_REF_PATH} — "
                         "voice will fall back to the model's default speaker.\n")
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

    try:
        _ = synth_sentence(model, "Test.", ref_audio, ref_text)
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

        sys.stderr.write(f"[tts-sidecar] {req_id}: {len(text)} chars\n")
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

                wav_bytes = synth_sentence(model, sentence, ref_audio, ref_text)

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
