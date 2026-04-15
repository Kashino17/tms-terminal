#!/usr/bin/env python3
"""Qwen3-TTS sidecar — text-to-speech with voice cloning via MLX.

Reads JSON Lines from stdin, synthesizes speech, writes JSON Lines to stdout.

Protocol:
  Request:  {"id": "tts-1", "text": "Hallo Welt"}
  Response: {"id": "tts-1", "audio_base64": "UklGR...", "duration_secs": 2.3}
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

        tmp_dir = tempfile.mkdtemp(prefix="tts_")
        try:
            # Generate with a filler prefix to avoid cold-start stutter.
            # Qwen3-TTS often produces garbled audio at the very beginning
            # because the model needs a "runway" to match the reference voice.
            # We prepend a short pause phrase and trim it from the output.
            FILLER = "... "
            padded_text = FILLER + text

            generate_audio(
                text=padded_text,
                model=MODEL,
                ref_audio=ref_audio,
                ref_text=ref_text[:200] if ref_text else "",
                output_path=tmp_dir,
                file_prefix="out",
                audio_format="wav",
                verbose=False,
                save=False,
                play=False,
            )

            # Find output file
            out_file = None
            for f in sorted(os.listdir(tmp_dir)):
                if f.startswith("out") and f.endswith(".wav"):
                    out_file = os.path.join(tmp_dir, f)
                    break

            if not out_file or not os.path.exists(out_file):
                print(json.dumps({"id": req_id, "error": "No audio generated"}))
                continue

            # Trim the filler prefix (~0.8s) from the beginning
            trimmed_path = os.path.join(tmp_dir, "trimmed.wav")
            try:
                with wave.open(out_file, 'rb') as w:
                    params = w.getparams()
                    rate = w.getframerate()
                    total = w.getnframes()
                    # Skip first 0.8 seconds (filler audio)
                    skip_frames = int(rate * 0.8)
                    if skip_frames < total:
                        w.setpos(skip_frames)
                        data = w.readframes(total - skip_frames)
                        with wave.open(trimmed_path, 'wb') as out_w:
                            out_w.setparams(params)
                            out_w.writeframes(data)
                        out_file = trimmed_path
            except Exception as trim_err:
                sys.stderr.write(f"[tts-sidecar] trim note: {trim_err}\n")

            # Read and encode
            with open(out_file, "rb") as f:
                audio_bytes = f.read()

            try:
                with wave.open(out_file, 'rb') as w:
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
            for f in os.listdir(tmp_dir):
                try:
                    os.unlink(os.path.join(tmp_dir, f))
                except OSError:
                    pass
            try:
                os.rmdir(tmp_dir)
            except OSError:
                pass


if __name__ == "__main__":
    main()
