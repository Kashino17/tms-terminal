# Audio Transcription (Speech-to-Text) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add voice-to-text input to the terminal — record audio on the mobile app, send it to the TMS server which runs Whisper locally, and inject the transcription into the terminal input field.

**Architecture:** Python Whisper sidecar process managed by the Node.js server, communicating over stdin/stdout JSON Lines. Mobile app records WAV audio via expo-av, sends base64 over the existing WebSocket, and injects transcribed text into the xterm.js shadow input.

**Tech Stack:** Python 3 + openai-whisper + PyTorch (MPS), Node.js child_process, expo-av (Audio.Recording), React Native Animated

---

### Task 1: Add Protocol Types (shared)

**Files:**
- Modify: `shared/protocol.ts:56-73` (add new interfaces + union members)

- [ ] **Step 1: Add audio message interfaces to shared/protocol.ts**

After the `SystemKillMessage` interface (line 56) and before the `ClientMessage` union (line 58), add:

```typescript
// ── Audio messages (Client → Server) ──────────────────────────
export interface AudioTranscribeMessage {
  type: 'audio:transcribe';
  sessionId: string;
  payload: { audio: string; format: 'wav' };
}
```

Then after the `SystemKillResultMessage` interface (line 154) and before the `ServerMessage` union (line 179), add:

```typescript
// ── Audio responses (Server → Client) ──────────────────────────
export interface AudioTranscriptionMessage {
  type: 'audio:transcription';
  sessionId: string;
  payload: { text: string };
}

export interface AudioErrorMessage {
  type: 'audio:error';
  sessionId: string;
  payload: { message: string };
}
```

- [ ] **Step 2: Add to union types**

Add `AudioTranscribeMessage` to the `ClientMessage` union:

```typescript
export type ClientMessage =
  | TerminalCreateMessage
  // ... existing members ...
  | SystemKillMessage
  | AudioTranscribeMessage;
```

Add `AudioTranscriptionMessage` and `AudioErrorMessage` to the `ServerMessage` union:

```typescript
export type ServerMessage =
  // ... existing members ...
  | SystemKillResultMessage
  | AudioTranscriptionMessage
  | AudioErrorMessage;
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/ayysir/Desktop/TMS\ Terminal/server && npx tsc --noEmit`
Expected: No errors (or only pre-existing ones)

- [ ] **Step 4: Commit**

```bash
git add shared/protocol.ts
git commit -m "feat(protocol): add audio:transcribe, audio:transcription, audio:error message types"
```

---

### Task 2: Create Python Whisper Sidecar Script

**Files:**
- Create: `server/audio/whisper_sidecar.py`

- [ ] **Step 1: Create the sidecar script**

```python
#!/usr/bin/env python3
"""Whisper sidecar — long-running process for audio transcription.

Reads JSON Lines from stdin, transcribes audio with Whisper, writes JSON Lines to stdout.

Protocol:
  Request:  {"id": "req-1", "audio_base64": "UklGR...", "language": "de"}
  Response: {"id": "req-1", "text": "transkribierter text"}
  Error:    {"id": "req-1", "error": "reason"}
"""

import sys
import json
import base64
import tempfile
import os

def main():
    # Force stdout to be line-buffered so Node.js gets responses immediately
    sys.stdout.reconfigure(line_buffering=True)

    sys.stderr.write("[whisper-sidecar] Loading model large-v3 on MPS...\n")
    sys.stderr.flush()

    try:
        import whisper
        import torch
    except ImportError as e:
        # Send error and exit — Node.js will catch the exit and report to client
        sys.stderr.write(f"[whisper-sidecar] Missing dependency: {e}\n")
        sys.stderr.write("[whisper-sidecar] Install with: pip3 install openai-whisper torch\n")
        sys.stderr.flush()
        sys.exit(1)

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    sys.stderr.write(f"[whisper-sidecar] Using device: {device}\n")
    sys.stderr.flush()

    model = whisper.load_model("large-v3", device=device)

    sys.stderr.write("[whisper-sidecar] Model loaded. Ready for requests.\n")
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
        audio_b64 = req.get("audio_base64", "")
        language = req.get("language", "de")

        if not audio_b64:
            response = {"id": req_id, "error": "No audio data provided"}
            print(json.dumps(response))
            continue

        # Write audio to temp file (Whisper needs a file path)
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav")
        try:
            audio_bytes = base64.b64decode(audio_b64)
            os.write(tmp_fd, audio_bytes)
            os.close(tmp_fd)

            result = model.transcribe(tmp_path, language=language, fp16=False)
            text = result.get("text", "").strip()

            response = {"id": req_id, "text": text}
            print(json.dumps(response))
        except Exception as e:
            response = {"id": req_id, "error": str(e)}
            print(json.dumps(response))
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Make executable**

Run: `chmod +x /Users/ayysir/Desktop/TMS\ Terminal/server/audio/whisper_sidecar.py`

- [ ] **Step 3: Test script manually (smoke test)**

Run:
```bash
echo '{"id":"test","audio_base64":"","language":"de"}' | python3 /Users/ayysir/Desktop/TMS\ Terminal/server/audio/whisper_sidecar.py
```
Expected: stderr shows "Missing dependency" (if whisper not installed) or loads model then outputs `{"id":"test","error":"No audio data provided"}`

- [ ] **Step 4: Commit**

```bash
git add server/audio/whisper_sidecar.py
git commit -m "feat(server): add Python Whisper sidecar script for local STT"
```

---

### Task 3: Create Node.js Whisper Sidecar Manager

**Files:**
- Create: `server/src/audio/whisper-sidecar.ts`

- [ ] **Step 1: Create the sidecar manager**

```typescript
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { logger } from '../utils/logger';

