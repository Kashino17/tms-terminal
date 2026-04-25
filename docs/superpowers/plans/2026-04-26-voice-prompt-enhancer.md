# Voice Prompt Enhancer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a togglable setting that, when on, rewrites Whisper-transcribed voice input into a clean, well-structured AI prompt via a fast local Llama 3.2 3B Instruct model — applied to all three transcription entry points (Terminal toolbar mic, Floating-Orb mic, Manager-Chat mic). Off by default; raw Whisper output unchanged.

**Architecture:**
- New Python sidecar `prompt_rewriter_sidecar.py` runs Llama 3.2 3B Instruct (4-bit MLX) in its own venv `.venv-rewriter`, mirroring the existing whisper / TTS sidecars (JSON-Lines stdin/stdout protocol, single-flight requests).
- New TS wrapper `prompt-rewriter-sidecar.ts` mirrors `whisper-sidecar.ts`. Server's `ws.handler.ts` checks the new `payload.enhance` flag on `audio:transcribe` — if `true`, pipes the Whisper text through the rewriter before sending `audio:transcription` back; mobile already inserts that text into the input field, so no mobile receive-side changes are needed.
- Mobile adds a single persisted setting (`voicePromptEnhanceEnabled`) and a Switch in `SettingsScreen`. All three send sites (TerminalToolbar, OrbLayer, ManagerChatScreen) read the flag and include it in the WS payload.

**Tech Stack:**
- Server: Node.js + TypeScript + Vitest, Python 3.14, mlx-lm (~0.20+), `mlx-community/Llama-3.2-3B-Instruct-4bit`
- Mobile: React Native (Expo), Zustand + AsyncStorage (already wired)
- Protocol: existing WebSocket types in `shared/protocol.ts`

---

## File Structure

**Create:**
- `server/audio/prompt_rewriter_sidecar.py` — Python sidecar, JSON-Lines protocol, mlx-lm
- `server/src/audio/prompt-rewriter-sidecar.ts` — TS wrapper around the sidecar
- `server/test/prompt-rewriter-sidecar.test.ts` — unit tests for the TS wrapper
- `docs/superpowers/specs/2026-04-26-voice-prompt-enhancer-design.md` — short design note (optional, written inline at end)

**Modify:**
- `shared/protocol.ts` — add `enhance?: boolean` to `AudioTranscribeMessage.payload`
- `server/src/websocket/ws.handler.ts` — invoke rewriter after Whisper when `enhance` is true
- `server/src/index.ts` — call `shutdownRewriter()` in graceful shutdown
- `mobile/src/store/settingsStore.ts` — add `voicePromptEnhanceEnabled` + setter
- `mobile/src/screens/SettingsScreen.tsx` — add new "Sprache" section with Switch
- `mobile/src/components/TerminalToolbar.tsx` — read flag, include in payload
- `mobile/src/components/OrbLayer.tsx` — same
- `mobile/src/screens/ManagerChatScreen.tsx` — same
- `memory/project-state.md` and `memory/journal.md` — entry at the end

---

## Task 1: Branch setup

**Files:**
- Modify: working tree only (no file changes)

- [ ] **Step 1: Create the feature branch off master**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git fetch origin
git checkout master
git pull --ff-only
git checkout -b feat/voice-prompt-enhancer
```

Expected: clean checkout, branch `feat/voice-prompt-enhancer` created.

- [ ] **Step 2: Verify clean working tree**

```bash
git status
```

Expected: `nothing to commit, working tree clean` (untracked dirs `prototype/`, `generated-presentations/`, `mcp-server/` are pre-existing and ignored for this feature).

---

## Task 2: Shared protocol — add `enhance` flag

**Files:**
- Modify: `shared/protocol.ts:59-63`

- [ ] **Step 1: Extend `AudioTranscribeMessage.payload`**

Replace the block at `shared/protocol.ts:59-63`:

```typescript
// ── Audio messages (Client → Server) ──────────────────────────
export interface AudioTranscribeMessage {
  type: 'audio:transcribe';
  sessionId: string;
  payload: {
    audio: string;
    format: 'wav';
    /** When true, rewrite the transcript into a polished AI prompt before returning. Default: false. */
    enhance?: boolean;
  };
}
```

- [ ] **Step 2: Verify TS compiles**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server"
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add shared/protocol.ts
git commit -m "feat(protocol): add optional enhance flag to audio:transcribe"
```

