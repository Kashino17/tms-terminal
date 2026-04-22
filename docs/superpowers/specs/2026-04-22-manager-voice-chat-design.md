# Manager Agent — Voice Chat Design

**Status:** Approved for Implementation
**Created:** 2026-04-22
**Target Version:** v1.19.0 (mobile + server)

## Summary

Add a voice chat mode to the Manager Agent that feels like a FaceTime call with the Manager character "Rem". User speaks via VAD-driven microphone; AI responds with F5-TTS voice synthesis. A fullscreen mobile screen plays phase-synchronized video loops of Rem (thinking, speaking, working with tools) with live subtitles. A pause/resume mechanic lets the user "hold" the AI mid-sentence with pre-recorded acknowledgment audio, then resume exactly where Rem left off.

## Key Decisions

| # | Decision | Value |
|---|---|---|
| 1 | Interaction model | Voice-Activity-Detection (VAD) — mic auto-ends turn on 800ms silence |
| 2 | Barge-in | Pause/Resume with ack+resume audio samples; AI literally pauses and resumes |
| 3 | UI surface | Dedicated fullscreen voice screen with phase-synchronized video loops and live subtitle sprechblasen |
| 4 | AI backends | All 5 providers (GLM, Kimi, Gemma 4 31B, Qwen 3 Coder 30B, Qwen 3.6 35B); video loops cover local-model latency |
| 5 | TTS voice | Reuse existing F5-TTS reference sample already configured |

## Architecture Overview

```
┌─────────────────── MOBILE (React Native) ───────────────────┐
│  VoiceScreen (Fullscreen Modal)                             │
│   ├─ VideoLoopPlayer   (idle/listening/thinking/             │
│   │                     tool_call/speaking/paused)          │
│   ├─ SubtitleOverlay   (live transcript, karaoke-sync)      │
│   ├─ VadRecorder       (expo-av + dB silence detection)     │
│   ├─ AudioPlayer       (expo-av queue, pausable+resumable)  │
│   └─ VoiceClient       (WS messages, phase subscription)    │
└────────────────────────────┬────────────────────────────────┘
                             │ WebSocket (ws:// via Tailscale)
┌────────────────────────────▼────────────────────────────────┐
│  SERVER (Node.js)                                           │
│   ws.handler.ts                                             │
│    └─ VoiceSessionController  (NEW)                         │
│         ├─ state: idle|listening|thinking|speaking|paused   │
│         ├─ turnBuffer   (accumulated text per AI turn)      │
│         ├─ ttsQueue     (sentence-chunks, pausable)         │
│         ├─ resumeCursor (text offset at pause point)        │
│         ↓ uses existing:                                    │
│    ├─ WhisperSidecar         (transcribe user audio)        │
│    ├─ AiProviderRegistry     (stream LLM response)          │
│    └─ F5TtsSidecar           (synthesize AI voice)          │
└─────────────────────────────────────────────────────────────┘
```

**Core principles:**

- **Single source of truth:** `VoiceSessionController` holds complete turn state. Mobile mirrors only.
- **Phase-driven video:** Server emits `voice:phase` on every state change → mobile swaps video loops. Videos stay synchronized with backend activity.
- **Chunk-based pause/resume:** The controller splits the LLM's text response into sentences (at `.`, `!`, `?` boundaries) and invokes F5-TTS one sentence at a time, queuing each resulting audio buffer. Pause happens between sentences → clean cuts, unambiguous resume point.
- **No stream duplication:** Reuses existing WebSocket transport. No WebRTC or additional channels.
- **Component recycling:** `WhisperSidecar`, `F5TtsSidecar`, `AiProviderRegistry` unchanged.

## Components

### Server

#### `VoiceSessionController` — new (`server/src/manager/voice.controller.ts`)

Finite state machine with states: `idle`, `listening`, `transcribing`, `thinking`, `tool_call`, `speaking`, `paused`.

**Public API:**
```typescript
class VoiceSessionController {
  start(sessionId: string): void
  ingestAudio(chunk: Buffer): void
  endUserTurn(): Promise<void>        // after mobile VAD silence detection
  pause(): void                        // emit ack audio, freeze queue
  resume(): Promise<void>              // emit resume audio, continue queue
  cancel(): void                       // abort current turn
  stop(): void                         // close session entirely
}
```

**Data structures:**
- `turnText: string` — full generated AI response so far
- `ttsQueue: TtsChunk[]` — `{ sentenceIdx, text, audioBase64, sent }`
- `resumeCursor: number` — index of last fully-sent chunk
- `phase: Phase` — emitted via `voice:phase`
- `pauseState?: { resumeCursor, remainingText, interjection?, pausedAt }` — set when paused

