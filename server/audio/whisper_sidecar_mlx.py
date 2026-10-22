#!/usr/bin/env python3
"""Whisper sidecar (MLX runtime) — long-running transcription process.

Reads JSON Lines from stdin, transcribes with mlx-whisper, writes JSON Lines to stdout.
Same protocol as whisper_sidecar.py. RIFF WAV is decoded in pure Python (fast path);
any other container (Android AMR/AAC/3GP, m4a, WebM …) is decoded via ffmpeg.
"""

import sys
import json
import base64
import wave
import io
import os
import shutil
import subprocess
import tempfile
import numpy as np

CHUNK_DURATION_SECS = 60
PRIMARY_MODEL_REPO = "mlx-community/whisper-large-v3-mlx"
FALLBACK_MODEL_REPO = "mlx-community/whisper-large-v3-turbo"
MODEL_REPO = PRIMARY_MODEL_REPO
TARGET_RATE = 16000

# Domain-specific vocabulary prompt so Whisper accurately recognizes German +
# English coding terms (Denglisch) and project names without misspelling them.
INITIAL_PROMPT = (
    "TMS Terminal, Claude Code, Fernzugriff, TypeScript, React Native, Expo, "
    "WebView, Tailscale, Git, Commit, Branch, Worktree, Server, Terminal, "
    "Prompt, Refactoring, Build, Release, APK, Hook, Store, Component, API, "
    "WebSocket, ptyd, MLX, Whisper, sudo, macOS, Keychain, Touch ID, Galaxy Fold."
)

# Known Whisper silence/outro hallucinations in German/English
HALLUCINATION_PHRASES = (
    "untertitel der amara.org-community",
    "untertitel im auftrag des zdf",
    "untertitel von",
    "vielen dank fürs zuschauen",
    "vielen dank für's zuschauen",
    "danke fürs zuschauen",
    "abonnieren sie unseren kanal",
    "bis zum nächsten mal",
    "thank you for watching",
    "thanks for watching",
    "subtitles by",
)


def resolve_model_path(preferred_repo=PRIMARY_MODEL_REPO):
    """Resolve HuggingFace repo to a local snapshot path once at startup.

    Passing a local directory path to mlx_whisper.transcribe() avoids a network
    roundtrip (`Fetching 4 files`) to huggingface.co on every single request.
    Falls back to FALLBACK_MODEL_REPO if the primary model is unavailable offline.
    """
    try:
        from huggingface_hub import snapshot_download
        for repo in (preferred_repo, FALLBACK_MODEL_REPO):
            try:
                return snapshot_download(repo_id=repo, local_files_only=True)
            except Exception:
                continue
        return snapshot_download(repo_id=preferred_repo)
    except Exception:
        return preferred_repo


