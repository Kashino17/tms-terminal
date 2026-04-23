# Voice Mode UX Polish — Design Spec

**Date:** 2026-04-23
**Status:** Draft → pending review
**Scope:** Mobile app — `VoiceScreen` and related components
**Version target:** v1.20.1 (after v1.20.0 ships Voice Chat v1)

## Problem

The initial Voice Chat feature (v1.20.0, `feat/chrome-remote-control`) shipped with a rich visual state machine but the UX is unclear in practice:

- **State ambiguity** — user cannot distinguish "listening" vs "thinking" vs "speaking" from the small StatusPill alone; the rich CharacterWebView phase animations exist but require a legend the user does not have.
- **Subtitle overflow** — `SubtitleOverlay` has no max-height and uses 24pt italic with `maxWidth: 540`. On longer Rem answers the text climbs upward across the whole screen, colliding with the character.
- **Missing control affordances** — the Mic button is wired to a no-op (`onPress={() => {}}` in `VoiceControls.tsx:32`). Pause/Play has no transition animation, no ripple, no haptic. State changes feel abrupt.
- **User-transcript clutter** — user's own prompt remains visible during `thinking`, creating three competing text regions at once (user chip, AI reply, status pill).
- **Self-interruption loop** — on loudspeaker the mic picks up Rem's own TTS output, triggers VAD, the server transcribes Rem's voice as user input and responds to itself. The bug is compounded by no hardware AEC and no cooldown between `speaking → listening`.

## Goals

- Preserve the existing **Cinematic Warmth** aesthetic (copper/obsidian, Fraunces italic, grain, warm glow). No redesign — targeted polish.
- Make the current phase unambiguous at a glance without relying on color memory.
- Contain subtitle text to a predictable zone regardless of AI output length.
- Make every control's effect immediate and tactile (animation + haptic).
- Eliminate the self-interruption loop with layered defenses so it is robust on speakerphone.

## Non-goals

- No new WebSocket protocol messages beyond what v1.20.0 already defines.
- No change to the server-side voice session state machine beyond an echo-suppression gate.
- No change to the F5-TTS sidecar, audio pipeline, or provider selection.
- No rework of the ResumeOptions flow — it stays as-is.

## Design

### § 1 — Phase Guidance (Hint System)

A centered two-line hint slot is added between the character and the subtitle zone. It renders Fraunces Italic ~26pt for the primary line and Bricolage Uppercase ~9.5pt for the secondary line, color-keyed to the current phase color so it reinforces the existing dot/aura palette.

| Phase | Primary Hint | Secondary |
|---|---|---|
| idle | *Tippe und sprich* | bereit |
| listening | *Sprich jetzt* | Mikrofon aktiv |
| transcribing | *Verstehe dich* | Transkription läuft |
| thinking | *Rem überlegt* | Antwort gleich da |
| tool_call | *Rem arbeitet* | Terminal-Aktion |
| speaking | *Rem antwortet* | Mikrofon unterbricht |
| paused | *Pause* | Tippe ▶︎ zum Fortsetzen |

Transitions between hints: 400ms fade-out of the old hint with +6px downward translate, 200ms fade-in of the new one from −6px. Easing `cubic-bezier(0.22, 1, 0.36, 1)` to match the existing WebView easing.

When the karaoke subtitle is active during `speaking`, the hint fades to opacity 0.4 (does not disappear) so the state remains readable while the subtitle takes visual priority.

**New component:** `mobile/src/components/voice/PhaseHint.tsx` — pure presentational, subscribes to `phase` from `voiceStore`.

### § 2 — Subtitle Zone (Scrim + Teleprompter Scroll)

**Position unchanged** (`bottom: 180` in `SubtitleOverlay.tsx`). Four targeted changes:

1. **Dark scrim** behind the subtitle. To avoid new dependencies, this is three stacked `View`s with `pointerEvents="none"` at `bottom: 70, height: 140`:
   - Outer band (full width, full 140px height): `backgroundColor: 'rgba(10,8,7,0.28)'`.
   - Middle band (centered, 90px height): `backgroundColor: 'rgba(10,8,7,0.35)'`.
   - Inner band (centered, 50px height): `backgroundColor: 'rgba(10,8,7,0.45)'`.
   Result is a pseudo-soft-edge scrim via compounded alpha — no gradient library, no SVG, no new deps. The goal is text contrast, not a perfect radial falloff.
2. **Max 3 visible lines** with **teleprompter-style auto-scroll**. The subtitle renders inside a clipped `View` (overflow: hidden) with fixed height of `3 * lineHeight` (lineHeight 30 → height 90). As `aiSpokenWordCount` advances, the inner text container's `translateY` is animated (via built-in `Animated.timing`, 250ms ease-out) so the currently-active word remains on the middle line. Older text scrolls off the top, newer text streams in from the bottom. Position is derived from measuring the active word's vertical offset with `onLayout` per word span.
3. **User transcript visible only during `listening` and `transcribing`.** Once phase becomes `thinking`, the user chip fades out over 300ms. This removes one of the three competing text regions while Rem replies.
4. **User chip spacing:** reduce `gap` between user chip and AI line from 6 to 2, they now read as a related unit.

### § 3 — Controls + Force-Turn-End

**Layout unchanged:** 3-button row (Cancel · Primary · Mic) centered at `bottom: 40`.

**Primary button (Pause/Play):**
- Icon crossfade via React Native's built-in `Animated` API: on state change the old icon fades out (150ms) while the new icon fades in (150ms) offset by 100ms, with a subtle rotate (`-8° → 0°`) on the incoming icon. No `react-native-reanimated` required.
- Touch ripple: an absolutely-positioned `Animated.View` at touch origin, scale `0 → 1.8`, opacity `0.35 → 0`, duration 450ms (`Animated.timing`).
- Haptic `impactLight` on press (`expo-haptics` — already installed).
- Scale `1.0 → 0.93 → 1.0` on press via `Animated.spring`.

**Mic button → "Force Turn End":**
- Enabled **only** during `speaking` or `thinking` phases. In `idle`/`listening`/`paused` it renders at opacity 0.4 with no press handler.
- On press: calls `client.cancel()` (existing `voice:cancel` message), flushes `AudioPlayerQueue.stop()`, and expects the server to transition to `listening` within ~300ms (existing server behavior).
- Haptic `impactMedium`, ripple in copper tone.
- A small label *"unterbrechen"* in 9pt Bricolage Uppercase appears below the icon when the button is enabled; hidden when disabled.

**Meta row:** Only renders when the active provider is not the default Rem voice. For the default provider, the row is omitted entirely to reduce clutter.

**Close button (top-right):** Two-tap confirmation. First tap shows a centered pill overlay *"Nochmal tippen zum Beenden"* for 2000ms. Second tap within that window calls `handleClose()`. After the window expires, the state resets. Implementation: local `useRef` timestamp + timer in `VoiceScreen.tsx`.

### § 4 — Echo-Loop Mitigation (Four Layers)

All four layers ship together. Each reduces risk independently; combined they should handle speakerphone reliably.

#### Layer 1 — Android Hardware AEC

In `VoiceScreen.tsx` `prepareToRecordAsync`, add `audioSource: 7` (`VOICE_COMMUNICATION`) to the android recording options. This enables Android's built-in `AcousticEchoCanceler`, `NoiseSuppressor`, and `AutomaticGainControl` — the same stack Google Meet and WhatsApp use for voice calls.

The target device is Samsung Galaxy Fold 7 (Android), so this is the primary platform. iOS is out of scope for Layer 1 at this time — `expo-av` does not cleanly expose `AVAudioSessionModeVoiceChat`, which is what would enable equivalent hardware AEC on iOS. If the loop is observed on iOS later, a follow-up can configure the audio session natively via a config plugin.