interface PendingRequest {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const TRANSCRIBE_TIMEOUT_MS = 30_000;
const SIDECAR_SCRIPT = path.resolve(__dirname, '..', '..', 'audio', 'whisper_sidecar.py');

let process: ChildProcess | null = null;
let buffer = '';
let requestId = 0;
const pending = new Map<string, PendingRequest>();
let starting = false;
let startPromise: Promise<void> | null = null;

function ensureRunning(): Promise<void> {
  if (process && !process.killed) return Promise.resolve();
  if (startPromise) return startPromise;

  starting = true;
  startPromise = new Promise<void>((resolve, reject) => {
    logger.info('[whisper] Starting sidecar...');

    const child = spawn('python3', [SIDECAR_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolved = false;

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      logger.info(`[whisper] ${text.trim()}`);
      // Resolve once the model is loaded and ready
      if (!resolved && text.includes('Ready for requests')) {
        resolved = true;
        starting = false;
        startPromise = null;
        process = child;
        resolve();
      }
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          const id = resp.id as string;
          const req = pending.get(id);
          if (!req) continue;
          pending.delete(id);
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
      logger.warn(`[whisper] Sidecar exited with code ${code}`);
      process = null;
      starting = false;
      startPromise = null;
      // Reject all pending requests
      for (const [id, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Whisper sidecar exited unexpectedly'));
        pending.delete(id);
      }
      if (!resolved) {
        reject(new Error('Whisper sidecar failed to start'));
      }
    });

    child.on('error', (err) => {
      logger.error(`[whisper] Failed to spawn sidecar: ${err.message}`);
      process = null;
      starting = false;
      startPromise = null;
      if (!resolved) {
        reject(new Error(`Whisper nicht verfuegbar: ${err.message}. Installieren mit: pip3 install openai-whisper torch`));
      }
    });
  });

  return startPromise;
}

export async function transcribe(audioBase64: string, language = 'de'): Promise<string> {
  await ensureRunning();

  if (!process?.stdin?.writable) {
    throw new Error('Whisper sidecar is not running');
  }

  const id = `req-${++requestId}`;

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Transkription Timeout (30s)'));
    }, TRANSCRIBE_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });

    const request = JSON.stringify({ id, audio_base64: audioBase64, language }) + '\n';
    process!.stdin!.write(request);
  });
}

