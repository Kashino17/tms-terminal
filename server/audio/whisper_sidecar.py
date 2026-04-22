#!/usr/bin/env python3
"""Whisper sidecar — long-running process for audio transcription.

Reads JSON Lines from stdin, transcribes audio with Whisper, writes JSON Lines to stdout.

Protocol:
  Request:  {"id": "req-1", "audio_base64": "UklGR...", "language": "de", "model": "large-v3"}
  Progress: {"id": "req-1", "progress": true, "chunk": 1, "total": 3, "text": "partial text"}
  Response: {"id": "req-1", "text": "transkribierter text"}
  Error:    {"id": "req-1", "error": "reason"}

Features:
  - Chunked transcription for long audio (>60s split into 60s segments)
  - Progress updates per chunk
  - Model selection per request (large-v3, turbo, medium, distil-large-v3)
"""

import sys
import json
import base64
import tempfile
import os
import wave
import struct

# Chunk duration in seconds for long audio
CHUNK_DURATION_SECS = 60

def get_wav_duration(wav_path):
    """Get duration of a WAV file in seconds."""
    try:
        with wave.open(wav_path, 'rb') as w:
            frames = w.getnframes()
            rate = w.getframerate()
            if rate == 0:
                return 0
            return frames / rate
    except Exception:
        return 0

def split_wav(wav_path, chunk_secs=CHUNK_DURATION_SECS):
    """Split a WAV file into chunks of chunk_secs duration. Returns list of temp file paths."""
    try:
        with wave.open(wav_path, 'rb') as w:
            params = w.getparams()
            total_frames = w.getnframes()
            chunk_frames = int(params.framerate * chunk_secs)

            if total_frames <= chunk_frames * 1.2:
                # Audio is short enough — don't split (allow 20% over)
                return [wav_path]

            chunks = []
            offset = 0
            while offset < total_frames:
                end = min(offset + chunk_frames, total_frames)
                w.setpos(offset)
                data = w.readframes(end - offset)

                tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav")
                with wave.open(tmp_path, 'wb') as out:
                    out.setparams(params)
                    out.writeframes(data)
                os.close(tmp_fd)
                chunks.append(tmp_path)
                offset = end

            return chunks
    except Exception:
        return [wav_path]

def main():
    sys.stdout.reconfigure(line_buffering=True)

    sys.stderr.write("[whisper-sidecar] Starting up...\n")
    sys.stderr.flush()

    try:
        import whisper
        import torch
    except ImportError as e:
        sys.stderr.write(f"[whisper-sidecar] Missing dependency: {e}\n")
        sys.stderr.write("[whisper-sidecar] Install with: pip3 install openai-whisper torch\n")
        sys.stderr.flush()
        sys.exit(1)

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    sys.stderr.write(f"[whisper-sidecar] Using device: {device}\n")
    sys.stderr.flush()

    # Cache loaded models to avoid reloading on every request
    models = {}

    def get_model(model_name):
        if model_name not in models:
            sys.stderr.write(f"[whisper-sidecar] Loading model {model_name}...\n")
            sys.stderr.flush()
            models[model_name] = whisper.load_model(model_name, device=device)
            sys.stderr.write(f"[whisper-sidecar] Model {model_name} loaded.\n")
            sys.stderr.flush()
        return models[model_name]

    # Pre-load default model (turbo: single model, no hot-swap hangs)
    default_model = "turbo"
    get_model(default_model)

    sys.stderr.write("[whisper-sidecar] Ready for requests.\n")
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
        audio_b64 = req.get("audio_base64", "")
        language = req.get("language", "de")
        model_name = req.get("model") or default_model

        if not audio_b64:
            print(json.dumps({"id": req_id, "error": "No audio data provided"}))
            continue

        # Decode audio to temp file
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav")
        try:
            audio_bytes = base64.b64decode(audio_b64)
            os.write(tmp_fd, audio_bytes)
            os.close(tmp_fd)

            duration = get_wav_duration(tmp_path)
            sys.stderr.write(f"[whisper-sidecar] {req_id}: {duration:.1f}s audio, model={model_name}\n")
            sys.stderr.flush()

            model = get_model(model_name)

            # Split into chunks if long audio
            chunks = split_wav(tmp_path)
            total_chunks = len(chunks)

            if total_chunks == 1:
                # Short audio — transcribe directly
                result = model.transcribe(chunks[0], language=language, fp16=False)
                text = result.get("text", "").strip()
                print(json.dumps({"id": req_id, "text": text}))
            else:
                # Long audio — transcribe chunks with progress
                sys.stderr.write(f"[whisper-sidecar] {req_id}: split into {total_chunks} chunks\n")
                sys.stderr.flush()
                all_text = []
                for i, chunk_path in enumerate(chunks):
                    result = model.transcribe(chunk_path, language=language, fp16=False)
                    chunk_text = result.get("text", "").strip()
                    all_text.append(chunk_text)
                    # Send progress update
                    print(json.dumps({
                        "id": req_id,
                        "progress": True,
                        "chunk": i + 1,
                        "total": total_chunks,
                        "text": chunk_text,
                    }))
                    # Clean up chunk temp file (not the original)
                    if chunk_path != tmp_path:
                        try:
                            os.unlink(chunk_path)
                        except OSError:
                            pass

                # Send final merged result
                merged = " ".join(all_text)
                print(json.dumps({"id": req_id, "text": merged}))

        except Exception as e:
            print(json.dumps({"id": req_id, "error": str(e)}))
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    main()