### Mobile

#### `VoiceScreen` — new (`mobile/src/screens/VoiceScreen.tsx`)

Fullscreen modal. Statusbar hidden. Orchestrates children. Holds local voice state mirrored from server. Portrait + Landscape support.

#### `VideoLoopPlayer` — new (`mobile/src/components/voice/VideoLoopPlayer.tsx`)

Takes `phase` as prop → plays matching video from server. Looping via `expo-av` Video component with `isLooping={true}`. Crossfade between phases (300ms).

#### `SubtitleOverlay` — new (`mobile/src/components/voice/SubtitleOverlay.tsx`)

Bottom-third sprechblase style. 2-3 lines visible, older lines fade out. Font size scales with screen width (optimized for Samsung Galaxy Fold 7 inner display). Karaoke word-highlight during TTS playback is a V1.1 enhancement; V1 does sentence-level highlight matching TTS chunk boundaries.

#### `VadRecorder` — new (Mobile utility hook)

Continuous recording via `expo-av`. Emits audio chunks every 200ms. Computes dB level per chunk. Default silence threshold: 800ms below -40dB triggers `onSilenceDetected`.

#### `AudioPlayer` — new (thin wrapper around `expo-av`)

Queue-based. Places incoming `voice:tts_chunk` into queue, plays sequentially. `pause()` stops after current chunk. `resume()` plays next chunk. Tracks `currentChunkIdx` for server coordination.

#### `VoiceClient` — new (WS wrapper)

Thin layer over existing `wsService`. Exposes `startVoiceSession()`, `sendAudioChunk()`, `requestPause()`, `requestResume()`, `cancelTurn()`, `stopSession()`.

### Existing components — unchanged

- `WhisperSidecar` (reused as-is)
- `F5TtsSidecar` (reused as-is; already configured with reference voice)
- `AiProviderRegistry` (reused as-is)
- `ManagerService` — chat history integration uses existing `addMessage` path

## Data Flow & WebSocket Protocol

### New messages (client → server)

```typescript
'voice:start'        { }
'voice:audio_chunk'  { audio: string /* base64 PCM */ }
'voice:end_turn'     { }
'voice:pause'        { }
'voice:resume'       { strategy?: 'clean' | 'with_interjection' }
'voice:cancel'       { }
'voice:stop'         { }
```

### New messages (server → client)

```typescript
'voice:phase'        { phase: 'idle'|'listening'|'transcribing'|'thinking'|'tool_call'|'speaking'|'paused' }
'voice:transcript'   { text: string, final: boolean }
'voice:ai_delta'     { text: string }
'voice:tts_chunk'    { chunkIdx: number, audio: string, sentence: string, isLast: boolean }
'voice:ack_audio'    { kind: 'pause'|'resume', audio: string }
'voice:error'        { message: string, recoverable: boolean }
```

### Turn sequence

```
USER taps "Start Voice"
  Mobile ─ voice:start ──────────→ Server
  Mobile ←─ voice:phase {listening}

USER speaks
  Mobile ─ voice:audio_chunk ────→ Server  (repeating, 200ms cadence)
  Mobile (VAD) detects 800ms silence
  Mobile ─ voice:end_turn ───────→ Server
  Mobile ←─ voice:phase {transcribing}

Server: Whisper
  Mobile ←─ voice:transcript {final:true}
  Mobile ←─ voice:phase {thinking}

Server: LLM streaming
  Mobile ←─ voice:ai_delta (repeating)                ← live subtitles
  Mobile ←─ voice:phase {tool_call}  (if tool call)
  Mobile ←─ voice:phase {thinking}   (after tool)

Server: F5-TTS sentence-by-sentence
  Mobile ←─ voice:phase {speaking}
  Mobile ←─ voice:tts_chunk {chunkIdx:0,...}
  Mobile ←─ voice:tts_chunk {chunkIdx:1,...}          ← AudioPlayer plays queue
  Mobile ←─ voice:tts_chunk {chunkIdx:N, isLast:true}
  Mobile ←─ voice:phase {listening}                   ← ready for next turn
```

### Pause/Resume flow