```ts
// mobile/src/screens/VoiceScreen.tsx (recording options)
android: {
  extension: '.wav',
  outputFormat: 3,
  audioEncoder: 1,
  audioSource: 7,      // VOICE_COMMUNICATION — enables hardware AEC/NS/AGC
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 256000,
}
```

#### Layer 2 — Mic Cooldown on `speaking → listening`

When the phase transitions into `listening`, do not start recording immediately. Wait 600ms to let:
- The final TTS sample drain from the speaker
- Room echo decay
- Hardware AEC re-calibrate against the new baseline

During the cooldown, the PhaseHint shows *"Moment…"* instead of *"Sprich jetzt"*. On expiry, the hint switches to its final copy and recording begins.

Implementation: in the `useEffect([phase, client])` that handles recorder lifecycle, replace the synchronous `if (phase === 'listening') start()` with a `setTimeout(start, 600)` path, and store the timer in a ref so `phase` changes before 600ms (e.g., rapid user cancel) abort it. The hint copy key (`listening` vs `listening-warmup`) is derived from the same local state.

#### Layer 3 — VAD Threshold + Min-Speech Sustain

Current `VoiceScreen.tsx:137` uses `s.metering > -40` as the speech trigger. Change to:

- **Threshold:** `-32 dB` (stricter — quiet echo does not cross; normal user speech is comfortably above).
- **Min sustain 150ms:** speech is only flagged (`hasSpokenRef.current = true`) when metering stays above −32dB for 150ms continuous. Isolated spikes from echo artifacts are ignored.

Implementation: a small sustain-tracker ref (`speechSustainStartRef`) that starts when metering first crosses, resets on dip, and commits `hasSpokenRef` once 150ms elapsed.

#### Layer 4 — Server-Side Post-Speak Guard

In `server/src/manager/voice.controller.ts`, record a `lastTtsChunkAt` timestamp whenever a TTS chunk is emitted. When a transcription arrives, compare against this timestamp:

- If `now - lastTtsChunkAt < 800ms`: discard the transcription, log `voice:echo_suppressed` with the discarded text (debug log only, not shown to user).
- Increment an `echoSuppressCount` on the session. If `echoSuppressCount >= 3` within a 60-second window, emit a new `voice:error` with `{ recoverable: true, message: 'Kopfhörer empfohlen — Lautsprecher verursacht Echo' }` to the client. The client already surfaces `voice:error` via the existing error banner.

The 800ms window accounts for WebSocket RTT + transcription latency — if the user *actually* spoke during that window, they almost always cross the threshold again after the guard expires.

#### Optional — AudioDevice-aware thresholds

Not in scope for v1 but called out for later: if `expo-av` later exposes audio route detection (Bluetooth/wired headset vs speaker), thresholds in Layer 3 can be loosened to −40dB / 80ms on headsets where the echo vector is absent.

## Component Changes

### New files

- `mobile/src/components/voice/PhaseHint.tsx` — phase-driven hint text (primary + secondary line) with cross-fade transitions.

### Modified files

- `mobile/src/screens/VoiceScreen.tsx`
  - Add `audioSource: 7` to android recording options.
  - Replace immediate recorder start with 600ms cooldown timer on `speaking → listening`.
  - Add VAD threshold change + 150ms sustain logic.
  - Wire the Mic button's `onPress` to `handleForceTurnEnd` (which calls `client.cancel()` + `audioQueue.stop()`); disable it when phase is not `speaking` or `thinking`.
  - Add two-tap confirmation to close button.
  - Mount `<PhaseHint />` between character and subtitle zone.
- `mobile/src/components/voice/VoiceControls.tsx`
  - Replace `onPress={() => {}}` Mic placeholder with a new `onForceTurnEnd` prop.
  - Add icon-morph (react-native-reanimated) + ripple + haptic to Primary button.
  - Add disabled state styling for Mic button with *"unterbrechen"* label.
  - Hide Meta row for default provider.