def _find_ffmpeg():
    """Locate ffmpeg — node may spawn us with a PATH that omits Homebrew."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    for cand in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"):
        if os.path.exists(cand):
            return cand
    return None


def _wav_to_float32(raw):
    """Fast path: decode 16-bit PCM WAV without spawning a subprocess."""
    with wave.open(io.BytesIO(raw), "rb") as w:
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


def _ffmpeg_to_float32(raw):
    """Robust path: let ffmpeg decode ANY container (AMR/M4A/3GP/WebM/WAV…)
    to float32 mono @16kHz. Android's MediaRecorder never emits RIFF WAV, so
    this is the real path on Android devices.

    The bytes go through a temp FILE, not a stdin pipe: MP4/M4A keeps its
    moov index at the END of the file and ffmpeg cannot seek backwards in a
    pipe — recordings larger than the probe buffer (~30s at 64kbps) then die
    with "stream 0: partial file" while short clips appear to work."""
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found — cannot decode non-WAV audio")
    tmp = tempfile.NamedTemporaryFile(prefix="tms-audio-", suffix=".bin", delete=False)
    try:
        tmp.write(raw)
        tmp.close()
        proc = subprocess.run(
            [ffmpeg, "-nostdin", "-loglevel", "error", "-i", tmp.name,
             "-f", "f32le", "-ac", "1", "-ar", str(TARGET_RATE), "pipe:1"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
    if proc.returncode != 0 or not proc.stdout:
        err = proc.stderr.decode("utf-8", "replace").strip()[:300]
        raise RuntimeError(f"ffmpeg decode failed: {err or 'no output'}")
    samples = np.frombuffer(proc.stdout, dtype=np.float32)
    return np.ascontiguousarray(samples, dtype=np.float32), TARGET_RATE


def wav_bytes_to_float32(raw_bytes):
    """Decode audio bytes to (float32 mono samples in [-1,1], sample_rate).

    Tries the pure-Python WAV fast path first (iOS sends real PCM WAV); falls
    back to ffmpeg for everything else. Android records AMR/AAC under a `.wav`
    name, which has no RIFF header — that lands on the ffmpeg path."""
    if raw_bytes[:4] == b"RIFF":
        return _wav_to_float32(raw_bytes)
    return _ffmpeg_to_float32(raw_bytes)


def trim_silence(samples, sample_rate, threshold=0.003, pad_secs=0.15):
    """Trim leading and trailing silence while keeping a small pad_secs margin.

    Returns an empty array if the entire clip contains no speech energy above
    threshold, preventing Whisper from hallucinating on pure silence.
    """
    if samples.shape[0] == 0:
        return samples
    win = max(1, int(sample_rate * 0.02))  # 20ms frame
    if samples.shape[0] < win:
        return samples if float(np.max(np.abs(samples))) >= threshold else np.zeros(0, dtype=np.float32)
    # Fast RMS envelope over 20ms frames
    n_frames = samples.shape[0] // win
    framed = samples[: n_frames * win].reshape(n_frames, win)
    rms = np.sqrt(np.mean(framed * framed, axis=1))
    active = np.flatnonzero(rms >= threshold)
    if active.size == 0:
        return np.zeros(0, dtype=np.float32)
    pad = int(sample_rate * pad_secs)
    start = max(0, int(active[0]) * win - pad)
    end = min(samples.shape[0], int(active[-1] + 1) * win + pad)
    return samples[start:end]


def filter_hallucinations(text):
    """Remove known Whisper silence hallucinations."""
    if not text:
        return ""
    cleaned = text.strip()
    lower = cleaned.lower().rstrip(".!?,;:")
    for phrase in HALLUCINATION_PHRASES:
        if lower == phrase or lower.startswith(phrase + " ") or lower.endswith(" " + phrase):
            if len(lower) <= len(phrase) + 12:
                return ""
    return cleaned


def _find_pause_split(samples, target_idx, sample_rate, search_secs=6.0):
    """Find the lowest-energy 100ms valley near target_idx so we split in a speech pause."""
    n = samples.shape[0]
    half_win = int(sample_rate * search_secs)
    lo = max(1, target_idx - half_win)
    hi = min(n - 1, target_idx + half_win)
    frame = max(1, int(sample_rate * 0.1))  # 100ms pause window
    if hi - lo <= frame * 2:
        return target_idx
    region = samples[lo:hi]
    n_frames = region.shape[0] // frame
    if n_frames < 2:
        return target_idx
    energies = np.mean(region[: n_frames * frame].reshape(n_frames, frame) ** 2, axis=1)
    # If all frames have identical energy (e.g. synthetic zero array in tests), keep exact target_idx
    if float(np.max(energies) - np.min(energies)) < 1e-12:
        return target_idx
    best_frame = int(np.argmin(energies))
    return lo + best_frame * frame + frame // 2


def split_audio(samples, sample_rate, chunk_secs=CHUNK_DURATION_SECS):
    """Split samples into ~chunk_secs slices at speech pauses. Short audio (<=1.2x chunk) stays a single chunk."""
    chunk_len = int(sample_rate * chunk_secs)
    total_len = samples.shape[0]
    if total_len <= chunk_len * 1.2:
        return [samples]
    chunks = []
    pos = 0
    while pos < total_len:
        remaining = total_len - pos
        if remaining <= chunk_len * 1.2:
            chunks.append(samples[pos:])
            break
        split_at = _find_pause_split(samples, pos + chunk_len, sample_rate)
        chunks.append(samples[pos:split_at])
        pos = split_at
    return chunks


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


def transcribe_chunk(mlx_whisper, samples, language, model_path=None):
    """Transcribe one chunk (numpy float32). One retry, then raise."""
    trimmed = trim_silence(samples, TARGET_RATE)
    if trimmed.shape[0] == 0:
        return ""
    repo_or_path = model_path or MODEL_REPO
    last_err = None
    for _attempt in range(2):
        try:
            result = mlx_whisper.transcribe(
                trimmed,
                path_or_hf_repo=repo_or_path,
                language=language,
                initial_prompt=INITIAL_PROMPT,
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
                compression_ratio_threshold=2.4,
            )
            return filter_hallucinations(result.get("text", "").strip())
        except TypeError:
            # Fallback for test doubles or older mlx_whisper signatures that only accept basic kwargs
            try:
                result = mlx_whisper.transcribe(
                    trimmed, path_or_hf_repo=repo_or_path, language=language
                )
                return filter_hallucinations(result.get("text", "").strip())
            except Exception as e2:  # noqa: BLE001
                last_err = e2
        except Exception as e:  # noqa: BLE001 — resilience boundary
            last_err = e
    raise last_err


def handle_request(mlx_whisper, req, model_path=None):
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
        text = transcribe_chunk(mlx_whisper, chunks[0], language, model_path=model_path)
        _emit({"id": req_id, "text": text})
        return

    _log(f"[whisper-mlx] {req_id}: split into {total} chunks")
    for i, chunk in enumerate(chunks):
        try:
            text = transcribe_chunk(mlx_whisper, chunk, language, model_path=model_path)
        except Exception as e:  # noqa: BLE001
            _log(f"[whisper-mlx] {req_id}: chunk {i+1}/{total} failed: {e}")
            text = chunk_failure_placeholder(i, total, str(e))
        parts.append(text)
        _emit({"id": req_id, "progress": True, "chunk": i + 1, "total": total, "text": text})

    _emit({"id": req_id, "text": " ".join(p for p in parts if p)})


def main():
    global MODEL_REPO
    sys.stdout.reconfigure(line_buffering=True)
    _log("[whisper-mlx] Starting up...")
    try:
        import mlx_whisper
    except ImportError as e:
        _log(f"[whisper-mlx] Missing dependency: {e}")
        _log("[whisper-mlx] Install with: pip install mlx-whisper")
        sys.exit(1)

    resolved_path = resolve_model_path(PRIMARY_MODEL_REPO)
    MODEL_REPO = resolved_path
    _log(f"[whisper-mlx] Loading model {PRIMARY_MODEL_REPO} ({resolved_path})...")
    try:
        # Warm the model with a small synthetic tone so the first real request is instantaneous (~0.25s).
        warmup_audio = (np.sin(np.linspace(0, 440 * 2 * np.pi, 16000)) * 0.05).astype(np.float32)
        mlx_whisper.transcribe(
            warmup_audio,
            path_or_hf_repo=resolved_path,
            language="de",
            initial_prompt=INITIAL_PROMPT,
            condition_on_previous_text=False,
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
            handle_request(mlx_whisper, req, model_path=resolved_path)
        except Exception as e:  # noqa: BLE001
            _emit({"id": req.get("id", "unknown"), "error": str(e)})


if __name__ == "__main__":
    main()