```
AI speaking (chunk 3 of 8 playing)
USER taps Pause
  Mobile: AudioPlayer.pause() immediately, remember currentChunkIdx=3
  Mobile ─ voice:pause ──────────→ Server
  Server: state → paused, resumeCursor=3
  Mobile ←─ voice:ack_audio {kind:pause, audio:...}
  Mobile: plays ack ("Okay, ich höre zu…")
  Mobile ←─ voice:phase {paused}
  Video loop switches to paused.mp4

[User pauses for whatever reason; mic stays open listening]

USER taps Weiter
  Mobile ─ voice:resume ─────────→ Server
  Mobile ←─ voice:ack_audio {kind:resume, audio:...}
  Mobile: plays resume ("Ah, wo war ich…")
  Mobile ←─ voice:phase {speaking}
  Mobile ←─ voice:tts_chunk {chunkIdx:3,...}          ← resumes from cursor
  Mobile ←─ voice:tts_chunk {chunkIdx:4,...}
  ... until isLast:true
```

### Chat history integration

- `voice:transcript {final:true}` → added to `ManagerMemory` as user message (same shape as typed message)
- Accumulated `voice:ai_delta` → added as assistant message at turn end
- User can switch to text-chat screen and see voice turns in the history

## Pause/Resume Mechanics

### Technical meaning of "pause"

**Not** "abort TTS stream and regenerate later."
**Rather** "freeze the pre-generated audio queue and resume it."

F5-TTS stops synthesizing further chunks after `voice:pause` arrives. Server holds state. On resume: generation continues from where it stopped.

```
Normal:   generate chunk 0 → send 0 → generate 1 → send 1 → ...
Paused at chunk 3:
          generate 0,1,2 → send 0,1,2,3 → PAUSE →
          server stops further generation → holds cursor at 3
          → resume → continues generating 4,5,6... → sends 4,5,6...
```

### Standard ack audios

Pre-generated once on first server start, cached:

```
~/.tms-terminal/voice-samples/
  ├─ pause-ack-1.wav   "Okay, ich höre zu."
  ├─ pause-ack-2.wav   "Moment, kurz warte."
  ├─ pause-ack-3.wav   "Mm-hmm, was gibt's?"
  ├─ resume-ack-1.wav  "Ah, wo war ich stehen geblieben..."
  ├─ resume-ack-2.wav  "Also, wie gesagt..."
  └─ resume-ack-3.wav  "Genau, weiter im Text."
```

Generated via F5-TTS at server start if files absent. Random pick from 3 variants per kind to avoid robotic repetition.

### Pause-listening behavior

During pause, mic stays open. Three sub-behaviors on Resume:

**(a) User said nothing:** Resume audio → AI finishes prior sentence. Clean.

**(b) User said something short** (<20 chars, no question mark): Discarded. Resume normally.

**(c) User said something substantive:** Transcript shown as floating sprechblase above. Weiter button shows two options:
- **"▶ Weiter wie zuvor"** → ignore user input, clean resume
- **"➜ Mit Einwand fortsetzen"** → send user input + "(AI war bei: ...)" + "Bitte fortsetzen mit Berücksichtigung meines Einwands" to LLM. Regenerates new continuation from pause point.

### Edge cases

| Case | Behavior |
|---|---|
| Pause during `thinking` (LLM running) | Cancel current LLM stream. Nothing to pause before AI said anything. UI shows pause button as "Cancel current turn". |
| Pause during `tool_call` | Let tool finish (avoid inconsistent state), then pause. Pause button greyed ~500ms. |
| App closed during pause | Session stays alive 5 min. Resume on reconnect. After 5 min: cancel, save partial to history. |
| Weiter tapped during ack-audio playback | Ack audio interrupted; resume audio plays immediately (or queue both — implementation may pick cleaner variant). |
| F5-TTS crash during speaking | `voice:error {recoverable:true}`, mobile shows overlay + retry. Session state preserved; resume possible. |

### Server-side pause state

```typescript
interface PauseState {
  resumeCursor: number;     // chunk index to resume from
  remainingText: string;    // unspoken AI text
  interjection?: string;    // user input during pause (sub-behavior c)
  pausedAt: number;         // timestamp for auto-timeout
}
```

**Auto-timeout:** 5 minutes paused → server cancels session, emits `voice:phase {idle}`.

## Video Loops & Subtitles

### Asset pipeline

Videos hosted server-side, streamed to mobile via HTTP (not bundled in APK).

```
~/.tms-terminal/voice-videos/
  ├─ idle.mp4
  ├─ listening.mp4
  ├─ thinking.mp4
  ├─ tool_call.mp4
  ├─ speaking.mp4
  └─ paused.mp4
```

**Why server-hosted:**
- APK stays lean (videos can be 10-50MB each)
- User can swap videos without app release
- Tailscale encrypts stream
- Matches architectural pattern (server = source of truth)

