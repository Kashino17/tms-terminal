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