---

## Task 3: Python sidecar — virtualenv + script

**Files:**
- Create: `server/audio/prompt_rewriter_sidecar.py`
- Create venv (no commit): `server/audio/.venv-rewriter/`

- [ ] **Step 1: Create the venv and install mlx-lm**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server/audio"
python3 -m venv .venv-rewriter
source .venv-rewriter/bin/activate
pip install --upgrade pip
pip install "mlx-lm>=0.20.0"
deactivate
```

Expected: `pip list | grep mlx-lm` shows mlx-lm installed in `.venv-rewriter`.

- [ ] **Step 2: Verify `.venv-rewriter` is gitignored**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
grep -n ".venv" .gitignore
```

Expected: a line matching `.venv*/` exists (added in commit `fc375f1`'s context). If missing, add `.venv*/` to `.gitignore`.

- [ ] **Step 3: Create `prompt_rewriter_sidecar.py`**

Path: `server/audio/prompt_rewriter_sidecar.py`

```python
#!/usr/bin/env python3
"""Prompt rewriter sidecar — long-running process for transforming voice transcripts into polished AI prompts.

Reads JSON Lines from stdin, rewrites with Llama 3.2 3B Instruct (MLX), writes JSON Lines to stdout.

Protocol:
  Request:  {"id": "req-1", "transcript": "user spoken text"}
  Response: {"id": "req-1", "text": "rewritten prompt"}
  Error:    {"id": "req-1", "error": "reason"}
"""

import sys
import json

MODEL_ID = "mlx-community/Llama-3.2-3B-Instruct-4bit"
MAX_TOKENS = 512

SYSTEM_PROMPT = (
    "You are a prompt rewriter for an AI coding assistant. "
    "Convert the user's spoken transcript into a clear, well-structured prompt. "
    "Rules:\n"
    "- Keep the user's intent exactly. Do not add requests they did not make.\n"
    "- Fix grammar and remove filler words (ähm, halt, irgendwie, sozusagen).\n"
    "- Structure with short bullet points if there are multiple distinct parts; otherwise plain prose.\n"
    "- Preserve the original language (German stays German, English stays English).\n"
    "- Output ONLY the rewritten prompt. No preamble, no explanation, no quotation marks."
)


def main():
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.write("[rewriter-sidecar] Starting up...\n")
    sys.stderr.flush()

    try:
        from mlx_lm import load, generate
    except ImportError as e:
        sys.stderr.write(f"[rewriter-sidecar] Missing dependency: {e}\n")
        sys.stderr.write("[rewriter-sidecar] Install with: pip install mlx-lm\n")
        sys.stderr.flush()
        sys.exit(1)

    sys.stderr.write(f"[rewriter-sidecar] Loading model {MODEL_ID}...\n")
    sys.stderr.flush()
    model, tokenizer = load(MODEL_ID)
    sys.stderr.write("[rewriter-sidecar] Model loaded.\n")
    sys.stderr.write("[rewriter-sidecar] Ready for requests.\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        req_id = req.get("id", "unknown")
        transcript = (req.get("transcript") or "").strip()

        if not transcript:
            print(json.dumps({"id": req_id, "error": "Empty transcript"}))
            continue

        try:
            messages = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": transcript},
            ]
            prompt = tokenizer.apply_chat_template(
                messages, add_generation_prompt=True, tokenize=False
            )
            output = generate(
                model,
                tokenizer,
                prompt=prompt,
                max_tokens=MAX_TOKENS,
                verbose=False,
            )
            # mlx_lm.generate returns the completion only (not the prompt) in recent versions.
            text = (output or "").strip()
            if not text:
                # Fall back to raw transcript if rewriter output is empty.
                text = transcript
            print(json.dumps({"id": req_id, "text": text}))
        except Exception as e:
            sys.stderr.write(f"[rewriter-sidecar] Error on {req_id}: {e}\n")
            sys.stderr.flush()
            print(json.dumps({"id": req_id, "error": str(e)}))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Smoke-test the Python sidecar manually**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server/audio"
source .venv-rewriter/bin/activate
echo '{"id":"t1","transcript":"also ähm ich will halt das die transkribierung sozusagen einen prompt draus macht weißt du"}' | python3 prompt_rewriter_sidecar.py
```

Expected: stderr shows `Ready for requests.`, then a single JSON line `{"id":"t1","text":"..."}` containing a polished German prompt without filler words. First run downloads the model (~2GB) — wait until it completes.

- [ ] **Step 5: Commit**

```bash
git add server/audio/prompt_rewriter_sidecar.py
git commit -m "feat(audio): add Llama 3.2 3B prompt rewriter sidecar (MLX)"
```

---

## Task 4: TS wrapper — write the failing test first

**Files:**
- Create: `server/test/prompt-rewriter-sidecar.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `server/test/prompt-rewriter-sidecar.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// In-memory fake child_process for sidecar tests.
const fakeChild = {
  stdin: new EventEmitter() as EventEmitter & { write: (data: string, cb?: (err?: Error) => void) => void; writable: boolean },
  stdout: new EventEmitter(),
  stderr: new EventEmitter(),
  killed: false,
  kill: vi.fn(),
  on: vi.fn(),
};

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const child: any = {
      stdin: { write: vi.fn((_d: string, cb?: (err?: Error) => void) => { cb && cb(); }), writable: true },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      killed: false,
      kill: vi.fn(function (this: any) { this.killed = true; }),
      on: vi.fn((evt: string, cb: any) => {
        // Wire 'on' to the EventEmitter via stdout/stderr already.
        if (evt === 'exit') (child as any)._exit = cb;
        if (evt === 'error') (child as any)._error = cb;
      }),
    };
    (fakeChild as any)._latest = child;
    // Emit "Ready for requests" on next tick to unblock ensureRunning.
    setImmediate(() => child.stderr.emit('data', Buffer.from('[rewriter-sidecar] Ready for requests.\n')));
    return child;
  }),
}));