**New HTTP endpoint:** `GET /voice-videos/:name.mp4` with `Cache-Control: max-age=86400`.

**Format:** MP4 H.264, 720p, 15-25s loops, target 5-10MB per file.

### Phase → video mapping

| Server phase | Video |
|---|---|
| `idle` | `idle.mp4` |
| `listening` | `listening.mp4` |
| `transcribing` | `thinking.mp4` |
| `thinking` | `thinking.mp4` |
| `tool_call` | `tool_call.mp4` |
| `speaking` | `speaking.mp4` |
| `paused` | `paused.mp4` |

### Transitions

**Crossfade 300ms** between videos via two stacked video layers (upper opacity 1 → 0 over 300ms).

**Phase hysteresis:** minimum 600ms in any phase before next switch, to avoid flicker. Exception: `paused` is immediate (user action, flicker is acceptable).

### Subtitles

Bottom-third sprechblase, FaceTime/Netflix-style (not AR bubbles).

```
┌─────────────────────────────────┐
│                                 │
│       [VIDEO FULLSCREEN]        │
│                                 │
│  ┌───────────────────────────┐  │
│  │  Ich habe deinen Fehler   │  │
│  │  gefunden in Zeile 42...  │  │
│  └───────────────────────────┘  │
│  ●●●  [Pause]  [Cancel]         │
└─────────────────────────────────┘
```

- User turn: shows `voice:transcript {final:false}` as live Whisper partials. Right-aligned, different color.
- AI turn: shows accumulated `voice:ai_delta`. Sentence-level highlight syncs with TTS chunk boundaries. Left-aligned, Rem's color.
- Max 3 lines visible. Smooth scroll upward. Old lines fade out over 500ms.

### Loading state

On first Voice-Screen open: mobile fetches all 6 videos in parallel, caches in `expo-file-system`. Loading overlay ("Rem bereitet sich vor…") for 5-10s over Tailscale. Subsequent opens are instant (cache hit). Cache invalidation via ETag.

## Error Handling & Resilience

| Error | Location | Strategy | UX |
|---|---|---|---|
| WebSocket lost during speaking | Mobile | Play remaining queue, then banner | Reconnect button |
| Whisper sidecar crash | Server | `voice:error {recoverable:true}`, restart sidecar | "Konnte nicht transkribieren, nochmal sprechen" |
| F5-TTS crash mid-speaking | Server | State preserved, queue played, retry offered | "Stimme unterbrochen, tippe zum Fortfahren" |
| LLM timeout (30min hard cap) | Server | Cancel turn, save partial to history | "Antwort zu lang, probier's nochmal" |
| Mic permission denied | Mobile | Catch VadRecorder init error | Prominent "Mic-Zugriff erlauben" overlay with Settings link |
| Video asset fails to load | Mobile | Fallback to static avatar image | Silent |
| VAD false-trigger (noise) | Mobile | `voice:cancel` before Whisper, back to listening | Silent |
| App backgrounded | Mobile | Auto-send `voice:pause` | On return: resume dialog |
| Provider switch mid-turn | Server | Block `setProvider` during thinking/speaking, queue | Provider badge shows "Wechsel nach aktuellem Turn" |
| Server dies | Mobile | WebSocket close → modal with retry + exit | "Server offline" |

### Recoverable vs. fatal

**Recoverable** (session survives):
- Whisper fail (audio lost, session intact)
- TTS chunk fail (skip, continue)
- Network glitch < 5s (mobile queues, server buffers)

**Fatal** (session ends):
- Server crash
- Provider 401/403
- Disk full
- 3 consecutive retries fail

### Logging

Via existing `logger`:
```
voice: session started (id=abc, provider=gemma-4)
voice: user turn 1 (audio 3.2s, transcript "Hallo Rem")
voice: LLM 2341ms, 842 tokens
voice: TTS 7 chunks in 5.1s
voice: paused at chunk 3 (elapsed 1m 23s)
voice: resumed from chunk 3 (paused for 14s)
voice: turn ended (total 18.4s)
```

### Cleanup guarantees

Always clean up on:
- `voice:stop`
- WebSocket close
- App background > 5 min
- Phase `idle` > 5 min without interaction
- Server shutdown (graceful: cancel + save partial history)

No file leaks, no zombie subprocesses — via `try/finally` + dispose pattern matching existing sidecars.

### Rate limiting

- 1 voice session per client at a time
- New `voice:start` during active session → reject OR force-stop old (implementation decides based on UX testing)
- Max audio chunk size: 100KB
- Max user-speaking turn duration: 5 min (then force `end_turn`)

