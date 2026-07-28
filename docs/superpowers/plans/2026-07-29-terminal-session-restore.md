# Terminal-Wiederherstellung — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nach jedem Server-Neustart kommen die Terminals mit denselben IDs und Arbeitsverzeichnissen zurück, und wo eine Claude-Code-Sitzung lief, wird sie über `claude --resume <sessionId>` fortgesetzt.

**Architecture:** Der Server schreibt laufend eine Aufnahme seiner Terminals nach `~/.tms-terminal/terminals.json`. Die Zuordnung Terminal → Claude-Sitzung kommt aus `~/.claude/sessions/<pid>.json`, das Claude Code selbst führt — aufgelöst über die Prozess-Abstammung der PTY-Shell, nicht über Dateizeiten. Beim Start liest der Server die Aufnahme, legt die Sessions unter denselben IDs neu an und schickt den Resume-Befehl, sobald die Shell bereit ist.

**Tech Stack:** TypeScript, Node ≥20, `node:test` + `node:assert/strict` (**kein Vitest**), node-pty. Keine neuen Abhängigkeiten.

## Global Constraints

- **Branch:** `feat/manager-chat-redesign` im Worktree `~/Desktop/tms-terminal`. Nicht `master`.
- **Testbefehl:** `npm test` in `server/` (= `node --require ts-node/register --test 'src/**/*.test.ts'`). Einzeln: `node --require ts-node/register --test src/terminal/<datei>.test.ts`.
- **Testimporte:** immer `node:test` und `node:assert/strict`. Niemals `vitest`/`jest`.
- **Keine neuen Laufzeit-Abhängigkeiten.**
- **Uhren und Prozessaufrufe werden injiziert.** Jede Einheit mit Zeit- oder Systemverhalten bekommt sie als Konstruktor- bzw. Optionsargument — Muster aus `src/notifications/prompt.detector.test.ts`. Tests dürfen **nie** echte Prozesse starten oder echt warten.
- **Dateischreiben atomar:** in `<datei>.tmp` schreiben, dann `fs.renameSync`. Modus `0o600`.
- **Prozessaufrufe mit Timeout.** `pgrep`/`ps` bekommen 1000 ms, wie im bestehenden `readForegroundProcess` (`src/terminal/cwd.utils.ts:56`).
- **`~/.claude/sessions/` wird nie als Verzeichnis durchsucht.** Nur PIDs, die nachweislich unter einer lebenden TMS-Shell hängen, dürfen nachgeschlagen werden.
- **UI-Strings Deutsch**, Code und Bezeichner Englisch.
- **Server niemals unaufgefordert neu starten.** Er besitzt alle node-pty-Sitzungen.
- **Commits:** nach jedem Task, Nachricht endet auf `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File Structure

Alle Pfade relativ zu `~/Desktop/tms-terminal/server/`.

**Neu:**

| Datei | Verantwortung |
|---|---|
| `src/terminal/restore/snapshot.types.ts` | Typen der Aufnahme |
| `src/terminal/restore/snapshot.store.ts` | Atomares Lesen/Schreiben/Verbrauchen von `terminals.json` |
| `src/terminal/restore/claude-session.ts` | Prozess-Abstammung → `~/.claude/sessions/<pid>.json` → Session-ID |
| `src/terminal/restore/snapshotter.ts` | Nimmt den aktuellen Terminal-Stand auf (Takt + auf Zuruf) |
| `src/terminal/restore/restore.ts` | Stellt beim Start wieder her, inkl. Warten auf die bereite Shell |

**Geändert:**

| Datei | Änderung |
|---|---|
| `src/terminal/terminal.types.ts` | `CreateSessionOptions` bekommt `id?` und `cwd?` |
| `src/terminal/terminal.factory.ts` | `createPty` bekommt einen `cwd`-Parameter |
| `src/terminal/terminal.manager.ts` | `createSession` nutzt vorgegebene ID/cwd; neu: `listSessions()`, `injectOutput()` |
| `src/index.ts` | Wiederherstellung beim Start, Aufnahme im `shutdown` |
| `src/websocket/ws.handler.ts` | Aufnahme nach `terminal:create` und `terminal:close` |
| `src/manager/manager.service.ts` | `pushSystemNotice()` für die Zusammenfassung |

Testdateien liegen neben der Implementierung als `<name>.test.ts`.

---

### Task 1: Aufnahme-Speicher

**Files:**
- Create: `src/terminal/restore/snapshot.types.ts`
- Create: `src/terminal/restore/snapshot.store.ts`
- Test: `src/terminal/restore/snapshot.store.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  - `ClaudeMark { sessionId: string; status: 'busy' | 'idle' | 'shell' }`
  - `SnapshotEntry { id, label?, cwd, cols, rows, claude? }`
  - `Snapshot { capturedAt: number; serverPid: number; entries: SnapshotEntry[] }`
  - `SNAPSHOT_FILE: string`, `TMS_DIR: string`
  - `readSnapshot(dir?: string): Snapshot | null`
  - `writeSnapshot(s: Snapshot, dir?: string): void`
  - `consumeSnapshot(dir?: string): Snapshot | null`

- [ ] **Step 1: Write the types file**

Create `src/terminal/restore/snapshot.types.ts`:

```ts
export interface ClaudeMark {
  /** Claude-Code-Session-ID aus ~/.claude/sessions/<pid>.json. */
  sessionId: string;
  /** 'busy' = die Sitzung wurde mitten in der Arbeit abgeschnitten. */
  status: 'busy' | 'idle' | 'shell';
}

export interface SnapshotEntry {
  /**
   * TMS-Session-ID. Wird beim Wiederherstellen WIEDERVERWENDET — die App hält
   * ihre Reiter an dieser ID fest und findet sie sonst nicht mehr.
   */
  id: string;
  /**
   * Nur für Log und Manager-Nachricht ("Shell 1 wiederhergestellt").
   * NICHT der Kartenname in der App: den hält die App selbst und verliert ihn
   * bei einem Server-Neustart gar nicht. TerminalSession trägt kein Label.
   */
  label?: string;
  cwd: string;
  cols: number;
  rows: number;
  claude?: ClaudeMark;
}

export interface Snapshot {
  capturedAt: number;
  /** Schutz davor, Terminals zu übernehmen, während ein anderer Server läuft. */
  serverPid: number;
  entries: SnapshotEntry[];
}
```

- [ ] **Step 2: Write the failing test**

