# Voice Mode UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make voice mode intuitive and crash-proof on loudspeaker — add phase hints, tame subtitle overflow, wire controls with animations and haptics, and kill the self-interruption echo loop.

**Architecture:** The existing cinematic aesthetic stays. Changes are additive (new PhaseHint component, new scrim views) or targeted (recorder config, VAD thresholds, server echo guard). No new dependencies beyond the already-installed `expo-haptics`. Server gets a four-line hot-path guard. Mobile gets a new zustand action for `listeningWarmup`, three scrim Views, and two `Animated` timelines on the primary button.

**Tech Stack:** React Native (Expo) with built-in `Animated` API, zustand, `expo-av` for recording, `expo-haptics` for tactile feedback. Server in Node.js with TypeScript and vitest.

**Spec:** `docs/superpowers/specs/2026-04-23-voice-mode-ux-polish-design.md`

---

## File Map

**Create:**
- `mobile/src/components/voice/PhaseHint.tsx` — phase-driven primary + secondary hint text with cross-fade

**Modify:**
- `mobile/src/store/voiceStore.ts` — add `listeningWarmup` boolean + setter
- `mobile/src/screens/VoiceScreen.tsx` — recorder config, cooldown timer, VAD thresholds, close-button two-tap, mount PhaseHint, wire force-turn-end
- `mobile/src/components/voice/VoiceControls.tsx` — primary-button animations, mic-button force-turn-end, "unterbrechen" label, conditional meta row
- `mobile/src/components/voice/SubtitleOverlay.tsx` — scrim underlay, 3-line teleprompter scroll, user chip phase gate
- `server/src/manager/voice.controller.ts` — echo-suppression guard + counter + warning
- `server/test/voice.controller.test.ts` — tests for the new guard

---

## Task 1: Server — Echo-Suppression Guard Foundation

**Purpose:** Track when the last TTS chunk was emitted. Discard transcriptions landing within 800ms.

**Files:**
- Modify: `server/src/manager/voice.controller.ts`
- Modify: `server/test/voice.controller.test.ts`

- [ ] **Step 1: Write the failing test for the 800ms guard**

Add to `server/test/voice.controller.test.ts`:

```typescript
  it('discards transcription arriving within 800ms after last tts chunk', async () => {
    const ctrl = new VoiceSessionController({
      registry: mockRegistry, whisper: mockWhisper, tts: mockTts, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    ctrl.ingestAudio(Buffer.from('fake-audio'));
    await ctrl.endUserTurn(); // runs full turn, last tts_chunk emits, phase → listening
    emitted.length = 0;

    // Immediately ingest new audio and end turn — transcription should be suppressed
    ctrl.ingestAudio(Buffer.from('echo-bleed'));
    await ctrl.endUserTurn();

    const transcripts = emitted.filter((m) => m.type === 'voice:transcript');
    expect(transcripts.length).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/voice.controller.test.ts`
Expected: FAIL — the new test fails because `voice:transcript` is still emitted.

- [ ] **Step 3: Add `lastTtsChunkAt` tracking + 800ms guard to VoiceSessionController**

In `server/src/manager/voice.controller.ts`, add two private fields near the other private declarations (after line 39):

```typescript
  private lastTtsChunkAt = 0;
  private readonly ECHO_WINDOW_MS = 800;
```

Find `synthesizeAndEmit` (around line 228). Inside the `onChunk` callback, right after `chunk.sent = true;`, add:

```typescript
      this.lastTtsChunkAt = Date.now();
```

Do the same in the `resume()` method's clean-resume branch (around line 195, after `c.sent = true;`):

```typescript
        this.lastTtsChunkAt = Date.now();
```

Then, in `endUserTurn()` (around line 74), guard the transcription. Find:

```typescript
      this.setPhase('transcribing');
      const audio = Buffer.concat(this.audioBuffer);
      this.audioBuffer = [];
      const userText = await this.deps.whisper.transcribe(audio);
      if (!userText.trim()) {
```

Insert immediately before `this.setPhase('transcribing');`:

```typescript
      const sinceTts = Date.now() - this.lastTtsChunkAt;
      if (this.lastTtsChunkAt > 0 && sinceTts < this.ECHO_WINDOW_MS) {
        logger.debug(`Voice: echo suppressed (${sinceTts}ms since last tts chunk)`);
        this.audioBuffer = [];
        this.setPhase('listening');
        return;
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run test/voice.controller.test.ts`
Expected: PASS (all 5 tests green, including the new one).

- [ ] **Step 5: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add server/src/manager/voice.controller.ts server/test/voice.controller.test.ts
git commit -m "feat(voice): discard transcriptions within 800ms of last TTS chunk

Prevents self-interruption echo loop on loudspeaker. Foundation for the
four-layer echo mitigation defined in the UX polish spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Server — Echo-Suppression Counter + Warning

**Purpose:** When 3 echo suppressions happen within 60s, emit a recoverable `voice:error` recommending headphones. Fire once per window.

**Files:**
- Modify: `server/src/manager/voice.controller.ts`
- Modify: `server/test/voice.controller.test.ts`

- [ ] **Step 1: Write the failing test for the 3-in-60s warning**

Add to `server/test/voice.controller.test.ts`:

```typescript
  it('emits voice:error after 3 echo suppressions within 60 seconds', async () => {
    const ctrl = new VoiceSessionController({
      registry: mockRegistry, whisper: mockWhisper, tts: mockTts, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    ctrl.ingestAudio(Buffer.from('a'));
    await ctrl.endUserTurn(); // primes lastTtsChunkAt

    // Three consecutive suppressions
    for (let i = 0; i < 3; i++) {
      ctrl.ingestAudio(Buffer.from('echo'));
      await ctrl.endUserTurn();
    }

    const errs = emitted.filter(
      (m) => m.type === 'voice:error' && m.payload.message.includes('Kopfhörer'),
    );
    expect(errs.length).toBe(1);
    expect(errs[0].payload.recoverable).toBe(true);
  });

  it('does not emit echo warning twice in the same 60s window', async () => {
    const ctrl = new VoiceSessionController({
      registry: mockRegistry, whisper: mockWhisper, tts: mockTts, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    ctrl.ingestAudio(Buffer.from('a'));
    await ctrl.endUserTurn();

    // Six consecutive suppressions — still only one warning expected
    for (let i = 0; i < 6; i++) {
      ctrl.ingestAudio(Buffer.from('echo'));
      await ctrl.endUserTurn();
    }

    const errs = emitted.filter(
      (m) => m.type === 'voice:error' && m.payload.message.includes('Kopfhörer'),
    );
    expect(errs.length).toBe(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/voice.controller.test.ts`
Expected: FAIL on both new tests (no warnings emitted).

- [ ] **Step 3: Add the counter + warning emission**

In `server/src/manager/voice.controller.ts`, add two more fields:

```typescript
  private echoSuppressTimestamps: number[] = [];
  private lastEchoWarningAt = 0;
  private readonly ECHO_WARN_WINDOW_MS = 60_000;
  private readonly ECHO_WARN_THRESHOLD = 3;
```

Modify the guard block added in Task 1 — change:

```typescript
      const sinceTts = Date.now() - this.lastTtsChunkAt;
      if (this.lastTtsChunkAt > 0 && sinceTts < this.ECHO_WINDOW_MS) {
        logger.debug(`Voice: echo suppressed (${sinceTts}ms since last tts chunk)`);
        this.audioBuffer = [];
        this.setPhase('listening');
        return;
      }
```

to:

```typescript
      const sinceTts = Date.now() - this.lastTtsChunkAt;
      if (this.lastTtsChunkAt > 0 && sinceTts < this.ECHO_WINDOW_MS) {
        logger.debug(`Voice: echo suppressed (${sinceTts}ms since last tts chunk)`);
        this.audioBuffer = [];
        this.trackEchoSuppression();
        this.setPhase('listening');
        return;
      }
```

And add the new private method just above `private setPhase` (around line 268):

```typescript
  private trackEchoSuppression(): void {
    const now = Date.now();
    this.echoSuppressTimestamps = this.echoSuppressTimestamps.filter(
      (t) => now - t < this.ECHO_WARN_WINDOW_MS,
    );
    this.echoSuppressTimestamps.push(now);

    if (
      this.echoSuppressTimestamps.length >= this.ECHO_WARN_THRESHOLD &&
      now - this.lastEchoWarningAt > this.ECHO_WARN_WINDOW_MS
    ) {
      this.lastEchoWarningAt = now;
      this.deps.emit({
        type: 'voice:error',
        payload: {
          message: 'Kopfhörer empfohlen — Lautsprecher verursacht Echo',
          recoverable: true,
        },
      });
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/voice.controller.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add server/src/manager/voice.controller.ts server/test/voice.controller.test.ts
git commit -m "feat(voice): warn user after 3 echo suppressions in 60s

Emits recoverable voice:error recommending headphones once per 60s
window when loudspeaker echo is repeatedly suppressed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Mobile — Android Hardware AEC + Stricter VAD

**Purpose:** Enable Android's hardware Acoustic Echo Canceller by switching to `VOICE_COMMUNICATION` audio source, and tighten the VAD threshold so quiet echo residue does not trigger a turn.

**Files:**
- Modify: `mobile/src/screens/VoiceScreen.tsx`

- [ ] **Step 1: Enable Android VOICE_COMMUNICATION audio source**

In `mobile/src/screens/VoiceScreen.tsx`, find the `prepareToRecordAsync` call (around line 126). Replace the android block:

```typescript
          android: { extension: '.wav', outputFormat: 3, audioEncoder: 1, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000 },
```

with:

```typescript
          android: {
            extension: '.wav',
            outputFormat: 3,
            audioEncoder: 1,
            audioSource: 7, // VOICE_COMMUNICATION → enables hardware AEC/NS/AGC on Android
            sampleRate: 16000,
            numberOfChannels: 1,
            bitRate: 256000,
          },
```

- [ ] **Step 2: Tighten VAD threshold + add 150ms sustain tracking**

Still in `VoiceScreen.tsx`, add a new ref near the other recorder refs (around line 43):

```typescript
  const speechSustainStartRef = useRef<number | null>(null);