// fs.existsSync is used to check for the venv python — return true so we use the venv path.
vi.mock('fs', async (orig) => {
  const real = (await orig()) as typeof import('fs');
  return { ...real, existsSync: vi.fn(() => true) };
});

describe('prompt-rewriter-sidecar', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it('returns rewritten text for a transcript', async () => {
    const mod = await import('../src/audio/prompt-rewriter-sidecar');
    const child = (await import('child_process')).spawn as any;
    const promise = mod.rewrite('also ähm ich will halt');

    // Wait one tick for the spawn + ready signal + request flush.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const last = (child as any).mock.results.at(-1).value as any;
    last.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ id: 'req-1', text: 'Bitte erweitere die Transkription.' }) + '\n'),
    );

    const text = await promise;
    expect(text).toBe('Bitte erweitere die Transkription.');
  });

  it('rejects on sidecar error response', async () => {
    const mod = await import('../src/audio/prompt-rewriter-sidecar');
    const child = (await import('child_process')).spawn as any;
    const promise = mod.rewrite('etwas');

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const last = (child as any).mock.results.at(-1).value as any;
    last.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ id: 'req-1', error: 'kaputt' }) + '\n'),
    );

    await expect(promise).rejects.toThrow(/kaputt/);
  });

  it('throws RewriterBusyError when a request is already in flight', async () => {
    const mod = await import('../src/audio/prompt-rewriter-sidecar');
    const child = (await import('child_process')).spawn as any;
    const first = mod.rewrite('eins');

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    await expect(mod.rewrite('zwei')).rejects.toThrow(/bereits/i);

    // Resolve the first one so we don't leak a pending promise.
    const last = (child as any).mock.results.at(-1).value as any;
    last.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ id: 'req-1', text: 'fertig' }) + '\n'),
    );
    await first;
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server"
npx vitest run test/prompt-rewriter-sidecar.test.ts
```

Expected: FAIL with "Cannot find module '../src/audio/prompt-rewriter-sidecar'".

---

## Task 5: TS wrapper — implementation

**Files:**
- Create: `server/src/audio/prompt-rewriter-sidecar.ts`

- [ ] **Step 1: Write the wrapper**

Path: `server/src/audio/prompt-rewriter-sidecar.ts`

```typescript
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { logger } from '../utils/logger';