- `mobile/src/components/voice/SubtitleOverlay.tsx`
  - Add scrim underlay.
  - Wrap AI subtitle in clipped 3-line container with animated `translateY` driven by `aiSpokenWordCount`.
  - Hide user chip during `thinking` and beyond.
- `server/src/manager/voice.controller.ts`
  - Track `lastTtsChunkAt` per session.
  - Guard incoming transcriptions: discard + count echo suppressions.
  - Emit `voice:error` warning after 3 suppressions in 60s.
- `server/test/voice.controller.test.ts`
  - Add test for echo-suppression guard (transcript within 800ms of TTS chunk is discarded, after is passed through).
  - Add test for the 3-in-60s warning emission.

### Deleted files

None.

## Data Flow (changed paths only)

**Echo guard on server:**
```
TTS chunk emitted → session.lastTtsChunkAt = Date.now()
                  → forward to client

Transcription arrives → if Date.now() - session.lastTtsChunkAt < 800ms:
                           log voice:echo_suppressed
                           increment session.echoSuppressCount
                           if count >= 3 in 60s: emit voice:error (recoverable)
                           return (discard)
                        else:
                           proceed with existing flow
```

**Mic cooldown on client:**
```
onPhase('listening') → if previous phase was 'speaking':
                          show PhaseHint "Moment…"
                          setTimeout(600ms, () => {
                             start recording
                             show PhaseHint "Sprich jetzt"
                          })
                       else:
                          start recording immediately
                          show PhaseHint "Sprich jetzt"
```

## Testing

**Unit tests (mandatory):**
- `server/test/voice.controller.test.ts` — echo-guard: transcript within 800ms of TTS chunk is dropped; outside is accepted; 3-suppressions warning fires once per 60s window, not repeatedly.

**Manual QA on Samsung Galaxy Fold 7:**
- Speakerphone at high volume: start voice session, let Rem reply to a neutral question, stay silent and observe — no self-triggered turn should occur. Repeat 5×.
- With wired headphones: same test. No cooldown perception issue, VAD still responsive.
- Force-turn-end: during a long Rem reply, tap mic button. AI stops within ~300ms, recorder activates after cooldown, user speech is captured correctly.
- Pause/Play animation: visually verify icon morph, ripple, and haptic on both folded and unfolded displays.
- Phase hints: cycle through each phase, confirm primary + secondary text appears and cross-fades.
- Subtitle teleprompter: ask Rem a question that yields a 4+ sentence reply, confirm text auto-scrolls and never climbs above its zone.
- Close button: single tap shows confirmation pill; second tap within 2s closes; tap + wait 3s + tap again does not close (resets).
- User chip fade: observe that user transcript disappears when phase becomes `thinking`.

## Risks & Mitigations

- **`audioSource: 7` availability** — Expo AV's TypeScript types may not include this field. Mitigation: cast to `any` at the call site (already the pattern in the existing code via `as any`). Verify at runtime that recording still starts; fall back to default source if prepare throws.
- **Animation API choice** — spec uses React Native's built-in `Animated`. No new dependencies. If the implementer wants richer morph animations later, `react-native-reanimated` could be added, but it is not required for v1.
- **Teleprompter scroll on slow devices** — if animated `translateY` per word advance causes jank on Android, fall back to: show only the last 3 lines, hard-cut older text. Visual polish loss but functionally equivalent.
- **800ms echo window too tight/loose** — tune after manual QA. If false positives occur (real user speech discarded), reduce to 600ms. If echo still leaks through, raise to 1000ms.
- **Server-side `voice:echo_suppressed` log noise** — only log at debug level; production logs stay clean unless the error banner fires.

## Open Questions

None at spec time. All four sections approved by user during brainstorming on 2026-04-23.

## Future Work

- Audio-route awareness (Bluetooth/wired vs speaker) to dynamically tune VAD thresholds.
- Visible echo-suppression counter in developer mode for debugging.
- Optional "Push-to-Talk" mode for extremely noisy environments (press-and-hold mic button, bypasses VAD).
