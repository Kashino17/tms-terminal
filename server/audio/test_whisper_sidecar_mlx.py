import io, wave, struct
import numpy as np
import whisper_sidecar_mlx as sc


def _make_wav(samples_int16, rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(struct.pack("<%dh" % len(samples_int16), *samples_int16))
    return buf.getvalue()


def test_wav_bytes_to_float32_range_and_rate():
    wav = _make_wav([32767, -32768, 0], rate=16000)
    samples, rate = sc.wav_bytes_to_float32(wav)
    assert rate == 16000
    assert samples.dtype == np.float32
    assert samples.shape[0] == 3
    assert abs(samples[0] - 1.0) < 1e-3
    assert abs(samples[1] + 1.0) < 1e-3
    assert abs(samples[2]) < 1e-6


def test_split_audio_short_stays_single():
    samples = np.zeros(16000 * 30, dtype=np.float32)  # 30s
    chunks = sc.split_audio(samples, 16000, chunk_secs=60)
    assert len(chunks) == 1


def test_split_audio_long_splits_into_chunks():
    samples = np.zeros(16000 * 150, dtype=np.float32)  # 150s
    chunks = sc.split_audio(samples, 16000, chunk_secs=60)
    assert len(chunks) == 3
    assert sum(c.shape[0] for c in chunks) == samples.shape[0]


def test_chunk_failure_placeholder_is_bracket_ellipsis():
    out = sc.chunk_failure_placeholder(2, 5, "boom")
    assert out == "[…]"


def test_trim_silence_returns_empty_on_pure_silence():
    silence = np.zeros(16000 * 5, dtype=np.float32)
    trimmed = sc.trim_silence(silence, 16000)
    assert trimmed.shape[0] == 0


def test_trim_silence_preserves_speech_and_trims_edges():
    samples = np.zeros(16000 * 4, dtype=np.float32)
    # 1s of speech in the middle (from 1.5s to 2.5s)
    samples[24000:40000] = 0.2
    trimmed = sc.trim_silence(samples, 16000)
    assert 16000 <= trimmed.shape[0] <= 24000


def test_filter_hallucinations_removes_known_artifacts():
    assert sc.filter_hallucinations("Untertitel der Amara.org-Community") == ""
    assert sc.filter_hallucinations("Vielen Dank fürs Zuschauen.") == ""
    assert sc.filter_hallucinations("Schau dir bitte die WebView an.") == "Schau dir bitte die WebView an."


def test_split_audio_finds_pause_valley():
    # 130s of loud speech (0.2), with a 0.5s silence pause at 58s
    samples = np.full(16000 * 130, 0.2, dtype=np.float32)
    pause_start = 16000 * 58
    pause_end = int(16000 * 58.5)
    samples[pause_start:pause_end] = 0.0
    chunks = sc.split_audio(samples, 16000, chunk_secs=60)
    assert len(chunks) == 2
    assert pause_start <= chunks[0].shape[0] <= pause_end
    assert sum(c.shape[0] for c in chunks) == samples.shape[0]



# ── Level normalization: quiet speech must not be dropped as "silence" ──────
def _tone(level, secs=1.0, rate=16000):
    t = np.arange(int(secs * rate), dtype=np.float32) / rate
    return (np.sin(2 * np.pi * 220 * t) * level).astype(np.float32)


def test_normalize_level_lifts_quiet_speech_to_about_0_9():
    out = sc.normalize_level(_tone(0.05))  # needs 18x, inside the 20x cap
    assert 0.85 <= float(np.max(np.abs(out))) <= 0.95


def test_normalize_level_never_lowers_loud_audio():
    loud = _tone(0.95)  # already above the 0.9 target
    out = sc.normalize_level(loud)
    assert np.allclose(out, loud)


def test_normalize_level_keeps_silence_silent():
    out = sc.normalize_level(np.zeros(16000, dtype=np.float32))
    assert float(np.max(np.abs(out))) == 0.0


def test_normalize_level_caps_the_gain_at_20x():
    out = sc.normalize_level(_tone(1e-4))
    assert float(np.max(np.abs(out))) <= 20 * 1e-4 + 1e-6


def test_quiet_speech_survives_trim_after_normalization():
    quiet = _tone(0.002)  # below trim_silence's absolute RMS threshold (0.003)
    assert sc.trim_silence(quiet, 16000).shape[0] == 0
    assert sc.trim_silence(sc.normalize_level(quiet), 16000).shape[0] > 0
