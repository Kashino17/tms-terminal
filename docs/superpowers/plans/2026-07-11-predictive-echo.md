# Predictive Echo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix typing lag over high-latency (500ms–3s) connections by showing typed characters and backspaces instantly in the terminal WebView, before the real server echo arrives.

**Architecture:** Pure client-side addition to the WebView's inline JS (`terminalHtml.ts`). A `predictionQueue` tracks recently-predicted single-character inserts/deletes with timestamps; predictions are written to xterm immediately with underline styling. When real server output arrives, queue entries older than the current RTT estimate are dropped (assumed reflected in the incoming output) and any remaining in-flight predictions are re-rendered after the real content, so continuous typing under multi-second lag doesn't visibly flicker. A small RTT-forwarding path (`websocket.service.ts` → `TerminalView.tsx` → WebView) feeds the confirmation window.

**Tech Stack:** React Native (Expo), TypeScript, xterm.js inside a WebView, Node's built-in test runner (`node --test`) for the one pure-logic unit.

## Global Constraints

- No server changes, no WebSocket protocol changes for terminal input/output (per spec).
- The existing Samsung IME diff-based input logic in `terminalHtml.ts:240–379` must not be touched.
- Prediction scope is exactly: single printable ASCII character insert, and single backspace delete. Nothing else is predicted.
- Visual style for unconfirmed predictions: underline SGR (`\x1b[4m...\x1b[24m`), no escalating "stale" styling.
- `mobile/` has no existing test framework (no Jest config, no test scripts). Do not introduce one. The one genuinely pure, dependency-free unit (`reconcilePredictions`) is tested with Node's built-in test runner (`node --test`, zero new dependencies). Everything else is verified manually (Task 5), matching spec section 8.
- `reconcilePredictions` lives once, as a real CommonJS function in `mobile/src/utils/predictionReconcile.js`, and is spliced into the `TERMINAL_HTML` template string via `.toString()` — this avoids duplicating the logic between a testable file and the WebView's inline script blob.
- Match existing `terminalHtml.ts` code style inside the template: `var`, function expressions, no arrow functions, no destructuring (ES5-leaning, for older Android WebView JS engine compatibility).

---

### Task 1: Verify Claude Code CLI's redraw behavior (spike)

**Purpose:** The design assumes that when real server output arrives, it naturally overwrites whatever we drew locally at the same screen position (either because the CLI clears+redraws its input box, or simply because terminal writes always overwrite the cell they target). This task confirms that assumption against a real Claude Code CLI session before Tasks 2–5 are built on top of it.

**Files:**
- Modify (temporarily, reverted at the end of this task): `mobile/src/components/terminalHtml.ts:676-677`

**Interfaces:**
- Produces: a documented finding appended to `docs/superpowers/specs/2026-07-11-predictive-echo-design.md`, and a go/no-go decision for continuing with Tasks 2–5 as planned.

- [ ] **Step 1: Add temporary raw-output logging**

In `mobile/src/components/terminalHtml.ts`, the `output` case currently reads (lines 676–677):

```js
      if      (msg.type === 'output') {
        term.write(msg.data, function() {
```

Temporarily change it to:

```js
      if      (msg.type === 'output') {
        console.log('[predictive-echo-spike] raw output:', JSON.stringify(msg.data));
        term.write(msg.data, function() {
```

- [ ] **Step 2: Run the app in dev mode and open the WebView's console**

Run:
```bash
cd mobile
npm start
```

