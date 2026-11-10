#!/usr/bin/env python3
"""Voice sidecar — speaks single sentences in the cloned voice (reader "Vorlesen").

One sentence in, one piece of audio out: the server feeds sentence after
sentence, so the phone starts playing after the first one while the next is
already being generated (measured on the Mac: ~1.5 s for a sentence of ~5 s).

Protocol (JSON Lines):
  ← {"ready": true, "sample_rate": 24000}
  → {"id": "v1", "text": "Ein Satz."}
  ← {"id": "v1", "pcm": "<base64 16-bit mono>", "sample_rate": 24000, "secs": 4.8}
  ← {"id": "v1", "error": "reason"}

Environment:
  TMS_VOICE_MODEL     model id (in the local Hugging Face cache — never downloaded here)
  TMS_VOICE_REF       reference recording (wav)
  TMS_VOICE_REF_TEXT  file with the words spoken in the reference
"""
import base64
import json
import os
import sys

# Libraries print progress to stdout — the protocol gets its own channel.
proto = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr

os.environ.setdefault("HF_HUB_OFFLINE", "1")


def send(obj):
    proto.write(json.dumps(obj) + "\n")
    proto.flush()


def main():
    model_id = os.environ.get("TMS_VOICE_MODEL", "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit")
    ref = os.environ.get("TMS_VOICE_REF", os.path.expanduser("~/.tms-terminal/voice_24k_15s.wav"))
    ref_text_file = os.environ.get("TMS_VOICE_REF_TEXT", os.path.expanduser("~/.tms-terminal/voice_24k_15s.txt"))
    try:
        import numpy as np
        from mlx_audio.tts.utils import load_model
        with open(ref_text_file, encoding="utf-8") as f:
            ref_text = f.read().strip()
        model = load_model(model_id)
    except Exception as e:  # noqa: BLE001 — report and leave, the server falls back
        send({"ready": False, "error": str(e)})
        return
    send({"ready": True, "sample_rate": 24000})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        rid = req.get("id")
        text = (req.get("text") or "").strip()
        if not rid or not text:
            send({"id": rid, "error": "empty"})
            continue
        try:
            parts = []
            rate = 24000
            for r in model.generate(text=text, ref_audio=ref, ref_text=ref_text, lang_code=req.get("lang") or "german"):
                parts.append(np.array(r.audio))
                rate = int(getattr(r, "sample_rate", rate) or rate)
            if not parts:
                send({"id": rid, "error": "no audio"})
                continue
            audio = np.concatenate(parts)
            pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
            send({"id": rid, "pcm": base64.b64encode(pcm).decode("ascii"), "sample_rate": rate, "secs": round(len(audio) / rate, 2)})
        except Exception as e:  # noqa: BLE001
            send({"id": rid, "error": str(e)})


if __name__ == "__main__":
    main()