interface PendingRequest {
  id: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const TIMEOUT_MS = 30_000;

function findServerRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (require('fs').existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..', '..');
}

const SERVER_ROOT = findServerRoot();
const SIDECAR_DIR = path.join(SERVER_ROOT, 'audio');
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'prompt_rewriter_sidecar.py');
const VENV_PYTHON = path.join(SIDECAR_DIR, '.venv-rewriter', 'bin', 'python3');

let sidecar: ChildProcess | null = null;
let lineBuffer = '';
let requestId = 0;
let activeRequest: PendingRequest | null = null;
let startPromise: Promise<void> | null = null;

export class RewriterBusyError extends Error {
  constructor() {
    super('Prompt-Rewrite läuft bereits. Bitte warten.');
    this.name = 'RewriterBusyError';
  }
}

function killSidecar(reason: string): void {
  if (sidecar && !sidecar.killed) {
    logger.warn(`[rewriter] Killing sidecar: ${reason}`);
    sidecar.kill('SIGKILL');
  }
  sidecar = null;
  startPromise = null;
  lineBuffer = '';
}

function failActive(err: Error): void {
  if (!activeRequest) return;
  const req = activeRequest;
  activeRequest = null;
  clearTimeout(req.timer);
  req.reject(err);
}

function ensureRunning(): Promise<void> {
  if (sidecar && !sidecar.killed) return Promise.resolve();
  if (startPromise) return startPromise;

  startPromise = new Promise<void>((resolve, reject) => {
    logger.info('[rewriter] Starting sidecar...');

    const fs = require('fs');
    const pythonBin = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';
    logger.info(`[rewriter] Using Python: ${pythonBin}`);

    const child = spawn(pythonBin, [SIDECAR_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolved = false;

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      logger.info(`[rewriter] ${text.trim()}`);
      if (!resolved && text.includes('Ready for requests')) {
        resolved = true;
        startPromise = null;
        sidecar = child;
        resolve();
      }
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          const req = activeRequest;
          if (!req || req.id !== resp.id) continue;

          activeRequest = null;
          clearTimeout(req.timer);
          if (resp.error) {
            req.reject(new Error(resp.error));
          } else {
            req.resolve(resp.text ?? '');
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    child.on('exit', (code) => {
      logger.warn(`[rewriter] Sidecar exited with code ${code}`);
      const wasResolved = resolved;
      sidecar = null;
      startPromise = null;
      failActive(new Error('Rewriter sidecar exited unexpectedly'));
      if (!wasResolved) reject(new Error('Rewriter sidecar failed to start'));
    });

    child.on('error', (err) => {
      logger.error(`[rewriter] Failed to spawn sidecar: ${err.message}`);
      sidecar = null;
      startPromise = null;
      if (!resolved) {
        reject(new Error(`Rewriter nicht verfuegbar: ${err.message}. Installieren mit: pip install mlx-lm`));
      }
    });
  });

  return startPromise;
}

export function isBusy(): boolean {
  return activeRequest !== null;
}

export async function rewrite(transcript: string): Promise<string> {
  if (activeRequest) throw new RewriterBusyError();

  await ensureRunning();

  if (!sidecar?.stdin?.writable) {
    throw new Error('Rewriter sidecar is not running');
  }

  const id = `req-${++requestId}`;
  logger.info(`[rewriter] Request ${id}: ${transcript.length} chars`);

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      killSidecar(`request ${id} timed out after ${TIMEOUT_MS}ms`);
      failActive(new Error(`Prompt-Rewrite Timeout (${Math.round(TIMEOUT_MS / 1000)}s).`));
    }, TIMEOUT_MS);

    activeRequest = { id, resolve, reject, timer };

    const request = JSON.stringify({ id, transcript }) + '\n';
    sidecar!.stdin!.write(request, (err) => {
      if (err) {
        logger.error(`[rewriter] stdin write failed: ${err.message}`);
        killSidecar('stdin write failed');
        failActive(new Error(`Prompt-Rewrite fehlgeschlagen: ${err.message}`));
      }
    });
  });
}