On the phone (already set up for USB/adb per the project's existing `./deploy.sh adb` workflow), open the TMS Terminal app and load a terminal session. On the desktop, open Chrome and navigate to `chrome://inspect/#devices`. Under "Remote Target", find the WebView instance belonging to the TMS Terminal app and click **inspect** — this opens a DevTools window with a Console tab showing `console.log` output from inside the WebView (react-native-webview enables content debugging by default in dev builds; if no target appears, content debugging may be off for this build — stop and report back rather than guessing at a fix).

- [ ] **Step 3: Reproduce and capture one keystroke**

In the terminal session on the phone, open (or focus) a Claude Code CLI prompt. Type a single character (e.g. "a"). In the Chrome DevTools console, find the logged line starting with `[predictive-echo-spike] raw output:` that corresponds to that keystroke, and copy the full JSON string.

- [ ] **Step 4: Interpret the finding**

Inspect the captured bytes for two things:
1. Does the sequence contain a clear/erase control sequence (e.g. `\x1b[2K`, `\x1b[K`, `\x1b[0J`) or cursor-repositioning codes (`\x1b[<n>A`, `\x1b[<n>G`) that touch the input line, before the visible character(s)?
2. Does the sequence otherwise just print the new character at the current cursor position, with no repositioning?

Either answer is a **pass** — in both cases, a real character write at a given screen cell overwrites whatever was there before (predicted or not), which is exactly what Tasks 2–5 rely on. This is a go: proceed to Task 2.

**Only if** the captured output does something unexpected — e.g. the cursor jumps to a position that does *not* correspond to "one character further than before", or the visible input line temporarily disappears/reflows in a way that isn't a simple same-position overwrite — that's a **stop**: do not proceed with Tasks 2–5 as written. Note the exact captured bytes and bring them back for a design revisit instead of guessing at a fix.

- [ ] **Step 5: Revert the temporary logging**

Change `mobile/src/components/terminalHtml.ts:676-678` back to its original form:

```js
      if      (msg.type === 'output') {
        term.write(msg.data, function() {
```

(remove the `console.log` line added in Step 1).

- [ ] **Step 6: Document the finding and commit**

Append a short "Verifikation" section to the end of `docs/superpowers/specs/2026-07-11-predictive-echo-design.md`:

```markdown

## Verifikation (Task 1)

Getestet mit echter Claude-Code-CLI-Session am [Datum einfügen]. Captured
Output für einen einzelnen Tastendruck: `<hier die tatsächlichen Bytes/das
JSON aus Schritt 3 einfügen>`.

Ergebnis: <hier kurz eintragen, ob Fall 1 (Clear+Redraw) oder Fall 2
(einfaches Zeichen an Cursor-Position) vorliegt — beides ist ein GO für
Task 2–5>.
```

Given the project's git-plumbing workaround for this worktree (see the repo's `project_git_slow_use_plumbing` note — avoid `git commit --only`), commit via:

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
HEAD_SHA=$(git rev-parse HEAD)
IDX=/private/tmp/tms-commit-index
rm -f "$IDX"
GIT_INDEX_FILE="$IDX" git read-tree "$HEAD_SHA"
GIT_INDEX_FILE="$IDX" git add -- docs/superpowers/specs/2026-07-11-predictive-echo-design.md
TREE=$(GIT_INDEX_FILE="$IDX" git write-tree)
COMMIT=$(git commit-tree "$TREE" -p "$HEAD_SHA" -m "docs: record predictive echo redraw verification")
git update-ref refs/heads/master "$COMMIT"
git add -- docs/superpowers/specs/2026-07-11-predictive-echo-design.md
git log -1 --oneline
```

---

### Task 2: Prediction reconciliation pure function

**Files:**
- Create: `mobile/src/utils/predictionReconcile.js`
- Create: `mobile/src/utils/predictionReconcile.test.js`

**Interfaces:**
- Produces: `reconcilePredictions(queue, rttEstimateMs, nowMs)` → `{ confirmed: Array, pending: Array }`, exported via `module.exports`. `queue` is an array of objects that each have at least a numeric `sentAt` field; the function partitions them by `sentAt <= nowMs - rttEstimateMs` (confirmed) vs not (pending), preserving relative order and all other fields on each entry untouched. Consumed by Task 4 (embedded into `terminalHtml.ts` via `.toString()`).

- [ ] **Step 1: Write the failing tests**

Create `mobile/src/utils/predictionReconcile.test.js`:

```js
var test = require('node:test');
var assert = require('node:assert/strict');
var { reconcilePredictions } = require('./predictionReconcile');