Create `src/terminal/restore/snapshot.store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Snapshot } from './snapshot.types';
import { readSnapshot, writeSnapshot, consumeSnapshot, SNAPSHOT_FILE } from './snapshot.store';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-snap-'));
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    capturedAt: 1_700_000_000_000,
    serverPid: 4242,
    entries: [{
      id: 'sess-1', label: 'Shell 1', cwd: '/Users/x/Desktop/TMS Terminal',
      cols: 80, rows: 24, claude: { sessionId: 'claude-abc', status: 'idle' },
    }],
    ...over,
  };
}

test('write then read round-trips including the claude mark', () => {
  const dir = tmpDir();
  writeSnapshot(snap(), dir);
  const back = readSnapshot(dir)!;
  assert.equal(back.serverPid, 4242);
  assert.equal(back.entries.length, 1);
  assert.equal(back.entries[0].claude?.sessionId, 'claude-abc');
  assert.equal(back.entries[0].cwd, '/Users/x/Desktop/TMS Terminal');
});

test('a missing file yields null, not a crash', () => {
  assert.equal(readSnapshot(tmpDir()), null);
});

test('a corrupt file yields null and is moved aside, never deleted', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, SNAPSHOT_FILE), '{ kaputt');
  assert.equal(readSnapshot(dir), null);
  assert.equal(fs.existsSync(path.join(dir, SNAPSHOT_FILE)), false, 'original weggeräumt');
  const quarantined = fs.readdirSync(dir).filter(f => f.startsWith(`${SNAPSHOT_FILE}.corrupt-`));
  assert.equal(quarantined.length, 1, 'als .corrupt-<zeit> aufgehoben');
});

test('the written file is not world-readable', () => {
  const dir = tmpDir();
  writeSnapshot(snap(), dir);
  assert.equal(fs.statSync(path.join(dir, SNAPSHOT_FILE)).mode & 0o777, 0o600);
});

test('consumeSnapshot returns the content AND removes the file', () => {
  const dir = tmpDir();
  writeSnapshot(snap(), dir);
  const taken = consumeSnapshot(dir)!;
  assert.equal(taken.entries.length, 1);
  assert.equal(fs.existsSync(path.join(dir, SNAPSHOT_FILE)), false,
    'sofort weg — sonst reisst ein Absturz mitten in der Wiederherstellung bei jedem Start erneut Terminals auf');
  assert.equal(consumeSnapshot(dir), null, 'ein zweiter Versuch findet nichts mehr');
});

test('an entry without a claude mark survives the round-trip', () => {
  const dir = tmpDir();
  writeSnapshot(snap({ entries: [{ id: 's2', cwd: '/tmp', cols: 100, rows: 30 }] }), dir);
  const back = readSnapshot(dir)!;
  assert.equal(back.entries[0].claude, undefined);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/terminal/restore/snapshot.store.test.ts`
Expected: FAIL — `Cannot find module './snapshot.store'`

- [ ] **Step 4: Write minimal implementation**

Create `src/terminal/restore/snapshot.store.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../utils/logger';
import type { Snapshot } from './snapshot.types';

export const TMS_DIR = path.join(os.homedir(), '.tms-terminal');
export const SNAPSHOT_FILE = 'terminals.json';

/**
 * Read the snapshot. A corrupt file is moved aside rather than deleted — it may
 * be the only record of what was open, and a human can still look at it.
 */
export function readSnapshot(dir: string = TMS_DIR): Snapshot | null {
  const file = path.join(dir, SNAPSHOT_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Snapshot;
  } catch {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      fs.renameSync(file, `${file}.corrupt-${stamp}`);
      logger.warn(`[restore] ${SNAPSHOT_FILE} war beschädigt — beiseitegelegt`);
    } catch { /* nothing we can do */ }
    return null;
  }
}

/** Atomic write: temp file + rename, so a crash never leaves half a snapshot. */
export function writeSnapshot(snapshot: Snapshot, dir: string = TMS_DIR): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, SNAPSHOT_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Read and immediately remove. The content is in memory by then, and deleting
 * before anything is created means a crash mid-restore cannot repeat forever.
 */
export function consumeSnapshot(dir: string = TMS_DIR): Snapshot | null {
  const snapshot = readSnapshot(dir);
  if (snapshot === null) return null;
  try {
    fs.unlinkSync(path.join(dir, SNAPSHOT_FILE));
  } catch { /* already gone — fine */ }
  return snapshot;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/terminal/restore/snapshot.store.test.ts`
Expected: PASS — 6 Tests grün

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/terminal/restore/
git commit -m "feat(terminal): Aufnahme-Speicher für die Terminal-Wiederherstellung

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Claude-Sitzung über die Prozess-Abstammung finden

Der heikelste Teil des Features. Alles wird injiziert, damit die Tests keine echten Prozesse starten.

**Files:**
- Create: `src/terminal/restore/claude-session.ts`
- Test: `src/terminal/restore/claude-session.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  - `ClaudeSessionInfo { pid: number; sessionId: string; cwd: string; status: 'busy' | 'idle' | 'shell' }`
  - `ChildLookup = (pid: number) => Promise<number[]>`
  - `descendantPids(rootPid: number, children: ChildLookup, maxDepth?: number): Promise<number[]>`
  - `readClaudeSessionFile(pid: number, sessionsDir: string): ClaudeSessionInfo | null`
  - `resolveClaudeSession(shellPid: number, opts?: { children?: ChildLookup; sessionsDir?: string; maxDepth?: number }): Promise<ClaudeSessionInfo | null>`
  - `CLAUDE_SESSIONS_DIR: string`

- [ ] **Step 1: Write the failing test**

Create `src/terminal/restore/claude-session.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { descendantPids, readClaudeSessionFile, resolveClaudeSession } from './claude-session';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-claude-'));
}

/** Writes a session file exactly as Claude Code v2.1.220 does. */
function writeSessionFile(dir: string, pid: number, over: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
    pid, sessionId: `session-of-${pid}`, cwd: '/Users/x/Desktop/Foo',
    startedAt: 1785219546136, version: '2.1.220', kind: 'interactive',
    status: 'idle', ...over,
  }));
}

/** Fake process tree: pid -> direct children. */
function tree(map: Record<number, number[]>) {
  return async (pid: number): Promise<number[]> => map[pid] ?? [];
}

test('descendantPids walks the tree breadth-first down to the depth limit', async () => {
  const children = tree({ 100: [200, 201], 200: [300], 300: [400] });
  assert.deepEqual(await descendantPids(100, children, 3), [200, 201, 300, 400]);
});

test('descendantPids stops at the depth limit', async () => {
  const children = tree({ 100: [200], 200: [300], 300: [400], 400: [500] });
  const found = await descendantPids(100, children, 2);
  assert.deepEqual(found, [200, 300]);
});

test('descendantPids survives a cycle instead of looping forever', async () => {
  const children = tree({ 100: [200], 200: [100] });
  const found = await descendantPids(100, children, 5);
  assert.ok(found.includes(200));
  assert.ok(found.length < 10, 'darf nicht endlos wachsen');
});

test('readClaudeSessionFile reads the fields we need', () => {
  const dir = tmpDir();
  writeSessionFile(dir, 90832, { status: 'busy' });
  const info = readClaudeSessionFile(90832, dir)!;
  assert.equal(info.sessionId, 'session-of-90832');
  assert.equal(info.status, 'busy');
  assert.equal(info.cwd, '/Users/x/Desktop/Foo');
});

test('a session file whose pid field does not match is REJECTED', () => {
  // PIDs get reused by the OS. Without this check an old file could be
  // attributed to a completely unrelated process.
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '555.json'), JSON.stringify({
    pid: 999, sessionId: 'fremd', cwd: '/tmp', status: 'idle',
  }));
  assert.equal(readClaudeSessionFile(555, dir), null);
});

test('a missing or corrupt session file yields null', () => {
  const dir = tmpDir();
  assert.equal(readClaudeSessionFile(1234, dir), null);
  fs.writeFileSync(path.join(dir, '1234.json'), 'kein json');
  assert.equal(readClaudeSessionFile(1234, dir), null);
});