export function shutdown(): void {
  killSidecar('shutdown');
}
```

- [ ] **Step 2: Run the test, expect green**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server"
npx vitest run test/prompt-rewriter-sidecar.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 3: Run the full server test suite**

```bash
npx vitest run
```

Expected: all existing tests still green, total includes the 3 new ones.

- [ ] **Step 4: TS check**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/audio/prompt-rewriter-sidecar.ts server/test/prompt-rewriter-sidecar.test.ts
git commit -m "feat(audio): TS wrapper for prompt rewriter sidecar with tests"
```

---

## Task 6: Wire shutdown handler

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Import shutdown alias**

In `server/src/index.ts:18`, add a new import line below the TTS shutdown import:

```typescript
import { shutdown as shutdownTts } from './audio/tts-sidecar';
import { shutdown as shutdownRewriter } from './audio/prompt-rewriter-sidecar';
```

- [ ] **Step 2: Call shutdown in the graceful-shutdown function**

In `server/src/index.ts`, inside the `shutdown` function (around line 247), add a call right after `shutdownTts();`:

```typescript
    shutdownWhisper();
    shutdownTts();
    shutdownRewriter();
```

- [ ] **Step 3: TS check**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server"
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(audio): kill rewriter sidecar on server shutdown"
```

---

## Task 7: Wire ws.handler.ts to invoke the rewriter

**Files:**
- Modify: `server/src/websocket/ws.handler.ts:15` (imports), `server/src/websocket/ws.handler.ts:802-833` (handler block)

- [ ] **Step 1: Add the rewriter import**

Find the existing line:

```typescript
import { transcribe as whisperTranscribe, WhisperBusyError } from '../audio/whisper-sidecar';
```

Add directly below it:

```typescript
import { rewrite as rewritePrompt } from '../audio/prompt-rewriter-sidecar';
```

- [ ] **Step 2: Replace the `audio:transcribe` handler block**

Replace `server/src/websocket/ws.handler.ts:802-833` with:

```typescript
    if (msgType === 'audio:transcribe') {
      const sessionId = (msg as any).sessionId;
      const audio = (msg as any).payload?.audio;
      const format = (msg as any).payload?.format;
      const enhance = (msg as any).payload?.enhance === true;

      if (!isValidSessionId(sessionId)) {
        send(ws, { type: 'audio:error', sessionId: 'none', payload: { message: 'Invalid sessionId' } } as any);
        return;
      }
      if (typeof audio !== 'string' || audio.length === 0) {
        send(ws, { type: 'audio:error', sessionId, payload: { message: 'Keine Audiodaten empfangen' } } as any);
        return;
      }
      if (format !== 'wav') {
        send(ws, { type: 'audio:error', sessionId, payload: { message: 'Nur WAV-Format unterstuetzt' } } as any);
        return;
      }

      whisperTranscribe(audio, {
        onProgress: (info) => {
          send(ws, { type: 'audio:progress', sessionId, payload: { chunk: info.chunk, total: info.total, text: info.text } } as any);
        },
      }).then(async (text) => {
        if (!enhance || !text.trim()) {
          send(ws, { type: 'audio:transcription', sessionId, payload: { text } } as any);
          return;
        }
        try {
          const enhanced = await rewritePrompt(text);
          send(ws, { type: 'audio:transcription', sessionId, payload: { text: enhanced } } as any);
        } catch (rewriteErr) {
          const reason = rewriteErr instanceof Error ? rewriteErr.message : String(rewriteErr);
          logger.warn(`[rewriter] Falling back to raw transcript: ${reason}`);
          // Soft-fail: still deliver the raw Whisper text so the user is never blocked.
          send(ws, { type: 'audio:transcription', sessionId, payload: { text } } as any);
        }
      }).catch((err) => {
        const busy = err instanceof WhisperBusyError;
        const message = err instanceof Error ? err.message : 'Transkription fehlgeschlagen';
        if (!busy) logger.warn(`[whisper] Transcription failed: ${message}`);
        send(ws, { type: 'audio:error', sessionId, payload: { message, busy } } as any);
      });
      return;
    }
