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
