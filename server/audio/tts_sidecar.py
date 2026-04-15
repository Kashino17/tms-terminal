#!/usr/bin/env python3
"""Qwen3-TTS sidecar — long-running process for German text-to-speech with voice cloning.

Uses Qwen3-TTS via mlx-audio on Apple Silicon with voice reference cloning.
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

VOICE_REF_PATH = os.path.expanduser("~/.tms-terminal/voice_24k_15s.wav")
MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16"
MAX_CHUNK_CHARS = 200  # Qwen3-TTS works best with short segments


def chunk_text(text):
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


def main():
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.write("[tts-sidecar] Starting Qwen3-TTS sidecar (MLX)...\n")
    sys.stderr.flush()

    # Check voice reference
    ref_audio = None
    ref_text = None
    if os.path.exists(VOICE_REF_PATH):
        ref_audio = VOICE_REF_PATH
        sys.stderr.write(f"[tts-sidecar] Voice reference: {VOICE_REF_PATH}\n")
        sys.stderr.flush()

        # Load cached ref_text if available
        ref_text_path = VOICE_REF_PATH.replace(".wav", ".txt")
        if os.path.exists(ref_text_path):
            ref_text = open(ref_text_path).read().strip()
            sys.stderr.write(f"[tts-sidecar] Reference text loaded ({len(ref_text)} chars)\n")
            sys.stderr.flush()
        else:
            sys.stderr.write(f"[tts-sidecar] WARNING: No reference text at {ref_text_path}\n")
            sys.stderr.write(f"[tts-sidecar] Create it with the exact transcript of the voice reference.\n")
            sys.stderr.flush()
            ref_text = ""
    else:
        sys.stderr.write(f"[tts-sidecar] No voice reference at {VOICE_REF_PATH}\n")
        sys.stderr.flush()

    try:
        from mlx_audio.tts.generate import generate_audio
    except ImportError as e:
        sys.stderr.write(f"[tts-sidecar] Missing dependency: {e}\n")
        sys.stderr.write("[tts-sidecar] Install with: pip install mlx-audio\n")
        sys.stderr.flush()
        sys.exit(1)

    # Warmup — load model once
    sys.stderr.write(f"[tts-sidecar] Loading model {MODEL}...\n")
    sys.stderr.flush()
    try:
        generate_audio(
            text="Test.",
            model=MODEL,
            ref_audio=ref_audio,
            ref_text=(ref_text or "")[:200],
            output_path="/tmp",
            file_prefix="_tts_warmup",
            audio_format="wav",
            verbose=False,
            save=False,
            play=False,
        )
        # Cleanup warmup file
        for f in os.listdir("/tmp"):
            if f.startswith("_tts_warmup"):
                os.unlink(os.path.join("/tmp", f))
    except Exception as e:
        sys.stderr.write(f"[tts-sidecar] Warmup failed (non-fatal): {e}\n")
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

        try:
            chunks = chunk_text(text)
            sys.stderr.write(f"[tts-sidecar] {req_id}: {len(text)} chars, {len(chunks)} chunk(s)\n")
            sys.stderr.flush()

            chunk_files = []
            for i, chunk in enumerate(chunks):
                tmp_dir = tempfile.mkdtemp(prefix="tts_")
                prefix = f"chunk_{i}"

                generate_audio(
                    text=chunk,
                    model=MODEL,
                    ref_audio=ref_audio,
                    ref_text=(ref_text or "")[:200],
                    output_path=tmp_dir,
                    file_prefix=prefix,
                    audio_format="wav",
                    verbose=False,
                    save=False,
                    play=False,
                )

                # Find generated file
                for f in sorted(os.listdir(tmp_dir)):
                    if f.startswith(prefix) and f.endswith(".wav"):
                        chunk_files.append(os.path.join(tmp_dir, f))
                        break

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

            # Concat if multiple chunks
            if len(chunk_files) == 1:
                final_path = chunk_files[0]
            else:
                final_fd, final_path = tempfile.mkstemp(suffix=".wav")
                os.close(final_fd)
                params = None
                all_data = []
                for cf in chunk_files:
                    with wave.open(cf, 'rb') as w:
                        if params is None:
                            params = w.getparams()
                        all_data.append(w.readframes(w.getnframes()))
                if params:
                    with wave.open(final_path, 'wb') as out:
                        out.setparams(params)
                        for d in all_data:
                            out.writeframes(d)

            # Encode
            with open(final_path, "rb") as f:
                audio_bytes = f.read()

            try:
                with wave.open(final_path, 'rb') as w:
                    duration = w.getnframes() / w.getframerate()
            except Exception:
                duration = 0

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
            for cf in chunk_files:
                try:
                    d = os.path.dirname(cf)
                    os.unlink(cf)
                    os.rmdir(d)
                except OSError:
                    pass


if __name__ == "__main__":
    main()