test('empty queue returns empty confirmed and pending', function () {
  var result = reconcilePredictions([], 1000, 5000);
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(result.pending, []);
});

test('entry older than the RTT window is confirmed', function () {
  var queue = [{ op: 'insert', char: 'a', sentAt: 1000 }];
  // now=5000, rtt=1000 -> watermark=4000; sentAt(1000) <= 4000 -> confirmed
  var result = reconcilePredictions(queue, 1000, 5000);
  assert.equal(result.confirmed.length, 1);
  assert.equal(result.pending.length, 0);
  assert.equal(result.confirmed[0].char, 'a');
});

test('entry newer than the RTT window is pending', function () {
  var queue = [{ op: 'insert', char: 'b', sentAt: 4800 }];
  // now=5000, rtt=1000 -> watermark=4000; sentAt(4800) > 4000 -> pending
  var result = reconcilePredictions(queue, 1000, 5000);
  assert.equal(result.confirmed.length, 0);
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].char, 'b');
});

test('entry exactly at the watermark counts as confirmed', function () {
  var queue = [{ op: 'delete', sentAt: 4000 }];
  // now=5000, rtt=1000 -> watermark=4000; sentAt(4000) <= 4000 -> confirmed
  var result = reconcilePredictions(queue, 1000, 5000);
  assert.equal(result.confirmed.length, 1);
  assert.equal(result.pending.length, 0);
});