export function shutdown(): void {
  if (process && !process.killed) {
    process.kill('SIGTERM');
    process = null;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/ayysir/Desktop/TMS\ Terminal/server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/src/audio/whisper-sidecar.ts
git commit -m "feat(server): add Node.js whisper sidecar manager (spawn + JSON Lines IPC)"
```

---

### Task 4: Add audio:transcribe Handler to WebSocket Server

**Files:**
- Modify: `server/src/websocket/ws.handler.ts:188-333` (extension message block)

- [ ] **Step 1: Import the sidecar module**

At the top of `ws.handler.ts`, add after the existing imports (line 10):

```typescript
import { transcribe as whisperTranscribe } from '../audio/whisper-sidecar';
```

- [ ] **Step 2: Add the audio:transcribe handler**

In the extension message block (after the `autopilot:queue_toggle` handler around line 333, before the `switch (msg.type)` at line 335), add:

```typescript
    if (msgType === 'audio:transcribe') {
      const sessionId = (msg as any).sessionId;
      const audio = (msg as any).payload?.audio;
      const format = (msg as any).payload?.format;

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

      whisperTranscribe(audio).then((text) => {
        send(ws, { type: 'audio:transcription', sessionId, payload: { text } } as any);
      }).catch((err) => {
        const message = err instanceof Error ? err.message : 'Transkription fehlgeschlagen';
        logger.warn(`[whisper] Transcription failed: ${message}`);
        send(ws, { type: 'audio:error', sessionId, payload: { message } } as any);
      });
      return;
    }
```

- [ ] **Step 3: Import shutdown in server index for graceful exit**

Read `server/src/index.ts` and add at the appropriate shutdown/exit handler:

```typescript
import { shutdown as shutdownWhisper } from './audio/whisper-sidecar';
```

Call `shutdownWhisper()` in the server's shutdown/exit path (e.g. SIGTERM handler).

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/ayysir/Desktop/TMS\ Terminal/server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add server/src/websocket/ws.handler.ts server/src/index.ts
git commit -m "feat(server): handle audio:transcribe messages, route to whisper sidecar"
```

---

### Task 5: Add audioInputEnabled Setting (Mobile)

**Files:**
- Modify: `mobile/src/store/settingsStore.ts`

- [ ] **Step 1: Add audioInputEnabled to the settings store**

In `settingsStore.ts`, add to the `SettingsState` interface (after `setTerminalTheme` on line 11):

```typescript
  /** Whether the microphone button is shown in the toolbar. Default: true. */
  audioInputEnabled: boolean;
  setAudioInputEnabled: (enabled: boolean) => void;
```

And in the `persist` initializer (after `setTerminalTheme` on line 32):

```typescript
      audioInputEnabled: true,
      setAudioInputEnabled(enabled: boolean) {
        set({ audioInputEnabled: enabled });
      },
```

- [ ] **Step 2: Commit**

```bash
git add mobile/src/store/settingsStore.ts
git commit -m "feat(mobile): add audioInputEnabled setting to settingsStore"
```

---

### Task 6: Add RECORD_AUDIO Permission (Mobile)

**Files:**
- Modify: `mobile/app.json`

- [ ] **Step 1: Add expo-av plugin with microphone permission**

In `app.json`, add `expo-av` to the plugins array. The existing plugins are `withCleartextTraffic` and `expo-secure-store`. Add after them:

```json
{
  "expo": {
    "plugins": [
      "./plugins/withCleartextTraffic",
      "expo-secure-store",
      [
        "expo-av",
        {
          "microphonePermission": "TMS Terminal benoetigt Zugriff auf das Mikrofon fuer Spracheingabe."
        }
      ]
    ]
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add mobile/app.json
git commit -m "feat(mobile): add RECORD_AUDIO permission via expo-av plugin"
```

---

### Task 7: Add Microphone Button to TerminalToolbar

**Files:**
- Modify: `mobile/src/components/TerminalToolbar.tsx`

This is the main UI task. The button has three states: idle, recording, processing.

- [ ] **Step 1: Add imports and state**

At the top of `TerminalToolbar.tsx`, add imports:

```typescript
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { useSettingsStore } from '../store/settingsStore';
```

Inside the `TerminalToolbar` component, add state after `const [arrowsOpen, setArrowsOpen] = useState(false);` (line 21):

```typescript
  const audioInputEnabled = useSettingsStore((s) => s.audioInputEnabled);
  const [micState, setMicState] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [recordingDuration, setRecordingDuration] = useState(0);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
```

- [ ] **Step 2: Add pulse animation effect**

After the existing keyboard `useEffect` (after line 32), add:

```typescript
  useEffect(() => {
    if (micState === 'recording') {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.5, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [micState]);
```

- [ ] **Step 3: Add the mic tap handler**

After the `send` function (after line 38), add:

```typescript
  const handleMicPress = async () => {
    if (micState === 'processing') return;

    if (micState === 'recording') {
      // Stop recording and send
      if (durationTimerRef.current) { clearInterval(durationTimerRef.current); durationTimerRef.current = null; }
      setMicState('processing');
      try {
        const recording = recordingRef.current;
        if (!recording) return;
        await recording.stopAndUnloadAsync();
        const uri = recording.getURI();
        recordingRef.current = null;
        if (!uri || !sessionId) { setMicState('idle'); return; }

        const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
        await FileSystem.deleteAsync(uri, { idempotent: true });

        wsService.send({
          type: 'audio:transcribe',
          sessionId,
          payload: { audio: base64, format: 'wav' },
        });
      } catch (err) {
        console.warn('[mic] Error stopping recording:', err);
        setMicState('idle');
      }
      return;
    }

    // Start recording
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) { console.warn('[mic] Permission denied'); return; }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync({
        android: {
          extension: '.wav',
          outputFormat: 3,        // THREE_GPP workaround — actual format set by sampleRate/channels
          audioEncoder: 1,        // DEFAULT
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 256000,
        },
        ios: {
          extension: '.wav',
          audioQuality: 96,       // Audio.IOSAudioQuality.HIGH
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 256000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
          outputFormat: 'lpcm',
        },
        web: {},
      });

      recordingRef.current = recording;
      setRecordingDuration(0);
      setMicState('recording');
      durationTimerRef.current = setInterval(() => {
        setRecordingDuration((d) => d + 1);
      }, 1000);
    } catch (err) {
      console.warn('[mic] Error starting recording:', err);
      setMicState('idle');
    }
  };
```

- [ ] **Step 4: Add the mic button to the JSX**

In the return JSX, after the Enter `BigBtn` (line 111) and before the closing `</Animated.View>` (line 112), add:

```tsx
      {audioInputEnabled && (
        <>
          <View style={s.sep} />
          <Animated.View style={{ opacity: micState === 'recording' ? pulseAnim : 1 }}>
            <TouchableOpacity
              style={[
                s.bigBtn,
                { height: h },
                micState === 'recording' && { backgroundColor: 'rgba(239,68,68,0.15)', borderWidth: StyleSheet.hairlineWidth, borderColor: '#ef4444' },
                micState === 'processing' && { opacity: 0.5 },
              ]}
              onPress={handleMicPress}
              activeOpacity={0.6}
              disabled={micState === 'processing'}
            >
              {micState === 'processing'
                ? <Feather name="loader" size={lg} color={colors.textDim} />
                : <Feather name="mic" size={lg} color={micState === 'recording' ? '#ef4444' : colors.textDim} />
              }
            </TouchableOpacity>
          </Animated.View>
          {micState === 'recording' && (
            <Text style={[s.keyText, { fontSize: fontSz, color: '#ef4444', minWidth: 28, textAlign: 'center' }]}>
              {Math.floor(recordingDuration / 60)}:{String(recordingDuration % 60).padStart(2, '0')}
            </Text>
          )}
        </>
      )}
```

- [ ] **Step 5: Add the transcription response listener**

Add a `useEffect` that listens for `audio:transcription` and `audio:error` messages. This needs access to `wsService` and the `onTranscription` prop. Add to the Props interface:

```typescript
  onTranscription?: (text: string) => void;
  onTranscriptionError?: (message: string) => void;
```

Add the effect inside the component:

```typescript
  useEffect(() => {
    return wsService.addMessageListener((msg: unknown) => {
      const m = msg as { type: string; sessionId?: string; payload?: any };
      if (m.sessionId !== sessionId) return;
      if (m.type === 'audio:transcription') {
        setMicState('idle');
        onTranscription?.(m.payload?.text ?? '');
      } else if (m.type === 'audio:error') {
        setMicState('idle');
        onTranscriptionError?.(m.payload?.message ?? 'Transkription fehlgeschlagen');
      }
    });
  }, [wsService, sessionId, onTranscription, onTranscriptionError]);
```

- [ ] **Step 6: Cleanup on unmount**

Add a cleanup effect to stop any in-progress recording when the component unmounts:

```typescript
  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
    };
  }, []);
```

- [ ] **Step 7: Commit**

```bash
git add mobile/src/components/TerminalToolbar.tsx
git commit -m "feat(mobile): add microphone button with recording/processing states to toolbar"
```

---

### Task 8: Wire Transcription into Terminal Input (TerminalView + TerminalScreen)

**Files:**
- Modify: `mobile/src/components/TerminalView.tsx:63-68` (TerminalViewRef)
- Modify: `mobile/src/screens/TerminalScreen.tsx`

- [ ] **Step 1: Add injectText method to TerminalViewRef**

In `TerminalView.tsx`, add to the `TerminalViewRef` interface (after `scrollToBottom` at line 67):

```typescript
  /** Injects text into the shadow input as if the user typed it. */
  injectText: (text: string) => void;
```

Add to the `useImperativeHandle` implementation (after `scrollToBottom` at line 143):

```typescript
    injectText: (text: string) => {
      if (webViewRef.current && text) {
        const msg = JSON.stringify({ type: 'inject_text', data: text });
        webViewRef.current.injectJavaScript(
          `window.postMessage(${JSON.stringify(msg)}, '*'); true;`,
        );
      }
    },
```

- [ ] **Step 2: Handle inject_text in terminalHtml.ts**

In the WebView's JavaScript message handler inside `terminalHtml.ts`, add a case for `inject_text`. Find the `window.addEventListener('message', ...)` handler and add:

```javascript
      if (msg.type === 'inject_text' && msg.data) {
        // Inject text into shadow input — same mechanism as paste
        var shadow = document.getElementById('shadow-input');
        shadow.value = msg.data;
        shadow.dispatchEvent(new Event('input', { bubbles: true }));
        // The diff-based handler will detect the new text and send it as terminal input
      }
```

- [ ] **Step 3: Wire up in TerminalScreen**

In `TerminalScreen.tsx`, pass `onTranscription` and `onTranscriptionError` to `TerminalToolbar`. The `onTranscription` callback calls `terminalViewRef.current?.injectText(text)`.

Find where `TerminalToolbar` is rendered and add the props:

```tsx
<TerminalToolbar
  sessionId={activeSessionId}
  wsService={wsService}
  rangeActive={rangeActive}
  onRangeToggle={handleRangeToggle}
  onScrollToBottom={handleScrollToBottom}
  onTranscription={(text) => terminalViewRef.current?.injectText(text)}
  onTranscriptionError={(msg) => console.warn('[audio]', msg)}
/>
```

- [ ] **Step 4: Verify the app builds**

Run: `cd /Users/ayysir/Desktop/TMS\ Terminal/mobile && npx expo export --platform android --dump-sourcemap 2>&1 | tail -5`
Expected: Build completes without errors

- [ ] **Step 5: Commit**

```bash
git add mobile/src/components/TerminalView.tsx mobile/src/components/terminalHtml.ts mobile/src/screens/TerminalScreen.tsx
git commit -m "feat(mobile): wire transcription response into terminal input via WebView bridge"
```

---

### Task 9: End-to-End Test

**Files:** None (manual testing)

- [ ] **Step 1: Install Whisper on server Mac (if not already)**

Run on the server Mac:
```bash
pip3 install openai-whisper torch
```

- [ ] **Step 2: Start TMS server**

Run: `tms-terminal`
Watch logs for `[whisper]` messages.

- [ ] **Step 3: Test from mobile app**

1. Connect to server from the app
2. Open a terminal session
3. Tap the mic button — should turn red with timer
4. Speak in German (e.g. "ls minus la")
5. Tap again — button shows spinner
6. After 3-5 seconds, transcribed text appears in the input field
7. Verify text is editable before pressing Enter

- [ ] **Step 4: Test error handling**

1. Stop the server, try recording — should show error
2. Start server without Whisper installed — should get "Whisper nicht verfuegbar" error
3. Record silence — should return empty or near-empty text

- [ ] **Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: audio transcription adjustments from E2E testing"
```
