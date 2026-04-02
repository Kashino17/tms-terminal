#!/usr/bin/env python3
"""Whisper sidecar — long-running process for audio transcription.

Reads JSON Lines from stdin, transcribes audio with Whisper, writes JSON Lines to stdout.

Protocol:
  Request:  {"id": "req-1", "audio_base64": "UklGR...", "language": "de"}
  Response: {"id": "req-1", "text": "transkribierter text"}
  Error:    {"id": "req-1", "error": "reason"}
"""

import sys
import json
import base64
import tempfile
import os

def main():
    # Force stdout to be line-buffered so Node.js gets responses immediately
    sys.stdout.reconfigure(line_buffering=True)

    sys.stderr.write("[whisper-sidecar] Loading model large-v3 on MPS...\n")
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

    model = whisper.load_model("large-v3", device=device)

    sys.stderr.write("[whisper-sidecar] Model loaded. Ready for requests.\n")
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

        if not audio_b64:
            response = {"id": req_id, "error": "No audio data provided"}
            print(json.dumps(response))
            continue

        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav")
        try:
            audio_bytes = base64.b64decode(audio_b64)
            os.write(tmp_fd, audio_bytes)
            os.close(tmp_fd)

            result = model.transcribe(tmp_path, language=language, fp16=False)
            text = result.get("text", "").strip()

            response = {"id": req_id, "text": text}
            print(json.dumps(response))
        except Exception as e:
            response = {"id": req_id, "error": str(e)}
            print(json.dumps(response))
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    main()
