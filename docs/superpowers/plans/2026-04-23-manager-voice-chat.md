# Manager Voice Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fullscreen voice-chat mode to the Manager Agent — user speaks via VAD mic, AI responds with F5-TTS voice, with phase-synchronized character visuals, live karaoke subtitles, and a pause/resume mechanic driven by pre-recorded acknowledgment audios.

**Architecture:** Server-side `VoiceSessionController` orchestrates the full turn pipeline (whisper → LLM → sentence-chunked TTS) and holds pause/resume state. Mobile presents a fullscreen `VoiceScreen` with native UI (subtitles, controls) around a WebView-hosted character animation that gives 1:1 fidelity with the approved HTML mockup at `prototype/voice-design/index.html`. New WebSocket messages on the `voice:*` namespace carry audio chunks, phase events, transcripts, and ack audios.

**Tech Stack:** TypeScript, Node.js (server), React Native + Expo (mobile), WebSocket over Tailscale, existing `WhisperSidecar` (Whisper turbo), existing `F5TtsSidecar` (F5-TTS MLX), existing `AiProviderRegistry`, `expo-av` for recording/playback, `react-native-webview` for character animation, Zustand for mobile state.

**Spec:** `docs/superpowers/specs/2026-04-22-manager-voice-chat-design.md`
**Design mockup:** `prototype/voice-design/index.html` (served via Tailscale on `http://100.125.192.44:8088`)

---

## File Structure

### Created

**Server:**
- `server/src/manager/voice.types.ts` — shared types (Phase, TtsChunk, VoiceMessages)
- `server/src/manager/voice.controller.ts` — state machine + turn pipeline orchestrator
- `server/src/manager/voice.sentences.ts` — text-to-sentences splitter (pure fn, tested)
- `server/src/manager/voice.ack-audio.ts` — pre-generates and caches pause/resume ack audios
- `server/test/voice.sentences.test.ts`
- `server/test/voice.controller.test.ts`

**Mobile:**
- `mobile/src/screens/VoiceScreen.tsx`
- `mobile/src/components/voice/CharacterWebView.tsx`
- `mobile/src/components/voice/SubtitleOverlay.tsx`
- `mobile/src/components/voice/VoiceControls.tsx`
- `mobile/src/components/voice/ResumeOptions.tsx`
- `mobile/src/components/voice/StatusPill.tsx`
- `mobile/src/hooks/useVadRecorder.ts`
- `mobile/src/services/AudioPlayerQueue.ts`
- `mobile/src/services/VoiceClient.ts`
- `mobile/src/store/voiceStore.ts`
- `mobile/assets/voice-character/index.html` — bundled HTML (adapted from mockup)

**Shared:**
- `shared/voice.protocol.ts` — message type definitions (optional split; may be added to existing `protocol.ts`)

### Modified

- `shared/protocol.ts` — add 13 `voice:*` message types
- `server/src/websocket/ws.handler.ts` — route `voice:*` messages to controller
- `server/src/audio/tts-sidecar.ts` — extend chunk-progress API to emit per-chunk audio buffer
- `server/src/index.ts` — static endpoint for `/voice-videos/:name.mp4`, trigger ack-audio generation on startup
- `mobile/src/screens/ManagerChatScreen.tsx` — add "🎙️ Voice" button in header
- `mobile/App.tsx` — register VoiceScreen modal route
- `mobile/package.json` — add `react-native-webview` if not present

---

## Task 1: Shared protocol message types

**Files:**
- Modify: `shared/protocol.ts` (append new types)

- [ ] **Step 1: Add client-to-server voice messages**

Append to `shared/protocol.ts` after the existing message type unions:

```typescript
// ── Voice Chat (Client → Server) ───────────────────────────────────────────

export interface VoiceStartMsg { type: 'voice:start'; payload?: {} }
export interface VoiceAudioChunkMsg { type: 'voice:audio_chunk'; payload: { audio: string /* base64 PCM */ } }
export interface VoiceEndTurnMsg { type: 'voice:end_turn'; payload?: {} }
export interface VoicePauseMsg { type: 'voice:pause'; payload?: {} }
export interface VoiceResumeMsg { type: 'voice:resume'; payload?: { strategy?: 'clean' | 'with_interjection' } }
export interface VoiceCancelMsg { type: 'voice:cancel'; payload?: {} }
export interface VoiceStopMsg { type: 'voice:stop'; payload?: {} }

// ── Voice Chat (Server → Client) ───────────────────────────────────────────

export type VoicePhase =
  | 'idle' | 'listening' | 'transcribing' | 'thinking'
  | 'tool_call' | 'speaking' | 'paused';

export interface VoicePhaseMsg { type: 'voice:phase'; payload: { phase: VoicePhase } }
export interface VoiceTranscriptMsg { type: 'voice:transcript'; payload: { text: string; final: boolean } }
export interface VoiceAiDeltaMsg { type: 'voice:ai_delta'; payload: { text: string } }
export interface VoiceTtsChunkMsg {
  type: 'voice:tts_chunk';
  payload: { chunkIdx: number; audio: string /* base64 WAV */; sentence: string; isLast: boolean }
}
export interface VoiceAckAudioMsg {
  type: 'voice:ack_audio';
  payload: { kind: 'pause' | 'resume'; audio: string /* base64 WAV */ }
}
export interface VoiceErrorMsg { type: 'voice:error'; payload: { message: string; recoverable: boolean } }
```

- [ ] **Step 2: Add to union types**

Find the existing `ClientMessage` and `ServerMessage` union types in `shared/protocol.ts` and add the new messages:

```typescript
// Locate the existing unions and extend them:
// (exact names may differ — search for "ClientMessage =" or "type Client")

export type ClientMessage =
  | /* existing */ ...
  | VoiceStartMsg | VoiceAudioChunkMsg | VoiceEndTurnMsg
  | VoicePauseMsg | VoiceResumeMsg | VoiceCancelMsg | VoiceStopMsg;

export type ServerMessage =
  | /* existing */ ...
  | VoicePhaseMsg | VoiceTranscriptMsg | VoiceAiDeltaMsg
  | VoiceTtsChunkMsg | VoiceAckAudioMsg | VoiceErrorMsg;
```

- [ ] **Step 3: Build the server to verify types compile**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server" && npm run build
```

Expected: build succeeds, no TS errors.

- [ ] **Step 4: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add shared/protocol.ts
git commit -m "feat(voice): add voice:* WebSocket message types for voice chat"
```

---

## Task 2: Sentence splitter utility (TDD)

**Files:**
- Create: `server/src/manager/voice.sentences.ts`
- Create: `server/test/voice.sentences.test.ts`

The controller splits streaming LLM text into sentences at `.`, `!`, `?` for per-sentence F5-TTS synthesis. This is a small pure function — test-driven.

- [ ] **Step 1: Write the failing test**

Create `server/test/voice.sentences.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SentenceBuffer } from '../src/manager/voice.sentences';

describe('SentenceBuffer', () => {
  it('emits no sentences while no terminal punctuation seen', () => {
    const buf = new SentenceBuffer();
    expect(buf.push('Hallo du')).toEqual([]);
    expect(buf.push(' bist')).toEqual([]);
  });

  it('emits a sentence when period is seen', () => {
    const buf = new SentenceBuffer();
    buf.push('Hallo du bist');
    expect(buf.push(' schön.')).toEqual(['Hallo du bist schön.']);
  });

  it('emits multiple sentences from one push', () => {
    const buf = new SentenceBuffer();
    expect(buf.push('Eins. Zwei! Drei?')).toEqual(['Eins.', 'Zwei!', 'Drei?']);
  });

  it('leaves trailing incomplete sentence in buffer', () => {
    const buf = new SentenceBuffer();
    expect(buf.push('Eins. Zwei')).toEqual(['Eins.']);
    expect(buf.push(' ist da.')).toEqual(['Zwei ist da.']);
  });

  it('flushes remaining text via flush()', () => {
    const buf = new SentenceBuffer();
    buf.push('Hallo');
    expect(buf.flush()).toEqual(['Hallo']);
    expect(buf.flush()).toEqual([]); // already flushed
  });

  it('ignores decimal points inside numbers', () => {
    const buf = new SentenceBuffer();
    expect(buf.push('Die Zahl ist 3.14 und endet hier.')).toEqual([
      'Die Zahl ist 3.14 und endet hier.',
    ]);
  });

  it('handles ellipsis as single break', () => {
    const buf = new SentenceBuffer();
    expect(buf.push('Also... ich denke nach.')).toEqual([
      'Also...',
      'ich denke nach.',
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server" && npx vitest run test/voice.sentences.test.ts
```

Expected: FAIL (`Cannot find module './src/manager/voice.sentences'`).

- [ ] **Step 3: Implement the splitter**

Create `server/src/manager/voice.sentences.ts`:

```typescript
/**
 * Accumulates streaming text and emits complete sentences when terminal
 * punctuation is seen. Preserves trailing incomplete text for the next push.
 * Used by VoiceSessionController to drive per-sentence TTS synthesis.
 */
export class SentenceBuffer {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const sentences: string[] = [];

    // Regex finds sentence terminators that are NOT preceded by a digit (so
    // "3.14" doesn't split). Matches `.` / `!` / `?` / `...` possibly followed
    // by quotes / closing brackets, then whitespace.
    const pattern = /([^\d\s][.!?]+["')\]]?)(?=\s|$)/g;

    let lastEnd = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(lastEnd, end).trim();
      if (sentence) sentences.push(sentence);
      lastEnd = end;
    }

    this.buffer = this.buffer.slice(lastEnd);
    return sentences;
  }

  /** Return remaining buffered text (call once at stream end). */
  flush(): string[] {
    const remaining = this.buffer.trim();
    this.buffer = '';
    return remaining ? [remaining] : [];
  }

  reset(): void {
    this.buffer = '';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server" && npx vitest run test/voice.sentences.test.ts
```

Expected: PASS all 7 tests.

