#!/usr/bin/env python3
"""Whisper sidecar (MLX runtime) — long-running transcription process.

Reads JSON Lines from stdin, transcribes with mlx-whisper, writes JSON Lines to stdout.
Same protocol as whisper_sidecar.py. Decodes WAV directly to a numpy array (no ffmpeg).
"""

import sys
import json
import base64
import wave
import io
import numpy as np

CHUNK_DURATION_SECS = 60
MODEL_REPO = "mlx-community/whisper-large-v3-turbo"


def wav_bytes_to_float32(wav_bytes):
    """Decode 16-bit PCM WAV bytes to (float32 mono samples in [-1,1], sample_rate)."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        n_channels = w.getnchannels()
        sample_width = w.getsampwidth()
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())
    if sample_width != 2:
        raise ValueError("Only 16-bit PCM WAV is supported")
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)
    return np.ascontiguousarray(samples, dtype=np.float32), rate


def split_audio(samples, sample_rate, chunk_secs=CHUNK_DURATION_SECS):
    """Split samples into <=chunk_secs slices. Short audio (<=1.2x chunk) stays a single chunk."""
    chunk_len = int(sample_rate * chunk_secs)
    if samples.shape[0] <= chunk_len * 1.2:
        return [samples]
    return [samples[i:i + chunk_len] for i in range(0, samples.shape[0], chunk_len)]


def chunk_failure_placeholder(chunk_index, total_chunks, error):
    """Policy A: silent placeholder for a chunk that failed after retry.

    Returns the string inserted into the transcript in place of the dead chunk.
    Keeps the text readable while clearly marking the gap.
    """
    return "[…]"


def _log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def _emit(obj):
    print(json.dumps(obj))


def transcribe_chunk(mlx_whisper, samples, language):
    """Transcribe one chunk (numpy float32). One retry, then raise."""
    last_err = None
    for _attempt in range(2):
        try:
            result = mlx_whisper.transcribe(
                samples, path_or_hf_repo=MODEL_REPO, language=language
            )
            return result.get("text", "").strip()
        except Exception as e:  # noqa: BLE001 — resilience boundary
            last_err = e
    raise last_err


def handle_request(mlx_whisper, req):
    req_id = req.get("id", "unknown")
    audio_b64 = req.get("audio_base64", "")
    language = req.get("language", "de")

    if not audio_b64:
        _emit({"id": req_id, "error": "No audio data provided"})
        return

    samples, rate = wav_bytes_to_float32(base64.b64decode(audio_b64))
    duration = samples.shape[0] / rate if rate else 0
    _log(f"[whisper-mlx] {req_id}: {duration:.1f}s audio, rate={rate}")

    chunks = split_audio(samples, rate)
    total = len(chunks)
    parts = []

    if total == 1:
        text = transcribe_chunk(mlx_whisper, chunks[0], language)
        _emit({"id": req_id, "text": text})
        return

    _log(f"[whisper-mlx] {req_id}: split into {total} chunks")
    for i, chunk in enumerate(chunks):
        try:
            text = transcribe_chunk(mlx_whisper, chunk, language)
        except Exception as e:  # noqa: BLE001
            _log(f"[whisper-mlx] {req_id}: chunk {i+1}/{total} failed: {e}")
            text = chunk_failure_placeholder(i, total, str(e))
        parts.append(text)
        _emit({"id": req_id, "progress": True, "chunk": i + 1, "total": total, "text": text})

    _emit({"id": req_id, "text": " ".join(p for p in parts if p)})


def main():
    sys.stdout.reconfigure(line_buffering=True)
    _log("[whisper-mlx] Starting up...")
    try:
        import mlx_whisper
    except ImportError as e:
        _log(f"[whisper-mlx] Missing dependency: {e}")
        _log("[whisper-mlx] Install with: pip install mlx-whisper")
        sys.exit(1)

    # Warm the model so the first real request is fast.
    _log(f"[whisper-mlx] Loading model {MODEL_REPO}...")
    try:
        mlx_whisper.transcribe(
            np.zeros(16000, dtype=np.float32), path_or_hf_repo=MODEL_REPO, language="de"
        )
    except Exception as e:  # noqa: BLE001
        _log(f"[whisper-mlx] Warmup failed (continuing): {e}")
    _log("[whisper-mlx] Ready for requests.")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            handle_request(mlx_whisper, req)
        except Exception as e:  # noqa: BLE001
            _emit({"id": req.get("id", "unknown"), "error": str(e)})


if __name__ == "__main__":
    main()
