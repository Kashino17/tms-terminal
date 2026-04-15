#!/usr/bin/env python3
"""F5-TTS sidecar — long-running process for text-to-speech synthesis via MLX.

Uses F5-TTS (German or default) with voice cloning from a reference audio file.
Reads JSON Lines from stdin, synthesizes speech, writes JSON Lines to stdout.

Protocol:
  Request:  {"id": "tts-1", "text": "Hallo Welt"}
  Response: {"id": "tts-1", "audio_base64": "UklGR...", "duration_secs": 2.3}
  Progress: {"id": "tts-1", "progress": true, "chunk": 1, "total": 3}
  Error:    {"id": "tts-1", "error": "reason"}
"""

import sys
import json
import base64
import tempfile
import os
import wave

# Voice reference file — user provides a 15-30s WAV with their desired voice
VOICE_REF_PATH = os.path.expanduser("~/.tms-terminal/voice.wav")

# TTS models to try (in order) — all MLX-optimized with voice cloning support
MODELS = [
    "mlx-community/chatterbox-turbo-fp16",   # Fast, voice cloning, multilingual
    "mlx-community/Chatterbox-TTS-fp16",     # Full quality fallback
    "mlx-community/chatterbox-turbo-4bit",   # Quantized, even faster
]

# Max text per synthesis call (characters)
MAX_CHUNK_CHARS = 300


def chunk_text(text: str) -> list:
    """Split text into sentence-sized chunks for better synthesis quality."""
    if len(text) <= MAX_CHUNK_CHARS:
        return [text]

    chunks = []
    current = ""
    for part in text.replace("! ", "!|").replace(". ", ".|").replace("? ", "?|").replace("\n", "\n|").split("|"):
        part = part.strip()
        if not part:
            continue
        if len(current) + len(part) > MAX_CHUNK_CHARS and current:
            chunks.append(current.strip())
            current = part
        else:
            current += " " + part if current else part
    if current.strip():
        chunks.append(current.strip())
    return chunks if chunks else [text]


def wav_duration(path):
    """Get WAV file duration in seconds."""
    try:
        with wave.open(path, 'rb') as w:
            return w.getnframes() / w.getframerate() if w.getframerate() > 0 else 0
    except Exception:
        return 0


def main():
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.write("[tts-sidecar] Starting F5-TTS sidecar (MLX)...\n")
    sys.stderr.flush()

    # Check voice reference
    ref_audio = None
    if os.path.exists(VOICE_REF_PATH):
        ref_audio = VOICE_REF_PATH
        dur = wav_duration(ref_audio)
        sys.stderr.write(f"[tts-sidecar] Voice reference: {VOICE_REF_PATH} ({dur:.1f}s)\n")
        sys.stderr.flush()
    else:
        sys.stderr.write(f"[tts-sidecar] No voice reference at {VOICE_REF_PATH} — using default voice\n")
        sys.stderr.flush()

    try:
        from mlx_audio.tts.generate import generate_audio, load_audio
        from mlx_audio.tts import load_model
    except ImportError as e:
        sys.stderr.write(f"[tts-sidecar] Missing dependency: {e}\n")
        sys.stderr.write("[tts-sidecar] Install with: pip install mlx-audio\n")
        sys.stderr.flush()
        sys.exit(1)

    # Load model
    model_name = None
    for m in MODELS:
        try:
            sys.stderr.write(f"[tts-sidecar] Loading model {m}...\n")
            sys.stderr.flush()
            model_name = m
            break
        except Exception as e:
            sys.stderr.write(f"[tts-sidecar] Failed to load {m}: {e}\n")
            sys.stderr.flush()
            continue

    if not model_name:
        sys.stderr.write("[tts-sidecar] No TTS model available\n")
        sys.stderr.flush()
        sys.exit(1)

    sys.stderr.write(f"[tts-sidecar] Using model: {model_name}\n")
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

        try:
            chunks = chunk_text(text)
            sys.stderr.write(f"[tts-sidecar] {req_id}: {len(text)} chars, {len(chunks)} chunk(s)\n")
            sys.stderr.flush()

            chunk_files = []

            for i, chunk in enumerate(chunks):
                tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav")
                os.close(tmp_fd)

                # Build generate_audio kwargs
                kwargs = {
                    "text": chunk,
                    "model": model_name,
                    "output_path": os.path.dirname(tmp_path),
                    "file_prefix": os.path.basename(tmp_path).replace(".wav", ""),
                    "audio_format": "wav",
                    "lang_code": "de",
                    "verbose": False,
                    "save": True,
                    "play": False,
                    "join_audio": False,
                }

                if ref_audio:
                    kwargs["ref_audio"] = ref_audio

                generate_audio(**kwargs)

                # generate_audio saves as {prefix}_0.wav — find the output file
                output_dir = os.path.dirname(tmp_path)
                prefix = os.path.basename(tmp_path).replace(".wav", "")
                generated = None
                for f in os.listdir(output_dir):
                    if f.startswith(prefix) and f.endswith(".wav"):
                        generated = os.path.join(output_dir, f)
                        break

                if generated and os.path.exists(generated):
                    chunk_files.append(generated)
                else:
                    chunk_files.append(tmp_path)

                # Progress
                if len(chunks) > 1:
                    print(json.dumps({
                        "id": req_id,
                        "progress": True,
                        "chunk": i + 1,
                        "total": len(chunks),
                    }))

            if not chunk_files:
                print(json.dumps({"id": req_id, "error": "No audio generated"}))
                continue

            # If single chunk, use directly. Otherwise concat.
            if len(chunk_files) == 1:
                final_path = chunk_files[0]
            else:
                # Concat WAVs
                final_fd, final_path = tempfile.mkstemp(suffix=".wav")
                os.close(final_fd)
                params = None
                all_data = []
                for cf in chunk_files:
                    try:
                        with wave.open(cf, 'rb') as w:
                            if params is None:
                                params = w.getparams()
                            all_data.append(w.readframes(w.getnframes()))
                    except Exception:
                        continue
                if params and all_data:
                    with wave.open(final_path, 'wb') as out:
                        out.setparams(params)
                        for d in all_data:
                            out.writeframes(d)

            # Read and encode
            with open(final_path, "rb") as f:
                audio_bytes = f.read()

            duration = wav_duration(final_path)
            audio_b64 = base64.b64encode(audio_bytes).decode("ascii")

            print(json.dumps({
                "id": req_id,
                "audio_base64": audio_b64,
                "duration_secs": round(duration, 2),
            }))

            sys.stderr.write(f"[tts-sidecar] {req_id}: done — {duration:.1f}s audio\n")
            sys.stderr.flush()

        except Exception as e:
            print(json.dumps({"id": req_id, "error": str(e)}))
            sys.stderr.write(f"[tts-sidecar] {req_id}: error — {e}\n")
            sys.stderr.flush()
        finally:
            # Cleanup temp files
            for cf in chunk_files if 'chunk_files' in dir() else []:
                try:
                    os.unlink(cf)
                except (OSError, NameError):
                    pass
            try:
                if 'final_path' in dir() and final_path and len(chunk_files) > 1:
                    os.unlink(final_path)
            except (OSError, NameError):
                pass


if __name__ == "__main__":
    main()