```

- [ ] **Step 3: TS check + full test run**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server"
npx tsc --noEmit && npx vitest run
```

Expected: clean compile, all tests green.

- [ ] **Step 4: Commit**

```bash
git add server/src/websocket/ws.handler.ts
git commit -m "feat(audio): pipe Whisper output through prompt rewriter when enhance=true"
```

---

## Task 8: Mobile — settings store flag

**Files:**
- Modify: `mobile/src/store/settingsStore.ts`

- [ ] **Step 1: Add the field, setter, default, and persisted state**

Insert into the `SettingsState` interface (after `setPersistentConnection`):

```typescript
  /** When true, voice transcripts are rewritten into polished AI prompts via the local rewriter sidecar. Default: false. */
  voicePromptEnhanceEnabled: boolean;
  setVoicePromptEnhanceEnabled: (enabled: boolean) => void;
```

Inside the `create<SettingsState>()(persist(...))` callback, append after `setPersistentConnection`:

```typescript
      voicePromptEnhanceEnabled: false,
      setVoicePromptEnhanceEnabled(enabled: boolean) {
        set({ voicePromptEnhanceEnabled: enabled });
      },
```

- [ ] **Step 2: Type-check the mobile project**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add mobile/src/store/settingsStore.ts
git commit -m "feat(settings): add voicePromptEnhanceEnabled flag"
```

---

## Task 9: Mobile — add the Switch in SettingsScreen

**Files:**
- Modify: `mobile/src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Pull the new flag + setter from the store**

Find the destructure at line 26:

```typescript
const { idleThresholdSeconds, setIdleThreshold, terminalTheme, setTerminalTheme, externalKeyboardMode, setExternalKeyboardMode, lockGraceSeconds, setLockGrace, persistentConnection, setPersistentConnection } = useSettingsStore();
```

Replace with:

```typescript
const { idleThresholdSeconds, setIdleThreshold, terminalTheme, setTerminalTheme, externalKeyboardMode, setExternalKeyboardMode, lockGraceSeconds, setLockGrace, persistentConnection, setPersistentConnection, voicePromptEnhanceEnabled, setVoicePromptEnhanceEnabled } = useSettingsStore();
```

- [ ] **Step 2: Add a new "Sprache" section with the Switch**

Find the closing `</View>` of the Terminal section (the one that contains "Verbindung im Hintergrund"). Directly after that section's closing `</View>` for the outer `section` View (look for the next opening `{/* ── Terminal ── */}` block end), insert this new section block:

```tsx
        {/* ── Sprache ── */}
        <View style={[styles.section, { marginBottom: rs(28) }]}>
          <Text style={[styles.sectionTitle, { fontSize: rf(11), marginBottom: rs(10) }]}>Sprache</Text>

          <View style={styles.card}>
            <TouchableOpacity
              style={[styles.row, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}
              onPress={() => setVoicePromptEnhanceEnabled(!voicePromptEnhanceEnabled)}
              activeOpacity={0.7}
              accessibilityRole="switch"
              accessibilityState={{ checked: voicePromptEnhanceEnabled }}
            >
              <View style={styles.rowLeft}>
                <Feather name="zap" size={ri(18)} color={voicePromptEnhanceEnabled ? colors.primary : colors.textMuted} style={{ marginRight: rs(12) }} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.label, { fontSize: rf(16) }]}>KI-Prompt-Modus</Text>
                  <Text style={[styles.rowSub, { fontSize: rf(11) }]}>Sprach-Eingabe wird in einen optimierten Prompt umgewandelt</Text>
                </View>
              </View>
              <Switch
                value={voicePromptEnhanceEnabled}
                onValueChange={setVoicePromptEnhanceEnabled}
                trackColor={{ false: colors.border, true: colors.primary + '88' }}
                thumbColor={voicePromptEnhanceEnabled ? colors.primary : colors.textDim}
              />
            </TouchableOpacity>
          </View>
        </View>
```