test('mixed queue splits and preserves order within each bucket', function () {
  var queue = [
    { op: 'insert', char: 'a', sentAt: 1000 }, // confirmed
    { op: 'insert', char: 'b', sentAt: 4800 }, // pending
    { op: 'delete', sentAt: 2000 },            // confirmed
    { op: 'insert', char: 'c', sentAt: 4900 }, // pending
  ];
  var result = reconcilePredictions(queue, 1000, 5000);
  assert.deepEqual(result.confirmed.map(function (e) { return e.sentAt; }), [1000, 2000]);
  assert.deepEqual(result.pending.map(function (e) { return e.sentAt; }), [4800, 4900]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
node --test mobile/src/utils/predictionReconcile.test.js
```
Expected: FAIL — `Cannot find module './predictionReconcile'` (the module doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `mobile/src/utils/predictionReconcile.js`:

```js
function reconcilePredictions(queue, rttEstimateMs, nowMs) {
  var confirmed = [];
  var pending = [];
  var watermark = nowMs - rttEstimateMs;
  for (var i = 0; i < queue.length; i++) {
    var entry = queue[i];
    if (entry.sentAt <= watermark) {
      confirmed.push(entry);
    } else {
      pending.push(entry);
    }
  }
  return { confirmed: confirmed, pending: pending };
}

module.exports = { reconcilePredictions: reconcilePredictions };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
node --test mobile/src/utils/predictionReconcile.test.js
```
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
HEAD_SHA=$(git rev-parse HEAD)
IDX=/private/tmp/tms-commit-index
rm -f "$IDX"
GIT_INDEX_FILE="$IDX" git read-tree "$HEAD_SHA"
GIT_INDEX_FILE="$IDX" git add -- mobile/src/utils/predictionReconcile.js mobile/src/utils/predictionReconcile.test.js
TREE=$(GIT_INDEX_FILE="$IDX" git write-tree)
COMMIT=$(git commit-tree "$TREE" -p "$HEAD_SHA" -m "feat(mobile): add prediction-queue reconciliation function")
git update-ref refs/heads/master "$COMMIT"
git add -- mobile/src/utils/predictionReconcile.js mobile/src/utils/predictionReconcile.test.js
git log -1 --oneline
```

---

### Task 3: Forward RTT estimate from the WebSocket service into the WebView

**Files:**
- Modify: `mobile/src/services/websocket.service.ts:34` (add field), `:83-87` (add method), `:260-269` (notify listeners)
- Modify: `mobile/src/components/TerminalView.tsx:249` (add effect after the existing output-routing effect)

**Interfaces:**
- Consumes: nothing new.
- Produces: `WebSocketService.addRttListener(handler: (rtt: number) => void): () => void` — calls `handler` with the rounded smoothed RTT (ms) every time it's recalculated. The WebView receives `{ type: 'rtt', data: '<ms as string>' }` via the existing `sendToTerminal` bridge. Consumed by Task 4 (`terminalHtml.ts`'s `handleMsg`).

- [ ] **Step 1: Add the RTT listener set and registration method**

In `mobile/src/services/websocket.service.ts`, the class currently declares (line 34):

```ts
  private listeners = new Set<MessageHandler>();
```

Add a second set right after it:

```ts
  private listeners = new Set<MessageHandler>();
  private rttListeners = new Set<(rtt: number) => void>();
```

The class currently defines `addMessageListener` at lines 83–87:

```ts
  /** Add a listener; returns an unsubscribe function */
  addMessageListener(handler: MessageHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
```

Add a matching method right after it:

```ts
  /** Add a listener; returns an unsubscribe function */
  addMessageListener(handler: MessageHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** Called with the rounded smoothed RTT (ms) whenever it's recalculated; returns an unsubscribe function */
  addRttListener(handler: (rtt: number) => void): () => void {
    this.rttListeners.add(handler);
    return () => this.rttListeners.delete(handler);
  }
```

- [ ] **Step 2: Notify listeners from `updateRttMetrics`**

`updateRttMetrics` currently ends with (lines 260–269):

```ts
    // Stale connection: if smoothed RTT stays above threshold for 5 consecutive pings, reconnect
    if (this.consecutivePoorCount >= 5 && this._smoothedRtt > RTT_STALE_THRESHOLD) {
      console.warn(`[WS] Sustained poor RTT (${Math.round(this._smoothedRtt)}ms) — reconnecting`);
      this.consecutivePoorCount = 0;
      this._smoothedRtt = undefined;
      this._jitter = 0;
      this.reconnectAttempts = 0;
      this.doConnect();
    }
  }
```

Add the notification just before the closing brace of the function, guarded so it doesn't fire with `undefined` right after a reconnect-triggered reset:

```ts
    // Stale connection: if smoothed RTT stays above threshold for 5 consecutive pings, reconnect
    if (this.consecutivePoorCount >= 5 && this._smoothedRtt > RTT_STALE_THRESHOLD) {
      console.warn(`[WS] Sustained poor RTT (${Math.round(this._smoothedRtt)}ms) — reconnecting`);
      this.consecutivePoorCount = 0;
      this._smoothedRtt = undefined;
      this._jitter = 0;
      this.reconnectAttempts = 0;
      this.doConnect();
    }

    if (this._smoothedRtt !== undefined) {
      const roundedRtt = Math.round(this._smoothedRtt);
      this.rttListeners.forEach((handler) => handler(roundedRtt));
    }
  }
```

- [ ] **Step 3: Typecheck**

Run:
```bash
cd mobile
npx tsc --noEmit
```
Expected: no new errors from `websocket.service.ts`.

- [ ] **Step 4: Subscribe in `TerminalView.tsx` and forward into the WebView**

The "Route server output..." effect currently ends at line 249:

```tsx
  // Route server output to xterm.js AND persist it in the view-buffer
  useEffect(() => {
    if (!sessionId) return;
    return wsService.addMessageListener((msg: unknown) => {
      const m = msg as { type: string; sessionId?: string; payload?: { data?: string } };
      if (m.type === 'terminal:output' && m.sessionId === sessionId && m.payload?.data) {
        appendViewBuffer(sessionId, m.payload.data);
        sendToTerminal('output', m.payload.data);

        // AI tool detection
        const detected = detectAiTool(m.payload.data);
        if (detected && detected !== lastAiToolRef.current) {
          lastAiToolRef.current = detected;
          onAiToolDetectedRef.current?.(detected);
        }

        // Keyword alert scanning (vibration + sound per category)
        keywordAlertService.scan(m.payload.data);
      }
    });
  }, [sessionId, wsService, sendToTerminal]);
```

Add a new effect right after it:

```tsx
  // Forward the current RTT estimate into the WebView so predictive echo knows
  // how long to keep unconfirmed predictions visible.
  useEffect(() => {
    return wsService.addRttListener((rtt) => {
      sendToTerminal('rtt', String(rtt));
    });
  }, [wsService, sendToTerminal]);
```

- [ ] **Step 5: Typecheck**

Run:
```bash
cd mobile
npx tsc --noEmit
```
Expected: no new errors from `TerminalView.tsx`.

- [ ] **Step 6: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
HEAD_SHA=$(git rev-parse HEAD)
IDX=/private/tmp/tms-commit-index
rm -f "$IDX"
GIT_INDEX_FILE="$IDX" git read-tree "$HEAD_SHA"
GIT_INDEX_FILE="$IDX" git add -- mobile/src/services/websocket.service.ts mobile/src/components/TerminalView.tsx
TREE=$(GIT_INDEX_FILE="$IDX" git write-tree)
COMMIT=$(git commit-tree "$TREE" -p "$HEAD_SHA" -m "feat(mobile): forward RTT estimate from websocket service into terminal WebView")
git update-ref refs/heads/master "$COMMIT"
git add -- mobile/src/services/websocket.service.ts mobile/src/components/TerminalView.tsx
git log -1 --oneline
```

---

### Task 4: Prediction engine inside the terminal WebView

**Files:**
- Modify: `mobile/src/components/terminalHtml.ts:1` (import), `:56-59` (embed pure function inside the IIFE), `:145` (hook into `sendKey`), `:673-696` (handle `'rtt'` message, hook into `output` handler)

**Interfaces:**
- Consumes: `reconcilePredictions(queue, rttEstimateMs, nowMs)` from `mobile/src/utils/predictionReconcile.js` (Task 2). Consumes `{ type: 'rtt', data: '<ms>' }` messages pushed by Task 3.
- Produces: no new exports (this is purely inside the WebView's inline script); behavioral output is underlined predicted characters that resolve to normal styling once real output arrives.

- [ ] **Step 1: Import the pure function**

`mobile/src/components/terminalHtml.ts` currently starts with:

```ts
import { XTERM_CSS, XTERM_XTERM, XTERM_FIT, XTERM_WEBLINKS, XTERM_CANVAS } from '../assets/xtermBundle';
```

Add a second import right after it:

```ts
import { XTERM_CSS, XTERM_XTERM, XTERM_FIT, XTERM_WEBLINKS, XTERM_CANVAS } from '../assets/xtermBundle';
import { reconcilePredictions } from '../utils/predictionReconcile';
```

- [ ] **Step 2: Splice the pure function into the template and add prediction state**

The script's IIFE currently opens with (lines 56–59):

```
<script>
(function() {

  var SEQ = {
```

Insert the embedded function and prediction state between the IIFE opening and `var SEQ`:

```
<script>
(function() {

  /* ── Predictive echo ────────────────────────────────────────────────
     reconcilePredictions is defined once in mobile/src/utils/predictionReconcile.js
     and spliced in here via .toString() so there is a single source of truth
     that's still unit-testable with plain Node. */
  var reconcilePredictions = ` + reconcilePredictions.toString() + `;
  var predictionQueue = [];   // { op: 'insert'|'delete', char?, sentAt }
  var lastRtt = 1000;         // ms fallback until the RN side pushes a real sample

  function isPredictableInsert(seq) {
    if (seq.length !== 1) return false;
    var c = seq.charCodeAt(0);
    return c >= 0x20 && c <= 0x7e;
  }

  function predictInsert(ch) {
    term.write('\\x1b[4m' + ch + '\\x1b[24m');
    predictionQueue.push({ op: 'insert', char: ch, sentAt: Date.now() });
  }

  function predictDelete() {
    // Destructive backspace: move left, blank the cell, move left again.
    // Known limitation: at a wrapped-line boundary this doesn't cross rows
    // (terminal BS never does) — self-corrects on the next real output.
    term.write('\\b \\b');
    predictionQueue.push({ op: 'delete', sentAt: Date.now() });
  }

  function pruneConfirmedPredictions() {
    var result = reconcilePredictions(predictionQueue, lastRtt, Date.now());
    predictionQueue = result.pending;
  }

  function rerenderPendingPredictions() {
    for (var i = 0; i < predictionQueue.length; i++) {
      var p = predictionQueue[i];
      if (p.op === 'insert') term.write('\\x1b[4m' + p.char + '\\x1b[24m');
      else term.write('\\b \\b');
    }
  }

  var SEQ = {
```

Note: this is TypeScript template-literal source, so the backslashes above (`\\x1b`, `\\b`) are written doubled — same convention already used throughout the rest of this file's template string (e.g. existing `SEQ.esc: '\\x1b'` at line 60).

- [ ] **Step 3: Hook prediction into `sendKey`**

`sendKey` currently reads (line 145):

```js
  function sendKey(seq) { sendToRN({ type: 'input', data: seq }); }
```

Change it to:

```js
  function sendKey(seq) {
    if (isPredictableInsert(seq)) {
      predictInsert(seq);
    } else if (seq === SEQ.bs) {
      predictDelete();
    }
    sendToRN({ type: 'input', data: seq });
  }
```

- [ ] **Step 4: Handle the `'rtt'` message from RN**

The `handleMsg` dispatcher currently has, right after the `'output'` case (lines 696):

```js
      else if (msg.type === 'clear')  term.clear();
```

Add a new branch right after it:

```js
      else if (msg.type === 'clear')  term.clear();
      else if (msg.type === 'rtt' && msg.data) {
        var parsedRtt = parseInt(msg.data, 10);
        if (!isNaN(parsedRtt) && parsedRtt > 0) lastRtt = parsedRtt;
      }
```

- [ ] **Step 5: Hook reconciliation into the `output` handler**

The `output` case currently reads (lines 676–694):

```js
      if      (msg.type === 'output') {
        term.write(msg.data, function() {
          // Live-check: only auto-scroll if user hasn't scrolled up.
          // Previous snapshot approach (wasAtBottom captured before write)
          // caused stale closures to yank viewport to bottom when the user
          // scrolled up while queued writes were pending.
          //
          // ALSO gate on !userIsTouching: during continuous streaming (Claude
          // Code spinner/thinking) a programmatic scrollToBottom() here fires
          // onScroll, and because the finger is still down (userIsTouching),
          // that handler resets userScrolledUp back to false — fighting the
          // user's scroll-up every frame so scrolling becomes impossible.
          // While the finger is on the screen we never auto-scroll; we resume
          // on release (userIsTouching clears 300 ms after touchend).
          if (!userScrolledUp && !userIsTouching) {
            term.scrollToBottom();
          }
          scheduleSqlScan();
        });
      }
```

Change it to prune confirmed predictions before the real write, and re-render any still-pending predictions after it:

```js
      if      (msg.type === 'output') {
        pruneConfirmedPredictions();
        term.write(msg.data, function() {
          rerenderPendingPredictions();
          // Live-check: only auto-scroll if user hasn't scrolled up.
          // Previous snapshot approach (wasAtBottom captured before write)
          // caused stale closures to yank viewport to bottom when the user
          // scrolled up while queued writes were pending.
          //
          // ALSO gate on !userIsTouching: during continuous streaming (Claude
          // Code spinner/thinking) a programmatic scrollToBottom() here fires
          // onScroll, and because the finger is still down (userIsTouching),
          // that handler resets userScrolledUp back to false — fighting the
          // user's scroll-up every frame so scrolling becomes impossible.
          // While the finger is on the screen we never auto-scroll; we resume
          // on release (userIsTouching clears 300 ms after touchend).
          if (!userScrolledUp && !userIsTouching) {
            term.scrollToBottom();
          }
          scheduleSqlScan();
        });
      }
```

- [ ] **Step 6: Typecheck**

Run:
```bash
cd mobile
npx tsc --noEmit
```
Expected: no new errors from `terminalHtml.ts`.

- [ ] **Step 7: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
HEAD_SHA=$(git rev-parse HEAD)
IDX=/private/tmp/tms-commit-index
rm -f "$IDX"
GIT_INDEX_FILE="$IDX" git read-tree "$HEAD_SHA"
GIT_INDEX_FILE="$IDX" git add -- mobile/src/components/terminalHtml.ts
TREE=$(GIT_INDEX_FILE="$IDX" git write-tree)
COMMIT=$(git commit-tree "$TREE" -p "$HEAD_SHA" -m "feat(mobile): predictive local echo for terminal input under high latency")
git update-ref refs/heads/master "$COMMIT"
git add -- mobile/src/components/terminalHtml.ts
git log -1 --oneline
```

---

### Task 5: Manual end-to-end verification under induced latency

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Build and install a debug build on the phone**

```bash
cd mobile
npm start
```
Open the app on the phone (already connected per the project's existing dev workflow) and connect to the TMS Terminal server as usual.

- [ ] **Step 2: Induce artificial latency on the Mac**

Use macOS's Network Link Conditioner (Xcode → Open Developer Tool → More Developer Tools, or already installed under System Settings if added previously) and enable a profile with ~1500ms latency on the network interface the phone connects through (Tailscale). If Network Link Conditioner isn't installed, use `dnctl`/`pfctl` instead:

```bash
sudo dnctl pipe 1 config delay 1500
echo "dummynet in quick proto tcp from any to any port 8767 pipe 1" | sudo pfctl -f -
sudo pfctl -e
```

(Reverse with `sudo pfctl -d` and `sudo dnctl -q flush` when done — port 8767 matches the project's default TMS Terminal server port from `CLAUDE.md`.)

- [ ] **Step 3: Verify baseline lag is present**

Open a Claude Code CLI session in the app and type a few characters. Confirm there's a visible, multi-second delay between key press and the character appearing — this confirms the induced latency is actually active before judging the fix.

- [ ] **Step 4: Verify predictive echo**

Type a short sentence continuously (don't pause between characters). Confirm:
- Each character appears underlined immediately on key press, with no visible per-character delay.
- While still typing, already-typed characters do not flicker or disappear.
- After you stop typing and wait a few seconds, the underline goes away and the text matches what the real Claude Code CLI session shows (no leftover stray characters, no missing characters).

- [ ] **Step 5: Verify backspace**

Type a few characters, then backspace 2–3 of them in quick succession while latency is still active. Confirm the characters disappear immediately and the end result (after the real echo catches up) matches what was actually deleted server-side.

- [ ] **Step 6: Verify the "??" command-suggest interaction**

Per the design spec's documented edge case, type `??` quickly. Confirm the command-suggest UI still opens correctly, and that any brief visual flash of unconfirmed `??` before the correction is not disruptive.

- [ ] **Step 7: Remove the induced latency**

```bash
sudo pfctl -d
sudo dnctl -q flush
```
(Skip if Network Link Conditioner was used instead — just disable the profile.)

- [ ] **Step 8: Report results**

If all checks in Steps 4–6 pass, the feature is done — no further commit needed (Task 4 already committed the implementation). If something looks wrong, note exactly which step failed and what was observed, and stop rather than making speculative fixes.