## Testing Strategy

### Unit tests

**Server:**
- `voice.controller.test.ts` — state transitions with mocked sidecars
- `tts-chunk-queue.test.ts` — pause/resume cursor logic, empty queue, out-of-order
- `ack-audio.test.ts` — random variant pick, cache generation

**Mobile:**
- `VadRecorder.test.ts` — silence detection at varying dB with mock audio
- `AudioPlayer.test.ts` — queue, pause/resume position, chunk gaps
- `SubtitleOverlay.test.tsx` — highlight sync, overflow scroll, fade
- `VoiceClient.test.ts` — WS message serialization, reconnect

### Integration tests

Server e2e with real sidecars:
- `voice.e2e.test.ts` — full turn: fake mic → Whisper → GLM → F5-TTS → assert chunks
- Pause/Resume scenario — turn starts, pause at chunk 3, assert state, resume, assert rest

Runtime slow (~30s each) → separate `npm run test:e2e`, not default.

### Manual test checklist (pre-release)

**Basic:**
- [ ] Voice start → mic works, VAD triggers on silence
- [ ] Whisper transcribes German correctly
- [ ] F5-TTS plays clear audio
- [ ] Subtitles sync with TTS
- [ ] Video loops change on phase change

**Pause/Resume:**
- [ ] Pause mid-speaking → ack audio, AI stops
- [ ] Weiter → resume audio, AI finishes prior sentence
- [ ] Pause → user says short → Weiter → ignored
- [ ] Pause → user says substantive → Weiter shows 2 options
- [ ] Pause > 5 min → auto-timeout

**Resilience:**
- [ ] WiFi off during speaking → queue plays, banner, reconnect
- [ ] App to background → auto-pause, return → resume dialog
- [ ] Mic permission denied → correct error overlay
- [ ] Second session attempt → reject or replace

**Provider matrix:**
- [ ] Voice with GLM
- [ ] Voice with Kimi
- [ ] Voice with Gemma 4 31B
- [ ] Voice with Qwen 3 Coder 30B
- [ ] Voice with Qwen 3.6 35B
- [ ] Provider switch during idle works
- [ ] Provider switch during thinking blocked

**UX feel (subjective):**
- [ ] Feels like FaceTime, not voice memo
- [ ] Video loops feel natural, not choppy
- [ ] Ack audios feel organic, not robotic
- [ ] Local-model latency tolerable thanks to thinking video

### Out of scope for V1

- Multi-tenant voice sessions (single user)
- 3G/LTE quality profile (WiFi/Tailscale assumption)
- Internationalization (DE only)
- Screen reader support (voice is itself accessibility)

## Implementation Scope

### New files

Server:
- `server/src/manager/voice.controller.ts`
- `server/src/manager/voice.types.ts` (shared types)

Mobile:
- `mobile/src/screens/VoiceScreen.tsx`
- `mobile/src/components/voice/VideoLoopPlayer.tsx`
- `mobile/src/components/voice/SubtitleOverlay.tsx`
- `mobile/src/components/voice/VoiceControls.tsx`
- `mobile/src/hooks/useVadRecorder.ts`
- `mobile/src/services/AudioPlayer.ts`
- `mobile/src/services/VoiceClient.ts`
- `mobile/src/store/voiceStore.ts` (Zustand, mirrors server state)

Shared:
- `shared/protocol.ts` — add 13 new message types

### Modified files

Server:
- `server/src/websocket/ws.handler.ts` — route new `voice:*` messages to controller
- `server/src/index.ts` — serve `/voice-videos/:name.mp4` static endpoint; generate ack audios on startup
- `server/src/audio/tts-sidecar.ts` — extend existing chunked-progress API to emit per-chunk audio (currently emits only progress counts; VoiceSessionController needs actual audio buffers per chunk)

Mobile:
- `mobile/src/screens/ManagerChatScreen.tsx` — add "🎙️ Voice" button in header
- `mobile/App.tsx` — register VoiceScreen modal route

### Out of scope for this spec

- Actual video recording/editing — user creates assets themselves
- TTS voice training/cloning — reuse existing configured reference
- Multilingual support beyond German

## Success Criteria

1. User can start voice session via button in ManagerChatScreen header
2. User speaks, AI transcribes, responds, speaks back — end to end
3. Pause/resume works reliably with ack audios
4. Video loops visibly switch on phase change
5. Subtitles stay in sync with TTS audio
6. Session survives backgrounding + network blip
7. Works with all 5 registered providers
8. No regressions in text-chat mode