```

Replace the `setOnRecordingStatusUpdate` callback (around lines 135-160). Current:

```typescript
        rec.setOnRecordingStatusUpdate(async (s) => {
          if (!('metering' in s) || typeof s.metering !== 'number') return;
          if (s.metering > -40) {
            if (!hasSpokenRef.current) hasSpokenRef.current = true;
            if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
          } else if (hasSpokenRef.current && !silenceTimerRef.current) {
            silenceTimerRef.current = setTimeout(async () => {
```

Replace with:

```typescript
        rec.setOnRecordingStatusUpdate(async (s) => {
          if (!('metering' in s) || typeof s.metering !== 'number') return;
          const SPEECH_THRESHOLD_DB = -32;
          const SUSTAIN_MIN_MS = 150;

          if (s.metering > SPEECH_THRESHOLD_DB) {
            if (speechSustainStartRef.current === null) {
              speechSustainStartRef.current = Date.now();
            } else if (
              !hasSpokenRef.current &&
              Date.now() - speechSustainStartRef.current >= SUSTAIN_MIN_MS
            ) {
              hasSpokenRef.current = true;
            }
            if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
          } else {
            speechSustainStartRef.current = null;
            if (hasSpokenRef.current && !silenceTimerRef.current) {
              silenceTimerRef.current = setTimeout(async () => {
```

Then reset the sustain ref in the cleanup block (around line 112, inside the `(async () => { ... })()` that runs when phase is not listening):

Current:

```typescript
        if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
        hasSpokenRef.current = false;
```

Change to:

```typescript
        if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
        hasSpokenRef.current = false;
        speechSustainStartRef.current = null;
```

And do the same in the effect's cleanup return (around line 177). Current:

```typescript
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      hasSpokenRef.current = false;
```

Change to:

```typescript
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      hasSpokenRef.current = false;
      speechSustainStartRef.current = null;
```

- [ ] **Step 3: Type-check**

Run: `cd mobile && npx tsc --noEmit`
Expected: no errors. The `audioSource` field may not be in the Expo type — if the compiler complains, the file already uses `as any` on the options object (line 131 `} as any`), so the cast covers it. Verify the cast is still in place.

- [ ] **Step 4: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/screens/VoiceScreen.tsx
git commit -m "feat(voice): enable Android HW AEC + stricter VAD threshold

Switches Android recording to VOICE_COMMUNICATION (audioSource 7) which
activates AcousticEchoCanceler/NoiseSuppressor/AGC. VAD threshold
tightened -40dB → -32dB with 150ms sustain before flagging speech,
so echo artifacts do not trigger turns.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Mobile — 600ms Mic Cooldown After Speaking

**Purpose:** When the phase transitions from `speaking` to `listening`, wait 600ms before activating the microphone. Gives the speaker buffer time to drain and hardware AEC time to re-calibrate.

**Files:**
- Modify: `mobile/src/store/voiceStore.ts`
- Modify: `mobile/src/screens/VoiceScreen.tsx`

- [ ] **Step 1: Add `listeningWarmup` state to voiceStore**

In `mobile/src/store/voiceStore.ts`, update the interface and implementation.

Change the `VoiceState` interface (around line 7) — add two lines after `pausedWithInterjection`:

```typescript
  listeningWarmup: boolean;            // true during 600ms cooldown after speaking
  setListeningWarmup: (b: boolean) => void;
```

Change the store object (around line 26) — add `listeningWarmup: false` to the initial state, and add the setter at the end of the create block (before closing `}))`):

```typescript
  listeningWarmup: false,
```

```typescript
  setListeningWarmup: (b) => set({ listeningWarmup: b }),
```

- [ ] **Step 2: Add cooldown logic in VoiceScreen**

In `mobile/src/screens/VoiceScreen.tsx`, add a new ref near the other refs (around line 43):

```typescript
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousPhaseRef = useRef<VoicePhase>('idle');
```

Import `VoicePhase` if not already imported — it comes from `'../store/voiceStore'`. Check existing imports at the top and add if missing.

Also pull the new setter from the store (add near other store hook calls, around line 36):

```typescript
  const setListeningWarmup = useVoiceStore((s) => s.setListeningWarmup);
```

Replace the recorder-lifecycle `useEffect` (lines 102-179). Split the behavior:

The existing effect has shape:
```
if (phase !== 'listening') { stop recording; return; }
(async () => { start recording })();
```

Change to this shape:

```typescript
  // Recorder lifecycle: start when listening, stop when not. Uses a 600ms
  // cooldown when transitioning from 'speaking' → 'listening' to let the
  // speaker buffer drain and hardware AEC re-calibrate.
  useEffect(() => {
    if (!client) return;

    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = phase;

    if (phase !== 'listening') {
      // Stop any ongoing recording and pending cooldown
      (async () => {
        if (cooldownTimerRef.current) {
          clearTimeout(cooldownTimerRef.current);
          cooldownTimerRef.current = null;
        }
        setListeningWarmup(false);
        if (recordingRef.current) {
          try { await recordingRef.current.stopAndUnloadAsync(); } catch {}
          recordingRef.current = null;
        }
        if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
        hasSpokenRef.current = false;
        speechSustainStartRef.current = null;
      })();
      return;
    }

    // phase === 'listening' — decide if we need cooldown
    const needsCooldown = previousPhase === 'speaking';
    const startDelayMs = needsCooldown ? 600 : 0;

    let cancelled = false;

    const startRecording = async () => {
      try {
        const { granted } = await Audio.requestPermissionsAsync();
        if (!granted) { setError('Mikrofon-Zugriff verweigert'); return; }
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

        const rec = new Audio.Recording();
        await rec.prepareToRecordAsync({
          android: {
            extension: '.wav',
            outputFormat: 3,
            audioEncoder: 1,
            audioSource: 7, // VOICE_COMMUNICATION → hardware AEC/NS/AGC
            sampleRate: 16000,
            numberOfChannels: 1,
            bitRate: 256000,
          },
          ios: { extension: '.wav', audioQuality: 96, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
          web: {},
          isMeteringEnabled: true,
        } as any);

        if (cancelled) { try { await rec.stopAndUnloadAsync(); } catch {} return; }

        rec.setOnRecordingStatusUpdate(async (s) => {
          if (!('metering' in s) || typeof s.metering !== 'number') return;
          const SPEECH_THRESHOLD_DB = -32;
          const SUSTAIN_MIN_MS = 150;

          if (s.metering > SPEECH_THRESHOLD_DB) {
            if (speechSustainStartRef.current === null) {
              speechSustainStartRef.current = Date.now();
            } else if (
              !hasSpokenRef.current &&
              Date.now() - speechSustainStartRef.current >= SUSTAIN_MIN_MS
            ) {
              hasSpokenRef.current = true;
            }
            if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
          } else {
            speechSustainStartRef.current = null;
            if (hasSpokenRef.current && !silenceTimerRef.current) {
              silenceTimerRef.current = setTimeout(async () => {
                silenceTimerRef.current = null;
                try {
                  const current = recordingRef.current;
                  if (!current) return;
                  const uri = current.getURI();
                  await current.stopAndUnloadAsync();
                  recordingRef.current = null;
                  hasSpokenRef.current = false;
                  speechSustainStartRef.current = null;
                  if (uri) {
                    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
                    client.sendAudioChunk(b64);
                    client.endTurn();
                  }
                } catch {
                  setError('Turn-Ende fehlgeschlagen');
                }
              }, 800);
            }
          }
        });
        rec.setProgressUpdateInterval(200);
        await rec.startAsync();
        if (cancelled) { try { await rec.stopAndUnloadAsync(); } catch {} return; }
        recordingRef.current = rec;
      } catch {
        setError('Mikrofon konnte nicht gestartet werden');
      }
    };

    if (needsCooldown) {
      setListeningWarmup(true);
      cooldownTimerRef.current = setTimeout(() => {
        cooldownTimerRef.current = null;
        setListeningWarmup(false);
        if (!cancelled) startRecording();
      }, startDelayMs);
    } else {
      startRecording();
    }

    return () => {
      cancelled = true;
      if (cooldownTimerRef.current) { clearTimeout(cooldownTimerRef.current); cooldownTimerRef.current = null; }
      setListeningWarmup(false);
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      hasSpokenRef.current = false;
      speechSustainStartRef.current = null;
    };
  }, [phase, client]);
```

Note: this block consolidates Tasks 3 and 4. If Task 3 was committed with partial changes, this replacement is cleaner than layering edits.

- [ ] **Step 3: Type-check**

Run: `cd mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/store/voiceStore.ts mobile/src/screens/VoiceScreen.tsx
git commit -m "feat(voice): 600ms cooldown between speaking and listening

Adds listeningWarmup flag to voiceStore. When phase transitions from
'speaking' to 'listening', microphone activation is delayed 600ms to
let TTS audio drain and hardware AEC re-calibrate. PhaseHint consumes
the flag to show a 'Moment…' hint during cooldown.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Mobile — PhaseHint Component

**Purpose:** New centered hint text that explains the current phase to the user in plain language, with cross-fade transitions.

**Files:**
- Create: `mobile/src/components/voice/PhaseHint.tsx`

- [ ] **Step 1: Create the PhaseHint component**

Create `mobile/src/components/voice/PhaseHint.tsx` with:

```typescript
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useVoiceStore } from '../../store/voiceStore';
import type { VoicePhase } from '../../store/voiceStore';

interface HintCopy { primary: string; secondary: string; }

const HINTS: Record<VoicePhase, HintCopy> = {
  idle:          { primary: 'Tippe und sprich', secondary: 'bereit' },
  listening:     { primary: 'Sprich jetzt', secondary: 'Mikrofon aktiv' },
  transcribing:  { primary: 'Verstehe dich', secondary: 'Transkription läuft' },
  thinking:      { primary: 'Rem überlegt', secondary: 'Antwort gleich da' },
  tool_call:     { primary: 'Rem arbeitet', secondary: 'Terminal-Aktion' },
  speaking:      { primary: 'Rem antwortet', secondary: 'Mikrofon unterbricht' },
  paused:        { primary: 'Pause', secondary: 'Tippe ▶︎ zum Fortsetzen' },
};

const WARMUP: HintCopy = { primary: 'Moment…', secondary: 'Mikrofon startet' };

export function PhaseHint() {
  const phase = useVoiceStore((s) => s.phase);
  const listeningWarmup = useVoiceStore((s) => s.listeningWarmup);
  const aiStreaming = useVoiceStore((s) => s.aiStreaming);

  const copy: HintCopy =
    phase === 'listening' && listeningWarmup ? WARMUP : HINTS[phase];

  // Fade down to 0.4 while subtitle is on screen during 'speaking'
  const subtitleVisible = !!aiStreaming && (phase === 'speaking' || phase === 'thinking');
  const targetOpacity = subtitleVisible ? 0.4 : 1;

  const opacity = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const keyRef = useRef<string>(copy.primary + '|' + copy.secondary);

  useEffect(() => {
    const nextKey = copy.primary + '|' + copy.secondary;
    if (nextKey === keyRef.current) {
      // Only opacity-dim for subtitle overlay case
      Animated.timing(opacity, { toValue: targetOpacity, duration: 250, useNativeDriver: true }).start();
      return;
    }
    keyRef.current = nextKey;

    Animated.sequence([
      Animated.parallel([
        Animated.timing(opacity,    { toValue: 0, duration: 400, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 6, duration: 400, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.timing(translateY, { toValue: -6, duration: 0, useNativeDriver: true }),
        Animated.timing(opacity,    { toValue: targetOpacity, duration: 200, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]),
    ]).start();
  }, [copy.primary, copy.secondary, targetOpacity, opacity, translateY]);

  return (
    <View style={styles.container} pointerEvents="none">
      <Animated.View style={{ opacity, transform: [{ translateY }] }}>
        <Text style={styles.primary}>{copy.primary}</Text>
        <Text style={styles.secondary}>{copy.secondary}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0, right: 0,
    top: '56%',
    alignItems: 'center',
    paddingHorizontal: 26,
  },
  primary: {
    fontFamily: 'Fraunces_400Regular_Italic',
    fontSize: 26,
    lineHeight: 30,
    letterSpacing: -0.3,
    color: '#F4EFE5',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 24,
  },
  secondary: {
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 9.5,
    letterSpacing: 2.1,
    textTransform: 'uppercase',
    color: '#8A8275',
    opacity: 0.75,
    textAlign: 'center',
    marginTop: 8,
  },
});
```

- [ ] **Step 2: Type-check**

Run: `cd mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/components/voice/PhaseHint.tsx
git commit -m "feat(voice): add PhaseHint component with per-phase guidance

Centered two-line hint (primary Fraunces italic, secondary Bricolage
uppercase) that cross-fades on phase change and dims to 0.4 while the
karaoke subtitle is active.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Mobile — Mount PhaseHint in VoiceScreen

**Purpose:** Render the new PhaseHint between the character and the subtitle zone.

**Files:**
- Modify: `mobile/src/screens/VoiceScreen.tsx`

- [ ] **Step 1: Import and mount PhaseHint**

In `mobile/src/screens/VoiceScreen.tsx`, add the import near the other voice component imports (around line 17):

```typescript
import { PhaseHint } from '../components/voice/PhaseHint';
```

Add `<PhaseHint />` in the JSX, between `<CharacterWebView>` and `<SubtitleOverlay>` (around line 217). The existing JSX:

```tsx
      <SubtitleOverlay />
```

Change the preceding lines so the final order is:

```tsx
      <CharacterWebView phase={phase} />

      <View style={styles.topbar}>
        <StatusPill phase={phase} />
        <TouchableOpacity style={styles.closeBtn} onPress={handleClose}>
          <Feather name="x" size={16} color="#C8BFB0" />
        </TouchableOpacity>
      </View>

      {errorBanner && ( /* unchanged */ )}

      <PhaseHint />
      <SubtitleOverlay />
```

- [ ] **Step 2: Type-check**

Run: `cd mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/screens/VoiceScreen.tsx
git commit -m "feat(voice): mount PhaseHint in VoiceScreen

Renders between character and subtitle zone.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Mobile — Subtitle Scrim (Pseudo-Gradient via Stacked Views)

**Purpose:** Dim the area behind the subtitle text without adding a gradient library.

**Files:**
- Modify: `mobile/src/components/voice/SubtitleOverlay.tsx`

- [ ] **Step 1: Add three stacked scrim views**

In `mobile/src/components/voice/SubtitleOverlay.tsx`, add the scrim markup before the `userBubble` and `subtitle` rendering. The component currently returns a single container `View`; add three new absolutely-positioned views as siblings *behind* the existing content.

Wrap the existing return in a `<>` fragment and prepend the scrim views:

```tsx
  return (
    <>
      <View style={styles.scrimOuter} pointerEvents="none" />
      <View style={styles.scrimMiddle} pointerEvents="none" />
      <View style={styles.scrimInner} pointerEvents="none" />
      <View style={styles.container} pointerEvents="none">
        {/* existing content unchanged */}
      </View>
    </>
  );
```

Add the new styles to the StyleSheet at the end:

```typescript
  scrimOuter: {
    position: 'absolute',
    left: 0, right: 0, bottom: 70,
    height: 140,
    backgroundColor: 'rgba(10,8,7,0.28)',
  },
  scrimMiddle: {
    position: 'absolute',
    left: 0, right: 0, bottom: 95,
    height: 90,
    backgroundColor: 'rgba(10,8,7,0.35)',
  },
  scrimInner: {
    position: 'absolute',
    left: 0, right: 0, bottom: 115,
    height: 50,
    backgroundColor: 'rgba(10,8,7,0.45)',
  },
```

- [ ] **Step 2: Type-check**

Run: `cd mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/components/voice/SubtitleOverlay.tsx
git commit -m "feat(voice): add subtitle scrim via three stacked alpha views

Pseudo-gradient dimming behind subtitle text for contrast. No new deps.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Mobile — Subtitle Teleprompter (3-Line Scroll)

**Purpose:** Keep the subtitle confined to 3 visible lines. Auto-scroll the inner text so the currently-spoken word stays near the middle line.

**Files:**
- Modify: `mobile/src/components/voice/SubtitleOverlay.tsx`

- [ ] **Step 1: Wrap subtitle in a clipped scroller**

In `mobile/src/components/voice/SubtitleOverlay.tsx`, restructure the AI subtitle block. Replace the existing `{showAi && (<Text style={styles.subtitle}>…</Text>)}` with a clipped view whose inner `Animated.View` shifts on word advance.

Add at the top of the file alongside existing imports:

```typescript
import { Animated } from 'react-native';
import { useEffect, useRef, useState } from 'react';
```

(Some of these may already be imported — merge without duplicating.)

Inside the component, before the return, add scroll logic:

```typescript
  const LINE_HEIGHT = 30;
  const MIDDLE_LINE_OFFSET = LINE_HEIGHT; // 2nd line of 3

  const [activeWordY, setActiveWordY] = useState(0);
  const translateY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const target = Math.max(0, activeWordY - MIDDLE_LINE_OFFSET);
    Animated.timing(translateY, {
      toValue: -target,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [activeWordY, translateY]);
```

Replace the existing AI subtitle render with:

```tsx
      {showAi && (
        <View style={styles.aiClip}>
          <Animated.View style={{ transform: [{ translateY }] }}>
            <Text style={styles.subtitle}>
              {words.map((w, i) => {
                if (/^\s+$/.test(w)) return <Text key={i}>{w}</Text>;
                const isSpoken = wordIdx < aiSpokenWordCount;
                const isActive = wordIdx === aiSpokenWordCount;
                wordIdx++;
                const style = isActive ? styles.wordActive : isSpoken ? styles.wordSpoken : styles.word;
                return (
                  <Text
                    key={i}
                    style={style}
                    onLayout={
                      isActive
                        ? (e) => setActiveWordY(e.nativeEvent.layout.y)
                        : undefined
                    }
                  >{w}</Text>
                );
              })}
            </Text>
          </Animated.View>
        </View>
      )}
```

Add the new `aiClip` style to the StyleSheet:

```typescript
  aiClip: {
    height: 90, // 3 lines × 30px lineHeight
    width: '100%',
    overflow: 'hidden',
    alignItems: 'center',
  },
```

- [ ] **Step 2: Type-check**

Run: `cd mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/components/voice/SubtitleOverlay.tsx
git commit -m "feat(voice): 3-line teleprompter scroll for AI subtitle

Subtitle clipped to 3 visible lines. Active word's Y offset drives an
animated translateY on the inner view so the current word stays near
the middle line.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Mobile — Hide User Chip During Thinking + Tighten Spacing

**Purpose:** User's transcript chip should not compete with the AI reply. Hide it once phase reaches `thinking`. Also tighten the gap between chip and AI line so they read as a related pair.

**Files:**
- Modify: `mobile/src/components/voice/SubtitleOverlay.tsx`

- [ ] **Step 1: Narrow the `showUser` gate**

In `mobile/src/components/voice/SubtitleOverlay.tsx`, find the `showUser` derivation (currently includes `'thinking'`):

```typescript
  const showUser = !!userTranscript && (phase === 'listening' || phase === 'transcribing' || phase === 'thinking');
```

Change to:

```typescript
  const showUser = !!userTranscript && (phase === 'listening' || phase === 'transcribing');
```

- [ ] **Step 2: Tighten the container gap**

In the same file, find the `container` style (currently `gap: 6`):

```typescript
  container: {
    position: 'absolute',
    left: 0, right: 0, bottom: 180,
    paddingHorizontal: 26,
    alignItems: 'center',
    gap: 6,
  },
```

Change `gap` from `6` to `2`:

```typescript
  container: {
    position: 'absolute',
    left: 0, right: 0, bottom: 180,
    paddingHorizontal: 26,
    alignItems: 'center',
    gap: 2,
  },
```

- [ ] **Step 3: Type-check**

Run: `cd mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/components/voice/SubtitleOverlay.tsx
git commit -m "feat(voice): hide user transcript once Rem starts thinking

Reduces concurrent text regions during reply. User chip visible only
during listening and transcribing phases. Tightens gap between user
chip and AI line from 6 to 2 so they read as a related pair.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Mobile — Primary Button Animations (Icon Crossfade + Ripple + Haptic)

**Purpose:** Make pause/play feel tactile. Icon crossfades with a subtle rotate, a ripple expands from the touch point, and `impactLight` haptic fires on press.

**Files:**
- Modify: `mobile/src/components/voice/VoiceControls.tsx`

- [ ] **Step 1: Rewrite the primary button with animations**

Replace the entire contents of `mobile/src/components/voice/VoiceControls.tsx` with:

```typescript
import React, { useEffect, useRef, useState } from 'react';
import { View, TouchableOpacity, Text, StyleSheet, Animated, Easing } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useVoiceStore } from '../../store/voiceStore';

interface Props {
  providerName: string;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onForceTurnEnd: () => void;
}

const DEFAULT_PROVIDER = 'Rem';

export function VoiceControls({ providerName, onPause, onResume, onCancel, onForceTurnEnd }: Props) {
  const phase = useVoiceStore((s) => s.phase);
  const pausedWithInterjection = useVoiceStore((s) => s.pausedWithInterjection);
  const isPaused = phase === 'paused';

  if (pausedWithInterjection) return null;

  // Primary button — icon crossfade + rotate on state change
  const iconOpacityA = useRef(new Animated.Value(isPaused ? 0 : 1)).current;
  const iconOpacityB = useRef(new Animated.Value(isPaused ? 1 : 0)).current;
  const iconRotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    iconRotate.setValue(-8);
    Animated.parallel([
      Animated.timing(iconOpacityA, { toValue: isPaused ? 0 : 1, duration: 250, useNativeDriver: true }),
      Animated.timing(iconOpacityB, { toValue: isPaused ? 1 : 0, duration: 250, useNativeDriver: true, delay: 100 }),
      Animated.timing(iconRotate,   { toValue: 0, duration: 300, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
    ]).start();
  }, [isPaused, iconOpacityA, iconOpacityB, iconRotate]);

  // Primary button — scale + ripple on press
  const pressScale = useRef(new Animated.Value(1)).current;
  const [ripples, setRipples] = useState<{ id: number; scale: Animated.Value; opacity: Animated.Value }[]>([]);
  const rippleIdRef = useRef(0);

  const triggerRipple = () => {
    const id = ++rippleIdRef.current;
    const scale = new Animated.Value(0);
    const opacity = new Animated.Value(0.35);
    setRipples((r) => [...r, { id, scale, opacity }]);
    Animated.parallel([
      Animated.timing(scale,   { toValue: 1.8, duration: 450, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0,   duration: 450, useNativeDriver: true }),
    ]).start(() => {
      setRipples((r) => r.filter((x) => x.id !== id));
    });
  };

  const handlePrimaryPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    triggerRipple();
    Animated.sequence([
      Animated.timing(pressScale, { toValue: 0.93, duration: 80,  useNativeDriver: true }),
      Animated.spring(pressScale, { toValue: 1,    useNativeDriver: true }),
    ]).start();
    if (isPaused) onResume(); else onPause();
  };

  // Mic button — force turn end, enabled only during speaking/thinking
  const micEnabled = phase === 'speaking' || phase === 'thinking';
  const handleMicPress = () => {
    if (!micEnabled) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onForceTurnEnd();
  };

  const rotateDeg = iconRotate.interpolate({ inputRange: [-8, 0], outputRange: ['-8deg', '0deg'] });
  const showMeta = providerName !== DEFAULT_PROVIDER;

  return (
    <View style={styles.container} pointerEvents="box-none">
      <View style={styles.row}>
        <TouchableOpacity style={[styles.btn, styles.danger]} onPress={onCancel}>
          <Feather name="x" size={24} color="rgba(228,120,115,0.9)" />
        </TouchableOpacity>

        <TouchableOpacity
          activeOpacity={0.85}
          style={styles.primaryTouch}
          onPress={handlePrimaryPress}
        >
          <Animated.View style={[styles.btn, styles.primary, { transform: [{ scale: pressScale }] }]}>
            {ripples.map((r) => (
              <Animated.View
                key={r.id}
                pointerEvents="none"
                style={[
                  styles.ripple,
                  { opacity: r.opacity, transform: [{ scale: r.scale }] },
                ]}
              />
            ))}
            <Animated.View style={{ position: 'absolute', opacity: iconOpacityA, transform: [{ rotate: rotateDeg }] }}>
              <Feather name="pause" size={28} color="#0a0807" />
            </Animated.View>
            <Animated.View style={{ position: 'absolute', opacity: iconOpacityB, transform: [{ rotate: rotateDeg }] }}>
              <Feather name="play" size={28} color="#0a0807" />
            </Animated.View>
          </Animated.View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.btn, !micEnabled && styles.btnDisabled]}
          onPress={handleMicPress}
          activeOpacity={micEnabled ? 0.7 : 1}
        >
          <Feather name="mic" size={24} color={micEnabled ? '#F4EFE5' : 'rgba(244,239,229,0.45)'} />
          {micEnabled && <Text style={styles.micLabel}>unterbrechen</Text>}
        </TouchableOpacity>
      </View>
      {showMeta && (
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>REM</Text>
          <View style={styles.sep} />
          <Text style={styles.metaProvider}>{providerName}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0, right: 0, bottom: 40,
    alignItems: 'center', gap: 16,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  btn: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: 'rgba(28,23,19,0.7)',
    borderWidth: 1, borderColor: 'rgba(244,239,229,0.14)',
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  primaryTouch: {
    width: 78, height: 78, borderRadius: 39,
    alignItems: 'center', justifyContent: 'center',
  },
  primary: {
    width: 78, height: 78, borderRadius: 39,
    backgroundColor: '#D68B4E', borderColor: 'rgba(243,181,122,0.5)',
    shadowColor: '#D68B4E', shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5, shadowRadius: 20, elevation: 12,
  },
  ripple: {
    position: 'absolute',
    width: 78, height: 78, borderRadius: 39,
    backgroundColor: '#F3B57A',
  },
  danger: {},
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  metaLabel: {
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 11.5, letterSpacing: 2,
    color: '#8A8275', textTransform: 'uppercase',
  },
  metaProvider: {
    fontFamily: 'Fraunces_400Regular_Italic',
    fontSize: 13, letterSpacing: 0.3,
    color: '#C8BFB0',
  },
  sep: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: '#8A8275', opacity: 0.5 },
  micLabel: {
    position: 'absolute',
    bottom: -18,
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 8.5, letterSpacing: 1.8,
    color: '#8A8275', textTransform: 'uppercase',
    opacity: 0.75,
  },
});
```

- [ ] **Step 2: Type-check**

Run: `cd mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/components/voice/VoiceControls.tsx
git commit -m "feat(voice): animate primary button + wire mic to force-turn-end

Icon crossfade with rotate, touch ripple, haptic feedback on pause/play.
Mic button is disabled outside speaking/thinking; when enabled, shows
'unterbrechen' label and triggers onForceTurnEnd on press.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Mobile — Wire Force-Turn-End in VoiceScreen

**Purpose:** Connect the new `onForceTurnEnd` prop to the VoiceClient cancel path and stop the audio queue immediately.

**Files:**
- Modify: `mobile/src/screens/VoiceScreen.tsx`

- [ ] **Step 1: Add handler and pass to VoiceControls**

In `mobile/src/screens/VoiceScreen.tsx`, add the handler near the other handlers (around line 190):

```typescript
  const handleForceTurnEnd = () => {
    audioQueue.stop();
    client?.cancel();
  };
```

Find the `<VoiceControls>` render and add the prop:

```tsx
        <VoiceControls
          providerName="Rem"
          onPause={handlePause}
          onResume={handleResume}
          onCancel={handleCancel}
          onForceTurnEnd={handleForceTurnEnd}
        />
```

- [ ] **Step 2: Type-check**

Run: `cd mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/screens/VoiceScreen.tsx
git commit -m "feat(voice): wire force-turn-end handler to VoiceControls

Mic button press stops audio queue and cancels the current AI turn.
Server transitions to listening; client's recorder activates after the
600ms cooldown from Task 4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Mobile — Close Button Two-Tap Confirmation

**Purpose:** Avoid accidental exit. First tap shows a 2000ms confirmation overlay; second tap within the window exits.

**Files:**
- Modify: `mobile/src/screens/VoiceScreen.tsx`

- [ ] **Step 1: Add confirmation state and overlay**

In `mobile/src/screens/VoiceScreen.tsx`, import `useState` if not already (already used via `useRef` — add `useState`):

```typescript
import React, { useEffect, useMemo, useRef, useState } from 'react';
```

Inside the component, add state for the confirmation pill:

```typescript
  const [closeConfirmVisible, setCloseConfirmVisible] = useState(false);
  const closeConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

Replace the `handleClose` implementation (currently lines ~191-194):

```typescript
  const handleClose = () => {
    client?.stop();
    navigation.goBack();
  };
```

with:

```typescript
  const handleClose = () => {
    if (closeConfirmVisible) {
      if (closeConfirmTimerRef.current) {
        clearTimeout(closeConfirmTimerRef.current);
        closeConfirmTimerRef.current = null;
      }
      client?.stop();
      navigation.goBack();
      return;
    }
    setCloseConfirmVisible(true);
    if (closeConfirmTimerRef.current) clearTimeout(closeConfirmTimerRef.current);
    closeConfirmTimerRef.current = setTimeout(() => {
      closeConfirmTimerRef.current = null;
      setCloseConfirmVisible(false);
    }, 2000);
  };
```

Add cleanup on unmount — inside the existing `useEffect` return (around line 98):

```typescript
      if (closeConfirmTimerRef.current) { clearTimeout(closeConfirmTimerRef.current); closeConfirmTimerRef.current = null; }
```

Add the confirmation pill overlay in the JSX, just after the error banner block (around line 216):

```tsx
      {closeConfirmVisible && (
        <View style={styles.closeConfirm} pointerEvents="none">
          <Text style={styles.closeConfirmText}>Nochmal tippen zum Beenden</Text>
        </View>
      )}
```

Add the matching styles to the StyleSheet:

```typescript
  closeConfirm: {
    position: 'absolute',
    top: 100,
    alignSelf: 'center',
    paddingHorizontal: 18, paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(28,23,19,0.85)',
    borderWidth: 1, borderColor: 'rgba(214,139,78,0.25)',
    zIndex: 11,
  },
  closeConfirmText: {
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 12, letterSpacing: 1.5,
    color: '#F4EFE5', textTransform: 'uppercase',
  },
```

- [ ] **Step 2: Type-check**

Run: `cd mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/screens/VoiceScreen.tsx
git commit -m "feat(voice): two-tap close confirmation

First tap shows 'Nochmal tippen zum Beenden' pill for 2000ms. Second
tap within that window exits. After 2000ms the state resets.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Manual QA on Samsung Galaxy Fold 7

**Purpose:** Verify the full feature end-to-end on device. All previous tasks are unit/logic-tested; these flows need a human.

**Files:** None (verification only).

- [ ] **Step 1: Build and install the release APK**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
./deploy.sh adb
```

Expected: APK builds and installs over USB. App launches.

- [ ] **Step 2: Start a voice session with the phone on loudspeaker at high volume**

Connect to the server. Open the Manager chat and switch to voice mode. Ask Rem a neutral question (e.g., *"Wie geht's dir?"*).

Expected:
- PhaseHint cycles: *Sprich jetzt* → *Verstehe dich* → *Rem überlegt* → *Moment…* (during 600ms cooldown after speaking) → *Sprich jetzt*.
- Subtitle appears with karaoke highlight, never climbs above its zone.
- No self-triggered turn after Rem finishes speaking. Stay silent for 10s.

Repeat 5 times. Document any false-trigger occurrences.

- [ ] **Step 3: Connect wired/Bluetooth headphones and repeat**

Expected: No perceptible delay in listening, VAD still responsive to normal speech.

- [ ] **Step 4: Force-turn-end flow**

Ask Rem a question that will yield a long answer (e.g., *"Erklär mir Tailscale"*). During Rem's reply, tap the mic button.

Expected:
- Haptic vibration on press.
- Audio playback stops within ~300ms.
- PhaseHint changes through *Moment…* → *Sprich jetzt*.
- User speech is captured and results in a new turn correctly.

- [ ] **Step 5: Pause/Play animations**

During Rem speaking, tap the pause button. Tap play to resume.

Expected:
- Icon crossfades between pause and play with subtle rotate.
- Orange ripple expands from the button center.
- Haptic vibration on each press.
- Pause stops TTS; resume continues where left off.

- [ ] **Step 6: Close-button confirmation**

Tap the close (X) button once.

Expected: Pill *"Nochmal tippen zum Beenden"* appears at top center for 2 seconds.

Tap again within 2 seconds. Expected: Voice mode closes.

Start voice mode again. Tap once, wait 3 seconds, tap again. Expected: First tap shows pill and it disappears after 2s; second tap after the timeout shows the pill again (does NOT close).

- [ ] **Step 7: Subtitle teleprompter**

Ask Rem *"Erzähl mir einen langen Absatz über Astronomie."* — a reply with 4+ sentences.

Expected:
- Subtitle is clamped to 3 visible lines.
- Text auto-scrolls so the currently-highlighted (copper-colored) word stays near the middle line.
- No text climbs above the scrim zone or collides with the character.

- [ ] **Step 8: User-chip fade**

Ask Rem something simple. Observe the user-transcript chip (your transcribed question).

Expected:
- Chip is visible during *listening* and *transcribing*.
- Chip fades out once phase becomes *thinking*; does not reappear during *speaking*.

- [ ] **Step 9: Bump app version and create release**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
./release.sh
```

Expected: patch bump to v1.20.1, APK built, Git tag + GitHub Release created. (Script prompts for tag creation — accept.)

- [ ] **Step 10: Update memory and final commit**

Update `memory/project-state.md` with v1.20.1 released (and the polish items shipped). Update `memory/journal.md` with a session entry. Then:

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add memory/
git commit -m "memory: update session journal for voice UX polish v1.20.1

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Summary

Thirteen tasks, committed incrementally. Server gets two new tests (echo guard + warning) and two new methods. Mobile gains one new component (`PhaseHint`), targeted changes to `VoiceScreen`, `VoiceControls`, `SubtitleOverlay`, and one new store field. No new dependencies. Manual QA covers the loudspeaker loop, pause/play tactile feedback, teleprompter scroll, and close-button confirmation.
