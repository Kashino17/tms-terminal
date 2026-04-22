#!/usr/bin/env python3
"""Qwen3-TTS sidecar — text-to-speech with voice cloning via MLX.

Reads JSON Lines from stdin, synthesizes speech, writes JSON Lines to stdout.

Protocol:
  Request:  {"id": "tts-1", "text": "Hallo Welt"}
  Per-chunk (one per sentence, emitted before final response):
            {"type": "chunk_audio", "id": "tts-1", "chunk": 0, "total": 3,
             "sentence": "Hallo Welt", "audio": "<base64-wav>"}
  Response: {"id": "tts-1", "audio_base64": "UklGR...", "duration_secs": 2.3}
  Error:    {"id": "tts-1", "error": "reason"}
"""

import sys
import json
import base64
import tempfile
import os
import re
import wave

VOICE_REF_PATH = os.path.expanduser("~/.tms-terminal/voice_24k_15s.wav")
MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16"


def split_sentences(text: str) -> list[str]:
    """Split text into sentences for per-chunk synthesis.

    Splits on sentence-ending punctuation (. ! ?) followed by whitespace or
    end-of-string. Keeps each sentence non-empty and stripped.
    """
    # Split on . ! ? but avoid splitting on abbreviations like "Dr." or decimal numbers
    # by requiring either end-of-string or whitespace + uppercase/digit after the punctuation.
    parts = re.split(r'(?<=[.!?])\s+', text.strip())
    sentences = [p.strip() for p in parts if p.strip()]
    return sentences if sentences else [text.strip()]


def synth_sentence(sentence: str, model: str, ref_audio, ref_text: str,
                   generate_audio) -> bytes:
    """Synthesize a single sentence and return raw WAV bytes."""
    tmp_dir = tempfile.mkdtemp(prefix="tts_chunk_")
    try:
        generate_audio(
            text="... " + sentence,
            model=model,
            ref_audio=ref_audio,
            ref_text=ref_text[:200] if ref_text else "",
            output_path=tmp_dir,
            file_prefix="out",
            audio_format="wav",
            verbose=False,
            save=False,
            play=False,
        )
        out_file = None
        for f in sorted(os.listdir(tmp_dir)):
            if f.startswith("out") and f.endswith(".wav"):
                out_file = os.path.join(tmp_dir, f)
                break
        if not out_file or not os.path.exists(out_file):
            raise RuntimeError("No audio generated for sentence chunk")
        with open(out_file, "rb") as fh:
            return fh.read()
    finally:
        for f in os.listdir(tmp_dir):
            try:
                os.unlink(os.path.join(tmp_dir, f))
            except OSError:
                pass
        try:
            os.rmdir(tmp_dir)
        except OSError:
            pass


def _concat_wav_chunks(chunks: list[bytes]) -> bytes:
    """Concatenate multiple WAV byte-strings into a single WAV.

    All chunks must share the same sample rate and channel count (they will,
    since they all come from the same model). If there is only one chunk, it
    is returned as-is without re-encoding.
    """
    import io

    if not chunks:
        # Return a minimal silent WAV (44-byte header, 0 frames)
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(b'')
        return buf.getvalue()

    if len(chunks) == 1:
        return chunks[0]

    # Read params from first chunk
    with wave.open(io.BytesIO(chunks[0]), 'rb') as first:
        params = first.getparams()

    buf = io.BytesIO()
    with wave.open(buf, 'wb') as out_wav:
        out_wav.setparams(params)
        for chunk in chunks:
            with wave.open(io.BytesIO(chunk), 'rb') as src:
                out_wav.writeframes(src.readframes(src.getnframes()))

    return buf.getvalue()


def main():
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.write("[tts-sidecar] Starting Qwen3-TTS sidecar (MLX)...\n")
    sys.stderr.flush()

    # Voice reference
    ref_audio = VOICE_REF_PATH if os.path.exists(VOICE_REF_PATH) else None
    ref_text = ""
    if ref_audio:
        sys.stderr.write(f"[tts-sidecar] Voice reference: {VOICE_REF_PATH}\n")
        ref_text_path = VOICE_REF_PATH.replace(".wav", ".txt")
        if os.path.exists(ref_text_path):
            ref_text = open(ref_text_path).read().strip()
            sys.stderr.write(f"[tts-sidecar] Reference text: {len(ref_text)} chars\n")
        sys.stderr.flush()

    try:
        from mlx_audio.tts.generate import generate_audio
    except ImportError as e:
        sys.stderr.write(f"[tts-sidecar] Missing: {e}. Install: pip install mlx-audio\n")
        sys.stderr.flush()
        sys.exit(1)

    # Pre-load model with warmup
    sys.stderr.write(f"[tts-sidecar] Loading model {MODEL}...\n")
    sys.stderr.flush()
    try:
        tmp_dir = tempfile.mkdtemp(prefix="tts_warmup_")
        generate_audio(
            text="Test.", model=MODEL, ref_audio=ref_audio,
            ref_text=ref_text[:200] if ref_text else "",
            output_path=tmp_dir, file_prefix="_warmup",
            audio_format="wav", verbose=False, save=False, play=False,
        )
        for f in os.listdir(tmp_dir):
            os.unlink(os.path.join(tmp_dir, f))
        os.rmdir(tmp_dir)
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

                wav_bytes = synth_sentence(sentence, MODEL, ref_audio, ref_text, generate_audio)

                # Measure chunk duration
                try:
                    import io
                    with wave.open(io.BytesIO(wav_bytes), 'rb') as w:
                        chunk_duration = w.getnframes() / w.getframerate()
                except Exception:
                    chunk_duration = 0.0
                total_duration += chunk_duration

                # Emit per-chunk audio message immediately
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

            # Concatenate all chunks into a single WAV for the final response.
            # The final response preserves backward compatibility for callers that
            # only use the monolithic audio_base64 field.
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
