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


def _noise(rms, secs=10.0, rate=16000, seed=1):
    return np.random.default_rng(seed).normal(0, rms, int(secs * rate)).astype(np.float32)


def _quiet_speech(level=0.004, floor=0.0003, secs=6.0, rate=16000):
    """Syllable-like bursts (250 ms on / 150 ms off) over a low noise floor."""
    out = _noise(floor, secs, rate)
    t = np.arange(int(0.25 * rate), dtype=np.float32) / rate
    burst = (np.sin(2 * np.pi * 180 * t) * level).astype(np.float32)
    step = int(0.4 * rate)
    for i in range(int(0.5 * rate), out.shape[0] - burst.shape[0], step):
        out[i:i + burst.shape[0]] += burst
    return out


# Review I6: lifting the level before an absolute silence threshold let pure
# room tone through to Whisper (hallucinated "Vielen Dank fürs Zuschauen").
def test_prepare_chunk_drops_pure_room_noise():
    assert sc.prepare_chunk(_noise(0.001)).shape[0] == 0


def test_prepare_chunk_drops_fluctuating_room_noise():
    n = _noise(0.001) * (1 + 0.5 * np.sin(np.arange(160000) / 16000 * 2 * np.pi * 3)).astype(np.float32)
    assert sc.prepare_chunk(n.astype(np.float32)).shape[0] == 0


def test_prepare_chunk_keeps_quiet_speech_and_lifts_it():
    quiet = _quiet_speech(level=0.006)
    out = sc.prepare_chunk(quiet)
    assert out.shape[0] > 16000 * 4
    assert float(np.max(np.abs(out))) > 0.05


def test_prepare_chunk_keeps_normal_speech_as_before():
    loud = _quiet_speech(level=0.3, floor=0.002)
    assert sc.prepare_chunk(loud).shape[0] >= sc.trim_silence(loud, 16000).shape[0]


# ── Dictionary prompt ──────────────────────────────────────────────────
class _FakeWhisper:
    def __init__(self):
        self.prompts = []

    def transcribe(self, samples, **kw):
        self.prompts.append(kw.get("initial_prompt"))
        return {"text": "ok"}


def _speech_wav_b64(seconds=1.0):
    import base64
    n = int(16000 * seconds)
    t = np.arange(n) / 16000.0
    pcm = (np.sin(2 * np.pi * 220 * t) * 0.4 * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(pcm.tobytes())
    return base64.b64encode(buf.getvalue()).decode()


def test_request_prompt_is_handed_to_whisper(monkeypatch):
    out = []
    monkeypatch.setattr(sc, "_emit", out.append)
    fake = _FakeWhisper()
    sc.handle_request(fake, {"id": "r1", "audio_base64": _speech_wav_b64(), "prompt": "Wispr Flow, Tailscale."})
    assert fake.prompts == ["Wispr Flow, Tailscale."]
    assert out[-1] == {"id": "r1", "text": "ok"}


def test_request_without_prompt_uses_the_fixed_vocabulary(monkeypatch):
    monkeypatch.setattr(sc, "_emit", lambda _o: None)
    fake = _FakeWhisper()
    sc.handle_request(fake, {"id": "r2", "audio_base64": _speech_wav_b64()})
    assert fake.prompts == [sc.INITIAL_PROMPT]


def test_an_empty_prompt_falls_back_to_the_fixed_vocabulary(monkeypatch):
    monkeypatch.setattr(sc, "_emit", lambda _o: None)
    fake = _FakeWhisper()
    sc.handle_request(fake, {"id": "r3", "audio_base64": _speech_wav_b64(), "prompt": "  "})
    assert fake.prompts == [sc.INITIAL_PROMPT]