test('an unknown status falls back to idle rather than being dropped', () => {
  const dir = tmpDir();
  writeSessionFile(dir, 77, { status: 'irgendwas-neues' });
  assert.equal(readClaudeSessionFile(77, dir)!.status, 'idle');
});

test('resolveClaudeSession finds claude TWO levels below the shell', async () => {
  // Claude need not be a direct child — a wrapper, npx or a shell alias puts it deeper.
  const dir = tmpDir();
  writeSessionFile(dir, 300);
  const info = await resolveClaudeSession(100, {
    children: tree({ 100: [200], 200: [300] }), sessionsDir: dir,
  });
  assert.equal(info!.sessionId, 'session-of-300');
});

test('resolveClaudeSession returns null when no descendant has a session file', async () => {
  const dir = tmpDir();
  const info = await resolveClaudeSession(100, {
    children: tree({ 100: [200, 201] }), sessionsDir: dir,
  });
  assert.equal(info, null);
});

test('resolveClaudeSession never scans the directory as a whole', async () => {
  // A stale file for a session the user deliberately ended must not resurrect it.
  const dir = tmpDir();
  writeSessionFile(dir, 999); // not a descendant of 100
  const info = await resolveClaudeSession(100, {
    children: tree({ 100: [200] }), sessionsDir: dir,
  });
  assert.equal(info, null, 'nur Nachfahren der lebenden Shell zählen');
});