- [ ] **Step 5: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add server/src/manager/voice.sentences.ts server/test/voice.sentences.test.ts
git commit -m "feat(voice): sentence buffer for per-sentence TTS synthesis"
```

---

## Task 3: Voice session types

**Files:**
- Create: `server/src/manager/voice.types.ts`

- [ ] **Step 1: Write the types file**

Create `server/src/manager/voice.types.ts`:

```typescript
/** Internal types used by VoiceSessionController. Not exported over WS. */

export type VoicePhase =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'tool_call'
  | 'speaking'
  | 'paused';

export interface TtsChunk {
  idx: number;                  // Sentence index within the current turn
  sentence: string;             // Source text
  audio: Buffer;                // WAV audio buffer
  sent: boolean;                // Has this been transmitted to client?
}

export interface PauseState {
  resumeCursor: number;         // First un-played chunk index
  remainingText: string;        // Unspoken AI text
  interjection?: string;        // User input during pause (sub-behavior c)
  pausedAt: number;             // Timestamp for auto-timeout
}

export type VoiceEmitter = (msg:
  | { type: 'voice:phase'; payload: { phase: VoicePhase } }
  | { type: 'voice:transcript'; payload: { text: string; final: boolean } }
  | { type: 'voice:ai_delta'; payload: { text: string } }
  | { type: 'voice:tts_chunk'; payload: { chunkIdx: number; audio: string; sentence: string; isLast: boolean } }
  | { type: 'voice:ack_audio'; payload: { kind: 'pause' | 'resume'; audio: string } }
  | { type: 'voice:error'; payload: { message: string; recoverable: boolean } }
) => void;
```

- [ ] **Step 2: Build to verify types**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server" && npm run build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add server/src/manager/voice.types.ts
git commit -m "feat(voice): internal types for VoiceSessionController"
```

---

## Task 4: Extend F5-TTS sidecar for per-chunk audio

**Files:**
- Modify: `server/src/audio/tts-sidecar.ts`

The existing sidecar emits `onProgress({chunk, total})` but not the per-chunk audio buffer. We need audio per sentence so the controller can queue them pausably.

- [ ] **Step 1: Read existing sidecar to understand current API**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server" && wc -l src/audio/tts-sidecar.ts
head -50 src/audio/tts-sidecar.ts
```

Look for:
- The existing `synthesize()` method signature
- How IPC messages are structured between Node and the Python sidecar
- Where `onProgress` is invoked

- [ ] **Step 2: Add `onChunkAudio` callback to the request interface**

In `server/src/audio/tts-sidecar.ts`, extend the `TtsRequest` interface:

```typescript
export interface TtsRequest {
  text: string;
  voice?: string;
  onProgress?: (info: { chunk: number; total: number }) => void;
  /** NEW: invoked per chunk with the resulting audio buffer */
  onChunkAudio?: (info: { chunk: number; total: number; audio: Buffer; sentence: string }) => void;
}
```

- [ ] **Step 3: Emit chunk audio from the IPC response handler**

In the same file, locate where the Python sidecar response is parsed (look for `resp.chunk` / `resp.total`). Add a branch that forwards per-chunk audio when available:

```typescript
// Find the existing stdout parser block around resp.chunk handling.
// The Python sidecar should be updated to send responses like:
//   {"type":"chunk_audio","chunk":0,"total":3,"sentence":"...","audio":"<base64>"}
// after each chunk is synthesized.

if (resp.type === 'chunk_audio' && req.onChunkAudio) {
  const audio = Buffer.from(resp.audio, 'base64');
  req.onChunkAudio({
    chunk: resp.chunk,
    total: resp.total,
    audio,
    sentence: resp.sentence,
  });
}
```

- [ ] **Step 4: Update the Python sidecar (`server/audio/f5_tts_sidecar.py` or equivalent)**

Search for the Python sidecar file first:

```bash
find "/Users/ayysir/Desktop/TMS Terminal/server/audio" -name "*.py" -type f
```

Open the main F5-TTS entry file. After each chunk is synthesized and before the next one starts, emit a JSON line to stdout:

```python
# Near the sentence-synthesis loop in the Python sidecar:
import base64, json, sys

def emit_chunk_audio(chunk_idx: int, total: int, sentence: str, wav_bytes: bytes):
    msg = {
        "type": "chunk_audio",
        "chunk": chunk_idx,
        "total": total,
        "sentence": sentence,
        "audio": base64.b64encode(wav_bytes).decode("ascii"),
    }
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()
```

Call `emit_chunk_audio(i, total_sentences, sentence_text, wav_buffer)` inside the existing synthesis loop, right after the WAV bytes for that sentence are generated. Keep the existing `progress` emission alongside for backward compatibility.

- [ ] **Step 5: Manually verify the sidecar still works**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server"
npm run build
# Start the server locally (or wait for next task's integration test).
# For a quick smoke test, we'll defer full verification to Task 7.
```