If the exact insertion anchor is unclear, place this section directly above the next `{/* ── ... ── */}` section comment that follows the Terminal section.

- [ ] **Step 3: Type-check**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/screens/SettingsScreen.tsx
git commit -m "feat(settings): KI-Prompt-Modus toggle in settings screen"
```

---

## Task 10: Mobile — TerminalToolbar sends `enhance` flag

**Files:**
- Modify: `mobile/src/components/TerminalToolbar.tsx:27` (existing read), `mobile/src/components/TerminalToolbar.tsx:134-138`

- [ ] **Step 1: Read the new flag from the store**

Find line 27:

```typescript
const audioInputEnabled = useSettingsStore((s) => s.audioInputEnabled);
```

Add directly below it:

```typescript
const voicePromptEnhanceEnabled = useSettingsStore((s) => s.voicePromptEnhanceEnabled);
```

- [ ] **Step 2: Include `enhance` in the send payload**

Replace the `wsService.send({...})` block at lines 134-138:

```typescript
        wsService.send({
          type: 'audio:transcribe',
          sessionId,
          payload: { audio: base64, format: 'wav', enhance: voicePromptEnhanceEnabled },
        });
```

- [ ] **Step 3: Type-check**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
npx tsc --noEmit
```

Expected: clean.

---

## Task 11: Mobile — OrbLayer sends `enhance` flag

**Files:**
- Modify: `mobile/src/components/OrbLayer.tsx`

- [ ] **Step 1: Pull the flag from settings**

Find an existing `useSettingsStore(...)` call near the top of the component (or add one). Add a selector:

```typescript
const voicePromptEnhanceEnabled = useSettingsStore((s) => s.voicePromptEnhanceEnabled);
```

If `useSettingsStore` is not yet imported in this file, add the import:

```typescript
import { useSettingsStore } from '../store/settingsStore';
```

- [ ] **Step 2: Update the send call at line 358**

Replace:

```typescript
wsService?.send({ type: 'audio:transcribe', sessionId, payload: { audio: base64, format: 'wav' } });
```

with:

```typescript
wsService?.send({ type: 'audio:transcribe', sessionId, payload: { audio: base64, format: 'wav', enhance: voicePromptEnhanceEnabled } });
```

- [ ] **Step 3: Type-check**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
npx tsc --noEmit
```

Expected: clean.

---

## Task 12: Mobile — ManagerChatScreen sends `enhance` flag

**Files:**
- Modify: `mobile/src/screens/ManagerChatScreen.tsx:1032-1036`

- [ ] **Step 1: Pull the flag from settings**

Find the existing `useSettingsStore` import / hook at the top of the file (search for `useSettingsStore`). If a selector is already destructured, add `voicePromptEnhanceEnabled`. Otherwise, add a fresh selector inside the component body:

```typescript
const voicePromptEnhanceEnabled = useSettingsStore((s) => s.voicePromptEnhanceEnabled);
```

If `useSettingsStore` is not yet imported, add:

```typescript
import { useSettingsStore } from '../store/settingsStore';
```

- [ ] **Step 2: Replace the `wsService.send` block at lines 1032-1036**

```typescript
        wsService.send({
          type: 'audio:transcribe',
          sessionId: 'manager',
          payload: { audio: base64, format: 'wav', enhance: voicePromptEnhanceEnabled },
        } as any);
```

- [ ] **Step 3: Type-check**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit all three mobile send sites**

```bash
git add mobile/src/components/TerminalToolbar.tsx mobile/src/components/OrbLayer.tsx mobile/src/screens/ManagerChatScreen.tsx
git commit -m "feat(audio): send enhance flag from all transcription sites"
```

---

## Task 13: Manual end-to-end test

**Files:**
- None

- [ ] **Step 1: Start the dev server**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/server"
npm run dev
```

Wait for `[rewriter] Ready for requests.` in the logs (model load takes ~3-10s on first run).