test('a failing child lookup yields null instead of throwing', async () => {
  const dir = tmpDir();
  const broken = async (): Promise<number[]> => { throw new Error('pgrep weg'); };
  assert.equal(await resolveClaudeSession(100, { children: broken, sessionsDir: dir }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/terminal/restore/claude-session.test.ts`
Expected: FAIL — `Cannot find module './claude-session'`

- [ ] **Step 3: Write minimal implementation**

Create `src/terminal/restore/claude-session.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

/** Claude Code keeps this itself — one file per running process. */
export const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

const PROC_TIMEOUT_MS = 1000;
const DEFAULT_MAX_DEPTH = 3;

export interface ClaudeSessionInfo {
  pid: number;
  sessionId: string;
  cwd: string;
  status: 'busy' | 'idle' | 'shell';
}

export type ChildLookup = (pid: number) => Promise<number[]>;

function safePid(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 4194304) return null;
  return String(pid);
}

/** Direct children of a pid via pgrep. Mirrors readForegroundProcess's timeout. */
export const pgrepChildren: ChildLookup = (pid) => new Promise((resolve) => {
  const arg = safePid(pid);
  if (arg === null) { resolve([]); return; }
  execFile('pgrep', ['-P', arg], { encoding: 'utf8', timeout: PROC_TIMEOUT_MS }, (err, stdout) => {
    if (err || !stdout) { resolve([]); return; }
    resolve(stdout.split('\n').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0));
  });
});

/**
 * All descendants of `rootPid`, breadth-first, down to `maxDepth` levels.
 * `seen` guards against a cycle — a malformed process table must not hang the server.
 */
export async function descendantPids(
  rootPid: number,
  children: ChildLookup,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Promise<number[]> {
  const found: number[] = [];
  const seen = new Set<number>([rootPid]);
  let frontier = [rootPid];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const pid of frontier) {
      for (const child of await children(pid)) {
        if (seen.has(child)) continue;
        seen.add(child);
        found.push(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return found;
}

const VALID_STATUS = new Set(['busy', 'idle', 'shell']);

/**
 * Read ~/.claude/sessions/<pid>.json.
 *
 * The file's own `pid` field must match the pid we looked up: the OS reuses
 * PIDs, and without this an old file could be attributed to a stranger.
 */
export function readClaudeSessionFile(pid: number, sessionsDir: string): ClaudeSessionInfo | null {
  const arg = safePid(pid);
  if (arg === null) return null;
  const file = path.join(sessionsDir, `${arg}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null; // missing, unreadable or corrupt — all equally "no claude here"
  }
  const obj = raw as Record<string, unknown>;
  if (obj.pid !== pid) return null;
  if (typeof obj.sessionId !== 'string' || obj.sessionId === '') return null;

  const status = typeof obj.status === 'string' && VALID_STATUS.has(obj.status)
    ? obj.status as ClaudeSessionInfo['status']
    : 'idle'; // a status we do not know yet must not lose us the session

  return {
    pid,
    sessionId: obj.sessionId,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : '',
    status,
  };
}

/**
 * The Claude session running under a PTY shell, or null.
 *
 * Deliberately walks the process tree instead of scanning the sessions
 * directory: only a pid that provably hangs below this living shell may be
 * looked up, so a stale file from a session the user ended cannot resurrect it.
 */
export async function resolveClaudeSession(
  shellPid: number,
  opts: { children?: ChildLookup; sessionsDir?: string; maxDepth?: number } = {},
): Promise<ClaudeSessionInfo | null> {
  const children = opts.children ?? pgrepChildren;
  const sessionsDir = opts.sessionsDir ?? CLAUDE_SESSIONS_DIR;
  try {
    for (const pid of await descendantPids(shellPid, children, opts.maxDepth)) {
      const info = readClaudeSessionFile(pid, sessionsDir);
      if (info !== null) return info;
    }
  } catch {
    return null; // pgrep missing or hanging — no claude mark, everything else still works
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/terminal/restore/claude-session.test.ts`
Expected: PASS — 11 Tests grün

- [ ] **Step 5: Verify against the real machine**

```bash
cd server && node --require ts-node/register -e "
const { resolveClaudeSession } = require('./src/terminal/restore/claude-session');
const { execSync } = require('child_process');
// Alle laufenden claude-Prozesse und ihre Eltern-Shells:
const rows = execSync(\"ps -ax -o pid=,ppid=,comm= | awk '\\\$3 ~ /claude\\$/ {print \\\$1, \\\$2}'\", {encoding:'utf8'}).trim().split('\n');
(async () => {
  for (const row of rows) {
    const [cpid, shell] = row.trim().split(/\s+/).map(Number);
    const info = await resolveClaudeSession(shell);
    console.log('Shell', shell, '-> claude', cpid, '->', info ? info.sessionId.slice(0,8) + ' (' + info.status + ')' : 'NICHT GEFUNDEN');
  }
})();
"
```

Expected: für jede lebende Claude-Sitzung eine Session-ID. **Findet er nichts**, hängt Claude tiefer als drei Ebenen oder das Dateiformat hat sich geändert — dann erst `ls ~/.claude/sessions/` prüfen, bevor weitergebaut wird.

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/terminal/restore/
git commit -m "feat(terminal): Claude-Sitzung über die Prozess-Abstammung auflösen

Nicht über die neueste Transkriptdatei (mehrdeutig bei mehreren Terminals im
selben Ordner) und nicht über einen Verzeichnis-Scan (weckt beendete
Sitzungen wieder), sondern nur über PIDs, die unter der lebenden Shell
haengen. Das pid-Feld der Datei muss passen — PIDs werden wiederverwendet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Vorgegebene ID und vorgegebenes Arbeitsverzeichnis

Zwei additive Erweiterungen. Ohne sie kann die Wiederherstellung weder die App-Reiter treffen noch den richtigen Ordner öffnen.

**Files:**
- Modify: `src/terminal/terminal.types.ts`
- Modify: `src/terminal/terminal.factory.ts`
- Modify: `src/terminal/terminal.manager.ts`
- Test: `src/terminal/terminal.manager.restore.test.ts`

**Interfaces:**
- Produces:
  - `CreateSessionOptions` um `id?: string` und `cwd?: string` erweitert
  - `createPty(cols, rows, extraEnv?, cwd?)`
  - `TerminalManager.listSessions(): TerminalSession[]`

- [ ] **Step 1: Extend the options type**

In `src/terminal/terminal.types.ts`:

```ts
export interface CreateSessionOptions {
  cols: number;
  rows: number;
  /**
   * Vorgegebene Session-ID. Nur für die Wiederherstellung nach einem Neustart:
   * die App hält ihre Reiter an dieser ID fest. Sonst weglassen.
   */
  id?: string;
  /** Startverzeichnis der Shell. Standard: Home. */
  cwd?: string;
}
```

- [ ] **Step 2: Let createPty take a cwd**

In `src/terminal/terminal.factory.ts`, change the signature and the `opts`:

```ts
export function createPty(
  cols: number,
  rows: number,
  extraEnv: Record<string, string> = {},
  cwd?: string,
): pty.IPty {
```

```ts
  const opts: pty.IPtyForkOptions = {
    cols,
    rows,
    // Ein vorgegebenes Verzeichnis wird beim Start gesetzt statt hinterher per
    // "cd" hineingeschrieben: kein Eintrag in der Shell-History, kein Wettlauf
    // mit der Shell-Initialisierung, und die Karte zeigt sofort den Pfad.
    cwd: cwd !== undefined && fs.existsSync(cwd) ? cwd : os.homedir(),
    env,
  };
```

Add `import * as fs from 'fs';` at the top if it is not there. A vanished directory silently falls back to home — the terminal must still come back.

- [ ] **Step 3: Use both in createSession**

In `src/terminal/terminal.manager.ts`, replace lines 80–81:

```ts
    const id = options.id ?? uuidv4();
    const pty = createPty(options.cols, options.rows, { TMS_SESSION_ID: id }, options.cwd);
```

And add a listing method next to `getSessionCount()`:

```ts
  /** All live sessions — the snapshotter needs pid, dims and cwd of each. */
  listSessions(): TerminalSession[] {
    return [...this.sessions.values()];
  }
```

- [ ] **Step 4: Write the test**

Create `src/terminal/terminal.manager.restore.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import { globalManager } from './terminal.manager';

const noop = (): void => {};

test('a preset id is used verbatim — the app finds its tabs by it', () => {
  const wanted = 'vorgegebene-id-123';
  const session = globalManager.createSession({ cols: 80, rows: 24, id: wanted }, noop, noop);
  try {
    assert.equal(session.id, wanted);
    assert.equal(globalManager.getSession(wanted)?.id, wanted);
  } finally {
    globalManager.closeSession(session.id);
  }
});

test('without an id a fresh uuid is generated as before', () => {
  const a = globalManager.createSession({ cols: 80, rows: 24 }, noop, noop);
  const b = globalManager.createSession({ cols: 80, rows: 24 }, noop, noop);
  try {
    assert.notEqual(a.id, b.id);
    assert.match(a.id, /^[0-9a-f-]{36}$/);
  } finally {
    globalManager.closeSession(a.id);
    globalManager.closeSession(b.id);
  }
});

test('listSessions reports the live sessions', () => {
  const before = globalManager.listSessions().length;
  const s = globalManager.createSession({ cols: 80, rows: 24 }, noop, noop);
  try {
    assert.equal(globalManager.listSessions().length, before + 1);
    assert.ok(globalManager.listSessions().some(x => x.id === s.id));
  } finally {
    globalManager.closeSession(s.id);
  }
  assert.equal(globalManager.listSessions().length, before);
});

test('a vanished cwd falls back to home instead of failing to start', () => {
  const s = globalManager.createSession(
    { cols: 80, rows: 24, cwd: '/definitiv/nicht/da' }, noop, noop);
  try {
    assert.ok(s.pty.pid > 0, 'die Shell läuft trotzdem');
  } finally {
    globalManager.closeSession(s.id);
  }
});

test('a real cwd is honoured', async () => {
  const target = os.tmpdir();
  let output = '';
  const s = globalManager.createSession(
    { cols: 80, rows: 24, cwd: target },
    (_id, data) => { output += data; },
    noop,
  );
  try {
    globalManager.write(s.id, 'pwd\r');
    await new Promise(r => setTimeout(r, 1500));
    // macOS meldet /private/var/... für /var/... — beide Formen zulassen.
    const tail = target.replace(/^\/private/, '');
    assert.ok(output.includes(tail) || output.includes(`/private${tail}`),
      `erwartete ${tail} in der Ausgabe, bekam: ${output.slice(-200)}`);
  } finally {
    globalManager.closeSession(s.id);
  }
});
```

- [ ] **Step 5: Run the test**

Run: `cd server && node --require ts-node/register --test src/terminal/terminal.manager.restore.test.ts`
Expected: PASS — 5 Tests grün

Dieser Test startet echte Shells. Das ist Absicht: Ob node-pty ein Startverzeichnis übernimmt, lässt sich nur echt prüfen. Falls der letzte Test auf einer langsamen Maschine wackelt, die Wartezeit erhöhen — **nicht** die Zusicherung aufweichen.

- [ ] **Step 6: Full suite and commit**

```bash
cd server && npx tsc --noEmit && npm test
cd ~/Desktop/tms-terminal
git add server/src/terminal/
git commit -m "feat(terminal): Session-ID und Startverzeichnis vorgebbar, listSessions()

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Die Aufnahme machen

**Files:**
- Create: `src/terminal/restore/snapshotter.ts`
- Test: `src/terminal/restore/snapshotter.test.ts`

**Interfaces:**
- Consumes: `writeSnapshot` (Task 1), `resolveClaudeSession` (Task 2), `listSessions` (Task 3)
- Produces:
  - `SnapshotSource { listSessions(): Array<{ id, pid, cols, rows, cwd? }>; labelFor(id): string | undefined }`
  - `class Snapshotter` mit `start()`, `stop()`, `captureNow(): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/terminal/restore/snapshotter.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Snapshotter } from './snapshotter';
import { readSnapshot } from './snapshot.store';
import type { ClaudeSessionInfo } from './claude-session';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-snapr-'));
}

function harness(sessions: Array<{ id: string; pid: number; cwd?: string }>, claude: Record<number, ClaudeSessionInfo | null> = {}) {
  const dir = tmpDir();
  const snapshotter = new Snapshotter({
    now: () => 1_700_000_000_000,
    serverPid: 4242,
    dir,
    source: {
      listSessions: () => sessions.map(s => ({ id: s.id, pid: s.pid, cols: 80, rows: 24, cwd: s.cwd })),
      labelFor: (id) => `Label ${id}`,
    },
    resolveClaude: async (pid) => claude[pid] ?? null,
  });
  return { snapshotter, dir };
}

test('captureNow writes every live session', async () => {
  const h = harness([{ id: 'a', pid: 10, cwd: '/tmp/a' }, { id: 'b', pid: 20, cwd: '/tmp/b' }]);
  await h.snapshotter.captureNow();
  const snap = readSnapshot(h.dir)!;
  assert.equal(snap.entries.length, 2);
  assert.equal(snap.serverPid, 4242);
  assert.deepEqual(snap.entries.map(e => e.id), ['a', 'b']);
  assert.equal(snap.entries[0].label, 'Label a');
});

test('a session with claude carries the mark, one without does not', async () => {
  const h = harness(
    [{ id: 'a', pid: 10 }, { id: 'b', pid: 20 }],
    { 10: { pid: 11, sessionId: 'claude-1', cwd: '/tmp/a', status: 'busy' } },
  );
  await h.snapshotter.captureNow();
  const snap = readSnapshot(h.dir)!;
  assert.equal(snap.entries[0].claude?.sessionId, 'claude-1');
  assert.equal(snap.entries[0].claude?.status, 'busy');
  assert.equal(snap.entries[1].claude, undefined);
});

test('the claude cwd wins over the pty cwd when they disagree', async () => {
  // Claude knows where it actually runs; the pty cwd is only sampled now and then.
  const h = harness(
    [{ id: 'a', pid: 10, cwd: '/veraltet' }],
    { 10: { pid: 11, sessionId: 'c', cwd: '/echt/aktuell', status: 'idle' } },
  );
  await h.snapshotter.captureNow();
  assert.equal(readSnapshot(h.dir)!.entries[0].cwd, '/echt/aktuell');
});

test('no sessions writes an empty snapshot rather than leaving a stale one', async () => {
  const h = harness([{ id: 'a', pid: 10 }]);
  await h.snapshotter.captureNow();
  assert.equal(readSnapshot(h.dir)!.entries.length, 1);

  const empty = new Snapshotter({
    now: () => 1_700_000_000_001, serverPid: 4242, dir: h.dir,
    source: { listSessions: () => [], labelFor: () => undefined },
    resolveClaude: async () => null,
  });
  await empty.captureNow();
  assert.equal(readSnapshot(h.dir)!.entries.length, 0,
    'sonst würden nach dem Schließen aller Terminals die alten wiederkommen');
});

test('a throwing claude resolver costs only the mark, not the entry', async () => {
  const dir = tmpDir();
  const s = new Snapshotter({
    now: () => 1, serverPid: 1, dir,
    source: { listSessions: () => [{ id: 'a', pid: 10, cols: 80, rows: 24, cwd: '/tmp' }], labelFor: () => undefined },
    resolveClaude: async () => { throw new Error('pgrep weg'); },
  });
  await s.captureNow();
  const snap = readSnapshot(dir)!;
  assert.equal(snap.entries.length, 1, 'das Terminal steht trotzdem drin');
  assert.equal(snap.entries[0].claude, undefined);
});

test('captureNow never throws even if writing fails', async () => {
  const s = new Snapshotter({
    now: () => 1, serverPid: 1, dir: '/definitiv/nicht/beschreibbar',
    source: { listSessions: () => [{ id: 'a', pid: 10, cols: 80, rows: 24 }], labelFor: () => undefined },
    resolveClaude: async () => null,
  });
  await s.captureNow(); // darf nicht werfen
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/terminal/restore/snapshotter.test.ts`
Expected: FAIL — `Cannot find module './snapshotter'`

- [ ] **Step 3: Write minimal implementation**

Create `src/terminal/restore/snapshotter.ts`:

```ts
import { logger } from '../../utils/logger';
import { writeSnapshot, TMS_DIR } from './snapshot.store';
import type { Snapshot, SnapshotEntry } from './snapshot.types';
import { resolveClaudeSession, type ClaudeSessionInfo } from './claude-session';

const CAPTURE_INTERVAL_MS = 30_000;

export interface SnapshotSource {
  listSessions(): Array<{ id: string; pid: number; cols: number; rows: number; cwd?: string }>;
  labelFor(id: string): string | undefined;
}

export interface SnapshotterDeps {
  now: () => number;
  serverPid: number;
  source: SnapshotSource;
  dir?: string;
  resolveClaude?: (shellPid: number) => Promise<ClaudeSessionInfo | null>;
  intervalMs?: number;
}

/**
 * Keeps ~/.tms-terminal/terminals.json current.
 *
 * Runs on a timer rather than only at shutdown: a crash or a power cut leaves no
 * chance to run a signal handler, and those are exactly the cases the user asked
 * to be covered.
 */
export class Snapshotter {
  private timer: NodeJS.Timeout | null = null;
  private capturing = false;

  constructor(private readonly deps: SnapshotterDeps) {}

  start(): void {
    if (this.timer !== null) return;
    void this.captureNow();
    this.timer = setInterval(() => { void this.captureNow(); }, this.deps.intervalMs ?? CAPTURE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Never throws — a failed snapshot must not take anything else down. */
  async captureNow(): Promise<void> {
    if (this.capturing) return; // a slow pgrep must not let runs pile up
    this.capturing = true;
    try {
      const resolve = this.deps.resolveClaude ?? ((pid: number) => resolveClaudeSession(pid));
      const entries: SnapshotEntry[] = [];

      for (const s of this.deps.source.listSessions()) {
        let claude: ClaudeSessionInfo | null = null;
        try {
          claude = await resolve(s.pid);
        } catch {
          claude = null; // no mark for this one; the terminal itself still gets saved
        }
        entries.push({
          id: s.id,
          label: this.deps.source.labelFor(s.id),
          // Claude knows where it actually runs; the pty cwd is only sampled now and then.
          cwd: claude?.cwd !== undefined && claude.cwd !== '' ? claude.cwd : (s.cwd ?? ''),
          cols: s.cols,
          rows: s.rows,
          claude: claude === null ? undefined : { sessionId: claude.sessionId, status: claude.status },
        });
      }

      const snapshot: Snapshot = {
        capturedAt: this.deps.now(),
        serverPid: this.deps.serverPid,
        entries,
      };
      writeSnapshot(snapshot, this.deps.dir ?? TMS_DIR);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[restore] Aufnahme fehlgeschlagen: ${msg}`);
    } finally {
      this.capturing = false;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/terminal/restore/snapshotter.test.ts`
Expected: PASS — 6 Tests grün

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/terminal/restore/
git commit -m "feat(terminal): Snapshotter haelt den Terminal-Stand laufend fest

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wiederherstellen beim Start

**Files:**
- Create: `src/terminal/restore/restore.ts`
- Test: `src/terminal/restore/restore.test.ts`

**Interfaces:**
- Consumes: `consumeSnapshot` (Task 1), `Snapshot`/`SnapshotEntry` (Task 1)
- Produces:
  - `RestoreResult { restored: string[]; resumed: string[]; interrupted: string[]; failed: Array<{ id: string; reason: string }>; skipped?: 'none' | 'stale' | 'other-server' }`
  - `MAX_SNAPSHOT_AGE_MS`, `READY_TIMEOUT_MS`
  - `looksReady(chunk: string): boolean`
  - `restoreTerminals(deps: RestoreDeps): Promise<RestoreResult>`

- [ ] **Step 1: Write the failing test**

Create `src/terminal/restore/restore.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from './snapshot.types';
import { restoreTerminals, looksReady, MAX_SNAPSHOT_AGE_MS } from './restore';

const NOW = 1_700_000_000_000;

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    capturedAt: NOW - 60_000,
    serverPid: 999,
    entries: [
      { id: 'a', label: 'Shell 1', cwd: '/tmp/a', cols: 80, rows: 24,
        claude: { sessionId: 'claude-a', status: 'idle' } },
      { id: 'b', label: 'Shell 2', cwd: '/tmp/b', cols: 80, rows: 24 },
    ],
    ...over,
  };
}

/** Collects what restore did, without starting a single process. */
function harness(snapshot: Snapshot | null, opts: { pidAlive?: boolean } = {}) {
  const created: Array<{ id: string; cwd: string }> = [];
  const written: Array<{ id: string; data: string }> = [];
  const marks: Array<{ id: string; text: string }> = [];
  const observers = new Map<string, (data: string) => void>();
  const fallbacks: Array<() => void> = [];

  const deps = {
    now: () => NOW,
    takeSnapshot: () => snapshot,
    isPidAlive: () => opts.pidAlive ?? false,
    createSession: (e: { id: string; cwd: string; cols: number; rows: number }, onOutput: (d: string) => void) => {
      created.push({ id: e.id, cwd: e.cwd });
      observers.set(e.id, onOutput);
      return true;
    },
    writeToSession: (id: string, data: string) => { written.push({ id, data }); },
    markSession: (id: string, text: string) => { marks.push({ id, text }); },
    maxSessions: 50,
    // Notbremsen-Timer einsammeln statt echt laufen lassen: sonst haengt jeder
    // Test 5 Sekunden und schreibt NACH der Zusicherung noch in die Session.
    setTimeoutFn: (fn: () => void) => { fallbacks.push(fn); return 0; },
  };
  return { deps, created, written, marks, observers, fallbacks };
}

test('a fresh snapshot restores every entry', async () => {
  const h = harness(snap());
  const result = await restoreTerminals(h.deps);
  assert.deepEqual(h.created.map(c => c.id), ['a', 'b']);
  assert.deepEqual(h.created.map(c => c.cwd), ['/tmp/a', '/tmp/b']);
  assert.deepEqual(result.restored, ['a', 'b']);
});

test('the resume command goes out only once the shell looks ready', async () => {
  const h = harness(snap());
  await restoreTerminals(h.deps);
  assert.deepEqual(h.written, [], 'noch nichts geschrieben — die Shell hat sich nicht gemeldet');

  h.observers.get('a')!('ayysir@MacBook-Pro ~ % ');
  assert.equal(h.written.length, 1);
  assert.equal(h.written[0].id, 'a');
  assert.equal(h.written[0].data, 'claude --resume claude-a\r');
});

test('a terminal without a claude mark never gets a command', async () => {
  const h = harness(snap());
  await restoreTerminals(h.deps);
  h.observers.get('b')!('ayysir@MacBook-Pro ~ % ');
  assert.deepEqual(h.written, []);
});

test('the command is sent exactly once, however much output follows', async () => {
  const h = harness(snap());
  await restoreTerminals(h.deps);
  const observer = h.observers.get('a')!;
  observer('~ % ');
  observer('~ % ');
  observer('mehr Ausgabe\n~ % ');
  assert.equal(h.written.length, 1);
});

test('the safety net sends the command when the shell never looks ready', async () => {
  // Eine exotische Shell, die nie einen erkennbaren Prompt druckt, darf die
  // Wiederherstellung nicht dauerhaft blockieren.
  const h = harness(snap());
  await restoreTerminals(h.deps);
  assert.deepEqual(h.written, [], 'noch nichts');
  h.fallbacks.forEach(fn => fn());          // 5-Sekunden-Notbremse ausloesen
  assert.equal(h.written.length, 1);
  assert.equal(h.written[0].data, 'claude --resume claude-a\r');
});

test('the safety net does not send twice when the prompt arrived first', async () => {
  const h = harness(snap());
  await restoreTerminals(h.deps);
  h.observers.get('a')!('~ % ');
  h.fallbacks.forEach(fn => fn());
  assert.equal(h.written.length, 1, 'genau einmal, egal in welcher Reihenfolge');
});

test('a snapshot older than the limit is discarded', async () => {
  const h = harness(snap({ capturedAt: NOW - MAX_SNAPSHOT_AGE_MS - 1000 }));
  const result = await restoreTerminals(h.deps);
  assert.deepEqual(h.created, []);
  assert.equal(result.skipped, 'stale');
});

test('a snapshot just inside the limit is restored', async () => {
  const h = harness(snap({ capturedAt: NOW - MAX_SNAPSHOT_AGE_MS + 1000 }));
  assert.equal((await restoreTerminals(h.deps)).restored.length, 2);
});

test('a living serverPid means another server owns these terminals', async () => {
  const h = harness(snap(), { pidAlive: true });
  const result = await restoreTerminals(h.deps);
  assert.deepEqual(h.created, []);
  assert.equal(result.skipped, 'other-server');
});

test('no snapshot at all is not an error', async () => {
  const h = harness(null);
  const result = await restoreTerminals(h.deps);
  assert.equal(result.skipped, 'none');
  assert.deepEqual(result.restored, []);
});

test('interrupted sessions are reported separately — they wait for input', async () => {
  const h = harness(snap({
    entries: [{ id: 'a', cwd: '/tmp/a', cols: 80, rows: 24, claude: { sessionId: 'c', status: 'busy' } }],
  }));
  const result = await restoreTerminals(h.deps);
  assert.deepEqual(result.interrupted, ['a']);
});

test('a session that cannot be created is reported, the rest still comes back', async () => {
  const h = harness(snap());
  h.deps.createSession = (e, onOutput) => {
    if (e.id === 'a') return false;
    h.created.push({ id: e.id, cwd: e.cwd });
    h.observers.set(e.id, onOutput);
    return true;
  };
  const result = await restoreTerminals(h.deps);
  assert.deepEqual(result.restored, ['b']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, 'a');
});

test('more entries than the session limit are capped and named, not silently dropped', async () => {
  const many = Array.from({ length: 55 }, (_, i) => ({
    id: `s${i}`, cwd: '/tmp', cols: 80, rows: 24,
  }));
  const h = harness(snap({ entries: many }));
  const result = await restoreTerminals(h.deps);
  assert.equal(result.restored.length, 50);
  assert.equal(result.failed.length, 5);
  assert.match(result.failed[0].reason, /Grenze|limit/i);
});

test('every restored terminal gets a marker line', async () => {
  const h = harness(snap());
  await restoreTerminals(h.deps);
  assert.equal(h.marks.length, 2);
  assert.match(h.marks[0].text, /wiederhergestellt/i);
  assert.match(h.marks[0].text, /Claude/i, 'bei a wird die fortgesetzte Sitzung genannt');
  assert.doesNotMatch(h.marks[1].text, /Claude/i, 'bei b nicht');
});

// ── Bereitschafts-Erkennung ──────────────────────────────────────────────────

test('looksReady recognises common shell prompts', () => {
  for (const s of ['ayysir@MacBook-Pro ~ % ', 'user@host:~/dev$ ', '❯ ', '/tmp # ', 'x › ']) {
    assert.equal(looksReady(s), true, `sollte bereit sein: ${JSON.stringify(s)}`);
  }
});

test('looksReady does not fire on ordinary output', () => {
  for (const s of ['Installing dependencies...', 'npm run build\n', '', 'Fehler: irgendwas']) {
    assert.equal(looksReady(s), false, `sollte NICHT bereit sein: ${JSON.stringify(s)}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/terminal/restore/restore.test.ts`
Expected: FAIL — `Cannot find module './restore'`

- [ ] **Step 3: Write minimal implementation**

Create `src/terminal/restore/restore.ts`:

```ts
import { logger } from '../../utils/logger';
import type { Snapshot, SnapshotEntry } from './snapshot.types';

/** Older than this and the snapshot is not restored — you do not want yesterday's terminals. */
export const MAX_SNAPSHOT_AGE_MS = 30 * 60 * 1000;
/** If a shell never looks ready, send anyway rather than hanging forever. */
export const READY_TIMEOUT_MS = 5000;

export interface RestoreResult {
  restored: string[];
  resumed: string[];
  /** Sessions that were cut off mid-work — they now wait for input. */
  interrupted: string[];
  failed: Array<{ id: string; reason: string }>;
  skipped?: 'none' | 'stale' | 'other-server';
}

export interface RestoreDeps {
  now: () => number;
  takeSnapshot: () => Snapshot | null;
  isPidAlive: (pid: number) => boolean;
  /** Returns false when the session could not be created. */
  createSession: (
    entry: { id: string; cwd: string; cols: number; rows: number },
    onOutput: (data: string) => void,
  ) => boolean;
  writeToSession: (id: string, data: string) => void;
  /** Writes a line into the OUTPUT stream — not into the shell, so it stays out of the history. */
  markSession: (id: string, text: string) => void;
  maxSessions: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

/**
 * A freshly spawned shell is not ready at once — zsh loads .zshrc, plugins and
 * prompt themes. Writing too early loses the command.
 *
 * Same approach as the delegated-task machinery in manager.service.ts: wait for
 * the EVENT (prompt-looking output), not for a clock. A fixed delay would be
 * wrong on both ends — 200 ms warm, seconds with a cold cache.
 */
export function looksReady(chunk: string): boolean {
  const tail = chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
  if (tail === '') return false;
  return /[$%>#❯›]$/.test(tail);
}

export async function restoreTerminals(deps: RestoreDeps): Promise<RestoreResult> {
  const result: RestoreResult = { restored: [], resumed: [], interrupted: [], failed: [] };

  const snapshot = deps.takeSnapshot();
  if (snapshot === null) {
    result.skipped = 'none';
    return result;
  }

  const age = deps.now() - snapshot.capturedAt;
  if (age > MAX_SNAPSHOT_AGE_MS) {
    logger.info(`[restore] Aufnahme ist ${Math.round(age / 60_000)} Min alt — verworfen`);
    result.skipped = 'stale';
    return result;
  }

  if (deps.isPidAlive(snapshot.serverPid)) {
    logger.warn(`[restore] Server ${snapshot.serverPid} lebt noch — keine Wiederherstellung`);
    result.skipped = 'other-server';
    return result;
  }

  const schedule = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));

  for (const entry of snapshot.entries) {
    if (result.restored.length >= deps.maxSessions) {
      result.failed.push({ id: entry.id, reason: 'Sitzungs-Grenze erreicht' });
      continue;
    }
    if (!restoreOne(entry, deps, result, schedule)) continue;
  }

  logger.info(
    `[restore] ${result.restored.length} Terminal(s) wiederhergestellt, ` +
    `${result.resumed.length} Claude-Sitzung(en) fortgesetzt, ${result.failed.length} Fehler`,
  );
  return result;
}

function restoreOne(
  entry: SnapshotEntry,
  deps: RestoreDeps,
  result: RestoreResult,
  schedule: (fn: () => void, ms: number) => unknown,
): boolean {
  const command = entry.claude !== undefined
    ? `claude --resume ${entry.claude.sessionId}\r`
    : null;

  let sent = false;
  const sendOnce = (): void => {
    if (sent || command === null) return;
    sent = true;
    try {
      deps.writeToSession(entry.id, command);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failed.push({ id: entry.id, reason: `Resume fehlgeschlagen: ${msg}` });
    }
  };

  const ok = deps.createSession(
    { id: entry.id, cwd: entry.cwd, cols: entry.cols, rows: entry.rows },
    (data) => { if (looksReady(data)) sendOnce(); },
  );

  if (!ok) {
    result.failed.push({ id: entry.id, reason: 'Session ließ sich nicht anlegen' });
    return false;
  }

  result.restored.push(entry.id);

  if (entry.claude !== undefined) {
    result.resumed.push(entry.id);
    if (entry.claude.status === 'busy') result.interrupted.push(entry.id);
    // Safety net: an exotic shell that never prints a recognisable prompt must
    // not block the restore for good.
    schedule(() => sendOnce(), READY_TIMEOUT_MS);
  }

  deps.markSession(entry.id, entry.claude !== undefined
    ? '— nach Neustart wiederhergestellt · Claude-Sitzung wird fortgesetzt —'
    : '— nach Neustart wiederhergestellt —');

  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/terminal/restore/restore.test.ts`
Expected: PASS — 16 Tests grün

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/terminal/restore/
git commit -m "feat(terminal): Wiederherstellung beim Start, Resume erst wenn die Shell bereit ist

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Verdrahten und Rückmeldung

**Files:**
- Modify: `src/terminal/terminal.manager.ts` (`injectOutput`)
- Modify: `src/manager/manager.service.ts` (`pushSystemNotice`)
- Modify: `src/index.ts` (Start + Shutdown)
- Modify: `src/websocket/ws.handler.ts` (Aufnahme nach create/close)

**Interfaces:**
- Consumes: alles aus Task 1–5
- Produces:
  - `TerminalManager.injectOutput(sessionId: string, text: string): void`
  - `ManagerService.pushSystemNotice(text: string, topicKey?: string): void`

- [ ] **Step 1: Add injectOutput to the terminal manager**

Die Hinweiszeile darf **nicht** in die Shell geschrieben werden — sie würde ausgeführt und landete in der History. Sie muss in den Ausgabeweg, damit sie im Spiegel und im Scrollback erscheint.

Find how pty data reaches clients and the mirror:

```bash
cd ~/Desktop/tms-terminal && grep -n "onData\|mirror.write\|this.mirrors.get" server/src/terminal/terminal.manager.ts | head -8
```

Add a method next to `write()` that feeds the **same** path, but skips the pty:

```ts
  /**
   * Push a line into the OUTPUT stream of a session, as if the pty had printed it.
   * Used for the restore marker: writing into the shell would execute it and
   * pollute the history.
   */
  injectOutput(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    // Dim, on its own line, so it cannot be mistaken for program output.
    const line = `\r\n\x1b[2m${text}\x1b[0m\r\n`;
    this.mirrors.get(sessionId)?.write(line);
    const cb = this.outputCallbacks.get(sessionId);
    if (cb) cb(sessionId, line);
  }
```

Adjust the two calls to match the real names found by the grep above.

- [ ] **Step 2: Add pushSystemNotice to the manager service**

In `src/manager/manager.service.ts`, next to `markOutboxRead()`:

```ts
  /** A one-off notice from the system (not from the model), e.g. after a restart. */
  pushSystemNotice(text: string, topicKey?: string): void {
    const msg = this.outbox.push({ kind: 'event', text, topicKey });
    if (msg !== null) this.emitProactive(msg);
  }
```

- [ ] **Step 3: Wire the snapshotter and the restore into index.ts**

Add imports:

```ts
import { Snapshotter } from './terminal/restore/snapshotter';
import { restoreTerminals } from './terminal/restore/restore';
import { consumeSnapshot } from './terminal/restore/snapshot.store';
```

Directly **before** `managerService.start()` (line ~69), restore:

```ts
  // Terminals aus der letzten Aufnahme zurückholen. Muss vor dem Manager
  // laufen, damit dessen erste Übersicht die Terminals schon kennt.
  const restoreResult = await restoreTerminals({
    now: () => Date.now(),
    takeSnapshot: () => consumeSnapshot(),
    isPidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    createSession: (entry, onOutput) => {
      try {
        globalManager.createSession(
          { id: entry.id, cwd: entry.cwd, cols: entry.cols, rows: entry.rows },
          (_id, data) => onOutput(data),
          () => { /* close handled by the normal path once a client attaches */ },
        );
        return true;
      } catch {
        return false;
      }
    },
    writeToSession: (id, data) => { globalManager.write(id, data); },
    markSession: (id, text) => { globalManager.injectOutput(id, text); },
    maxSessions: 50,
  });
```

**`process.kill(pid, 0)` sendet kein Signal** — es prüft nur, ob der Prozess existiert. Das ist der übliche Weg und tötet nichts.

Directly **after** `managerService.start()`, report:

```ts
  if (restoreResult.restored.length > 0) {
    const parts = [`${restoreResult.restored.length} Terminal(s) nach dem Neustart wiederhergestellt.`];
    if (restoreResult.resumed.length > 0) {
      parts.push(`${restoreResult.resumed.length} Claude-Sitzung(en) fortgesetzt.`);
    }
    if (restoreResult.interrupted.length > 0) {
      // Das ist der Teil, der wirklich gesagt werden muss: diese Sitzungen
      // arbeiten NICHT weiter, sie warten auf eine Eingabe.
      parts.push(
        `${restoreResult.interrupted.length} davon wurde(n) mitten in der Arbeit ` +
        `unterbrochen und wartet/warten jetzt auf dich.`,
      );
    }
    if (restoreResult.failed.length > 0) {
      parts.push(`${restoreResult.failed.length} ließ(en) sich nicht wiederherstellen.`);
    }
    managerService.pushSystemNotice(`♻️ ${parts.join(' ')}`, `restore:${Date.now()}`);
  }
```

Make the enclosing function `async` if it is not already — check with:

```bash
cd ~/Desktop/tms-terminal && grep -n "async function\|^function main\|void main()" server/src/index.ts | head -5
```

- [ ] **Step 4: Start the snapshotter and capture on shutdown**

After the restore block:

```ts
  const snapshotter = new Snapshotter({
    now: () => Date.now(),
    serverPid: process.pid,
    source: {
      listSessions: () => globalManager.listSessions().map(s => ({
        id: s.id, pid: s.pty.pid, cols: s.cols, rows: s.rows, cwd: s.cwd,
      })),
      labelFor: (id) => managerService.getSessionList().find(s => s.sessionId === id)?.label,
    },
  });
  snapshotter.start();
```

In `shutdown` (line ~202), **before** `globalManager.closeAllSessions()`:

```ts
    // Letzte, exakte Aufnahme — danach sind die PTYs weg.
    snapshotter.stop();
    void snapshotter.captureNow();
```

`captureNow` ist asynchron; der Shutdown hat dank `forceExit` 5 Sekunden Luft, und der 30-Sekunden-Takt hat ohnehin schon eine brauchbare Aufnahme geschrieben.

- [ ] **Step 5: Capture right after create and close**

In `src/websocket/ws.handler.ts`, after a terminal is created and after it is closed, add a capture so a fresh terminal is covered before the next tick. Find the call sites:

```bash
cd ~/Desktop/tms-terminal && grep -n "terminal:create'\|terminal:close'" server/src/websocket/ws.handler.ts | head -4
```

The snapshotter instance lives in `index.ts`. Export a module-level hook so `ws.handler` does not need the instance — add to `snapshotter.ts`:

```ts
let active: Snapshotter | null = null;
export function setActiveSnapshotter(s: Snapshotter | null): void { active = s; }
/** Fire-and-forget capture from anywhere. No-op before the snapshotter exists. */
export function captureSoon(): void { void active?.captureNow(); }
```

Call `setActiveSnapshotter(snapshotter)` in `index.ts` after `snapshotter.start()`, and `captureSoon()` in both `ws.handler` places.

- [ ] **Step 6: Verify**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: PASS, alle bisherigen Tests weiterhin grün

Then a real end-to-end check **without restarting the live server**:

```bash
cd server && node --require ts-node/register -e "
const { Snapshotter } = require('./src/terminal/restore/snapshotter');
const os = require('os'), fs = require('fs'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-live-'));
// Echte Prozess-Auflösung gegen die laufenden Claude-Sitzungen dieser Maschine:
const { execSync } = require('child_process');
const rows = execSync(\"ps -ax -o pid=,ppid=,comm= | awk '\\\$3 ~ /claude\\$/ {print \\\$2}'\", {encoding:'utf8'}).trim().split('\n').map(Number);
const s = new Snapshotter({
  now: () => Date.now(), serverPid: process.pid, dir,
  source: {
    listSessions: () => rows.map((pid, i) => ({ id: 'fake-' + i, pid, cols: 80, rows: 24, cwd: '/tmp' })),
    labelFor: (id) => id,
  },
});
s.captureNow().then(() => {
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'terminals.json'), 'utf8'));
  for (const e of snap.entries) {
    console.log(e.id, '->', e.claude ? e.claude.sessionId.slice(0,8) + ' (' + e.claude.status + ')  cwd=' + e.cwd : 'kein Claude');
  }
});
"
```

Expected: für jede laufende Claude-Sitzung eine Session-ID **und** das echte Arbeitsverzeichnis. Das prüft Auflösung, Aufnahme und Schreiben in einem Durchgang, ohne den Server anzufassen.

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/
git commit -m "feat(terminal): Wiederherstellung verdrahtet, Hinweiszeile und Manager-Nachricht

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Ausrollen

1. `cd server && npm run build` (bei `MODULE_NOT_FOUND` erst `rm .tsbuildinfo`)
2. Den Nutzer bitten, `tms-terminal update` zu laufen. **Der Neustart killt jedes offene Terminal** — genau das soll dieses Feature danach heilen.
3. **Der eigentliche Beweis** liegt erst nach dem zweiten Neustart vor: Der erste Neustart läuft noch mit dem alten Server, der keine Aufnahme geschrieben hat. Ab dem zweiten müssen die Terminals zurückkommen. Das dem Nutzer klar sagen, sonst wirkt das Feature beim ersten Mal kaputt.
4. Danach prüfen: `grep -n "\[restore\]" ~/.tms-terminal/update.log | tail -20` (der Nutzer sieht diese Logs nicht).