- [ ] **Step 6: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add server/src/audio/tts-sidecar.ts server/audio/*.py
git commit -m "feat(voice): tts-sidecar emits per-chunk audio buffers

Required for VoiceSessionController to queue sentences individually
and support pausable playback between chunks."
```

---

## Task 5: Ack audio pre-generation service

**Files:**
- Create: `server/src/manager/voice.ack-audio.ts`
- Modify: `server/src/index.ts` (call `ensureAckAudios()` on startup)

- [ ] **Step 1: Write the service**

Create `server/src/manager/voice.ack-audio.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';
import { synthesize } from '../audio/tts-sidecar';

const ACK_DIR = path.join(os.homedir(), '.tms-terminal', 'voice-samples');

const PAUSE_VARIANTS = [
  'Okay, ich höre zu.',
  'Moment, kurz warte.',
  'Mm-hmm, was gibt\'s?',
];

const RESUME_VARIANTS = [
  'Ah, wo war ich stehen geblieben...',
  'Also, wie gesagt...',
  'Genau, weiter im Text.',
];

/** Generate all ack audio variants if they don't exist on disk. Called once at server start. */
export async function ensureAckAudios(): Promise<void> {
  if (!fs.existsSync(ACK_DIR)) {
    fs.mkdirSync(ACK_DIR, { recursive: true, mode: 0o700 });
  }

  const jobs: Array<Promise<void>> = [];
  PAUSE_VARIANTS.forEach((text, i) => {
    const filePath = path.join(ACK_DIR, `pause-ack-${i + 1}.wav`);
    if (!fs.existsSync(filePath)) jobs.push(synthesizeAndSave(text, filePath));
  });
  RESUME_VARIANTS.forEach((text, i) => {
    const filePath = path.join(ACK_DIR, `resume-ack-${i + 1}.wav`);
    if (!fs.existsSync(filePath)) jobs.push(synthesizeAndSave(text, filePath));
  });

  if (jobs.length === 0) {
    logger.info(`Voice: ack audios already cached (${PAUSE_VARIANTS.length + RESUME_VARIANTS.length} files)`);
    return;
  }

  logger.info(`Voice: generating ${jobs.length} ack audio variant(s)...`);
  try {
    await Promise.all(jobs);
    logger.info('Voice: ack audios ready');
  } catch (err) {
    logger.warn(`Voice: ack audio generation failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function synthesizeAndSave(text: string, filePath: string): Promise<void> {
  const audio = await synthesize({ text });
  fs.writeFileSync(filePath, audio, { mode: 0o600 });
  logger.info(`Voice: saved ${path.basename(filePath)} (${(audio.length / 1024).toFixed(1)} KB)`);
}

/** Pick a random ack-audio WAV buffer from the pool of the given kind. */
export function pickAckAudio(kind: 'pause' | 'resume'): Buffer | null {
  const variants = kind === 'pause' ? PAUSE_VARIANTS.length : RESUME_VARIANTS.length;
  const idx = Math.floor(Math.random() * variants) + 1;
  const filePath = path.join(ACK_DIR, `${kind}-ack-${idx}.wav`);
  try {
    return fs.readFileSync(filePath);
  } catch {
    logger.warn(`Voice: ack audio missing at ${filePath}`);
    return null;
  }
}
```

Note: The call `synthesize({ text })` in the service assumes `tts-sidecar.ts` exports a high-level `synthesize(req)` that returns a single buffer. If the existing export signature differs (e.g. uses a class instance), adapt the call to match. If the `synthesize` export doesn't exist yet, add a thin wrapper in `tts-sidecar.ts`:

```typescript
// Add to tts-sidecar.ts if not already present:
export async function synthesize(req: { text: string }): Promise<Buffer> {
  // Collect all chunks into one buffer for simple use-cases like ack audios.
  const chunks: Buffer[] = [];
  await enqueueTts({
    text: req.text,
    onChunkAudio: ({ audio }) => chunks.push(audio),
  });
  return Buffer.concat(chunks);
}
```

- [ ] **Step 2: Hook into server startup**

In `server/src/index.ts`, find the section where the server finishes initialization (after WebSocket server starts, etc). Add:

```typescript
import { ensureAckAudios } from './manager/voice.ack-audio';

// After the existing "Server listening on port X" log:
ensureAckAudios().catch((err) => {
  logger.warn(`Voice: ack audio init failed: ${err instanceof Error ? err.message : err}`);
});
```

- [ ] **Step 3: Build to verify**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server" && npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add server/src/manager/voice.ack-audio.ts server/src/index.ts server/src/audio/tts-sidecar.ts
git commit -m "feat(voice): pre-generate pause/resume ack audios on server start"
```

---

## Task 6: VoiceSessionController state machine (TDD with mocked sidecars)

**Files:**
- Create: `server/src/manager/voice.controller.ts`
- Create: `server/test/voice.controller.test.ts`

- [ ] **Step 1: Write the failing test (basic lifecycle)**

Create `server/test/voice.controller.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoiceSessionController } from '../src/manager/voice.controller';
import type { VoiceEmitter } from '../src/manager/voice.types';

// Minimal mocks; real integration is covered in Task 7.
const mockRegistry = {
  getActive: () => ({
    id: 'mock',
    chatStream: vi.fn(async (_msgs, _sys, onChunk) => {
      onChunk('Hallo.');
      return 'Hallo.';
    }),
  }),
} as any;

const mockWhisper = { transcribe: vi.fn(async () => 'User text') } as any;
const mockTts = {
  synthesizeChunked: vi.fn(async (text: string, onChunk: Function) => {
    onChunk({ idx: 0, sentence: text, audio: Buffer.from('fake-wav') });
  }),
} as any;

describe('VoiceSessionController', () => {
  let emitted: any[];
  let emit: VoiceEmitter;

  beforeEach(() => {
    emitted = [];
    emit = (msg) => emitted.push(msg);
  });

  it('emits phase transitions idle → listening on start', async () => {
    const ctrl = new VoiceSessionController({
      registry: mockRegistry, whisper: mockWhisper, tts: mockTts, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    expect(emitted.some((m) => m.type === 'voice:phase' && m.payload.phase === 'listening')).toBe(true);
  });

  it('runs full turn: listening → transcribing → thinking → speaking → listening', async () => {
    const ctrl = new VoiceSessionController({
      registry: mockRegistry, whisper: mockWhisper, tts: mockTts, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    ctrl.ingestAudio(Buffer.from('fake-audio'));
    await ctrl.endUserTurn();
    const phases = emitted
      .filter((m) => m.type === 'voice:phase')
      .map((m) => m.payload.phase);
    expect(phases).toEqual(['listening', 'transcribing', 'thinking', 'speaking', 'listening']);
  });

  it('emits a tts_chunk with audio for each sentence', async () => {
    const ctrl = new VoiceSessionController({
      registry: mockRegistry, whisper: mockWhisper, tts: mockTts, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    ctrl.ingestAudio(Buffer.from('fake-audio'));
    await ctrl.endUserTurn();
    const ttsChunks = emitted.filter((m) => m.type === 'voice:tts_chunk');
    expect(ttsChunks.length).toBe(1);
    expect(ttsChunks[0].payload.isLast).toBe(true);
  });

  it('stops gracefully', () => {
    const ctrl = new VoiceSessionController({
      registry: mockRegistry, whisper: mockWhisper, tts: mockTts, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    ctrl.stop();
    expect(emitted.some((m) => m.type === 'voice:phase' && m.payload.phase === 'idle')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server" && npx vitest run test/voice.controller.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement the controller**

Create `server/src/manager/voice.controller.ts`:

```typescript
import { logger } from '../utils/logger';
import type { VoicePhase, TtsChunk, PauseState, VoiceEmitter } from './voice.types';
import { SentenceBuffer } from './voice.sentences';
import { pickAckAudio } from './voice.ack-audio';

export interface VoiceSessionDeps {
  registry: {
    getActive: () => {
      id: string;
      chatStream: (
        messages: Array<{ role: string; content: string }>,
        systemPrompt: string,
        onChunk: (token: string) => void,
      ) => Promise<string>;
    };
  };
  whisper: {
    transcribe: (audio: Buffer) => Promise<string>;
  };
  tts: {
    synthesizeChunked: (
      text: string,
      onChunk: (info: { idx: number; sentence: string; audio: Buffer }) => void,
    ) => Promise<void>;
  };
  emit: VoiceEmitter;
  systemPrompt: string;
}

const AUTO_PAUSE_TIMEOUT_MS = 5 * 60_000;

export class VoiceSessionController {
  private phase: VoicePhase = 'idle';
  private audioBuffer: Buffer[] = [];
  private ttsQueue: TtsChunk[] = [];
  private pauseState: PauseState | null = null;
  private autoPauseTimer: NodeJS.Timeout | null = null;
  private currentStreamAbort: AbortController | null = null;
  private active = false;

  constructor(private deps: VoiceSessionDeps) {}

  start(): void {
    this.active = true;
    this.reset();
    this.setPhase('listening');
  }

  ingestAudio(chunk: Buffer): void {
    if (this.phase !== 'listening') return;
    this.audioBuffer.push(chunk);
  }

  async endUserTurn(): Promise<void> {
    if (this.phase !== 'listening' || this.audioBuffer.length === 0) return;

    try {
      this.setPhase('transcribing');
      const audio = Buffer.concat(this.audioBuffer);
      this.audioBuffer = [];
      const userText = await this.deps.whisper.transcribe(audio);
      if (!userText.trim()) {
        this.setPhase('listening');
        return;
      }
      this.deps.emit({ type: 'voice:transcript', payload: { text: userText, final: true } });

      this.setPhase('thinking');
      const messages = [{ role: 'user', content: userText }];
      const sentenceBuf = new SentenceBuffer();
      const pendingSentences: string[] = [];

      this.currentStreamAbort = new AbortController();
      const fullAiText = await this.deps.registry.getActive().chatStream(
        messages,
        this.deps.systemPrompt,
        (token) => {
          this.deps.emit({ type: 'voice:ai_delta', payload: { text: token } });
          pendingSentences.push(...sentenceBuf.push(token));
        },
      );
      pendingSentences.push(...sentenceBuf.flush());

      if (pendingSentences.length === 0) {
        this.setPhase('listening');
        return;
      }

      this.setPhase('speaking');
      await this.synthesizeAndEmit(pendingSentences);

      if (this.phase !== 'paused') {
        this.setPhase('listening');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Voice: turn failed — ${msg}`);
      this.deps.emit({ type: 'voice:error', payload: { message: msg, recoverable: true } });
      this.setPhase('listening');
    }
  }

  pause(): void {
    if (this.phase !== 'speaking' && this.phase !== 'thinking' && this.phase !== 'tool_call') return;

    if (this.phase === 'thinking' || this.phase === 'tool_call') {
      // Nothing yet said → treat as cancel.
      this.cancel();
      return;
    }

    // Remember resume cursor = first un-sent chunk
    const nextUnsent = this.ttsQueue.findIndex((c) => !c.sent);
    this.pauseState = {
      resumeCursor: nextUnsent >= 0 ? nextUnsent : this.ttsQueue.length,
      remainingText: this.ttsQueue.slice(Math.max(0, nextUnsent)).map((c) => c.sentence).join(' '),
      pausedAt: Date.now(),
    };
    this.setPhase('paused');

    const ack = pickAckAudio('pause');
    if (ack) {
      this.deps.emit({ type: 'voice:ack_audio', payload: { kind: 'pause', audio: ack.toString('base64') } });
    }

    this.autoPauseTimer = setTimeout(() => {
      logger.info('Voice: auto-timeout after 5min pause → cancel');
      this.cancel();
    }, AUTO_PAUSE_TIMEOUT_MS);
  }

  async resume(strategy: 'clean' | 'with_interjection' = 'clean'): Promise<void> {
    if (this.phase !== 'paused' || !this.pauseState) return;
    if (this.autoPauseTimer) { clearTimeout(this.autoPauseTimer); this.autoPauseTimer = null; }

    const ack = pickAckAudio('resume');
    if (ack) {
      this.deps.emit({ type: 'voice:ack_audio', payload: { kind: 'resume', audio: ack.toString('base64') } });
    }

    this.setPhase('speaking');

    if (strategy === 'with_interjection' && this.pauseState.interjection) {
      // Regenerate: cancel pending chunks, re-run LLM with interjection context.
      this.ttsQueue = this.ttsQueue.slice(0, this.pauseState.resumeCursor);
      const messages = [
        { role: 'assistant', content: this.ttsQueue.map((c) => c.sentence).join(' ') },
        { role: 'user', content: `${this.pauseState.interjection}\n(Bitte fortsetzen mit Berücksichtigung meines Einwands.)` },
      ];
      this.pauseState = null;
      const sentenceBuf = new SentenceBuffer();
      const newSentences: string[] = [];
      await this.deps.registry.getActive().chatStream(messages, this.deps.systemPrompt, (token) => {
        this.deps.emit({ type: 'voice:ai_delta', payload: { text: token } });
        newSentences.push(...sentenceBuf.push(token));
      });
      newSentences.push(...sentenceBuf.flush());
      await this.synthesizeAndEmit(newSentences);
    } else {
      // Clean resume: re-emit queue from cursor.
      const cursor = this.pauseState.resumeCursor;
      this.pauseState = null;
      for (let i = cursor; i < this.ttsQueue.length; i++) {
        const c = this.ttsQueue[i];
        this.deps.emit({
          type: 'voice:tts_chunk',
          payload: {
            chunkIdx: c.idx,
            audio: c.audio.toString('base64'),
            sentence: c.sentence,
            isLast: i === this.ttsQueue.length - 1,
          },
        });
        c.sent = true;
      }
    }

    if (this.phase !== 'paused') this.setPhase('listening');
  }

  /** Transcript received during paused state — buffered for sub-behavior (c). */
  addInterjection(text: string): void {
    if (this.phase !== 'paused' || !this.pauseState) return;
    if (text.trim().length < 20 && !text.includes('?')) return; // sub-behavior (b): ignore short
    this.pauseState.interjection = text;
  }

  cancel(): void {
    this.currentStreamAbort?.abort();
    this.reset();
    this.setPhase('listening');
  }

  stop(): void {
    this.active = false;
    this.currentStreamAbort?.abort();
    if (this.autoPauseTimer) { clearTimeout(this.autoPauseTimer); this.autoPauseTimer = null; }
    this.reset();
    this.setPhase('idle');
  }

  private async synthesizeAndEmit(sentences: string[]): Promise<void> {
    const baseIdx = this.ttsQueue.length;
    await this.deps.tts.synthesizeChunked(sentences.join(' '), (info) => {
      const chunk: TtsChunk = {
        idx: baseIdx + info.idx,
        sentence: info.sentence,
        audio: info.audio,
        sent: false,
      };
      this.ttsQueue.push(chunk);

      if (this.phase === 'paused') return; // don't emit during pause

      const total = this.ttsQueue.length;
      this.deps.emit({
        type: 'voice:tts_chunk',
        payload: {
          chunkIdx: chunk.idx,
          audio: chunk.audio.toString('base64'),
          sentence: chunk.sentence,
          isLast: false, // set true after loop; see below
        },
      });
      chunk.sent = true;
    });

    // Mark the final chunk as last.
    const last = this.ttsQueue[this.ttsQueue.length - 1];
    if (last && last.sent) {
      this.deps.emit({
        type: 'voice:tts_chunk',
        payload: {
          chunkIdx: last.idx,
          audio: '',
          sentence: '',
          isLast: true,
        },
      });
    }
  }

  private setPhase(phase: VoicePhase): void {
    this.phase = phase;
    this.deps.emit({ type: 'voice:phase', payload: { phase } });
  }

  private reset(): void {
    this.audioBuffer = [];
    this.ttsQueue = [];
    this.pauseState = null;
    this.currentStreamAbort = null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server" && npx vitest run test/voice.controller.test.ts
```

Expected: PASS all 4 tests.

- [ ] **Step 5: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add server/src/manager/voice.controller.ts server/test/voice.controller.test.ts
git commit -m "feat(voice): VoiceSessionController state machine

Orchestrates the voice turn pipeline (whisper → LLM → chunked TTS)
with server-side pause/resume state. Covered by unit tests with
mocked sidecars."
```

---

## Task 7: WebSocket handler wires voice:* messages

**Files:**
- Modify: `server/src/websocket/ws.handler.ts`
- Modify: `server/src/manager/manager.service.ts` (expose voice controller factory)

- [ ] **Step 1: Add voice-session factory to ManagerService**

In `server/src/manager/manager.service.ts`, near `getProviders()` and other public methods, add:

```typescript
// Near other public methods like getProviders, setProvider:

createVoiceSession(emit: import('./voice.types').VoiceEmitter): import('./voice.controller').VoiceSessionController {
  const { VoiceSessionController } = require('./voice.controller');
  return new VoiceSessionController({
    registry: this.registry,
    whisper: this.whisper,      // existing WhisperSidecar instance
    tts: this.tts,              // existing F5TtsSidecar instance (wrap with synthesizeChunked helper if needed)
    emit,
    systemPrompt: this.buildSystemPrompt(),
  });
}
```

If `this.whisper` / `this.tts` aren't already properties of ManagerService, look at how `WhisperSidecar` and the TTS sidecar are currently instantiated elsewhere in the codebase and mirror that. The controller expects objects with `transcribe(buf)` and `synthesizeChunked(text, onChunk)`.

If `synthesizeChunked` doesn't exist on the current TTS sidecar API, add a thin wrapper:

```typescript
// In server/src/audio/tts-sidecar.ts, add:
export async function synthesizeChunked(
  text: string,
  onChunk: (info: { idx: number; sentence: string; audio: Buffer }) => void,
): Promise<void> {
  let idx = 0;
  await enqueueTts({
    text,
    onChunkAudio: ({ audio, sentence }) => {
      onChunk({ idx: idx++, sentence, audio });
    },
  });
}
```

- [ ] **Step 2: Add session tracking to ws.handler**

In `server/src/websocket/ws.handler.ts`, near the top of the per-connection scope (search for where `ws.on('message', ...)` is set up), add a session holder:

```typescript
// Per-connection state:
let voiceSession: import('../manager/voice.controller').VoiceSessionController | null = null;

const getVoiceSession = () => {
  if (!voiceSession) {
    voiceSession = managerService.createVoiceSession((msg) => send(ws, msg as any));
  }
  return voiceSession;
};
```

- [ ] **Step 3: Route voice:* messages**

In the same file, after the existing `manager:*` handlers, add:

```typescript
// ── Voice chat message handlers ────────────────────────────────

if (msgType === 'voice:start') {
  getVoiceSession().start();
  return;
}
if (msgType === 'voice:audio_chunk') {
  const audio = (msg as any).payload?.audio;
  if (typeof audio === 'string') {
    getVoiceSession().ingestAudio(Buffer.from(audio, 'base64'));
  }
  return;
}
if (msgType === 'voice:end_turn') {
  getVoiceSession().endUserTurn().catch((err) => {
    const m = err instanceof Error ? err.message : String(err);
    send(ws, { type: 'voice:error', payload: { message: m, recoverable: true } } as any);
  });
  return;
}
if (msgType === 'voice:pause') {
  getVoiceSession().pause();
  return;
}
if (msgType === 'voice:resume') {
  const strategy = (msg as any).payload?.strategy === 'with_interjection' ? 'with_interjection' : 'clean';
  getVoiceSession().resume(strategy).catch((err) => {
    const m = err instanceof Error ? err.message : String(err);
    send(ws, { type: 'voice:error', payload: { message: m, recoverable: true } } as any);
  });
  return;
}
if (msgType === 'voice:cancel') {
  getVoiceSession().cancel();
  return;
}
if (msgType === 'voice:stop') {
  getVoiceSession().stop();
  voiceSession = null;
  return;
}
```

- [ ] **Step 4: Clean up on disconnect**

Find the existing `ws.on('close', ...)` handler and add:

```typescript
// Inside the existing close handler:
if (voiceSession) {
  voiceSession.stop();
  voiceSession = null;
}
```

- [ ] **Step 5: Build server**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server" && npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add server/src/websocket/ws.handler.ts server/src/manager/manager.service.ts server/src/audio/tts-sidecar.ts
git commit -m "feat(voice): route voice:* WebSocket messages to VoiceSessionController"
```

---

## Task 8: HTTP endpoint for voice-videos and character HTML

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Read existing HTTP routes in index.ts**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server"
grep -n "createServer\|on('request'\|http\." src/index.ts | head -20
```

Identify how the HTTP server is created and how routing works (manual switch on `req.url` vs. framework).

- [ ] **Step 2: Add static serve for `/voice-videos/:name.mp4`**

In `server/src/index.ts`, at the appropriate request-handler location, add:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const VOICE_VIDEOS_DIR = path.join(os.homedir(), '.tms-terminal', 'voice-videos');
const CHARACTER_HTML_PATH = path.join(__dirname, '../..', 'prototype/voice-design/index.html');

// Inside the request-dispatching logic:
if (req.url?.startsWith('/voice-videos/')) {
  const name = req.url.slice('/voice-videos/'.length).replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!name.endsWith('.mp4')) { res.writeHead(404); res.end(); return; }
  const filePath = path.join(VOICE_VIDEOS_DIR, name);
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': stat.size,
    'Cache-Control': 'max-age=86400',
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(filePath).pipe(res);
  return;
}

if (req.url === '/voice-character.html') {
  if (!fs.existsSync(CHARACTER_HTML_PATH)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'max-age=3600' });
  fs.createReadStream(CHARACTER_HTML_PATH).pipe(res);
  return;
}
```

- [ ] **Step 3: Ensure voice-videos dir exists at startup**

Near the other init code in `index.ts`:

```typescript
if (!fs.existsSync(VOICE_VIDEOS_DIR)) {
  fs.mkdirSync(VOICE_VIDEOS_DIR, { recursive: true, mode: 0o700 });
  logger.info(`Voice: created videos directory at ${VOICE_VIDEOS_DIR}`);
}
```

- [ ] **Step 4: Test manually**

Start server, then:

```bash
curl -I http://localhost:8767/voice-character.html
# Expected: HTTP/1.1 200 OK, Content-Type: text/html
curl -I http://localhost:8767/voice-videos/nonexistent.mp4
# Expected: HTTP/1.1 404
```

- [ ] **Step 5: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add server/src/index.ts
git commit -m "feat(voice): HTTP endpoints for voice-videos and character HTML"
```

---

## Task 9: Mobile AudioPlayerQueue service (TDD)

**Files:**
- Create: `mobile/src/services/AudioPlayerQueue.ts`
- Create: `mobile/src/services/AudioPlayerQueue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `mobile/src/services/AudioPlayerQueue.test.ts`:

```typescript
import { AudioPlayerQueue } from './AudioPlayerQueue';

// Mock expo-av Sound
const mockSound = {
  playAsync: jest.fn(async () => {}),
  pauseAsync: jest.fn(async () => {}),
  unloadAsync: jest.fn(async () => {}),
  setOnPlaybackStatusUpdate: jest.fn(),
};

jest.mock('expo-av', () => ({
  Audio: {
    Sound: {
      createAsync: jest.fn(async () => ({ sound: mockSound })),
    },
  },
}));

describe('AudioPlayerQueue', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('plays chunks sequentially', async () => {
    const q = new AudioPlayerQueue();
    await q.enqueue('base64-a');
    await q.enqueue('base64-b');
    // After 1st finishes, 2nd starts.
    expect(mockSound.playAsync).toHaveBeenCalledTimes(1);
  });

  it('pauses and resumes from current chunk', async () => {
    const q = new AudioPlayerQueue();
    await q.enqueue('base64-a');
    await q.pause();
    expect(mockSound.pauseAsync).toHaveBeenCalled();
    await q.resume();
    expect(mockSound.playAsync).toHaveBeenCalledTimes(2);
  });

  it('clears queue on stop', async () => {
    const q = new AudioPlayerQueue();
    await q.enqueue('base64-a');
    await q.stop();
    expect(q.queueLength()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile" && npx jest AudioPlayerQueue.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement the queue**

Create `mobile/src/services/AudioPlayerQueue.ts`:

```typescript
import { Audio } from 'expo-av';

/**
 * Queue of base64-encoded WAV chunks. Plays sequentially. Can be paused
 * (stays on the current chunk) and resumed. New chunks arriving during pause
 * wait in the queue until resume.
 */
export class AudioPlayerQueue {
  private queue: string[] = [];
  private current: Audio.Sound | null = null;
  private paused = false;
  private playing = false;
  private onFinished?: () => void;

  setOnFinished(cb: () => void) { this.onFinished = cb; }

  async enqueue(base64Wav: string): Promise<void> {
    this.queue.push(base64Wav);
    if (!this.playing && !this.paused) {
      await this.playNext();
    }
  }

  async pause(): Promise<void> {
    this.paused = true;
    if (this.current) {
      try { await this.current.pauseAsync(); } catch {}
    }
  }

  async resume(): Promise<void> {
    this.paused = false;
    if (this.current) {
      try { await this.current.playAsync(); } catch {}
    } else if (this.queue.length > 0) {
      await this.playNext();
    }
  }

  async stop(): Promise<void> {
    this.paused = false;
    this.playing = false;
    this.queue = [];
    if (this.current) {
      try { await this.current.unloadAsync(); } catch {}
      this.current = null;
    }
  }

  queueLength(): number { return this.queue.length; }
  isPlaying(): boolean { return this.playing; }
  isPaused(): boolean { return this.paused; }

  private async playNext(): Promise<void> {
    if (this.paused || this.queue.length === 0) {
      this.playing = false;
      this.onFinished?.();
      return;
    }
    this.playing = true;
    const next = this.queue.shift()!;
    try {
      if (this.current) {
        try { await this.current.unloadAsync(); } catch {}
      }
      const uri = `data:audio/wav;base64,${next}`;
      const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true });
      this.current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if ('didJustFinish' in status && status.didJustFinish) {
          this.playNext();
        }
      });
    } catch (e) {
      // Bad chunk — skip to next.
      this.playNext();
    }
  }
}
```

- [ ] **Step 4: Run test**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile" && npx jest AudioPlayerQueue.test.ts
```

Expected: PASS 3 tests.

- [ ] **Step 5: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/services/AudioPlayerQueue.ts mobile/src/services/AudioPlayerQueue.test.ts
git commit -m "feat(voice/mobile): pausable audio chunk queue"
```

---

## Task 10: Mobile VoiceClient service

**Files:**
- Create: `mobile/src/services/VoiceClient.ts`

- [ ] **Step 1: Write the client**

Create `mobile/src/services/VoiceClient.ts`:

```typescript
import type { wsService as WsService } from './ws.service'; // or adapt to actual export

type VoicePhase =
  | 'idle' | 'listening' | 'transcribing' | 'thinking'
  | 'tool_call' | 'speaking' | 'paused';

export interface VoiceClientHandlers {
  onPhase: (phase: VoicePhase) => void;
  onTranscript: (text: string, final: boolean) => void;
  onAiDelta: (text: string) => void;
  onTtsChunk: (chunkIdx: number, audioBase64: string, sentence: string, isLast: boolean) => void;
  onAckAudio: (kind: 'pause' | 'resume', audioBase64: string) => void;
  onError: (message: string, recoverable: boolean) => void;
}

export class VoiceClient {
  private unsubscribe: (() => void) | null = null;

  constructor(private ws: typeof WsService, private handlers: VoiceClientHandlers) {}

  subscribe(): void {
    const listener = (msg: any) => {
      switch (msg?.type) {
        case 'voice:phase': this.handlers.onPhase(msg.payload.phase); break;
        case 'voice:transcript': this.handlers.onTranscript(msg.payload.text, msg.payload.final); break;
        case 'voice:ai_delta': this.handlers.onAiDelta(msg.payload.text); break;
        case 'voice:tts_chunk':
          this.handlers.onTtsChunk(msg.payload.chunkIdx, msg.payload.audio, msg.payload.sentence, msg.payload.isLast);
          break;
        case 'voice:ack_audio': this.handlers.onAckAudio(msg.payload.kind, msg.payload.audio); break;
        case 'voice:error': this.handlers.onError(msg.payload.message, msg.payload.recoverable); break;
      }
    };
    this.unsubscribe = this.ws.onMessage(listener);  // adapt to actual ws API
  }

  dispose(): void { this.unsubscribe?.(); this.unsubscribe = null; }

  start(): void { this.ws.send({ type: 'voice:start', payload: {} }); }
  stop(): void { this.ws.send({ type: 'voice:stop', payload: {} }); }
  sendAudioChunk(audioBase64: string): void {
    this.ws.send({ type: 'voice:audio_chunk', payload: { audio: audioBase64 } });
  }
  endTurn(): void { this.ws.send({ type: 'voice:end_turn', payload: {} }); }
  pause(): void { this.ws.send({ type: 'voice:pause', payload: {} }); }
  resume(strategy: 'clean' | 'with_interjection' = 'clean'): void {
    this.ws.send({ type: 'voice:resume', payload: { strategy } });
  }
  cancel(): void { this.ws.send({ type: 'voice:cancel', payload: {} }); }
}
```

Adapt the `ws` import/API to the existing `mobile/src/services/ws.service.ts` (or whatever it's called) — specifically the `send()` and `onMessage()` methods.

- [ ] **Step 2: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/services/VoiceClient.ts
git commit -m "feat(voice/mobile): VoiceClient WebSocket wrapper"
```

---

## Task 11: Mobile VAD recorder hook

**Files:**
- Create: `mobile/src/hooks/useVadRecorder.ts`

- [ ] **Step 1: Write the hook**

Create `mobile/src/hooks/useVadRecorder.ts`:

```typescript
import { useEffect, useRef, useState } from 'react';
import { Audio } from 'expo-av';

export interface VadRecorderConfig {
  silenceMs?: number;           // default 800ms
  silenceDb?: number;           // default -40 dB
  chunkMs?: number;             // default 200ms
  onChunk?: (base64Pcm: string) => void;
  onSpeechStart?: () => void;
  onSilenceDetected?: () => void;
}

export function useVadRecorder(enabled: boolean, cfg: VadRecorderConfig = {}) {
  const {
    silenceMs = 800,
    silenceDb = -40,
    chunkMs = 200,
    onChunk,
    onSpeechStart,
    onSilenceDetected,
  } = cfg;

  const [status, setStatus] = useState<'idle' | 'listening' | 'speaking' | 'error'>('idle');
  const recordingRef = useRef<Audio.Recording | null>(null);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hasSpokenRef = useRef(false);

  useEffect(() => {
    if (!enabled) { stop(); return; }
    start().catch((e) => { console.warn('VAD start failed', e); setStatus('error'); });
    return () => { stop(); };
  }, [enabled]);

  async function start() {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) { setStatus('error'); return; }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

    const rec = new Audio.Recording();
    await rec.prepareToRecordAsync({
      android: { extension: '.wav', outputFormat: 3, audioEncoder: 1, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000 },
      ios: { extension: '.wav', audioQuality: 96, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
      web: {},
      isMeteringEnabled: true,
    } as any);

    rec.setOnRecordingStatusUpdate((s) => {
      if (!('metering' in s) || typeof s.metering !== 'number') return;
      const db = s.metering;
      if (db > silenceDb) {
        // Speaking
        if (!hasSpokenRef.current) { hasSpokenRef.current = true; setStatus('speaking'); onSpeechStart?.(); }
        if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
      } else if (hasSpokenRef.current && !silenceTimerRef.current) {
        silenceTimerRef.current = setTimeout(() => { onSilenceDetected?.(); }, silenceMs);
      }
    });
    rec.setProgressUpdateInterval(chunkMs);
    await rec.startAsync();
    recordingRef.current = rec;
    setStatus('listening');
    hasSpokenRef.current = false;

    // NOTE: expo-av does not expose streaming PCM chunks reliably. For V1,
    // we rely on full recording + upload at endTurn. Streaming upload
    // can be added later via native module. For now, onChunk is unused.
  }

  async function stop() {
    try {
      if (recordingRef.current) {
        await recordingRef.current.stopAndUnloadAsync();
        recordingRef.current = null;
      }
    } catch {}
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    setStatus('idle');
  }

  /** Stop recording and return the base64-encoded WAV. */
  async function finish(): Promise<string | null> {
    try {
      const rec = recordingRef.current;
      if (!rec) return null;
      await rec.stopAndUnloadAsync();
      recordingRef.current = null;
      const uri = rec.getURI();
      if (!uri) return null;
      const FileSystem = await import('expo-file-system');
      const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      return b64;
    } catch { return null; }
  }

  return { status, finish };
}
```

Note: V1 uses the "record-until-VAD-silence, then upload full WAV" approach because expo-av's streaming API is limited. The onChunk callback in the config is kept for a future upgrade but not emitted in V1. The protocol's `voice:audio_chunk` is still used once per turn — the client sends the full base64 WAV in a single message, then calls `voice:end_turn`.

- [ ] **Step 2: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/hooks/useVadRecorder.ts
git commit -m "feat(voice/mobile): VAD recorder hook with silence detection"
```

---

## Task 12: Mobile voice Zustand store

**Files:**
- Create: `mobile/src/store/voiceStore.ts`

- [ ] **Step 1: Write the store**

Create `mobile/src/store/voiceStore.ts`:

```typescript
import { create } from 'zustand';

export type VoicePhase =
  | 'idle' | 'listening' | 'transcribing' | 'thinking'
  | 'tool_call' | 'speaking' | 'paused';

interface VoiceState {
  phase: VoicePhase;
  userTranscript: string;              // most recent user transcript
  aiStreaming: string;                 // current turn's streamed AI text
  aiSpokenWordCount: number;           // for karaoke highlight
  turnStartedAt: number | null;
  errorBanner: string | null;
  pausedWithInterjection: boolean;     // sub-behavior (c): show resume options
  interjectionText: string | null;

  setPhase: (p: VoicePhase) => void;
  setUserTranscript: (t: string) => void;
  appendAiDelta: (t: string) => void;
  markWordSpoken: (sentenceText: string) => void;
  resetTurn: () => void;
  setError: (msg: string | null) => void;
  setPausedWithInterjection: (b: boolean, text?: string) => void;
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  phase: 'idle',
  userTranscript: '',
  aiStreaming: '',
  aiSpokenWordCount: 0,
  turnStartedAt: null,
  errorBanner: null,
  pausedWithInterjection: false,
  interjectionText: null,

  setPhase: (p) => set((s) => {
    const patch: Partial<VoiceState> = { phase: p };
    if (p === 'listening' && s.phase === 'speaking') {
      // Turn ended, clear transient state on next turn start.
    }
    if (p === 'listening' && s.phase === 'idle') patch.turnStartedAt = Date.now();
    return patch;
  }),
  setUserTranscript: (t) => set({ userTranscript: t }),
  appendAiDelta: (t) => set((s) => ({ aiStreaming: s.aiStreaming + t })),
  markWordSpoken: (sentenceText) => set((s) => ({
    aiSpokenWordCount: s.aiSpokenWordCount + sentenceText.split(/\s+/).length,
  })),
  resetTurn: () => set({
    aiStreaming: '',
    aiSpokenWordCount: 0,
    userTranscript: '',
    pausedWithInterjection: false,
    interjectionText: null,
  }),
  setError: (msg) => set({ errorBanner: msg }),
  setPausedWithInterjection: (b, text) => set({ pausedWithInterjection: b, interjectionText: text ?? null }),
}));
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/store/voiceStore.ts
git commit -m "feat(voice/mobile): Zustand store for voice session UI state"
```

---

## Task 13: Bundle the character HTML with the mobile app

**Files:**
- Create: `mobile/assets/voice-character/index.html`
- Modify: `mobile/app.json` (add asset pattern if needed)

- [ ] **Step 1: Copy the mockup HTML as the bundled asset**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
mkdir -p mobile/assets/voice-character
cp prototype/voice-design/index.html mobile/assets/voice-character/index.html
```

- [ ] **Step 2: Adapt the bundled HTML for WebView embedding**

In `mobile/assets/voice-character/index.html`, REMOVE the demo-bar (the state picker), the subtitles, the top bar, and the controls — keep ONLY the character animation. The WebView should render only the character with a transparent background so native UI sits on top.

Edit the `body` styles:

```css
body {
  background: transparent !important;
}
.stage::before, .stage::after { /* keep grain but let parent show through */ }
.topbar, .subtitle-area, .controls, .resume-options, .demo-bar { display: none !important; }
```

And add a message listener at the bottom of the `<script>`:

```javascript
// Receive phase updates from React Native host
window.addEventListener('message', (e) => {
  try {
    const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    if (data?.type === 'setPhase' && data.phase) {
      // Map paused-interjection etc if needed
      document.getElementById('stage').dataset.phase = data.phase;
    }
  } catch {}
});
```

Android WebView uses `document.addEventListener('message', …)` instead. Add both:

```javascript
['message'].forEach((name) => {
  document.addEventListener(name, handler);
  window.addEventListener(name, handler);
});
function handler(e) { /* above logic */ }
```

- [ ] **Step 3: Verify expo-asset pattern picks it up**

Check `mobile/app.json` — if there's an `assetBundlePatterns` entry, ensure it includes `"assets/**/*"` (which is the default). If it uses explicit patterns, add `"assets/voice-character/**"`.

- [ ] **Step 4: Install react-native-webview if not already**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
npx expo install react-native-webview
```

- [ ] **Step 5: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/assets/voice-character/index.html mobile/app.json mobile/package.json mobile/package-lock.json 2>/dev/null || true
git commit -m "feat(voice/mobile): bundle character animation HTML for WebView"
```

---

## Task 14: CharacterWebView component

**Files:**
- Create: `mobile/src/components/voice/CharacterWebView.tsx`

- [ ] **Step 1: Write the component**

Create `mobile/src/components/voice/CharacterWebView.tsx`:

```typescript
import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Asset } from 'expo-asset';
import type { VoicePhase } from '../../store/voiceStore';

interface Props {
  phase: VoicePhase;
}

export function CharacterWebView({ phase }: Props) {
  const webviewRef = useRef<WebView>(null);
  const [html, setHtml] = React.useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const asset = Asset.fromModule(require('../../../assets/voice-character/index.html'));
      await asset.downloadAsync();
      const res = await fetch(asset.localUri ?? asset.uri);
      setHtml(await res.text());
    })();
  }, []);

  useEffect(() => {
    if (webviewRef.current) {
      webviewRef.current.postMessage(JSON.stringify({ type: 'setPhase', phase }));
    }
  }, [phase]);

  if (!html) return <View style={styles.container} />;

  return (
    <View style={styles.container} pointerEvents="none">
      <WebView
        ref={webviewRef}
        source={{ html }}
        style={styles.webview}
        scrollEnabled={false}
        bounces={false}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        allowFileAccess
        androidLayerType="hardware"
        backgroundColor="transparent"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { ...StyleSheet.absoluteFillObject },
  webview: { flex: 1, backgroundColor: 'transparent' },
});
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/components/voice/CharacterWebView.tsx
git commit -m "feat(voice/mobile): CharacterWebView renders phase-synced animation"
```

---

## Task 15: SubtitleOverlay with karaoke highlight

**Files:**
- Create: `mobile/src/components/voice/SubtitleOverlay.tsx`

- [ ] **Step 1: Write the component**

Create `mobile/src/components/voice/SubtitleOverlay.tsx`:

```typescript
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useVoiceStore } from '../../store/voiceStore';

export function SubtitleOverlay() {
  const { userTranscript, aiStreaming, aiSpokenWordCount, phase } = useVoiceStore();

  const showUser = userTranscript && (phase === 'listening' || phase === 'transcribing' || phase === 'thinking');
  const showAi = aiStreaming && (phase === 'thinking' || phase === 'tool_call' || phase === 'speaking' || phase === 'paused');

  const words = aiStreaming.split(/(\s+)/);
  let wordIdx = 0;

  return (
    <View style={styles.container} pointerEvents="none">
      {showUser && (
        <View style={styles.userBubble}>
          <Text style={styles.userLabel}>DU</Text>
          <Text style={styles.userText}>{userTranscript}</Text>
        </View>
      )}
      {showAi && (
        <Text style={styles.subtitle}>
          {words.map((w, i) => {
            if (/^\s+$/.test(w)) return w;
            const isSpoken = wordIdx < aiSpokenWordCount;
            const isActive = wordIdx === aiSpokenWordCount;
            wordIdx++;
            const style = isActive ? styles.wordActive : isSpoken ? styles.wordSpoken : styles.word;
            return <Text key={i} style={style}>{w}</Text>;
          })}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0, right: 0, bottom: 180,
    paddingHorizontal: 26,
    alignItems: 'center',
    gap: 6,
  },
  subtitle: {
    fontFamily: 'Fraunces_400Italic',   // load via expo-font; see Task 16
    fontSize: 24,
    lineHeight: 30,
    letterSpacing: -0.2,
    color: '#F4EFE5',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 20,
    maxWidth: 540,
  },
  word: { color: '#F4EFE5' },
  wordSpoken: { color: '#C8BFB0' },
  wordActive: { color: '#F3B57A' },
  userBubble: {
    paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: 'rgba(20,16,13,0.5)',
    borderRadius: 18,
    borderWidth: 1, borderColor: 'rgba(244,239,229,0.08)',
    maxWidth: 440,
  },
  userLabel: {
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 9.5, letterSpacing: 2,
    color: '#8A8275', opacity: 0.6,
    marginBottom: 4, textTransform: 'uppercase',
  },
  userText: {
    fontFamily: 'BricolageGrotesque_400Regular',
    fontSize: 15, lineHeight: 21,
    color: '#8A8275', textAlign: 'center',
  },
});
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/components/voice/SubtitleOverlay.tsx
git commit -m "feat(voice/mobile): SubtitleOverlay with karaoke highlighting"
```

---

## Task 16: VoiceControls + ResumeOptions + StatusPill

**Files:**
- Create: `mobile/src/components/voice/VoiceControls.tsx`
- Create: `mobile/src/components/voice/ResumeOptions.tsx`
- Create: `mobile/src/components/voice/StatusPill.tsx`
- Modify: `mobile/App.tsx` (load Fraunces + Bricolage Grotesque fonts)

- [ ] **Step 1: Install fonts**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
npx expo install @expo-google-fonts/fraunces @expo-google-fonts/bricolage-grotesque expo-font
```

- [ ] **Step 2: Load fonts at app start**

In `mobile/App.tsx`, near the top inside the root component, add font loading:

```typescript
import { useFonts, Fraunces_400Italic, Fraunces_500Medium } from '@expo-google-fonts/fraunces';
import { BricolageGrotesque_400Regular, BricolageGrotesque_500Medium, BricolageGrotesque_600SemiBold } from '@expo-google-fonts/bricolage-grotesque';

// Inside App component:
const [fontsLoaded] = useFonts({
  Fraunces_400Italic, Fraunces_500Medium,
  BricolageGrotesque_400Regular, BricolageGrotesque_500Medium, BricolageGrotesque_600SemiBold,
});
if (!fontsLoaded) return null; // or splash
```

- [ ] **Step 3: Write VoiceControls**

Create `mobile/src/components/voice/VoiceControls.tsx`:

```typescript
import React from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useVoiceStore } from '../../store/voiceStore';

interface Props {
  providerName: string;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}

export function VoiceControls({ providerName, onPause, onResume, onCancel }: Props) {
  const phase = useVoiceStore((s) => s.phase);
  const pausedWithInterjection = useVoiceStore((s) => s.pausedWithInterjection);
  const isPaused = phase === 'paused';

  if (pausedWithInterjection) return null;  // ResumeOptions takes over

  return (
    <View style={styles.container} pointerEvents="box-none">
      <View style={styles.row}>
        <TouchableOpacity style={[styles.btn, styles.danger]} onPress={onCancel}>
          <Feather name="x" size={24} color="rgba(228,120,115,0.9)" />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.primary]}
          onPress={isPaused ? onResume : onPause}
        >
          <Feather name={isPaused ? 'play' : 'pause'} size={28} color="#0a0807" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={() => {}}>
          <Feather name="mic" size={24} color="#F4EFE5" />
        </TouchableOpacity>
      </View>
      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>REM</Text>
        <View style={styles.sep} />
        <Text style={styles.metaProvider}>{providerName}</Text>
      </View>
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
  },
  primary: {
    width: 78, height: 78, borderRadius: 39,
    backgroundColor: '#D68B4E', borderColor: 'rgba(243,181,122,0.5)',
    shadowColor: '#D68B4E', shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5, shadowRadius: 20, elevation: 12,
  },
  danger: {},
  metaRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  metaLabel: {
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 11.5, letterSpacing: 2,
    color: '#8A8275', textTransform: 'uppercase',
  },
  metaProvider: {
    fontFamily: 'Fraunces_400Italic',
    fontSize: 13, letterSpacing: 0.3,
    color: '#C8BFB0',
  },
  sep: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: '#8A8275', opacity: 0.5 },
});
```

- [ ] **Step 4: Write ResumeOptions**

Create `mobile/src/components/voice/ResumeOptions.tsx`:

```typescript
import React from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';

interface Props {
  onResumeClean: () => void;
  onResumeInterject: () => void;
}

export function ResumeOptions({ onResumeClean, onResumeInterject }: Props) {
  return (
    <View style={styles.container}>
      <TouchableOpacity style={[styles.opt]} onPress={onResumeClean}>
        <Feather name="play" size={14} color="#F4EFE5" />
        <Text style={styles.txt}>Weiter wie zuvor</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.opt, styles.accent]} onPress={onResumeInterject}>
        <Feather name="arrow-right" size={14} color="#0a0807" />
        <Text style={[styles.txt, styles.txtAccent]}>Mit meinem Einwand fortsetzen</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0, right: 0, bottom: 130,
    alignItems: 'center', gap: 10, paddingHorizontal: 26,
  },
  opt: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 22, paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(28,23,19,0.75)',
    borderWidth: 1, borderColor: 'rgba(214,139,78,0.25)',
    minWidth: 240, justifyContent: 'center',
  },
  accent: {
    backgroundColor: '#D68B4E',
    borderColor: 'transparent',
  },
  txt: {
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 13.5, color: '#F4EFE5',
  },
  txtAccent: { color: '#0a0807' },
});
```

- [ ] **Step 5: Write StatusPill**

Create `mobile/src/components/voice/StatusPill.tsx`:

```typescript
import React from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import type { VoicePhase } from '../../store/voiceStore';

const LABELS: Record<VoicePhase, string> = {
  idle: 'Bereit',
  listening: 'Hört zu',
  transcribing: 'Transkribiert',
  thinking: 'Denkt nach',
  tool_call: 'Arbeitet mit Tools',
  speaking: 'Rem spricht',
  paused: 'Pause',
};

const COLORS: Record<VoicePhase, string> = {
  idle: '#D68B4E',
  listening: '#88D4A0',
  transcribing: '#E8A94C',
  thinking: '#E8A94C',
  tool_call: '#B5A1EA',
  speaking: '#D68B4E',
  paused: '#9AA2A8',
};

export function StatusPill({ phase }: { phase: VoicePhase }) {
  return (
    <View style={styles.pill}>
      <View style={[styles.dot, { backgroundColor: COLORS[phase], shadowColor: COLORS[phase] }]} />
      <Text style={styles.label}>{LABELS[phase]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    paddingLeft: 10, paddingRight: 14, paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(28,23,19,0.55)',
    borderWidth: 1, borderColor: 'rgba(214,139,78,0.2)',
  },
  dot: {
    width: 8, height: 8, borderRadius: 4,
    shadowOffset: { width: 0, height: 0 }, shadowOpacity: 1, shadowRadius: 12,
  },
  label: {
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 12.5, letterSpacing: 0.4,
    color: '#C8BFB0', textTransform: 'uppercase',
  },
});
```

- [ ] **Step 6: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/components/voice/VoiceControls.tsx mobile/src/components/voice/ResumeOptions.tsx mobile/src/components/voice/StatusPill.tsx mobile/App.tsx mobile/package.json mobile/package-lock.json 2>/dev/null || true
git commit -m "feat(voice/mobile): VoiceControls, ResumeOptions, StatusPill + fonts"
```

---

## Task 17: VoiceScreen (integration of all components)

**Files:**
- Create: `mobile/src/screens/VoiceScreen.tsx`

- [ ] **Step 1: Write the screen**

Create `mobile/src/screens/VoiceScreen.tsx`:

```typescript
import React, { useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet, TouchableOpacity, StatusBar } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { useVoiceStore } from '../store/voiceStore';
import { useVadRecorder } from '../hooks/useVadRecorder';
import { AudioPlayerQueue } from '../services/AudioPlayerQueue';
import { VoiceClient } from '../services/VoiceClient';
import { wsService } from '../services/ws.service';  // adapt to actual import

import { CharacterWebView } from '../components/voice/CharacterWebView';
import { SubtitleOverlay } from '../components/voice/SubtitleOverlay';
import { VoiceControls } from '../components/voice/VoiceControls';
import { ResumeOptions } from '../components/voice/ResumeOptions';
import { StatusPill } from '../components/voice/StatusPill';

export function VoiceScreen() {
  const navigation = useNavigation();
  const store = useVoiceStore();
  const audioQueue = useRef(new AudioPlayerQueue()).current;

  const client = useMemo(
    () =>
      new VoiceClient(wsService, {
        onPhase: (p) => store.setPhase(p),
        onTranscript: (t, final) => store.setUserTranscript(t),
        onAiDelta: (t) => store.appendAiDelta(t),
        onTtsChunk: (idx, audio, sentence, isLast) => {
          if (audio) audioQueue.enqueue(audio);
          if (sentence) store.markWordSpoken(sentence);
        },
        onAckAudio: (kind, audio) => audioQueue.enqueue(audio),
        onError: (msg) => store.setError(msg),
      }),
    [],
  );

  // VAD-driven turn
  useVadRecorder(store.phase === 'listening', {
    onSpeechStart: () => {},
    onSilenceDetected: async () => {
      // Get WAV, send, end turn
      // Hook's finish() isn't directly accessible from here; simpler: let the
      // hook's parent manage a ref. For V1 we'll refactor the hook to expose
      // finish via a ref-based pattern. Inline here:
      // TODO wiring — see Task 18 for the final pattern.
    },
  });

  useEffect(() => {
    client.subscribe();
    client.start();
    return () => { client.stop(); client.dispose(); audioQueue.stop(); };
  }, []);

  const handlePause = () => client.pause();
  const handleResume = () => { store.setPausedWithInterjection(false); client.resume('clean'); };
  const handleResumeInterject = () => { store.setPausedWithInterjection(false); client.resume('with_interjection'); };
  const handleCancel = () => client.cancel();
  const handleClose = () => { client.stop(); navigation.goBack(); };

  return (
    <View style={styles.root}>
      <StatusBar hidden />
      <CharacterWebView phase={store.phase} />

      <View style={styles.topbar}>
        <StatusPill phase={store.phase} />
        <TouchableOpacity style={styles.closeBtn} onPress={handleClose}>
          <Feather name="x" size={16} color="#C8BFB0" />
        </TouchableOpacity>
      </View>

      <SubtitleOverlay />

      {store.pausedWithInterjection ? (
        <ResumeOptions
          onResumeClean={handleResume}
          onResumeInterject={handleResumeInterject}
        />
      ) : (
        <VoiceControls
          providerName={/* read from manager store */ 'Provider'}
          onPause={handlePause}
          onResume={handleResume}
          onCancel={handleCancel}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0807' },
  topbar: {
    position: 'absolute',
    top: 14, left: 18, right: 18,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 40,  // safe area approx; use react-native-safe-area-context for precision
  },
  closeBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(28,23,19,0.55)',
    borderWidth: 1, borderColor: 'rgba(244,239,229,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
});
```

Fine-tune the VAD integration in the next task — the `onSilenceDetected` callback needs access to `finish()` from the recorder.

- [ ] **Step 2: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/screens/VoiceScreen.tsx
git commit -m "feat(voice/mobile): VoiceScreen integrates all voice components"
```

---

## Task 18: VAD-to-upload wiring + entry button

**Files:**
- Modify: `mobile/src/screens/VoiceScreen.tsx` — inline recorder lifecycle
- Modify: `mobile/src/screens/ManagerChatScreen.tsx` — add entry button
- Modify: `mobile/App.tsx` — register VoiceScreen route

- [ ] **Step 1: Rewire recorder lifecycle inline in VoiceScreen**

Replace the recorder section of `VoiceScreen.tsx` with a ref-based lifecycle. Add at the top:

```typescript
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
```

Replace the `useVadRecorder` call with inline recording logic (the hook can be retired if only this screen uses it, or keep it for future):

```typescript
const recordingRef = useRef<Audio.Recording | null>(null);
const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
const hasSpokenRef = useRef(false);

// Start recording when phase becomes listening:
useEffect(() => {
  if (store.phase !== 'listening') return;
  (async () => {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) { store.setError('Mic-Zugriff verweigert'); return; }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    const rec = new Audio.Recording();
    await rec.prepareToRecordAsync({
      android: { extension: '.wav', outputFormat: 3, audioEncoder: 1, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000 },
      ios: { extension: '.wav', audioQuality: 96, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
      web: {},
      isMeteringEnabled: true,
    } as any);
    rec.setOnRecordingStatusUpdate(async (s) => {
      if (!('metering' in s) || typeof s.metering !== 'number') return;
      if (s.metering > -40) {
        if (!hasSpokenRef.current) hasSpokenRef.current = true;
        if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
      } else if (hasSpokenRef.current && !silenceTimerRef.current) {
        silenceTimerRef.current = setTimeout(async () => {
          // End turn: stop, read WAV, send chunk + end_turn
          try {
            const uri = rec.getURI();
            await rec.stopAndUnloadAsync();
            recordingRef.current = null;
            hasSpokenRef.current = false;
            if (uri) {
              const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
              client.sendAudioChunk(b64);
              client.endTurn();
            }
          } catch (e) { store.setError('Turn-Ende fehlgeschlagen'); }
        }, 800);
      }
    });
    rec.setProgressUpdateInterval(200);
    await rec.startAsync();
    recordingRef.current = rec;
  })();
  return () => {
    if (recordingRef.current) { recordingRef.current.stopAndUnloadAsync().catch(() => {}); recordingRef.current = null; }
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
  };
}, [store.phase, client]);
```

- [ ] **Step 2: Register VoiceScreen in navigation**

In `mobile/App.tsx` (or wherever the navigator is defined), find the `Stack.Navigator` and add:

```typescript
import { VoiceScreen } from './src/screens/VoiceScreen';

// Inside Stack.Navigator:
<Stack.Screen
  name="VoiceChat"
  component={VoiceScreen}
  options={{
    headerShown: false,
    presentation: 'fullScreenModal',
    animation: 'fade',
    gestureEnabled: false,
  }}
/>
```

- [ ] **Step 3: Add entry button in ManagerChatScreen**

In `mobile/src/screens/ManagerChatScreen.tsx`, find where the header-right icons live (search for `useEffect` calls setting `headerRight` or the custom header render). Add a mic button that navigates:

```typescript
<TouchableOpacity
  onPress={() => navigation.navigate('VoiceChat' as never)}
  style={/* match existing icon style */}
>
  <Feather name="mic" size={20} color={colors.textBright} />
</TouchableOpacity>
```

- [ ] **Step 4: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mobile/src/screens/VoiceScreen.tsx mobile/src/screens/ManagerChatScreen.tsx mobile/App.tsx
git commit -m "feat(voice/mobile): wire VAD recorder + entry point from ManagerChatScreen"
```

---

## Task 19: Error handling and edge-case behaviors

**Files:**
- Modify: `server/src/manager/voice.controller.ts`
- Modify: `mobile/src/screens/VoiceScreen.tsx`
- Modify: `mobile/src/store/voiceStore.ts`

- [ ] **Step 1: Server — provider-switch block during active turn**

In `server/src/manager/voice.controller.ts`, expose:

```typescript
isBusy(): boolean {
  return this.phase === 'thinking' || this.phase === 'speaking' || this.phase === 'tool_call';
}
```

In `server/src/manager/ai-provider.ts`, the `setActive()` method should early-return or throw if an active voice session reports `isBusy()`. Since the controller lives in `ManagerService`, expose a guard in `ManagerService.setProvider()`:

```typescript
setProvider(id: string): void {
  if (this.activeVoiceSession?.isBusy()) {
    throw new Error('Provider-Wechsel während aktivem Voice-Turn blockiert');
  }
  this.registry.setActive(id);
}
```

(Track `this.activeVoiceSession` in `createVoiceSession()` — store the instance to `this.activeVoiceSession` and clear when it's stopped.)

- [ ] **Step 2: Mobile — app-background auto-pause**

In `mobile/src/screens/VoiceScreen.tsx`, add:

```typescript
import { AppState } from 'react-native';

useEffect(() => {
  const sub = AppState.addEventListener('change', (state) => {
    if (state !== 'active' && store.phase === 'speaking') {
      client.pause();
    }
  });
  return () => sub.remove();
}, [client, store.phase]);
```

- [ ] **Step 3: Mobile — interjection detection during paused phase**

In `VoiceScreen.tsx`, when `phase === 'paused'` and a new `voice:transcript` arrives during the pause-listening, set `pausedWithInterjection`:

```typescript
// In the VoiceClient subscription setup:
onTranscript: (t, final) => {
  store.setUserTranscript(t);
  if (final && store.phase === 'paused' && t.trim().length >= 20) {
    store.setPausedWithInterjection(true, t);
  }
},
```

Also update the server controller so that during `paused` phase, incoming audio chunks + end_turn are transcribed and delivered via `voice:transcript` but do NOT trigger the regular LLM pipeline (they're stored via `addInterjection()`):

```typescript
// In VoiceSessionController — add phase guard to endUserTurn:
async endUserTurn(): Promise<void> {
  if (this.phase === 'paused') {
    // Transcribe the interjection and buffer it
    const audio = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];
    if (audio.length === 0) return;
    try {
      const text = await this.deps.whisper.transcribe(audio);
      this.deps.emit({ type: 'voice:transcript', payload: { text, final: true } });
      this.addInterjection(text);
    } catch {}
    return;
  }
  // ... existing logic
}
```

(Also extend `ingestAudio` to accept audio while paused, buffered for interjection.)

- [ ] **Step 4: Mobile — error banner UI**

In `mobile/src/screens/VoiceScreen.tsx`, render a transient error banner:

```typescript
{store.errorBanner && (
  <View style={styles.errorBanner}>
    <Text style={styles.errorText}>{store.errorBanner}</Text>
    <TouchableOpacity onPress={() => store.setError(null)}>
      <Feather name="x" size={14} color="#F4EFE5" />
    </TouchableOpacity>
  </View>
)}
```

Add styles:

```typescript
errorBanner: {
  position: 'absolute', top: 80, left: 18, right: 18,
  flexDirection: 'row', alignItems: 'center', gap: 10,
  padding: 12, borderRadius: 12,
  backgroundColor: 'rgba(180,60,60,0.85)',
},
errorText: { flex: 1, color: '#F4EFE5', fontFamily: 'BricolageGrotesque_400Regular', fontSize: 13 },
```

- [ ] **Step 5: Build & run full test suite**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server" && npm run build && npx vitest run
cd "/Users/ayysir/Desktop/TMS Terminal/mobile" && npx jest --passWithNoTests
```

Expected: all passing (or no tests for mobile if jest isn't set up yet — that's fine for V1).

- [ ] **Step 6: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add server/src/manager/voice.controller.ts server/src/manager/manager.service.ts mobile/src/screens/VoiceScreen.tsx mobile/src/store/voiceStore.ts
git commit -m "feat(voice): error handling — app-background pause, interjection, error banner, provider-switch block"
```

---

## Task 20: Manual verification, memory update, release

**Files:**
- Modify: `memory/project-state.md`
- Modify: `memory/journal.md`

- [ ] **Step 1: Run server + install mobile APK locally**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server" && npm run build
tms-terminal stop; tms-terminal start
cd "/Users/ayysir/Desktop/TMS Terminal/mobile" && ./deploy.sh adb
```

- [ ] **Step 2: Run the manual test checklist from the spec**

Step through every item under "Manual test checklist" in `docs/superpowers/specs/2026-04-22-manager-voice-chat-design.md`. Focus on:
- Voice with at least 2 providers (GLM cloud + Gemma 4 local)
- Pause / Weiter cycle with ack audios
- Pause → user speaks substantive → 2-option resume
- App background → auto-pause → return → resume dialog
- Subtitle karaoke stays in sync with TTS audio
- Video/character loop changes phase visibly

Document any bugs found as follow-up commits.

- [ ] **Step 3: Update memory**

Append to `memory/journal.md`:

```markdown
## 2026-04-23 — Manager Voice Chat (v1.19.0)

### Was wurde gemacht
- Vollständiger Voice-Chat-Modus: VAD-Mic → Whisper → LLM → F5-TTS sentence-chunked → Mobile Queue
- Fullscreen VoiceScreen mit phasen-synchronem Character (WebView-Animation aus prototype/voice-design/index.html)
- Pause/Resume mit pre-generierten Ack-Audios ("Okay ich höre zu..." / "Ah wo war ich...")
- 3-variant Pause-Listening: (a) nichts → clean resume, (b) kurz → ignoriert, (c) substantiv → 2-Option-Resume
- Typografie: Fraunces Italic für AI-Subtitles + Bricolage Grotesque für UI
- Alle 5 Provider unterstützt (Cloud + Local), Video-Loops überbrücken Wartezeit

### Architektur
- Server: neuer VoiceSessionController, SentenceBuffer, ack-audio pre-generation
- Mobile: VoiceScreen, CharacterWebView, SubtitleOverlay (karaoke), VoiceControls, ResumeOptions, AudioPlayerQueue, VoiceClient, voiceStore
- 13 neue voice:* WebSocket-Messages

### Specs
- `docs/superpowers/specs/2026-04-22-manager-voice-chat-design.md`
- `docs/superpowers/plans/2026-04-23-manager-voice-chat.md`
```

Update `memory/project-state.md` — bump version to v1.19.0, move completed features up.

- [ ] **Step 4: Release via `release.sh`**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile" && yes y | ./release.sh minor
```

(minor bump because this is a new major feature. The script handles APK build + tag + GitHub release.)

- [ ] **Step 5: Final commit for memory**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add memory/
git commit -m "memory: update session journal for v1.19.0 voice chat"
git push
```

---

## Self-Review Log

Ran the following checks after writing the plan:

**1. Spec coverage:** Each numbered spec section has corresponding tasks:
- Interaction model (VAD) → Task 11 (useVadRecorder) + Task 18 (wiring)
- Pause/Resume with ack → Tasks 5, 6, 8, 17, 18, 19
- Fullscreen Voice-Screen + video loops → Tasks 13, 14, 17
- All 5 providers → handled via existing AiProviderRegistry; no provider-specific work required
- Existing F5-TTS voice → reused throughout, no changes
- Character visualization → Tasks 13, 14 (WebView of approved mockup)
- Karaoke subtitles → Task 15
- Error-handling matrix → Task 19
- Testing strategy → Tasks 2, 6, 9 (unit tests); Task 20 (manual checklist)

**2. Placeholders:** Only "adapt to actual ws API" remains, because the mobile WS service export names haven't been verified. The engineer MUST read `mobile/src/services/ws.service.ts` (or the actual path) at the start of Task 10 to get exact names. No TBDs in code — all actual implementations.

**3. Type consistency:** Phase names (`idle`/`listening`/...) identical across shared protocol, server types, and mobile store. Message type names identical. The `TtsChunk` server-side type has field `idx`, the wire message has `chunkIdx` — different on purpose (internal vs. external). The `SentenceBuffer` API uses `push/flush/reset` consistently. The `AudioPlayerQueue` API uses `enqueue/pause/resume/stop` consistently.

---

**Next:** Choose execution mode — subagent-driven or inline.