- [ ] **Step 2: Build mobile dev APK and install**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
./deploy.sh adb
```

- [ ] **Step 3: Test path A — toggle OFF (default)**

In the app: open Terminal, tap the mic, say "Test eins zwei drei". Stop. Verify transcript appears in input field as plain Whisper output (no rewriting).

- [ ] **Step 4: Test path B — toggle ON, Terminal**

Open Settings → "Sprache" → enable "KI-Prompt-Modus". Open Terminal, tap mic, say something rambling like "also ähm ich will halt dass git status ausgeführt wird sozusagen". Stop. Verify the input field receives a polished prompt (e.g. "Bitte führe `git status` aus.").

- [ ] **Step 5: Test path C — toggle ON, Manager Chat**

Open Manager Chat, tap mic, speak rambling text. Verify the input field receives a polished prompt.

- [ ] **Step 6: Test path D — sidecar failure soft-fall-back**

Manually kill the rewriter Python process while it's idle (`pgrep -f prompt_rewriter_sidecar | xargs kill`). Trigger a transcription with toggle ON. Expected: server restarts the sidecar OR (if startup fails) the user receives the raw Whisper transcript with a warning in server logs — never a stuck UI.

- [ ] **Step 7: Verify shutdown kills the sidecar**

Stop the server with Ctrl-C. Verify `pgrep -f prompt_rewriter_sidecar` returns nothing.

---

## Task 14: Memory + version bump + final commit

**Files:**
- Modify: `memory/project-state.md`, `memory/journal.md`
- Modify: `server/package.json` (version bump optional — only if you ship via tms-terminal CLI)

- [ ] **Step 1: Update `memory/project-state.md`**

Edit "Aktuelle Version" and "Zuletzt abgeschlossene Features" to mention the new Voice-Prompt-Enhancer feature on `feat/voice-prompt-enhancer`. Use the existing entry style.

- [ ] **Step 2: Append a new entry to `memory/journal.md`**

Add at the top:

```markdown
## 2026-04-26 — Voice Prompt Enhancer

- Neue lokale Llama 3.2 3B Instruct (MLX) Sidecar-Pipeline, optional zwischen Whisper-Output und Mobile.
- Toggle in Settings → Sprache → "KI-Prompt-Modus" (default off).
- Wirkt für Terminal-Toolbar-Mic, Floating-Orb-Mic und Manager-Chat-Mic gleichermaßen.
- Soft-Fall-Back: bei Rewriter-Fehlern bekommt der User den rohen Whisper-Text.
- Branch: `feat/voice-prompt-enhancer`.
```

- [ ] **Step 3: Final commit**

```bash
git add memory/project-state.md memory/journal.md
git commit -m "memory: log voice prompt enhancer feature"
```

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feat/voice-prompt-enhancer
```

---

## Self-Review Notes

- **Spec coverage:** Toggle-in-settings ✅ (Task 9), Llama 3.2 3B Instruct via MLX ✅ (Task 3), editable in input field ✅ (no mobile receive-side change needed — existing `onTranscription` already inserts text into the input field where the user edits before pressing Enter), works for Terminal + Chat ✅ (Tasks 10–12), single code path ✅ (one wrapper, one toggle), local + fast ✅ (sub-300ms target after model warm-up).
- **No placeholders:** every step contains exact paths, code, and commands.
- **Type consistency:** `rewrite()` and `RewriterBusyError` are used consistently in Tasks 4–7. The protocol field `enhance` is named identically in all three send sites and the server handler. The settings field `voicePromptEnhanceEnabled` is named identically in store + screen + send sites.
- **Edge cases covered:** empty transcript skips rewriter (Task 7), sidecar failure soft-falls-back to raw Whisper (Task 7), busy guard on the sidecar (Task 5), shutdown handler (Task 6), watchdog already exists in mobile and is unaffected.

## Out of scope

- Showing a UI indicator that the rewriter is currently running (no progress event added — round-trip is short enough).
- Per-app system-prompt customization (single shared prompt for now; add later if needed).
- A "blitz"-style global hotkey or cross-app dictation — this stays inside the TMS Terminal app.
- Pre-warming the rewriter at server startup. Currently lazy-loaded on first use; first request after server start pays the ~3-10s model-load cost.
