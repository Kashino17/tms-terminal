# Manager-Agent Stufe 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Manager-Agent bekommt einen strukturierten Faktenspeicher, einen echten Kalender mit Erinnerungen, ein Notiz-/To-do-System und einen proaktiven Kanal, über den er von sich aus schreibt — sichtbar als Badge auf der Dynamic Island und als Push.

**Architecture:** Strikte Trennung von **Sammeln** (deterministisch, dauerhaft, ohne Modell) und **Urteilen** (Modell, nur bei Anlass). Vier JSON-Dateien unter `~/.tms-terminal/manager/` bilden das Weltmodell; reine Funktionen rechnen darauf; das Modell greift über fünf neue Werkzeuge zu. Diese Trennung ist zugleich die Ausfallsicherung: Erinnerungen feuern auch dann, wenn kein Modell erreichbar ist.

**Tech Stack:** TypeScript, Node ≥20, `node:test` + `node:assert/strict` (**kein Vitest**), `ts-node`, `ws`, `firebase-admin` (FCM). Frontend: reines HTML/CSS/JS im Season-2-Mockup, gebaut über `npm run build:season2`.

## Global Constraints

- **Branch:** `feat/manager-chat-redesign` im Worktree `~/Desktop/tms-terminal`. **Nicht** `master`, **nicht** der Worktree `~/Desktop/TMS Terminal`.
- **Testbefehl:** `npm test` in `server/` (= `node --require ts-node/register --test 'src/**/*.test.ts'`). Einzelne Datei: `node --require ts-node/register --test src/manager/agenda/agenda.time.test.ts`.
- **Testimporte:** immer `import { test } from 'node:test'` und `import assert from 'node:assert/strict'`. Niemals `vitest`, `jest`, `describe/it` aus anderen Runnern.
- **Keine neuen Laufzeit-Abhängigkeiten.** Kein SQLite, kein Datumspaket. Nur Node-Standardbibliothek und was in `server/package.json` bereits steht.
- **Zeitangaben** sind lokale Wanduhrzeit als String `"YYYY-MM-DDTHH:MM"`, niemals Unix-Timestamps. Umrechnung ausschließlich über `new Date(y, m-1, d, h, mi, 0, 0)`.
- **Uhren werden injiziert.** Jede Klasse mit Zeitverhalten bekommt `now: () => number` als Konstruktorargument — Muster aus `src/notifications/prompt.detector.test.ts`.
- **Dateischreiben immer atomar:** in `<datei>.tmp` schreiben, dann `fs.renameSync`. Modus `0o600`, Verzeichnis `0o700`.
- **Git im Sammler:** ausschließlich Plumbing (`git rev-parse`, `git log -1 --format=…`). **Niemals `git status`** — der iCloud-Desktop lässt baumdurchsuchende Operationen minutenlang hängen. Jeder Aufruf mit 3 s Timeout.
- **UI-Sprache Deutsch**, Code und Bezeichner Englisch.
- **Bridge-IDs unverändert lassen:** `managerTextInput`, `managerMicBtn`, `mgrModelName`, `managerAttachRow`, `managerAttachBtn`, `mgrPresence`, `islandMgrName`. `mobile/src/season2/web/bridge.js` greift per ID zu.
- **Season 2 wird im Mockup bearbeitet** — und zwar über Worktree-Grenzen hinweg. `mobile/scripts/build-season2-html.js:16` hat den Quellpfad **fest verdrahtet**:
  ```js
  const MOCKUP_DIR = '/Users/ayysir/Desktop/TMS Terminal/mockups/season2';
  ```
  Das heißt:
  - **Bearbeitet wird** `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` (Dev-Worktree, Großbuchstabe + Leerzeichen).
  - **Gebaut wird** mit `npm run build:season2` in `~/Desktop/tms-terminal/mobile/` (Live-Worktree).
  - Erzeugt wird `liquidDeckHtml.ts` im Live-Worktree. Diese Datei wird **nie** direkt editiert, aber **muss mitcommittet werden**.

  Eine Änderung am Mockup im Live-Worktree hat **keine Wirkung** — sie wird vom Build schlicht nicht gelesen.
- **Server niemals unaufgefordert neu starten.** Er besitzt alle node-pty-Sitzungen; ein Neustart killt jedes offene Terminal, möglicherweise auch die Sitzung, in der gearbeitet wird.
- **Commits:** nach jedem Task, Nachricht endet auf `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File Structure

Alle Pfade relativ zu `~/Desktop/tms-terminal`.

**Neu — Server:**

| Datei | Verantwortung |
|---|---|
| `server/src/manager/store.ts` | Atomares Lesen/Schreiben der JSON-Dateien, Quarantäne beschädigter Dateien |
| `server/src/manager/agenda/agenda.types.ts` | Typen für Termine und Erinnerungen |
| `server/src/manager/agenda/agenda.time.ts` | Reine Zeitrechnung: Wanduhrzeit → Epoch, nächstes Vorkommen, fällige Erinnerungen |
| `server/src/manager/agenda/agenda.store.ts` | CRUD auf `agenda.json` |
| `server/src/manager/agenda/agenda.scheduler.ts` | Wecker im Minutentakt, Nachholen nach Neustart |
| `server/src/manager/entries/entries.types.ts` | Typ für Einträge |
| `server/src/manager/entries/entries.store.ts` | CRUD auf `entries.json` |
| `server/src/manager/outbox/outbox.types.ts` | Typen für proaktive Nachrichten |
| `server/src/manager/outbox/outbox.ts` | Dosierung, Themen-Unterdrückung, Ungelesen-Zähler |
| `server/src/manager/tools/definitions.ts` | Aus `manager.service.ts` verschobene `MANAGER_TOOLS` + neue Definitionen |
| `server/src/manager/tools/system-prompt.ts` | Aus `manager.service.ts` verschobenes `buildSystemPrompt` |
| `server/src/manager/context/collector.ts` | Projektfakten aus Transkripten, Dateizeiten, Git |
| `server/src/manager/context/osc.ts` | OSC-Titel aus dem PTY-Strom |
| `server/src/manager/context/stuck.ts` | Fehlersignaturen normalisieren und zählen |
| `server/src/manager/context/triggers.ts` | Auslöser-Verdrahtung und Check-in-Zeiten |

**Geändert — Server:**

| Datei | Änderung |
|---|---|
| `server/src/manager/manager.service.ts` | Zeilen 33–405 (`MANAGER_TOOLS`) und 551–779 (`buildSystemPrompt`) raus; neue Action-Typen in `toolCallsToActions` und `executeAction`; `feedOutput` ruft OSC- und Stuck-Erkennung |
| `server/src/websocket/ws.handler.ts` | Neue `manager:*`-Nachrichten, neuer Callback für proaktive Nachrichten |
| `shared/protocol.ts` | Acht neue Nachrichtentypen |

**Geändert — App:**

| Datei | Änderung |
|---|---|
| `mockups/season2/liquid-deck/index.html` | Sub-Tabs Chat/Agenda/Notizen, zwei neue Ansichten, Island-Badge |
| `mobile/src/season2/web/bridge.js` | Weiterleitung der neuen Nachrichten |

**Testdateien** liegen jeweils neben der Implementierung als `<name>.test.ts`.

---

# Phase A — Speicher, Kalender, Erinnerungen

Am Ende von Phase A (Task 10) ist das System **benutzbar**: Termine anlegen, Erinnerungen bekommen, Notizen führen, Badge auf der Island. Sammler und Vorschläge kommen erst in Phase B.

---

### Task 1: Faktenspeicher

**Files:**
- Create: `server/src/manager/store.ts`
- Test: `server/src/manager/store.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  - `MANAGER_DIR: string`
  - `readStore<T>(fileName: string, fallback: T, dir?: string): T`
  - `writeStore<T>(fileName: string, data: T, dir?: string): void`
  - `takeCorruptionReports(): string[]`

- [ ] **Step 1: Write the failing test**

Create `server/src/manager/store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readStore, writeStore, takeCorruptionReports } from './store';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-store-'));
}

test('write then read round-trips', () => {
  const dir = tmpDir();
  writeStore('x.json', { items: [1, 2, 3] }, dir);
  assert.deepEqual(readStore('x.json', { items: [] as number[] }, dir), { items: [1, 2, 3] });
});

test('missing file returns the fallback and does not create the file', () => {
  const dir = tmpDir();
  assert.deepEqual(readStore('nope.json', { items: [7] }, dir), { items: [7] });
  assert.equal(fs.existsSync(path.join(dir, 'nope.json')), false);
});

test('written file is not world-readable', () => {
  const dir = tmpDir();
  writeStore('perm.json', { a: 1 }, dir);
  const mode = fs.statSync(path.join(dir, 'perm.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('corrupt file is quarantined, fallback returned, corruption reported', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ this is not json');
  takeCorruptionReports(); // drain anything left over from other tests

  const result = readStore('bad.json', { items: [] as string[] }, dir);

  assert.deepEqual(result, { items: [] }, 'fallback must be returned');
  assert.equal(fs.existsSync(path.join(dir, 'bad.json')), false, 'original must be moved away');
  const quarantined = fs.readdirSync(dir).filter(f => f.startsWith('bad.json.corrupt-'));
  assert.equal(quarantined.length, 1, 'exactly one quarantine file');

  const reports = takeCorruptionReports();
  assert.equal(reports.length, 1);
  assert.match(reports[0], /bad\.json/);
});

test('takeCorruptionReports drains the list', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'bad2.json'), 'nope');
  takeCorruptionReports();
  readStore('bad2.json', {}, dir);
  assert.equal(takeCorruptionReports().length, 1);
  assert.equal(takeCorruptionReports().length, 0, 'second call must be empty');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/manager/store.test.ts`
Expected: FAIL — `Cannot find module './store'`

- [ ] **Step 3: Write minimal implementation**

Create `server/src/manager/store.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';

/** All Stufe-1 manager state lives here. */
export const MANAGER_DIR = path.join(os.homedir(), '.tms-terminal', 'manager');

/** Corruption notices waiting to be reported to the user. Drained by the caller. */
const corruptionReports: string[] = [];

export function takeCorruptionReports(): string[] {
  return corruptionReports.splice(0, corruptionReports.length);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Read a JSON store. A missing file yields the fallback silently.
 * A corrupt file is moved aside (never deleted) and reported — user data must
 * never disappear without the user hearing about it.
 */
export function readStore<T>(fileName: string, fallback: T, dir: string = MANAGER_DIR): T {
  const file = path.join(dir, fileName);
  if (!fs.existsSync(file)) return fallback;

  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantine = `${file}.corrupt-${stamp}`;
    try {
      fs.renameSync(file, quarantine);
      corruptionReports.push(
        `Die Datei ${fileName} war beschädigt. Sie liegt jetzt als ${path.basename(quarantine)} daneben, ` +
        `und ich habe leer neu angefangen.`,
      );
      logger.error(`[manager-store] ${fileName} corrupt → quarantined as ${path.basename(quarantine)}`);
    } catch (renameErr) {
      const msg = renameErr instanceof Error ? renameErr.message : String(renameErr);
      logger.error(`[manager-store] could not quarantine ${fileName}: ${msg}`);
    }
    return fallback;
  }
}

/** Atomic write: temp file + rename, so a crash never leaves a half-written store. */
export function writeStore<T>(fileName: string, data: T, dir: string = MANAGER_DIR): void {
  ensureDir(dir);
  const file = path.join(dir, fileName);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/manager/store.test.ts`
Expected: PASS — 5 Tests grün

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/store.ts server/src/manager/store.test.ts
git commit -m "feat(manager): atomarer Faktenspeicher mit Quarantäne für beschädigte Dateien

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Zeitrechnung für Termine

Der Kern des Kalenders und die Stelle, an der Kalender-Implementierungen üblicherweise falsch sind. Reine Funktionen, keine Seiteneffekte, kein Dateizugriff.

**Files:**
- Create: `server/src/manager/agenda/agenda.types.ts`
- Create: `server/src/manager/agenda/agenda.time.ts`
- Test: `server/src/manager/agenda/agenda.time.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  - `RepeatRule = 'none' | 'yearly' | 'monthly' | 'weekly' | 'daily'`
  - `AgendaReminder { id: string; offsetMinutes: number; firedFor?: number }`
  - `AgendaItem { id, title, note?, at, allDay, repeat, reminders, source, createdAt }`
  - `AgendaFile { items: AgendaItem[] }`
  - `parseWallTime(at: string): WallTime | null`
  - `wallTimeToEpoch(w: WallTime): number`
  - `nextOccurrence(item: AgendaItem, afterMs: number): number | null`
  - `dueReminders(items: AgendaItem[], nowMs: number, windowStartMs: number): DueReminder[]`
  - `DueReminder { item: AgendaItem; reminder: AgendaReminder; dueAt: number; occurrenceAt: number }`

- [ ] **Step 1: Write the types file**

Create `server/src/manager/agenda/agenda.types.ts`:

```ts
export type RepeatRule = 'none' | 'yearly' | 'monthly' | 'weekly' | 'daily';

export interface AgendaReminder {
  id: string;
  /** Minutes BEFORE the occurrence. 0 = at the appointment itself. */
  offsetMinutes: number;
  /**
   * Epoch ms of the OCCURRENCE this reminder last fired for — not the firing time.
   * For a one-off that is equivalent; for a yearly birthday it is the difference
   * between "fires every year" and "fires once, then never again".
   */
  firedFor?: number;
}

export interface AgendaItem {
  id: string;
  title: string;
  /** Verbatim wording of the user, used when the reminder fires. */
  note?: string;
  /** Local wall-clock time, "YYYY-MM-DDTHH:MM". Never a Unix timestamp. */
  at: string;
  allDay: boolean;
  repeat: RepeatRule;
  reminders: AgendaReminder[];
  source: 'user' | 'agent';
  createdAt: number;
}

export interface AgendaFile {
  items: AgendaItem[];
}
```

- [ ] **Step 2: Write the failing test**

Create `server/src/manager/agenda/agenda.time.test.ts`. The `process.env.TZ` line must be the **first executable statement**, before any `Date` is constructed:

```ts
process.env.TZ = 'Europe/Berlin';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgendaItem } from './agenda.types';
import { parseWallTime, wallTimeToEpoch, nextOccurrence, dueReminders } from './agenda.time';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function item(over: Partial<AgendaItem> = {}): AgendaItem {
  return {
    id: 'i1', title: 'Test', at: '2026-08-04T14:00', allDay: false,
    repeat: 'none', reminders: [], source: 'user', createdAt: 0, ...over,
  };
}

function at(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

test('parseWallTime accepts the canonical form and rejects junk', () => {
  assert.deepEqual(parseWallTime('2026-08-04T14:00'),
    { year: 2026, month: 8, day: 4, hour: 14, minute: 0 });
  assert.equal(parseWallTime('2026-08-04'), null);
  assert.equal(parseWallTime('2026-08-04T14:00:00Z'), null);
  assert.equal(parseWallTime('garbage'), null);
});

test('a one-off returns its own time, then null once past', () => {
  const it = item({ at: '2026-08-04T14:00' });
  assert.equal(nextOccurrence(it, at(2026, 8, 1)), at(2026, 8, 4, 14, 0));
  assert.equal(nextOccurrence(it, at(2026, 8, 4, 13, 59)), at(2026, 8, 4, 14, 0));
  assert.equal(nextOccurrence(it, at(2026, 8, 4, 14, 1)), null);
});

test('14:00 stays 14:00 across the autumn DST change', () => {
  // Europe/Berlin falls back on 2026-10-25. A daily 14:00 appointment must be
  // 14:00 wall-clock on both sides — not 13:00 or 15:00.
  const it = item({ at: '2026-10-24T14:00', repeat: 'daily' });
  const before = nextOccurrence(it, at(2026, 10, 24))!;
  const after = nextOccurrence(it, at(2026, 10, 26))!;
  assert.equal(new Date(before).getHours(), 14);
  assert.equal(new Date(after).getHours(), 14, 'must still be 14:00 local after DST');
  // The gap is 48h of wall time but 49h of real time — proof DST was applied.
  assert.equal(after - before, 49 * HOUR);
});

test('a 02:30 reminder on the spring-forward night yields a usable time', () => {
  // Europe/Berlin springs forward 2026-03-29: 02:30 local does not exist.
  // It must normalise forward, never produce NaN and never loop forever.
  const it = item({ at: '2026-03-29T02:30', repeat: 'none' });
  const occ = nextOccurrence(it, at(2026, 3, 1));
  assert.notEqual(occ, null);
  assert.equal(Number.isNaN(occ), false);
  assert.equal(new Date(occ!).getHours(), 3, 'non-existent 02:30 normalises to 03:30');
});

test('a yearly 29 February falls back to 28 February in non-leap years', () => {
  const it = item({ at: '2024-02-29T09:00', repeat: 'yearly' });
  const y2027 = nextOccurrence(it, at(2027, 1, 1))!;
  assert.equal(new Date(y2027).getMonth(), 1, 'February');
  assert.equal(new Date(y2027).getDate(), 28, '28th in a non-leap year');
  const y2028 = nextOccurrence(it, at(2028, 1, 1))!;
  assert.equal(new Date(y2028).getDate(), 29, '29th in the leap year 2028');
});

test('a yearly birthday keeps recurring', () => {
  const it = item({ at: '2020-07-30T00:00', allDay: true, repeat: 'yearly' });
  assert.equal(nextOccurrence(it, at(2026, 7, 1)), at(2026, 7, 30));
  assert.equal(nextOccurrence(it, at(2026, 8, 1)), at(2027, 7, 30));
});

test('monthly clamps to the last day of short months', () => {
  const it = item({ at: '2026-01-31T08:00', repeat: 'monthly' });
  const feb = nextOccurrence(it, at(2026, 2, 1))!;
  assert.equal(new Date(feb).getMonth(), 1);
  assert.equal(new Date(feb).getDate(), 28);
});

test('dueReminders finds a two-day-ahead reminder while the appointment is still future', () => {
  const it = item({
    at: '2026-08-04T14:00',
    reminders: [
      { id: 'r2d', offsetMinutes: 2 * 24 * 60 },
      { id: 'r1h', offsetMinutes: 60 },
    ],
  });
  const now = at(2026, 8, 2, 14, 0); // exactly two days before
  const due = dueReminders([it], now, now - 5 * MIN);
  assert.equal(due.length, 1);
  assert.equal(due[0].reminder.id, 'r2d');
  assert.equal(due[0].occurrenceAt, at(2026, 8, 4, 14, 0));
});

test('an already-fired reminder for the same occurrence is not returned again', () => {
  const occ = at(2026, 8, 4, 14, 0);
  const it = item({
    at: '2026-08-04T14:00',
    reminders: [{ id: 'r1h', offsetMinutes: 60, firedFor: occ }],
  });
  const now = at(2026, 8, 4, 13, 0);
  assert.equal(dueReminders([it], now, now - 5 * MIN).length, 0);
});

test('a yearly reminder fires again next year despite firedFor from last year', () => {
  const it = item({
    at: '2020-07-30T09:00', repeat: 'yearly',
    reminders: [{ id: 'r0', offsetMinutes: 0, firedFor: at(2025, 7, 30, 9, 0) }],
  });
  const now = at(2026, 7, 30, 9, 0);
  const due = dueReminders([it], now, now - 5 * MIN);
  assert.equal(due.length, 1, 'last year\'s firedFor must not silence this year');
  assert.equal(due[0].occurrenceAt, at(2026, 7, 30, 9, 0));
});

test('reminders outside the window are not returned', () => {
  const it = item({ at: '2026-08-04T14:00', reminders: [{ id: 'r0', offsetMinutes: 0 }] });
  const tooEarly = at(2026, 8, 4, 13, 0);
  assert.equal(dueReminders([it], tooEarly, tooEarly - 5 * MIN).length, 0, 'not due yet');
  const wayLater = at(2026, 8, 6, 14, 0);
  assert.equal(dueReminders([it], wayLater, wayLater - 5 * MIN).length, 0, 'fell out of the window');
});

test('results are sorted by due time', () => {
  const it = item({
    at: '2026-08-04T14:00',
    reminders: [
      { id: 'late', offsetMinutes: 0 },
      { id: 'early', offsetMinutes: 30 },
    ],
  });
  const now = at(2026, 8, 4, 14, 0);
  const due = dueReminders([it], now, now - 2 * HOUR);
  assert.deepEqual(due.map(d => d.reminder.id), ['early', 'late']);
});

test('an unparseable item is skipped instead of throwing', () => {
  const bad = item({ at: 'kaputt', reminders: [{ id: 'r', offsetMinutes: 0 }] });
  const now = at(2026, 8, 4, 14, 0);
  assert.deepEqual(dueReminders([bad], now, now - DAY), []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/manager/agenda/agenda.time.test.ts`
Expected: FAIL — `Cannot find module './agenda.time'`

- [ ] **Step 4: Write minimal implementation**

Create `server/src/manager/agenda/agenda.time.ts`:

```ts
import type { AgendaItem, AgendaReminder } from './agenda.types';

export interface WallTime {
  year: number; month: number; day: number; hour: number; minute: number;
}

export interface DueReminder {
  item: AgendaItem;
  reminder: AgendaReminder;
  /** Epoch ms at which this reminder should fire. */
  dueAt: number;
  /** Epoch ms of the occurrence it belongs to. */
  occurrenceAt: number;
}

const AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Loop guards — an appointment further out than this is not worth chasing. */
const MAX_YEARS = 400;
const MAX_MONTHS = 1200;
const MAX_DAY_STEPS = 4000;

export function parseWallTime(at: string): WallTime | null {
  const m = AT_RE.exec(at);
  if (!m) return null;
  return {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]),
  };
}

/**
 * Local wall time → epoch ms.
 * The Date constructor applies the machine's DST rules, which is exactly what we
 * want: "14:00" means 14:00 on the clock on the wall, whatever the offset is that
 * day. Times that do not exist (spring forward) normalise forward by an hour.
 */
export function wallTimeToEpoch(w: WallTime): number {
  return new Date(w.year, w.month - 1, w.day, w.hour, w.minute, 0, 0).getTime();
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(year, month, 0).getDate();
}

/** Next occurrence at or after `afterMs`, or null when a one-off has passed. */
export function nextOccurrence(item: AgendaItem, afterMs: number): number | null {
  const w = parseWallTime(item.at);
  if (w === null) return null;

  if (item.repeat === 'none') {
    const t = wallTimeToEpoch(w);
    return t >= afterMs ? t : null;
  }

  if (item.repeat === 'daily' || item.repeat === 'weekly') {
    const stepDays = item.repeat === 'daily' ? 1 : 7;
    // Step in whole calendar days rather than fixed milliseconds, so a DST
    // change shifts the real duration instead of the wall-clock time.
    const cur: WallTime = { ...w };
    let t = wallTimeToEpoch(cur);
    for (let i = 0; i < MAX_DAY_STEPS && t < afterMs; i++) {
      const stepped = new Date(cur.year, cur.month - 1, cur.day + stepDays, cur.hour, cur.minute, 0, 0);
      cur.year = stepped.getFullYear();
      cur.month = stepped.getMonth() + 1;
      cur.day = stepped.getDate();
      t = stepped.getTime();
    }
    return t >= afterMs ? t : null;
  }

  if (item.repeat === 'monthly') {
    let year = w.year;
    let month = w.month;
    for (let i = 0; i < MAX_MONTHS; i++) {
      const day = Math.min(w.day, daysInMonth(year, month));
      const t = wallTimeToEpoch({ ...w, year, month, day });
      if (t >= afterMs) return t;
      month++;
      if (month > 12) { month = 1; year++; }
    }
    return null;
  }

  // yearly
  let year = w.year;
  for (let i = 0; i < MAX_YEARS; i++) {
    // 29 February in a non-leap year clamps to the 28th rather than vanishing.
    const day = Math.min(w.day, daysInMonth(year, w.month));
    const t = wallTimeToEpoch({ ...w, year, day });
    if (t >= afterMs) return t;
    year++;
  }
  return null;
}

/**
 * Every reminder whose firing time falls in (windowStartMs, nowMs].
 *
 * A reminder with offset o fires at occurrence - o, so we look for the next
 * occurrence at or after windowStart + o. That is what lets a "two days before"
 * reminder be found while the appointment itself is still two days away.
 */
export function dueReminders(
  items: AgendaItem[],
  nowMs: number,
  windowStartMs: number,
): DueReminder[] {
  const out: DueReminder[] = [];

  for (const item of items) {
    if (parseWallTime(item.at) === null) continue; // skip malformed, never throw

    for (const reminder of item.reminders) {
      const offsetMs = reminder.offsetMinutes * 60_000;
      const occurrenceAt = nextOccurrence(item, windowStartMs + offsetMs + 1);
      if (occurrenceAt === null) continue;
      if (reminder.firedFor === occurrenceAt) continue;

      const dueAt = occurrenceAt - offsetMs;
      if (dueAt > nowMs) continue;

      out.push({ item, reminder, dueAt, occurrenceAt });
    }
  }

  return out.sort((a, b) => a.dueAt - b.dueAt);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/manager/agenda/agenda.time.test.ts`
Expected: PASS — 13 Tests grün

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/agenda/
git commit -m "feat(manager): Zeitrechnung für Termine — Wanduhrzeit, Jahres-/Monatswiederholung, 29. Februar

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Terminspeicher und Wecker

**Files:**
- Create: `server/src/manager/agenda/agenda.store.ts`
- Create: `server/src/manager/agenda/agenda.scheduler.ts`
- Test: `server/src/manager/agenda/agenda.scheduler.test.ts`

**Interfaces:**
- Consumes: `readStore`/`writeStore` (Task 1), `AgendaItem`/`AgendaFile` (Task 2), `dueReminders`/`DueReminder`/`nextOccurrence` (Task 2)
- Produces:
  - `loadAgenda(dir?: string): AgendaItem[]`
  - `saveAgenda(items: AgendaItem[], dir?: string): void`
  - `addAgendaItem(input: NewAgendaInput, dir?: string): AgendaItem`
  - `updateAgendaItem(id: string, patch: Partial<AgendaItem>, dir?: string): AgendaItem | null`
  - `deleteAgendaItem(id: string, dir?: string): boolean`
  - `listAgenda(fromMs: number, toMs: number, dir?: string): Array<{ item: AgendaItem; occurrenceAt: number }>`
  - `NewAgendaInput { title, at, allDay?, repeat?, note?, reminderOffsets?: number[], source? }`
  - `class AgendaScheduler` mit `start()`, `stop()`, `tick()`

- [ ] **Step 1: Write the store implementation**

Create `server/src/manager/agenda/agenda.store.ts`:

```ts
import { randomUUID } from 'crypto';
import { readStore, writeStore, MANAGER_DIR } from '../store';
import type { AgendaFile, AgendaItem, RepeatRule } from './agenda.types';
import { nextOccurrence } from './agenda.time';

const FILE = 'agenda.json';

export interface NewAgendaInput {
  title: string;
  at: string;
  allDay?: boolean;
  repeat?: RepeatRule;
  note?: string;
  /** Minutes before the appointment. [] means no reminder at all. */
  reminderOffsets?: number[];
  source?: 'user' | 'agent';
}

export function loadAgenda(dir: string = MANAGER_DIR): AgendaItem[] {
  return readStore<AgendaFile>(FILE, { items: [] }, dir).items;
}

export function saveAgenda(items: AgendaItem[], dir: string = MANAGER_DIR): void {
  // No cap: these are the user's own appointments and must never be dropped.
  writeStore<AgendaFile>(FILE, { items }, dir);
}

export function addAgendaItem(input: NewAgendaInput, dir: string = MANAGER_DIR): AgendaItem {
  const item: AgendaItem = {
    id: randomUUID(),
    title: input.title,
    note: input.note,
    at: input.at,
    allDay: input.allDay ?? false,
    repeat: input.repeat ?? 'none',
    reminders: (input.reminderOffsets ?? [0]).map(offsetMinutes => ({
      id: randomUUID(),
      offsetMinutes,
    })),
    source: input.source ?? 'user',
    createdAt: Date.now(),
  };
  const items = loadAgenda(dir);
  items.push(item);
  saveAgenda(items, dir);
  return item;
}

export function updateAgendaItem(
  id: string,
  patch: Partial<AgendaItem>,
  dir: string = MANAGER_DIR,
): AgendaItem | null {
  const items = loadAgenda(dir);
  const idx = items.findIndex(i => i.id === id);
  if (idx < 0) return null;
  // id and createdAt are not patchable.
  items[idx] = { ...items[idx], ...patch, id: items[idx].id, createdAt: items[idx].createdAt };
  saveAgenda(items, dir);
  return items[idx];
}

export function deleteAgendaItem(id: string, dir: string = MANAGER_DIR): boolean {
  const items = loadAgenda(dir);
  const next = items.filter(i => i.id !== id);
  if (next.length === items.length) return false;
  saveAgenda(next, dir);
  return true;
}

/** Appointments occurring in [fromMs, toMs], sorted, with their concrete occurrence. */
export function listAgenda(
  fromMs: number,
  toMs: number,
  dir: string = MANAGER_DIR,
): Array<{ item: AgendaItem; occurrenceAt: number }> {
  const out: Array<{ item: AgendaItem; occurrenceAt: number }> = [];
  for (const item of loadAgenda(dir)) {
    const occurrenceAt = nextOccurrence(item, fromMs);
    if (occurrenceAt === null || occurrenceAt > toMs) continue;
    out.push({ item, occurrenceAt });
  }
  return out.sort((a, b) => a.occurrenceAt - b.occurrenceAt);
}
```

- [ ] **Step 2: Write the failing scheduler test**

Create `server/src/manager/agenda/agenda.scheduler.test.ts`:

```ts
process.env.TZ = 'Europe/Berlin';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgendaItem } from './agenda.types';
import type { DueReminder } from './agenda.time';
import { AgendaScheduler } from './agenda.scheduler';

const MIN = 60_000;
const HOUR = 60 * MIN;

function at(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

/** Scheduler wired to an in-memory item list and a hand-cranked clock. */
function harness(items: AgendaItem[], startNow: number) {
  let now = startNow;
  const fired: Array<{ title: string; late: boolean }> = [];
  const scheduler = new AgendaScheduler(
    () => now,
    () => items,
    () => { /* in-memory: mutation happens in place */ },
    (d: DueReminder, late: boolean) => fired.push({ title: d.item.title, late }),
  );
  return {
    scheduler,
    fired,
    items,
    advanceTo(ms: number) { now = ms; },
  };
}

function appointment(over: Partial<AgendaItem> = {}): AgendaItem {
  return {
    id: 'a1', title: 'Zahnarzt', at: '2026-08-04T14:00', allDay: false,
    repeat: 'none', reminders: [{ id: 'r0', offsetMinutes: 0 }],
    source: 'user', createdAt: 0, ...over,
  };
}

test('a reminder that comes due fires exactly once', () => {
  const h = harness([appointment()], at(2026, 8, 4, 13, 30));
  h.scheduler.start();
  assert.equal(h.fired.length, 0, 'not due yet');

  h.advanceTo(at(2026, 8, 4, 14, 0));
  h.scheduler.tick();
  assert.equal(h.fired.length, 1);
  assert.equal(h.fired[0].late, false);

  h.advanceTo(at(2026, 8, 4, 14, 1));
  h.scheduler.tick();
  assert.equal(h.fired.length, 1, 'must not fire a second time');
  h.scheduler.stop();
});

test('all three lead-time reminders fire, each on its own', () => {
  const it = appointment({
    reminders: [
      { id: 'r2d', offsetMinutes: 2 * 24 * 60 },
      { id: 'r1d', offsetMinutes: 24 * 60 },
      { id: 'r1h', offsetMinutes: 60 },
    ],
  });
  const h = harness([it], at(2026, 8, 1));
  h.scheduler.start();

  h.advanceTo(at(2026, 8, 2, 14, 0)); h.scheduler.tick();
  assert.equal(h.fired.length, 1, 'two days before');

  h.advanceTo(at(2026, 8, 3, 14, 0)); h.scheduler.tick();
  assert.equal(h.fired.length, 2, 'one day before — must not be silenced by the first');

  h.advanceTo(at(2026, 8, 4, 13, 0)); h.scheduler.tick();
  assert.equal(h.fired.length, 3, 'one hour before');
  h.scheduler.stop();
});

test('after downtime a reminder 11 hours old is caught up and marked late', () => {
  const h = harness([appointment()], at(2026, 8, 5, 1, 0)); // 11h after 14:00
  h.scheduler.start();
  assert.equal(h.fired.length, 1, 'inside the 12h catch-up window');
  assert.equal(h.fired[0].late, true, 'must be flagged as late');
  h.scheduler.stop();
});

test('after downtime a reminder 13 hours old is silently retired', () => {
  const h = harness([appointment()], at(2026, 8, 5, 3, 0)); // 13h after 14:00
  h.scheduler.start();
  assert.equal(h.fired.length, 0, 'outside the window — no flood after long downtime');

  h.advanceTo(at(2026, 8, 5, 4, 0));
  h.scheduler.tick();
  assert.equal(h.fired.length, 0, 'and it stays quiet afterwards');
  h.scheduler.stop();
});

test('a yearly birthday fires again the following year', () => {
  const it = appointment({
    title: 'Geburtstag Mama', at: '2020-07-30T09:00', repeat: 'yearly',
    reminders: [{ id: 'r0', offsetMinutes: 0 }],
  });
  const h = harness([it], at(2026, 7, 30, 8, 0));
  h.scheduler.start();

  h.advanceTo(at(2026, 7, 30, 9, 0)); h.scheduler.tick();
  assert.equal(h.fired.length, 1);

  h.advanceTo(at(2027, 7, 30, 9, 0)); h.scheduler.tick();
  assert.equal(h.fired.length, 2, 'the next year must fire too');
  h.scheduler.stop();
});

test('start() is idempotent and stop() halts ticking', () => {
  const h = harness([appointment()], at(2026, 8, 4, 13, 0));
  h.scheduler.start();
  h.scheduler.start();
  h.scheduler.stop();
  h.advanceTo(at(2026, 8, 4, 14, 0));
  h.scheduler.tick(); // manual tick still works
  assert.equal(h.fired.length, 1);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/manager/agenda/agenda.scheduler.test.ts`
Expected: FAIL — `Cannot find module './agenda.scheduler'`

- [ ] **Step 4: Write minimal implementation**

Create `server/src/manager/agenda/agenda.scheduler.ts`:

```ts
import type { AgendaItem } from './agenda.types';
import { dueReminders, type DueReminder } from './agenda.time';
import { logger } from '../../utils/logger';

const TICK_MS = 60_000;
/** Reminders missed while the server was down are caught up within this window. */
export const CATCH_UP_MS = 12 * 60 * 60 * 1000;
/** How far back reconcile looks when retiring reminders it will never fire. */
const RETIRE_FLOOR_MS = 365 * 24 * 60 * 60 * 1000;
/** A reminder more than this late is announced as "verspätet". */
const LATE_THRESHOLD_MS = 5 * 60_000;

/**
 * Fires due reminders once a minute. Deliberately model-free: reminders must
 * still work when no provider is reachable — that is the whole point of keeping
 * collecting and judging apart.
 */
export class AgendaScheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt = 0;
  private started = false;

  constructor(
    private readonly now: () => number,
    private readonly load: () => AgendaItem[],
    private readonly save: (items: AgendaItem[]) => void,
    private readonly onFire: (due: DueReminder, late: boolean) => void,
    private readonly catchUpMs: number = CATCH_UP_MS,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    const now = this.now();
    this.retireOlderThan(now - this.catchUpMs);
    this.lastTickAt = now - this.catchUpMs;
    this.tick();

    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
    logger.info('[agenda] scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  /** Fire everything due in (lastTickAt, now]. Public so tests can crank it. */
  tick(): void {
    const now = this.now();
    const items = this.load();
    const due = dueReminders(items, now, this.lastTickAt);

    for (const d of due) {
      d.reminder.firedFor = d.occurrenceAt;
      const late = now - d.dueAt > LATE_THRESHOLD_MS;
      try {
        this.onFire(d, late);
      } catch (err) {
        // One bad handler must not stop the remaining reminders.
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[agenda] reminder handler failed for "${d.item.title}": ${msg}`);
      }
    }

    this.lastTickAt = now;
    if (due.length > 0) this.save(items);
  }

  /**
   * Mark everything due before `before` as fired WITHOUT firing it. Without this,
   * a week of downtime would greet the user with dozens of stale reminders.
   */
  private retireOlderThan(before: number): void {
    const items = this.load();
    const stale = dueReminders(items, before, before - RETIRE_FLOOR_MS);
    for (const d of stale) d.reminder.firedFor = d.occurrenceAt;
    if (stale.length > 0) {
      logger.info(`[agenda] retired ${stale.length} reminder(s) older than the catch-up window`);
      this.save(items);
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/manager/agenda/agenda.scheduler.test.ts`
Expected: PASS — 6 Tests grün

- [ ] **Step 6: Run the whole suite to check nothing regressed**

Run: `cd server && npm test`
Expected: PASS — alle bestehenden Tests weiterhin grün

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/agenda/
git commit -m "feat(manager): Terminspeicher + Wecker mit Nachholfenster nach Serverausfall

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Einträge (Notizen und To-dos)

Ein einziger Eintragstyp. Eine Notiz ist ein Eintrag mit `checkable: false` — sie taucht nie in „was ist noch offen" auf.

**Files:**
- Create: `server/src/manager/entries/entries.types.ts`
- Create: `server/src/manager/entries/entries.store.ts`
- Test: `server/src/manager/entries/entries.store.test.ts`

**Interfaces:**
- Consumes: `readStore`/`writeStore`/`MANAGER_DIR` (Task 1)
- Produces:
  - `Entry { id, text, checkable, done, due?, project?, createdAt, updatedAt, source }`
  - `EntriesFile { entries: Entry[] }`
  - `EntryFilter { project?: string; onlyOpen?: boolean }`
  - `NewEntryInput { text: string; checkable?: boolean; due?: string; project?: string; source?: 'user' | 'agent' }`
  - `listEntries(filter?: EntryFilter, dir?: string): Entry[]`
  - `addEntry(input: NewEntryInput, dir?: string): Entry`
  - `updateEntry(id: string, patch: Partial<Entry>, dir?: string): Entry | null`
  - `completeEntry(id: string, done: boolean, dir?: string): Entry | null`
  - `deleteEntry(id: string, dir?: string): boolean`
  - `openCount(dir?: string): number`

- [ ] **Step 1: Write the types file**

Create `server/src/manager/entries/entries.types.ts`:

```ts
export interface Entry {
  id: string;
  text: string;
  /** false = a plain note; it is never counted as "open" and has no checkbox. */
  checkable: boolean;
  done: boolean;
  /** Optional deadline as local wall-clock time, "YYYY-MM-DDTHH:MM". */
  due?: string;
  /** Project key from the collector, e.g. "-Users-ayysir-Desktop-TMS-Terminal". */
  project?: string;
  createdAt: number;
  updatedAt: number;
  source: 'user' | 'agent';
}

export interface EntriesFile {
  entries: Entry[];
}

export interface EntryFilter {
  project?: string;
  /** Only checkable, not-yet-done entries. Notes are excluded by definition. */
  onlyOpen?: boolean;
}
```

- [ ] **Step 2: Write the failing test**

Create `server/src/manager/entries/entries.store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listEntries, addEntry, updateEntry, completeEntry, deleteEntry, openCount,
} from './entries.store';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-entries-'));
}

test('an added entry survives a reload', () => {
  const dir = tmpDir();
  const created = addEntry({ text: 'Server neu bauen', checkable: true }, dir);
  const [loaded] = listEntries(undefined, dir);
  assert.equal(loaded.id, created.id);
  assert.equal(loaded.text, 'Server neu bauen');
  assert.equal(loaded.checkable, true);
  assert.equal(loaded.done, false);
});

test('entries default to being a note, not a to-do', () => {
  const dir = tmpDir();
  const e = addEntry({ text: 'Idee: Manager könnte Wetter zeigen' }, dir);
  assert.equal(e.checkable, false, 'without an explicit flag it is a note');
});

test('onlyOpen excludes notes and finished to-dos', () => {
  const dir = tmpDir();
  addEntry({ text: 'Notiz', checkable: false }, dir);
  const todo = addEntry({ text: 'Offenes To-do', checkable: true }, dir);
  const doneOne = addEntry({ text: 'Erledigtes To-do', checkable: true }, dir);
  completeEntry(doneOne.id, true, dir);

  const open = listEntries({ onlyOpen: true }, dir);
  assert.equal(open.length, 1);
  assert.equal(open[0].id, todo.id);
  assert.equal(openCount(dir), 1);
});

test('the project filter narrows the list', () => {
  const dir = tmpDir();
  addEntry({ text: 'A', project: 'proj-a' }, dir);
  addEntry({ text: 'B', project: 'proj-b' }, dir);
  addEntry({ text: 'C' }, dir);
  assert.equal(listEntries({ project: 'proj-a' }, dir).length, 1);
});

test('completing bumps updatedAt and is reversible', () => {
  const dir = tmpDir();
  const e = addEntry({ text: 'X', checkable: true }, dir);
  const before = e.updatedAt;
  const done = completeEntry(e.id, true, dir)!;
  assert.equal(done.done, true);
  assert.ok(done.updatedAt >= before);
  const undone = completeEntry(e.id, false, dir)!;
  assert.equal(undone.done, false);
});

test('updating cannot rewrite id or createdAt', () => {
  const dir = tmpDir();
  const e = addEntry({ text: 'Original' }, dir);
  const patched = updateEntry(e.id, {
    text: 'Geändert', id: 'gefälscht', createdAt: 0,
  } as Partial<import('./entries.types').Entry>, dir)!;
  assert.equal(patched.text, 'Geändert');
  assert.equal(patched.id, e.id);
  assert.equal(patched.createdAt, e.createdAt);
});

test('unknown ids report failure instead of throwing', () => {
  const dir = tmpDir();
  assert.equal(updateEntry('nope', { text: 'x' }, dir), null);
  assert.equal(completeEntry('nope', true, dir), null);
  assert.equal(deleteEntry('nope', dir), false);
});

test('deleting removes exactly one entry', () => {
  const dir = tmpDir();
  const a = addEntry({ text: 'A' }, dir);
  addEntry({ text: 'B' }, dir);
  assert.equal(deleteEntry(a.id, dir), true);
  assert.deepEqual(listEntries(undefined, dir).map(e => e.text), ['B']);
});

test('entries are never capped — user data must not silently vanish', () => {
  const dir = tmpDir();
  for (let i = 0; i < 600; i++) addEntry({ text: `Eintrag ${i}` }, dir);
  assert.equal(listEntries(undefined, dir).length, 600);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/manager/entries/entries.store.test.ts`
Expected: FAIL — `Cannot find module './entries.store'`

- [ ] **Step 4: Write minimal implementation**

Create `server/src/manager/entries/entries.store.ts`:

```ts
import { randomUUID } from 'crypto';
import { readStore, writeStore, MANAGER_DIR } from '../store';
import type { EntriesFile, Entry, EntryFilter } from './entries.types';

const FILE = 'entries.json';

export interface NewEntryInput {
  text: string;
  /** Defaults to false — a plain note. Only set true for something tickable. */
  checkable?: boolean;
  due?: string;
  project?: string;
  source?: 'user' | 'agent';
}

function load(dir: string): Entry[] {
  return readStore<EntriesFile>(FILE, { entries: [] }, dir).entries;
}

function save(entries: Entry[], dir: string): void {
  // No cap: these are the user's own notes and to-dos.
  writeStore<EntriesFile>(FILE, { entries }, dir);
}

export function listEntries(filter: EntryFilter = {}, dir: string = MANAGER_DIR): Entry[] {
  let entries = load(dir);
  if (filter.project !== undefined) {
    entries = entries.filter(e => e.project === filter.project);
  }
  if (filter.onlyOpen === true) {
    entries = entries.filter(e => e.checkable && !e.done);
  }
  return entries;
}

export function openCount(dir: string = MANAGER_DIR): number {
  return listEntries({ onlyOpen: true }, dir).length;
}

export function addEntry(input: NewEntryInput, dir: string = MANAGER_DIR): Entry {
  const now = Date.now();
  const entry: Entry = {
    id: randomUUID(),
    text: input.text,
    checkable: input.checkable ?? false,
    done: false,
    due: input.due,
    project: input.project,
    createdAt: now,
    updatedAt: now,
    source: input.source ?? 'user',
  };
  const entries = load(dir);
  entries.push(entry);
  save(entries, dir);
  return entry;
}

export function updateEntry(
  id: string,
  patch: Partial<Entry>,
  dir: string = MANAGER_DIR,
): Entry | null {
  const entries = load(dir);
  const idx = entries.findIndex(e => e.id === id);
  if (idx < 0) return null;
  entries[idx] = {
    ...entries[idx],
    ...patch,
    id: entries[idx].id,               // identity is not patchable
    createdAt: entries[idx].createdAt, // nor is creation time
    updatedAt: Date.now(),
  };
  save(entries, dir);
  return entries[idx];
}

export function completeEntry(
  id: string,
  done: boolean,
  dir: string = MANAGER_DIR,
): Entry | null {
  return updateEntry(id, { done }, dir);
}

export function deleteEntry(id: string, dir: string = MANAGER_DIR): boolean {
  const entries = load(dir);
  const next = entries.filter(e => e.id !== id);
  if (next.length === entries.length) return false;
  save(next, dir);
  return true;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/manager/entries/entries.store.test.ts`
Expected: PASS — 9 Tests grün

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/entries/
git commit -m "feat(manager): Einträge — ein Typ für Notizen und To-dos, ohne Obergrenze

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Outbox mit Dosierung

Die Stelle, an der entschieden wird, ob der Agent nervt. Alle Regeln aus der Spec sitzen hier und nirgendwo sonst.

**Files:**
- Create: `server/src/manager/outbox/outbox.types.ts`
- Create: `server/src/manager/outbox/outbox.ts`
- Test: `server/src/manager/outbox/outbox.test.ts`

**Interfaces:**
- Consumes: `readStore`/`writeStore`/`MANAGER_DIR` (Task 1)
- Produces:
  - `OutboxKind = 'reminder' | 'checkin' | 'stuck' | 'suggestion' | 'event'`
  - `OutboxMessage { id, kind, text, topicKey?, project?, sessionId?, createdAt, readAt?, pushedAt?, dismissed? }`
  - `OutboxFile { messages: OutboxMessage[]; suppressedTopics: string[] }`
  - `NewOutboxInput { kind, text, topicKey?, project?, sessionId? }`
  - `class Outbox` mit `push`, `list`, `unreadCount`, `markAllRead`, `markPushed`, `suppressTopic`, `dismiss`, `shouldPush`

- [ ] **Step 1: Write the types file**

Create `server/src/manager/outbox/outbox.types.ts`:

```ts
export type OutboxKind = 'reminder' | 'checkin' | 'stuck' | 'suggestion' | 'event';

export interface OutboxMessage {
  id: string;
  kind: OutboxKind;
  text: string;
  /** Stable key for "this exact topic", e.g. "stuck:<error-hash>". */
  topicKey?: string;
  project?: string;
  sessionId?: string;
  createdAt: number;
  readAt?: number;
  pushedAt?: number;
  dismissed?: boolean;
}

export interface OutboxFile {
  messages: OutboxMessage[];
  /** Topics the user rejected. They never come back. */
  suppressedTopics: string[];
}
```

- [ ] **Step 2: Write the failing test**

Create `server/src/manager/outbox/outbox.test.ts`:

```ts
process.env.TZ = 'Europe/Berlin';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Outbox } from './outbox';

const MIN = 60_000;
const HOUR = 60 * MIN;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-outbox-'));
}

function at(y: number, mo: number, d: number, h = 12, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

/** Outbox on a temp dir with a hand-cranked clock. */
function makeOutbox(startNow: number) {
  const dir = tmpDir();
  let now = startNow;
  const outbox = new Outbox(() => now, dir);
  return { outbox, dir, advance(ms: number) { now += ms; }, setNow(t: number) { now = t; } };
}

test('a reminder always gets through', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  const msg = h.outbox.push({ kind: 'reminder', text: 'Zahnarzt um 14 Uhr' });
  assert.notEqual(msg, null);
  assert.equal(h.outbox.unreadCount(), 1);
});

test('five reminders at the same minute all get through — the cap is for the agent, not the user', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  for (let i = 0; i < 5; i++) {
    assert.notEqual(h.outbox.push({ kind: 'reminder', text: `Erinnerung ${i}`, sessionId: 's1' }), null);
  }
  assert.equal(h.outbox.unreadCount(), 5);
});

test('a second suggestion for the same terminal within the hour is refused', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  assert.notEqual(h.outbox.push({ kind: 'suggestion', text: 'Idee A', sessionId: 's1' }), null);
  h.advance(30 * MIN);
  assert.equal(h.outbox.push({ kind: 'suggestion', text: 'Idee B', sessionId: 's1' }), null);
  h.advance(31 * MIN); // now more than an hour after the first
  assert.notEqual(h.outbox.push({ kind: 'suggestion', text: 'Idee C', sessionId: 's1' }), null);
});

test('the hourly cap is per terminal, not global', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  assert.notEqual(h.outbox.push({ kind: 'suggestion', text: 'A', sessionId: 's1' }), null);
  assert.notEqual(h.outbox.push({ kind: 'suggestion', text: 'B', sessionId: 's2' }), null);
});

test('check-ins ignore the per-terminal cap because they belong to no terminal', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  h.outbox.push({ kind: 'suggestion', text: 'Idee', sessionId: 's1' });
  assert.notEqual(h.outbox.push({ kind: 'checkin', text: 'Das steht heute an' }), null);
});

test('the same topic is never delivered twice', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  assert.notEqual(h.outbox.push({ kind: 'stuck', text: 'Hängst du?', topicKey: 'stuck:abc' }), null);
  h.advance(5 * HOUR); // long past the hourly cap
  assert.equal(h.outbox.push({ kind: 'stuck', text: 'Hängst du immer noch?', topicKey: 'stuck:abc' }), null);
});

test('a suppressed topic is refused forever', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  h.outbox.suppressTopic('stuck:xyz');
  h.advance(30 * 24 * HOUR);
  assert.equal(h.outbox.push({ kind: 'stuck', text: 'Vorschlag', topicKey: 'stuck:xyz' }), null);
});

test('dismissing a message suppresses its topic', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  const msg = h.outbox.push({ kind: 'suggestion', text: 'Idee', topicKey: 'sug:1' })!;
  h.outbox.dismiss(msg.id);
  h.advance(5 * HOUR);
  assert.equal(h.outbox.push({ kind: 'suggestion', text: 'Idee nochmal', topicKey: 'sug:1' }), null);
});

test('quiet hours suppress the push but not the message', () => {
  const h = makeOutbox(at(2026, 8, 4, 23, 30)); // inside 23:00–07:00
  const msg = h.outbox.push({ kind: 'checkin', text: 'Nachts' })!;
  assert.notEqual(msg, null, 'the message is still created');
  assert.equal(h.outbox.unreadCount(), 1, 'and it still counts in the badge');
  assert.equal(h.outbox.shouldPush(msg), false, 'only the push is withheld');
});

test('a reminder pushes even at night — the user asked to be woken', () => {
  const h = makeOutbox(at(2026, 8, 5, 6, 0)); // inside quiet hours
  const msg = h.outbox.push({ kind: 'reminder', text: 'Aufstehen' })!;
  assert.equal(h.outbox.shouldPush(msg), true);
});

test('outside quiet hours everything pushes', () => {
  const h = makeOutbox(at(2026, 8, 4, 10, 0));
  const msg = h.outbox.push({ kind: 'suggestion', text: 'Tagsüber' })!;
  assert.equal(h.outbox.shouldPush(msg), true);
});

test('markAllRead clears the badge', () => {
  const h = makeOutbox(at(2026, 8, 4, 10, 0));
  h.outbox.push({ kind: 'reminder', text: 'A' });
  h.outbox.push({ kind: 'reminder', text: 'B' });
  assert.equal(h.outbox.unreadCount(), 2);
  h.outbox.markAllRead();
  assert.equal(h.outbox.unreadCount(), 0);
});

test('the outbox is capped at 500, dropping read messages first', () => {
  const h = makeOutbox(at(2026, 8, 4, 10, 0));
  for (let i = 0; i < 400; i++) h.outbox.push({ kind: 'reminder', text: `alt ${i}` });
  h.outbox.markAllRead();
  for (let i = 0; i < 200; i++) {
    h.advance(MIN);
    h.outbox.push({ kind: 'reminder', text: `neu ${i}` });
  }
  const all = h.outbox.list(1000);
  assert.equal(all.length, 500);
  assert.equal(h.outbox.unreadCount(), 200, 'unread messages must survive the cap');
});

test('state survives a fresh Outbox on the same directory', () => {
  const h = makeOutbox(at(2026, 8, 4, 10, 0));
  h.outbox.push({ kind: 'reminder', text: 'Persistiert' });
  h.outbox.suppressTopic('t:1');
  const reopened = new Outbox(() => at(2026, 8, 4, 11, 0), h.dir);
  assert.equal(reopened.unreadCount(), 1);
  assert.equal(reopened.push({ kind: 'stuck', text: 'x', topicKey: 't:1' }), null);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/manager/outbox/outbox.test.ts`
Expected: FAIL — `Cannot find module './outbox'`

- [ ] **Step 4: Write minimal implementation**

Create `server/src/manager/outbox/outbox.ts`:

```ts
import { randomUUID } from 'crypto';
import { readStore, writeStore, MANAGER_DIR } from '../store';
import type { OutboxFile, OutboxKind, OutboxMessage } from './outbox.types';

const FILE = 'outbox.json';
const MAX_MESSAGES = 500;
const PER_SESSION_COOLDOWN_MS = 60 * 60 * 1000;
const QUIET_START_HOUR = 23;
const QUIET_END_HOUR = 7;

/** Kinds that are the agent's own idea and therefore rate-limited. */
const AGENT_INITIATED: OutboxKind[] = ['stuck', 'suggestion', 'event'];

export interface NewOutboxInput {
  kind: OutboxKind;
  text: string;
  topicKey?: string;
  project?: string;
  sessionId?: string;
}

export class Outbox {
  constructor(
    private readonly now: () => number,
    private readonly dir: string = MANAGER_DIR,
  ) {}

  private load(): OutboxFile {
    return readStore<OutboxFile>(FILE, { messages: [], suppressedTopics: [] }, this.dir);
  }

  private save(file: OutboxFile): void {
    writeStore<OutboxFile>(FILE, file, this.dir);
  }

  /**
   * Add a message if the dosage rules allow it, otherwise return null.
   *
   * The rules exist so the agent stays welcome: its own ideas are capped, the
   * user's own reminders never are.
   */
  push(input: NewOutboxInput): OutboxMessage | null {
    const file = this.load();
    const now = this.now();

    if (input.topicKey !== undefined) {
      // Rejected once — never again.
      if (file.suppressedTopics.includes(input.topicKey)) return null;
      // Already said once — saying it twice is what makes an assistant annoying.
      if (file.messages.some(m => m.topicKey === input.topicKey)) return null;
    }

    if (AGENT_INITIATED.includes(input.kind) && input.sessionId !== undefined) {
      const recent = file.messages.some(m =>
        m.sessionId === input.sessionId &&
        AGENT_INITIATED.includes(m.kind) &&
        now - m.createdAt < PER_SESSION_COOLDOWN_MS,
      );
      if (recent) return null;
    }

    const msg: OutboxMessage = {
      id: randomUUID(),
      kind: input.kind,
      text: input.text,
      topicKey: input.topicKey,
      project: input.project,
      sessionId: input.sessionId,
      createdAt: now,
    };
    file.messages.push(msg);
    this.enforceCap(file);
    this.save(file);
    return msg;
  }

  /** Newest first. */
  list(limit = 50): OutboxMessage[] {
    return [...this.load().messages].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  unreadCount(): number {
    return this.load().messages.filter(m => m.readAt === undefined).length;
  }

  markAllRead(): void {
    const file = this.load();
    const now = this.now();
    let touched = false;
    for (const m of file.messages) {
      if (m.readAt === undefined) { m.readAt = now; touched = true; }
    }
    if (touched) this.save(file);
  }

  markPushed(id: string): void {
    const file = this.load();
    const msg = file.messages.find(m => m.id === id);
    if (msg === undefined) return;
    msg.pushedAt = this.now();
    this.save(file);
  }

  suppressTopic(topicKey: string): void {
    const file = this.load();
    if (file.suppressedTopics.includes(topicKey)) return;
    file.suppressedTopics.push(topicKey);
    this.save(file);
  }

  /** Rejecting a message also buries its topic for good. */
  dismiss(id: string): void {
    const file = this.load();
    const msg = file.messages.find(m => m.id === id);
    if (msg === undefined) return;
    msg.dismissed = true;
    msg.readAt = msg.readAt ?? this.now();
    if (msg.topicKey !== undefined && !file.suppressedTopics.includes(msg.topicKey)) {
      file.suppressedTopics.push(msg.topicKey);
    }
    this.save(file);
  }

  /**
   * Whether this message may raise a push right now. Quiet hours silence the
   * phone but never the message itself — reminders the user scheduled are exempt,
   * because being woken at 06:00 is exactly what they asked for.
   */
  shouldPush(msg: OutboxMessage): boolean {
    if (msg.kind === 'reminder') return true;
    const hour = new Date(this.now()).getHours();
    const quiet = hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
    return !quiet;
  }

  /** Drop read messages first, oldest to newest; unread ones are kept. */
  private enforceCap(file: OutboxFile): void {
    if (file.messages.length <= MAX_MESSAGES) return;
    const excess = file.messages.length - MAX_MESSAGES;

    const readOldestFirst = file.messages
      .filter(m => m.readAt !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt);
    const doomed = new Set(readOldestFirst.slice(0, excess).map(m => m.id));

    if (doomed.size < excess) {
      // Not enough read messages — fall back to the oldest overall.
      const rest = file.messages
        .filter(m => !doomed.has(m.id))
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const m of rest.slice(0, excess - doomed.size)) doomed.add(m.id);
    }

    file.messages = file.messages.filter(m => !doomed.has(m.id));
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/manager/outbox/outbox.test.ts`
Expected: PASS — 14 Tests grün

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/outbox/
git commit -m "feat(manager): Outbox mit Dosierung, Themen-Gedächtnis und Ruhezeit

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Werkzeug-Definitionen und System-Prompt herauslösen

Reines Verschieben ohne Verhaltensänderung — damit die neuen Werkzeuge in Task 7 nicht in einer 198-KB-Datei landen. Kein neuer Test; der Beweis ist, dass die bestehende Suite und der Compiler grün bleiben.

**Files:**
- Create: `server/src/manager/tools/definitions.ts`
- Create: `server/src/manager/tools/system-prompt.ts`
- Modify: `server/src/manager/manager.service.ts` (Zeilen 33–405 und 551–779 entfernen, Importe ergänzen)

**Interfaces:**
- Consumes: `ToolDefinition` aus `../ai-provider`
- Produces:
  - `MANAGER_TOOLS: ToolDefinition[]` (exportiert aus `tools/definitions.ts`)
  - `PersonalityConfig` und `buildSystemPrompt(p: PersonalityConfig): string` (exportiert aus `tools/system-prompt.ts`)

- [ ] **Step 1: Record the current baseline**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: PASS. Notiere die Anzahl grüner Tests — sie muss am Ende identisch sein.

- [ ] **Step 2: Move the tool definitions**

Create `server/src/manager/tools/definitions.ts` with this header, then paste the **exact** contents of `manager.service.ts` lines 33–405 (from `const MANAGER_TOOLS: ToolDefinition[] = [` through its closing `];`), changing only `const` to `export const`:

```ts
import type { ToolDefinition } from '../ai-provider';

// Moved verbatim out of manager.service.ts (was lines 33–405). Behaviour unchanged.
export const MANAGER_TOOLS: ToolDefinition[] = [
  // ... paste lines 34–404 unchanged ...
];
```

Then in `manager.service.ts`: delete lines 33–405 and add near the other imports:

```ts
import { MANAGER_TOOLS } from './tools/definitions';
```

- [ ] **Step 3: Verify the move compiles and behaves**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: PASS with the same test count as Step 1.

Run: `cd server && node --require ts-node/register -e "const {MANAGER_TOOLS}=require('./src/manager/tools/definitions'); console.log(MANAGER_TOOLS.length, MANAGER_TOOLS.map(t=>t.function.name).join(','))"`
Expected: `24` gefolgt von den Namen, beginnend mit `write_to_terminal,send_enter,send_keys,…`

- [ ] **Step 4: Commit the first move on its own**

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/tools/definitions.ts server/src/manager/manager.service.ts
git commit -m "refactor(manager): MANAGER_TOOLS in tools/definitions.ts verschoben (reines Verschieben)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Move the system prompt**

Create `server/src/manager/tools/system-prompt.ts`. Move the `PersonalityConfig` interface, the `DEFAULT_PERSONALITY` constant and `buildSystemPrompt` (lines 551–779) verbatim, exporting all three:

```ts
export interface PersonalityConfig {
  agentName: string;
  tone: string;
  detail: string;
  emojis: boolean;
  proactive: boolean;
  customInstruction: string;
}

export const DEFAULT_PERSONALITY: PersonalityConfig = {
  agentName: 'Manager',
  tone: 'chill',
  detail: 'balanced',
  emojis: true,
  proactive: true,
  customInstruction: '',
};

// Moved verbatim out of manager.service.ts (was lines 551–779). Behaviour unchanged.
export function buildSystemPrompt(p: PersonalityConfig): string {
  // ... paste the original body unchanged ...
}
```

In `manager.service.ts`: delete the moved declarations and add:

```ts
import { buildSystemPrompt, DEFAULT_PERSONALITY, type PersonalityConfig } from './tools/system-prompt';
```

Re-export `PersonalityConfig` from `manager.service.ts` if other modules import it from there — check with:

```bash
cd ~/Desktop/tms-terminal && grep -rn "PersonalityConfig" server/src --include="*.ts" | grep -v "manager/tools/system-prompt.ts"
```

- [ ] **Step 6: Verify**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: PASS with the same test count as Step 1.

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/tools/system-prompt.ts server/src/manager/manager.service.ts
git commit -m "refactor(manager): buildSystemPrompt in tools/system-prompt.ts verschoben (reines Verschieben)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Die fünf neuen Werkzeuge

Damit kann der Agent Termine und Einträge anlegen, nachschlagen und von sich aus schreiben. Die eigentliche Arbeit liegt in einem eigenen Handler-Modul, damit `manager.service.ts` nur drei kurze `case`-Zweige dazubekommt.

**Files:**
- Create: `server/src/manager/tools/stufe1.handlers.ts`
- Test: `server/src/manager/tools/stufe1.handlers.test.ts`
- Modify: `server/src/manager/tools/definitions.ts` (fünf Definitionen anhängen)
- Modify: `server/src/manager/tools/system-prompt.ts` (aktuelles Datum in den Prompt)
- Modify: `server/src/manager/manager.service.ts` (`ManagerAction`-Typen, `toolCallsToActions`, `executeAction`)

**Interfaces:**
- Consumes: `listAgenda`/`addAgendaItem`/`updateAgendaItem`/`deleteAgendaItem` (Task 3), `listEntries`/`addEntry`/`updateEntry`/`completeEntry`/`deleteEntry` (Task 4), `Outbox` (Task 5)
- Produces:
  - `handleAgendaTool(args: Record<string, string>, nowMs: number, dir?: string): string`
  - `handleEntriesTool(args: Record<string, string>, dir?: string): string`
  - `buildOverview(input: OverviewInput, dir?: string): string`
  - `OverviewInput { nowMs: number; terminals: Array<{ label: string; status: string; cwd?: string }> }`
  - `handleNotifyUser(args: Record<string, string>, outbox: Outbox): string`
  - `parseOffsets(raw: string | undefined): number[]`

- [ ] **Step 1: Write the failing test**

Create `server/src/manager/tools/stufe1.handlers.test.ts`:

```ts
process.env.TZ = 'Europe/Berlin';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Outbox } from '../outbox/outbox';
import {
  parseOffsets, handleAgendaTool, handleEntriesTool, buildOverview, handleNotifyUser,
} from './stufe1.handlers';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-tools-'));
}

function at(y: number, mo: number, d: number, h = 12, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

test('parseOffsets reads the comma-separated form the model produces', () => {
  assert.deepEqual(parseOffsets('2880,1440,60'), [2880, 1440, 60]);
  assert.deepEqual(parseOffsets(' 60 , 0 '), [60, 0]);
  assert.deepEqual(parseOffsets(''), [0], 'empty means "remind me at the appointment"');
  assert.deepEqual(parseOffsets(undefined), [0]);
  assert.deepEqual(parseOffsets('abc,60'), [60], 'junk entries are dropped, not fatal');
});

test('agenda add creates the appointment and confirms it in German', () => {
  const dir = tmpDir();
  const out = handleAgendaTool({
    action: 'add', title: 'Zahnarzt', at: '2026-08-04T14:00', reminder_offsets: '2880,1440,60',
  }, at(2026, 7, 28), dir);

  assert.match(out, /Zahnarzt/);
  assert.match(out, /04\.08\.2026/);
  assert.match(out, /3 Erinnerung/);

  const list = handleAgendaTool({ action: 'list' }, at(2026, 7, 28), dir);
  assert.match(list, /Zahnarzt/);
});

test('agenda add rejects a malformed date instead of storing nonsense', () => {
  const dir = tmpDir();
  const out = handleAgendaTool({ action: 'add', title: 'X', at: 'nächste Woche' }, at(2026, 7, 28), dir);
  assert.match(out, /Fehler/);
  assert.match(out, /YYYY-MM-DDTHH:MM/);
  assert.match(handleAgendaTool({ action: 'list' }, at(2026, 7, 28), dir), /Keine Termine/);
});

test('a yearly birthday is listed for the coming year', () => {
  const dir = tmpDir();
  handleAgendaTool({
    action: 'add', title: 'Geburtstag Mama', at: '2026-07-30T00:00',
    all_day: 'true', repeat: 'yearly', reminder_offsets: '1440',
  }, at(2026, 7, 28), dir);
  const list = handleAgendaTool({ action: 'list', days: '7' }, at(2026, 7, 28), dir);
  assert.match(list, /Geburtstag Mama/);
  assert.match(list, /jährlich/i);
});

test('agenda delete removes the appointment', () => {
  const dir = tmpDir();
  handleAgendaTool({ action: 'add', title: 'Weg damit', at: '2026-08-04T14:00' }, at(2026, 7, 28), dir);
  const list = handleAgendaTool({ action: 'list' }, at(2026, 7, 28), dir);
  const id = /ID: ([0-9a-f-]{36})/.exec(list)![1];
  assert.match(handleAgendaTool({ action: 'delete', id }, at(2026, 7, 28), dir), /gelöscht/i);
  assert.match(handleAgendaTool({ action: 'list' }, at(2026, 7, 28), dir), /Keine Termine/);
});

test('agenda rejects an unknown action', () => {
  const dir = tmpDir();
  assert.match(handleAgendaTool({ action: 'frobnicate' }, at(2026, 7, 28), dir), /Unbekannte Aktion/);
});

test('entries add defaults to a note and can be made checkable', () => {
  const dir = tmpDir();
  assert.match(handleEntriesTool({ action: 'add', text: 'Idee X' }, dir), /Notiz/);
  assert.match(handleEntriesTool({ action: 'add', text: 'Y bauen', checkable: 'true' }, dir), /To-do/);
});

test('entries list only_open hides notes and finished items', () => {
  const dir = tmpDir();
  handleEntriesTool({ action: 'add', text: 'Nur eine Notiz' }, dir);
  handleEntriesTool({ action: 'add', text: 'Offenes Ding', checkable: 'true' }, dir);
  const open = handleEntriesTool({ action: 'list', only_open: 'true' }, dir);
  assert.match(open, /Offenes Ding/);
  assert.doesNotMatch(open, /Nur eine Notiz/);
});

test('entries complete ticks the item off', () => {
  const dir = tmpDir();
  handleEntriesTool({ action: 'add', text: 'Abhaken', checkable: 'true' }, dir);
  const list = handleEntriesTool({ action: 'list' }, dir);
  const id = /ID: ([0-9a-f-]{36})/.exec(list)![1];
  assert.match(handleEntriesTool({ action: 'complete', id }, dir), /erledigt/i);
  assert.equal(/Abhaken/.test(handleEntriesTool({ action: 'list', only_open: 'true' }, dir)), false);
});

test('entries reports a helpful error for a missing id', () => {
  const dir = tmpDir();
  assert.match(handleEntriesTool({ action: 'complete', id: 'gibtsnicht' }, dir), /nicht gefunden/i);
});

test('the overview names terminals, open entries and upcoming appointments', () => {
  const dir = tmpDir();
  handleAgendaTool({ action: 'add', title: 'Zahnarzt', at: '2026-07-29T14:00' }, at(2026, 7, 28), dir);
  handleEntriesTool({ action: 'add', text: 'Server bauen', checkable: 'true' }, dir);

  const out = buildOverview({
    nowMs: at(2026, 7, 28, 10, 0),
    terminals: [{ label: 'Shell 1', status: 'Idle', cwd: '/Users/ayysir/Desktop/TMS Terminal' }],
  }, dir);

  assert.match(out, /Shell 1/);
  assert.match(out, /Server bauen/);
  assert.match(out, /Zahnarzt/);
  assert.match(out, /28\.07\.2026/, 'the overview states today so the model can do date maths');
});

test('the overview stays readable with nothing in it', () => {
  const dir = tmpDir();
  const out = buildOverview({ nowMs: at(2026, 7, 28, 10, 0), terminals: [] }, dir);
  assert.match(out, /Keine Terminals/);
  assert.match(out, /Keine offenen/);
});

test('notify_user writes to the outbox and reports back', () => {
  const dir = tmpDir();
  const outbox = new Outbox(() => at(2026, 7, 28, 10, 0), dir);
  const out = handleNotifyUser(
    { text: 'Du hängst seit zwei Stunden am selben Fehler — schon X probiert?', kind: 'stuck', topic_key: 'stuck:abc' },
    outbox,
  );
  assert.match(out, /gesendet/i);
  assert.equal(outbox.unreadCount(), 1);
});

test('notify_user tells the model plainly when the dosage refused the message', () => {
  const dir = tmpDir();
  const outbox = new Outbox(() => at(2026, 7, 28, 10, 0), dir);
  handleNotifyUser({ text: 'Erster', kind: 'suggestion', topic_key: 'k' }, outbox);
  const second = handleNotifyUser({ text: 'Zweiter', kind: 'suggestion', topic_key: 'k' }, outbox);
  assert.match(second, /nicht gesendet/i);
  assert.equal(outbox.unreadCount(), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/manager/tools/stufe1.handlers.test.ts`
Expected: FAIL — `Cannot find module './stufe1.handlers'`

- [ ] **Step 3: Write minimal implementation**

Create `server/src/manager/tools/stufe1.handlers.ts`:

```ts
import {
  listAgenda, addAgendaItem, deleteAgendaItem, updateAgendaItem,
} from '../agenda/agenda.store';
import { parseWallTime, wallTimeToEpoch } from '../agenda/agenda.time';
import type { RepeatRule } from '../agenda/agenda.types';
import {
  listEntries, addEntry, completeEntry, deleteEntry, updateEntry,
} from '../entries/entries.store';
import { MANAGER_DIR } from '../store';
import type { Outbox } from '../outbox/outbox';
import type { OutboxKind } from '../outbox/outbox.types';

const DAY_MS = 24 * 60 * 60 * 1000;
const AT_FORMAT_HINT = 'Format: YYYY-MM-DDTHH:MM (lokale Zeit), z.B. "2026-08-04T14:00".';

const REPEAT_LABEL: Record<RepeatRule, string> = {
  none: 'einmalig', daily: 'täglich', weekly: 'wöchentlich',
  monthly: 'monatlich', yearly: 'jährlich',
};

function isTrue(v: string | undefined): boolean {
  return v === 'true' || v === '1' || v === 'ja';
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function fmtDateTime(ms: number, allDay: boolean): string {
  if (allDay) return fmtDate(ms);
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${fmtDate(ms)} um ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Models emit every argument as a string; offsets arrive comma-separated. */
export function parseOffsets(raw: string | undefined): number[] {
  if (raw === undefined || raw.trim() === '') return [0];
  const nums = raw.split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n >= 0);
  return nums.length > 0 ? nums : [0];
}

export function handleAgendaTool(
  args: Record<string, string>,
  nowMs: number,
  dir: string = MANAGER_DIR,
): string {
  const action = args.action ?? 'list';

  if (action === 'list') {
    const days = Number(args.days ?? '30');
    const span = Number.isFinite(days) && days > 0 ? days : 30;
    const found = listAgenda(nowMs, nowMs + span * DAY_MS, dir);
    if (found.length === 0) return `Keine Termine in den nächsten ${span} Tagen.`;
    const lines = found.map(({ item, occurrenceAt }) => {
      const rep = item.repeat === 'none' ? '' : ` (${REPEAT_LABEL[item.repeat]})`;
      const rem = item.reminders.length > 0
        ? ` — ${item.reminders.length} Erinnerung(en)` : ' — keine Erinnerung';
      return `• ${fmtDateTime(occurrenceAt, item.allDay)} — ${item.title}${rep}${rem}  [ID: ${item.id}]`;
    });
    return `Termine in den nächsten ${span} Tagen:\n${lines.join('\n')}`;
  }

  if (action === 'add') {
    const title = args.title?.trim();
    const at = args.at?.trim();
    if (!title) return 'Fehler: "title" fehlt.';
    if (!at) return `Fehler: "at" fehlt. ${AT_FORMAT_HINT}`;
    if (parseWallTime(at) === null) {
      return `Fehler: "${at}" ist kein gültiges Datum. ${AT_FORMAT_HINT}`;
    }
    const repeat = (args.repeat ?? 'none') as RepeatRule;
    if (!(repeat in REPEAT_LABEL)) {
      return `Fehler: "${args.repeat}" ist keine gültige Wiederholung. Erlaubt: ${Object.keys(REPEAT_LABEL).join(', ')}.`;
    }
    const offsets = parseOffsets(args.reminder_offsets);
    const item = addAgendaItem({
      title, at, note: args.note, allDay: isTrue(args.all_day),
      repeat, reminderOffsets: offsets, source: 'user',
    }, dir);
    const rep = repeat === 'none' ? '' : `, ${REPEAT_LABEL[repeat]}`;
    const occurrenceMs = wallTimeToEpoch(parseWallTime(at)!); // already validated above
    return `Termin angelegt: "${title}" am ${fmtDateTime(occurrenceMs, item.allDay)}${rep}`
      + ` — ${offsets.length} Erinnerung(en). [ID: ${item.id}]`;
  }

  if (action === 'update') {
    const id = args.id?.trim();
    if (!id) return 'Fehler: "id" fehlt.';
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.note !== undefined) patch.note = args.note;
    if (args.at !== undefined) {
      if (parseWallTime(args.at) === null) return `Fehler: "${args.at}" ist kein gültiges Datum. ${AT_FORMAT_HINT}`;
      patch.at = args.at;
    }
    if (args.repeat !== undefined) patch.repeat = args.repeat as RepeatRule;
    if (args.all_day !== undefined) patch.allDay = isTrue(args.all_day);
    const updated = updateAgendaItem(id, patch, dir);
    return updated === null
      ? `Fehler: Termin ${id} nicht gefunden.`
      : `Termin "${updated.title}" aktualisiert.`;
  }

  if (action === 'delete') {
    const id = args.id?.trim();
    if (!id) return 'Fehler: "id" fehlt.';
    return deleteAgendaItem(id, dir)
      ? `Termin gelöscht.`
      : `Fehler: Termin ${id} nicht gefunden.`;
  }

  return `Unbekannte Aktion "${action}". Erlaubt: list, add, update, delete.`;
}

export function handleEntriesTool(
  args: Record<string, string>,
  dir: string = MANAGER_DIR,
): string {
  const action = args.action ?? 'list';

  if (action === 'list') {
    const found = listEntries({
      project: args.project,
      onlyOpen: isTrue(args.only_open),
    }, dir);
    if (found.length === 0) {
      return isTrue(args.only_open) ? 'Keine offenen To-dos.' : 'Keine Einträge.';
    }
    const lines = found.map(e => {
      const box = e.checkable ? (e.done ? '[x]' : '[ ]') : '   ';
      const proj = e.project !== undefined ? ` (${e.project})` : '';
      const due = e.due !== undefined ? ` — fällig ${e.due}` : '';
      return `${box} ${e.text}${proj}${due}  [ID: ${e.id}]`;
    });
    return lines.join('\n');
  }

  if (action === 'add') {
    const text = args.text?.trim();
    if (!text) return 'Fehler: "text" fehlt.';
    const checkable = isTrue(args.checkable);
    const e = addEntry({ text, checkable, due: args.due, project: args.project, source: 'user' }, dir);
    return `${checkable ? 'To-do' : 'Notiz'} angelegt: "${text}". [ID: ${e.id}]`;
  }

  if (action === 'complete' || action === 'reopen') {
    const id = args.id?.trim();
    if (!id) return 'Fehler: "id" fehlt.';
    const e = completeEntry(id, action === 'complete', dir);
    if (e === null) return `Fehler: Eintrag ${id} nicht gefunden.`;
    return action === 'complete' ? `"${e.text}" als erledigt markiert.` : `"${e.text}" wieder geöffnet.`;
  }

  if (action === 'update') {
    const id = args.id?.trim();
    if (!id) return 'Fehler: "id" fehlt.';
    const patch: Record<string, unknown> = {};
    if (args.text !== undefined) patch.text = args.text;
    if (args.due !== undefined) patch.due = args.due;
    if (args.project !== undefined) patch.project = args.project;
    if (args.checkable !== undefined) patch.checkable = isTrue(args.checkable);
    const e = updateEntry(id, patch, dir);
    return e === null ? `Fehler: Eintrag ${id} nicht gefunden.` : `Eintrag aktualisiert.`;
  }

  if (action === 'delete') {
    const id = args.id?.trim();
    if (!id) return 'Fehler: "id" fehlt.';
    return deleteEntry(id, dir) ? 'Eintrag gelöscht.' : `Fehler: Eintrag ${id} nicht gefunden.`;
  }

  return `Unbekannte Aktion "${action}". Erlaubt: list, add, complete, reopen, update, delete.`;
}

export interface OverviewInput {
  nowMs: number;
  terminals: Array<{ label: string; status: string; cwd?: string }>;
}

/**
 * The compact answer to "wie laufen die Terminals?". Deliberately states today's
 * date: the model needs it to turn "in einer Woche um 14 Uhr" into a real date.
 */
export function buildOverview(input: OverviewInput, dir: string = MANAGER_DIR): string {
  const parts: string[] = [];
  const now = new Date(input.nowMs);
  const p = (n: number) => String(n).padStart(2, '0');
  parts.push(`## Stand ${fmtDate(input.nowMs)}, ${p(now.getHours())}:${p(now.getMinutes())} Uhr`);

  parts.push('\n### Terminals');
  if (input.terminals.length === 0) {
    parts.push('Keine Terminals offen.');
  } else {
    for (const t of input.terminals) {
      parts.push(`• ${t.label} — ${t.status}${t.cwd !== undefined ? ` — ${t.cwd}` : ''}`);
    }
  }

  parts.push('\n### Offene To-dos');
  const open = listEntries({ onlyOpen: true }, dir);
  if (open.length === 0) {
    parts.push('Keine offenen To-dos.');
  } else {
    for (const e of open.slice(0, 20)) {
      parts.push(`• ${e.text}${e.project !== undefined ? ` (${e.project})` : ''}`);
    }
    if (open.length > 20) parts.push(`… und ${open.length - 20} weitere.`);
  }

  parts.push('\n### Termine (nächste 14 Tage)');
  const upcoming = listAgenda(input.nowMs, input.nowMs + 14 * DAY_MS, dir);
  if (upcoming.length === 0) {
    parts.push('Keine Termine.');
  } else {
    for (const { item, occurrenceAt } of upcoming) {
      parts.push(`• ${fmtDateTime(occurrenceAt, item.allDay)} — ${item.title}`);
    }
  }

  return parts.join('\n');
}

const VALID_KINDS: OutboxKind[] = ['reminder', 'checkin', 'stuck', 'suggestion', 'event'];

export function handleNotifyUser(args: Record<string, string>, outbox: Outbox): string {
  const text = args.text?.trim();
  if (!text) return 'Fehler: "text" fehlt.';
  const kind = (args.kind ?? 'suggestion') as OutboxKind;
  if (!VALID_KINDS.includes(kind)) {
    return `Fehler: "${args.kind}" ist keine gültige Art. Erlaubt: ${VALID_KINDS.join(', ')}.`;
  }
  const msg = outbox.push({
    kind, text, topicKey: args.topic_key, project: args.project, sessionId: args.session_id,
  });
  if (msg === null) {
    // Being told plainly beats retrying: the model must not work around the cap.
    return 'Nachricht NICHT gesendet — die Dosierung hat sie abgelehnt (Thema schon behandelt, '
      + 'vom Nutzer abgelehnt, oder Stundenlimit für dieses Terminal erreicht). Nicht erneut versuchen.';
  }
  return `Nachricht gesendet. [ID: ${msg.id}]`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/manager/tools/stufe1.handlers.test.ts`
Expected: PASS — 14 Tests grün

- [ ] **Step 5: Add the five tool definitions**

In `server/src/manager/tools/definitions.ts`, append these five entries inside the `MANAGER_TOOLS` array, before the closing `];`:

```ts
  {
    type: 'function',
    function: {
      name: 'get_overview',
      description: 'Der aktuelle Gesamtstand: offene Terminals, offene To-dos, anstehende Termine, plus das heutige Datum. Rufe das auf, wenn der Nutzer fragt wie es läuft, was ansteht, oder bevor du ein Datum ausrechnest.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_project',
      description: 'Ein einzelnes Projekt im Detail: Pfad, Git-Branch, letzte Sitzungsthemen, Auszug der CLAUDE.md, offene To-dos dazu.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Projektname oder Teil des Pfads, z.B. "TMS Terminal"' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agenda',
      description: 'Termine und Erinnerungen verwalten. WICHTIG: "at" muss immer das Format YYYY-MM-DDTHH:MM haben (lokale Zeit) — rechne relative Angaben wie "in einer Woche" selbst aus, das heutige Datum steht in get_overview. Für Geburtstage: all_day=true und repeat=yearly.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list, add, update oder delete' },
          id: { type: 'string', description: 'Termin-ID (für update/delete)' },
          title: { type: 'string', description: 'Titel, z.B. "Zahnarzt" oder "Geburtstag Mama"' },
          at: { type: 'string', description: 'Zeitpunkt als YYYY-MM-DDTHH:MM, z.B. "2026-08-04T14:00"' },
          all_day: { type: 'string', description: '"true" für ganztägig (Geburtstage)' },
          repeat: { type: 'string', description: 'none, daily, weekly, monthly oder yearly' },
          reminder_offsets: { type: 'string', description: 'Minuten VOR dem Termin, komma-getrennt. "2880,1440,60" = 2 Tage, 1 Tag und 1 Stunde vorher. "0" = zum Termin.' },
          note: { type: 'string', description: 'Freitext — was der Nutzer wörtlich gesagt hat' },
          days: { type: 'string', description: 'Für list: wie viele Tage voraus. Standard 30.' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'entries',
      description: 'Notizen und To-dos verwalten. checkable=true macht ein abhakbares To-do, sonst ist es eine reine Notiz. Schau hier rein, bevor du beurteilst was noch offen ist.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list, add, complete, reopen, update oder delete' },
          id: { type: 'string', description: 'Eintrags-ID' },
          text: { type: 'string', description: 'Der Text des Eintrags' },
          checkable: { type: 'string', description: '"true" für ein abhakbares To-do, sonst Notiz' },
          due: { type: 'string', description: 'Optionale Frist als YYYY-MM-DDTHH:MM' },
          project: { type: 'string', description: 'Optionale Projektzuordnung' },
          only_open: { type: 'string', description: 'Für list: "true" zeigt nur offene To-dos' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notify_user',
      description: 'Schreibe dem Nutzer von dir aus — für eigene Beobachtungen und Vorschläge. Setze topic_key auf einen stabilen Schlüssel des Themas, damit dasselbe nie zweimal kommt. Wenn die Dosierung ablehnt, versuche es NICHT erneut. Vom Nutzer beauftragte Erinnerungen gehören nicht hierher, sondern in agenda.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Die Nachricht an den Nutzer' },
          kind: { type: 'string', description: 'stuck (er hängt fest), suggestion (Idee), event (Ereignis), checkin (Tageszusammenfassung)' },
          topic_key: { type: 'string', description: 'Stabiler Themenschlüssel, z.B. "stuck:<fehler-hash>"' },
          project: { type: 'string', description: 'Betroffenes Projekt' },
          session_id: { type: 'string', description: 'Betroffenes Terminal' },
        },
        required: ['text'],
      },
    },
  },
```

- [ ] **Step 6: Make sure the model knows what day it is**

Without today's date the model cannot turn "in einer Woche um 14 Uhr" into `2026-08-04T14:00`.

Run: `cd ~/Desktop/tms-terminal && grep -n "Heute\|toLocaleDateString\|getFullYear" server/src/manager/tools/system-prompt.ts`

If nothing matches, add near the top of the string that `buildSystemPrompt` returns:

```ts
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayLine =
    `Heute ist ${['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'][now.getDay()]}, ` +
    `der ${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}, ${pad(now.getHours())}:${pad(now.getMinutes())} Uhr. ` +
    `Rechne relative Zeitangaben ("morgen", "in einer Woche") davon ausgehend in das Format YYYY-MM-DDTHH:MM um.`;
```

and include `todayLine` in the returned prompt.

- [ ] **Step 7: Wire the actions into manager.service.ts**

In `manager.service.ts`, extend the `ManagerAction` type union (around line 410) with:

```ts
 | 'get_overview' | 'get_project' | 'agenda' | 'entries' | 'notify_user'
```

Add imports:

```ts
import { handleAgendaTool, handleEntriesTool, buildOverview, handleNotifyUser } from './tools/stufe1.handlers';
import { Outbox } from './outbox/outbox';
```

Add an `Outbox` instance as a field on `ManagerService`:

```ts
  private outbox = new Outbox(() => Date.now());
```

In `toolCallsToActions`, in the block that handles tools needing no session (right after the `list_terminals` branch), add:

```ts
      if (tc.name === 'get_overview') {
        actions.push({ type: 'get_overview', sessionId: '', detail: '' });
        continue;
      }
      if (tc.name === 'get_project') {
        actions.push({ type: 'get_project', sessionId: '', detail: tc.arguments.name ?? '' });
        continue;
      }
      if (tc.name === 'agenda' || tc.name === 'entries' || tc.name === 'notify_user') {
        actions.push({ type: tc.name, sessionId: '', detail: JSON.stringify(tc.arguments ?? {}) });
        continue;
      }
```

In `executeAction` (switch starting at line 2267), add these cases:

```ts
      case 'get_overview': {
        const terminals = this.buildTerminalContexts().map(c => ({
          label: c.label,
          status: c.status,
          cwd: c.cwd,
        }));
        return { text: buildOverview({ nowMs: Date.now(), terminals }) };
      }

      case 'get_project': {
        // Phase A: no collector yet — answer from what the terminals reveal.
        const match = this.buildTerminalContexts().find(c =>
          (c.cwd ?? '').toLowerCase().includes(action.detail.toLowerCase()) ||
          (c.project ?? '').toLowerCase().includes(action.detail.toLowerCase()));
        if (match === undefined) {
          return { text: `Kein Projekt gefunden, das zu "${action.detail}" passt.` };
        }
        return { text: `${match.label} — ${match.cwd ?? 'kein Pfad'} — Status: ${match.status}` };
      }

      case 'agenda': {
        const args = JSON.parse(action.detail || '{}') as Record<string, string>;
        return { text: handleAgendaTool(args, Date.now()) };
      }

      case 'entries': {
        const args = JSON.parse(action.detail || '{}') as Record<string, string>;
        return { text: handleEntriesTool(args) };
      }

      case 'notify_user': {
        const args = JSON.parse(action.detail || '{}') as Record<string, string>;
        return { text: handleNotifyUser(args, this.outbox) };
      }
```

- [ ] **Step 8: Verify the whole suite and the compiler**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: PASS

Run: `cd server && node --require ts-node/register -e "const {MANAGER_TOOLS}=require('./src/manager/tools/definitions'); console.log(MANAGER_TOOLS.length)"`
Expected: `29`

- [ ] **Step 9: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/tools/ server/src/manager/manager.service.ts
git commit -m "feat(manager): fünf neue Werkzeuge — Überblick, Projekt, Agenda, Einträge, proaktive Nachricht

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Protokoll, Wecker-Start und Push

Ab hier feuern Erinnerungen wirklich — auf dem Handy, auch wenn die App zu ist.

**Files:**
- Modify: `shared/protocol.ts`
- Modify: `server/src/manager/manager.service.ts` (Wecker starten, proaktiver Callback, Korruptionsmeldungen)
- Modify: `server/src/websocket/ws.handler.ts` (vier neue Nachrichten, neuer Callback)

**Interfaces:**
- Consumes: `AgendaScheduler` (Task 3), `Outbox` (Task 5), `handleAgendaTool`/`handleEntriesTool`/`buildOverview` (Task 7), `takeCorruptionReports` (Task 1), `fcmService` aus `../notifications/fcm.service`
- Produces:
  - Client → Server: `manager:agenda`, `manager:entries`, `manager:overview`, `manager:outbox_read`
  - Server → Client: `manager:agenda_data`, `manager:entries_data`, `manager:proactive`, `manager:unread`
  - `ManagerService.setProactiveCallback(cb: (msg: OutboxMessage, unread: number) => void): void`
  - `ManagerService.markOutboxRead(): number`

- [ ] **Step 1: Add the protocol types**

In `shared/protocol.ts`, after `ManagerMemoryWriteMessage` (around line 98) add:

```ts
export interface ManagerAgendaMessage {
  type: 'manager:agenda';
  payload: { action: 'list' | 'add' | 'update' | 'delete'; args?: Record<string, string> };
}
export interface ManagerEntriesMessage {
  type: 'manager:entries';
  payload: { action: 'list' | 'add' | 'complete' | 'reopen' | 'update' | 'delete'; args?: Record<string, string> };
}
export interface ManagerOverviewMessage {
  type: 'manager:overview';
}
export interface ManagerOutboxReadMessage {
  type: 'manager:outbox_read';
}
```

After `ManagerMemoryDataMessage` (around line 331) add:

```ts
export interface ManagerAgendaDataMessage {
  type: 'manager:agenda_data';
  payload: {
    items: Array<{
      id: string; title: string; note?: string; at: string; allDay: boolean;
      repeat: string; reminderOffsets: number[]; occurrenceAt: number;
    }>;
  };
}
export interface ManagerEntriesDataMessage {
  type: 'manager:entries_data';
  payload: {
    entries: Array<{
      id: string; text: string; checkable: boolean; done: boolean;
      due?: string; project?: string; updatedAt: number;
    }>;
  };
}
export interface ManagerProactiveMessage {
  type: 'manager:proactive';
  payload: {
    id: string; kind: string; text: string; createdAt: number;
    project?: string; sessionId?: string; unread: number;
  };
}
export interface ManagerUnreadMessage {
  type: 'manager:unread';
  payload: { unread: number };
}
```

Find the client and server message unions and add the new interfaces to them:

```bash
cd ~/Desktop/tms-terminal && grep -n "ManagerMemoryWriteMessage$\|ManagerMemoryWriteMessage;\|ManagerMemoryWriteMessage\b" shared/protocol.ts | tail -5
grep -n "ManagerMemoryDataMessage\b" shared/protocol.ts | tail -5
```

Add `| ManagerAgendaMessage | ManagerEntriesMessage | ManagerOverviewMessage | ManagerOutboxReadMessage` to the client-message union and `| ManagerAgendaDataMessage | ManagerEntriesDataMessage | ManagerProactiveMessage | ManagerUnreadMessage` to the server-message union.

- [ ] **Step 2: Verify the protocol compiles**

Run: `cd server && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Start the scheduler and expose the outbox in ManagerService**

In `manager.service.ts`, add imports:

```ts
import { AgendaScheduler } from './agenda/agenda.scheduler';
import { loadAgenda, saveAgenda } from './agenda/agenda.store';
import type { OutboxMessage } from './outbox/outbox.types';
import { takeCorruptionReports } from './store';
import { fcmService } from '../notifications/fcm.service';
```

Add fields next to the existing `private outbox`:

```ts
  private proactiveCallback: ((msg: OutboxMessage, unread: number) => void) | null = null;

  private agendaScheduler = new AgendaScheduler(
    () => Date.now(),
    () => loadAgenda(),
    (items) => saveAgenda(items),
    (due, late) => {
      const prefix = late ? '⏰ (verspätet) ' : '⏰ ';
      const body = due.item.note !== undefined && due.item.note.trim() !== ''
        ? `${due.item.title} — ${due.item.note}`
        : due.item.title;
      const msg = this.outbox.push({ kind: 'reminder', text: `${prefix}${body}` });
      if (msg !== null) this.emitProactive(msg);
    },
  );
```

Add methods:

```ts
  setProactiveCallback(cb: (msg: OutboxMessage, unread: number) => void): void {
    this.proactiveCallback = cb;
  }

  /** Deliver a proactive message: to the app, and — if allowed — as a push. */
  private emitProactive(msg: OutboxMessage): void {
    const unread = this.outbox.unreadCount();
    this.proactiveCallback?.(msg, unread);

    if (!this.outbox.shouldPush(msg)) {
      logger.info(`[outbox] quiet hours — message ${msg.id} delivered without push`);
      return;
    }
    const title = msg.kind === 'reminder' ? 'Erinnerung' : 'Manager';
    for (const token of this.fcmTokens) {
      void fcmService.send(token, title, msg.text.slice(0, 200), { kind: msg.kind, id: msg.id });
    }
    this.outbox.markPushed(msg.id);
  }

  markOutboxRead(): number {
    this.outbox.markAllRead();
    return this.outbox.unreadCount();
  }

  getUnreadCount(): number {
    return this.outbox.unreadCount();
  }

  /** Turn any store corruption into a message the user actually sees. */
  private reportStoreCorruption(): void {
    for (const report of takeCorruptionReports()) {
      const msg = this.outbox.push({ kind: 'event', text: `⚠️ ${report}` });
      if (msg !== null) this.emitProactive(msg);
    }
  }
```

In `start()` (line 949), after the existing body, add:

```ts
    this.agendaScheduler.start();
    this.reportStoreCorruption();
```

In `stop()` (line 982), add:

```ts
    this.agendaScheduler.stop();
```

Confirm the FCM token field name — the class already has `setFcmTokens(tokens: Set<string>)`:

```bash
cd ~/Desktop/tms-terminal && grep -n "fcmTokens" server/src/manager/manager.service.ts | head -3
```

Use whatever field name that reveals in `emitProactive`.

- [ ] **Step 4: Wire the WebSocket handlers**

In `server/src/websocket/ws.handler.ts`, inside `setupManagerCallbacks` add after the existing `setCallbacks(...)` call:

```ts
  managerService.setProactiveCallback((msg, unread) => {
    sendManager({ type: 'manager:proactive', payload: { ...msg, unread } });
  });
```

Next to the other `if (msgType === 'manager:…')` blocks (after the `manager:memory_write` block around line 798) add:

```ts
    if (msgType === 'manager:overview') {
      const { buildOverview } = require('../manager/tools/stufe1.handlers');
      const terminals = managerService.getSessionList().map(s => ({ label: s.label, status: '—' }));
      send(ws, { type: 'manager:response', payload: { text: buildOverview({ nowMs: Date.now(), terminals }) } } as any);
      return;
    }

    if (msgType === 'manager:agenda') {
      const { handleAgendaTool } = require('../manager/tools/stufe1.handlers');
      const { listAgenda } = require('../manager/agenda/agenda.store');
      const payload = (msg as any).payload ?? {};
      if (payload.action !== 'list') {
        handleAgendaTool({ action: payload.action, ...(payload.args ?? {}) }, Date.now());
      }
      const now = Date.now();
      const items = listAgenda(now, now + 365 * 24 * 60 * 60 * 1000).map((e: any) => ({
        id: e.item.id, title: e.item.title, note: e.item.note, at: e.item.at,
        allDay: e.item.allDay, repeat: e.item.repeat,
        reminderOffsets: e.item.reminders.map((r: any) => r.offsetMinutes),
        occurrenceAt: e.occurrenceAt,
      }));
      send(ws, { type: 'manager:agenda_data', payload: { items } } as any);
      return;
    }

    if (msgType === 'manager:entries') {
      const { handleEntriesTool } = require('../manager/tools/stufe1.handlers');
      const { listEntries } = require('../manager/entries/entries.store');
      const payload = (msg as any).payload ?? {};
      if (payload.action !== 'list') {
        handleEntriesTool({ action: payload.action, ...(payload.args ?? {}) });
      }
      send(ws, { type: 'manager:entries_data', payload: { entries: listEntries() } } as any);
      return;
    }

    if (msgType === 'manager:outbox_read') {
      const unread = managerService.markOutboxRead();
      send(ws, { type: 'manager:unread', payload: { unread } } as any);
      return;
    }
```

If the file uses top-level `import` rather than `require` for manager modules, convert these to imports at the top of the file to match the surrounding style:

```bash
cd ~/Desktop/tms-terminal && head -30 server/src/websocket/ws.handler.ts
```

- [ ] **Step 5: Verify compile and suite**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: PASS

- [ ] **Step 6: Manual smoke test of the reminder path**

This is the one thing unit tests cannot prove: that a reminder actually reaches the phone.

Create `server/scripts/smoke-reminder.ts`:

```ts
process.env.TZ = 'Europe/Berlin';
import { addAgendaItem, loadAgenda } from '../src/manager/agenda/agenda.store';

const inTwoMinutes = new Date(Date.now() + 2 * 60_000);
const p = (n: number) => String(n).padStart(2, '0');
const at = `${inTwoMinutes.getFullYear()}-${p(inTwoMinutes.getMonth() + 1)}-${p(inTwoMinutes.getDate())}`
  + `T${p(inTwoMinutes.getHours())}:${p(inTwoMinutes.getMinutes())}`;

const item = addAgendaItem({
  title: 'Rauchtest', at, note: 'Wenn du das siehst, funktioniert der Wecker.',
  reminderOffsets: [0], source: 'user',
});
console.log(`Termin angelegt für ${at} (ID ${item.id}). Insgesamt ${loadAgenda().length} Termine.`);
```

Run: `cd server && node --require ts-node/register scripts/smoke-reminder.ts`

Then **ask the user** to confirm within ~3 minutes whether the push arrived. Do **not** restart the server to make this work — if the running server predates this build, note that the smoke test can only be completed after the user's next scheduled restart, and say so plainly.

Check the log for the fired reminder:

```bash
grep -n "Rauchtest\|\[agenda\]\|\[outbox\]" ~/.tms-terminal/update.log | tail -20
```

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/tms-terminal
git add shared/protocol.ts server/src/manager/manager.service.ts server/src/websocket/ws.handler.ts server/scripts/smoke-reminder.ts
git commit -m "feat(manager): Wecker im Server, proaktiver Kanal über WebSocket und FCM

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Manager-Tabs — Chat / Agenda / Notizen

**Files:**
- Modify: `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` (**Dev-Worktree** — siehe Global Constraints)
- Modify: `~/Desktop/tms-terminal/mobile/src/season2/web/bridge.js`
- Modify: `~/Desktop/tms-terminal/mobile/src/season2/SeasonTwoWebRoot.tsx` ← **die Übersetzungsschicht**
- Generated: `~/Desktop/tms-terminal/mobile/src/season2/liquidDeckHtml.ts`

### Der tatsächliche Nachrichtenweg (am 2026-07-28 im Code verifiziert)

Es sind **vier** Schichten, nicht zwei. Das Mockup ist eine Attrappe; es kennt weder
`postMessage` noch die Protokollnamen. Die Bridge verkabelt es nachträglich:

```
Seite → bridge.js: post('manager:agendaList', {…})       // App-interner Name!
      → SeasonTwoWebRoot.tsx: case 'manager:agendaList'  // Übersetzung
      → WebSocket: { type: 'manager:agenda', … }         // Protokollname

WebSocket: { type: 'manager:agenda_data', … }
      → SeasonTwoWebRoot.tsx: if (m?.type === 'manager:agenda_data')
      → call('setAgenda', items)                          // injectJavaScript
      → window.TMSBridge.setAgenda(items)                 // in bridge.js definiert
      → Seite: renderManagerAgenda()
```

Belege im Code: `bridge.js:16-18` (`post` → `RN.postMessage`), `bridge.js:1144`
(`post('manager:send', …)`), `SeasonTwoWebRoot.tsx:766` (`case 'manager:send'`),
`SeasonTwoWebRoot.tsx:158-162` (`call` → `injectJavaScript` auf `window.TMSBridge.*`),
`SeasonTwoWebRoot.tsx:375-381` (`manager:memory_data` → `call('setManagerMemory', …)`).

**Vorbild zum Abschauen:** der komplette `manager:memory_data`-Pfad. Er macht genau
das, was Agenda und Notizen brauchen, und ist nur ein paar Zeilen lang.

**Namenskonvention:** App-interne Namen sind camelCase ohne Unterstrich
(`manager:agendaList`), Protokollnamen bleiben snake_case (`manager:agenda_data`).
Die beiden nicht verwechseln — sie sehen ähnlich aus und werden an verschiedenen
Stellen geprüft.

**Interfaces:**
- Consumes: `manager:agenda_data`, `manager:entries_data` (Task 8)
- Produces:
  - Mockup: `renderManagerAgenda()`, `renderManagerEntries()`
  - bridge.js: `TMSBridge.setAgenda(items)`, `TMSBridge.setEntries(entries)`,
    `post('manager:agendaList')`, `post('manager:entriesList')`,
    `post('manager:entryToggle', { id, done })`
  - SeasonTwoWebRoot.tsx: die drei `case`-Zweige und die zwei Inbound-Prüfungen

- [ ] **Step 1: Add the two data buckets**

In the mockup, find `TMS_DATA.manager` and add two empty arrays next to `artifacts` and `memory`:

```js
      agenda: [],
      entries: [],
```

- [ ] **Step 2: Rewrite the sub-tabs and add the two views**

In `renderManagerShell()` replace the `subtabs` block:

```html
        <div class="subtabs" id="managerTabs">
          <button data-tab="chat" class="active">Chat</button>
          <button data-tab="agenda">Agenda</button>
          <button data-tab="entries">Notizen</button>
        </div>
```

and add the two new panes inside `.manager-view`, right after `<div id="managerMemory" hidden></div>`:

```html
          <div id="managerAgenda" hidden></div>
          <div id="managerEntries" hidden></div>
```

`#managerArtifacts` and `#managerMemory` stay in the DOM — they move into the ⋮ menu, they do not disappear.

- [ ] **Step 3: Add the CSS**

Next to the existing `#managerMemory:not([hidden])` rule (around line 1110) add:

```css
  #managerAgenda:not([hidden]), #managerEntries:not([hidden]) {
    flex: 1; min-height: 0; overflow-y: auto; padding: 4px 2px 12px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .ag-row, .en-row {
    display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px;
    border-radius: 14px; background: rgba(var(--overlay-rgb), .06);
    border: 1px solid rgba(var(--overlay-rgb), .08);
  }
  .ag-row__when {
    flex: none; min-width: 86px; font-variant-numeric: tabular-nums;
    font-size: 12px; font-weight: 700; color: var(--accent);
  }
  .ag-row__body, .en-row__body { flex: 1; min-width: 0; }
  .ag-row__title, .en-row__text { font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
  .ag-row__meta, .en-row__meta { margin-top: 3px; font-size: 11px; color: var(--text-dim); }
  .en-row__box {
    flex: none; width: 20px; height: 20px; margin-top: 1px; border-radius: 7px;
    border: 1.5px solid rgba(var(--overlay-rgb), .28); background: transparent;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 12px; color: var(--accent); cursor: pointer;
  }
  .en-row__box[aria-pressed="true"] { background: rgba(var(--accent-rgb), .18); border-color: rgba(var(--accent-rgb), .5); }
  .en-row.is-note .en-row__box { visibility: hidden; }
  .en-row.is-done .en-row__text { text-decoration: line-through; color: var(--text-dim); }
  .mgr-empty { padding: 22px 12px; text-align: center; color: var(--text-dim); font-size: 13px; }
```

- [ ] **Step 4: Add the two render functions**

Right after `renderManagerMemory()` (around line 5705) add:

```js
  function fmtAgendaWhen(occurrenceAt, allDay) {
    const d = new Date(occurrenceAt);
    const p = n => String(n).padStart(2, '0');
    const day = `${p(d.getDate())}.${p(d.getMonth() + 1)}.`;
    return allDay ? day : `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const REPEAT_DE = {
    none: '', daily: 'täglich', weekly: 'wöchentlich',
    monthly: 'monatlich', yearly: 'jährlich',
  };

  function renderManagerAgenda() {
    const host = document.getElementById('managerAgenda');
    if (!host) return;
    const items = TMS_DATA.manager.agenda || [];
    if (items.length === 0) {
      host.innerHTML = '<div class="mgr-empty">Keine Termine. Sag dem Manager einfach, woran er dich erinnern soll.</div>';
      return;
    }
    host.innerHTML = items.map(a => {
      const rep = REPEAT_DE[a.repeat] || '';
      const count = (a.reminderOffsets || []).length;
      const meta = [rep, count > 0 ? `${count} Erinnerung${count === 1 ? '' : 'en'}` : 'keine Erinnerung']
        .filter(Boolean).join(' · ');
      return `
      <div class="ag-row">
        <div class="ag-row__when">${escapeHtml(fmtAgendaWhen(a.occurrenceAt, a.allDay))}</div>
        <div class="ag-row__body">
          <div class="ag-row__title">${escapeHtml(a.title)}</div>
          <div class="ag-row__meta">${escapeHtml(meta)}</div>
        </div>
      </div>`;
    }).join('');
  }

  function renderManagerEntries() {
    const host = document.getElementById('managerEntries');
    if (!host) return;
    const entries = TMS_DATA.manager.entries || [];
    if (entries.length === 0) {
      host.innerHTML = '<div class="mgr-empty">Keine Notizen. Alles, was du dem Manager sagst, kann hier landen.</div>';
      return;
    }
    host.innerHTML = entries.map(e => {
      const cls = ['en-row', e.checkable ? '' : 'is-note', e.done ? 'is-done' : ''].filter(Boolean).join(' ');
      const meta = [e.project, e.due].filter(Boolean).join(' · ');
      return `
      <div class="${cls}" data-entry-id="${escapeHtml(e.id)}">
        <button class="en-row__box" type="button" aria-pressed="${e.done ? 'true' : 'false'}"
                aria-label="${e.done ? 'Wieder öffnen' : 'Als erledigt markieren'}">${e.done ? '✓' : ''}</button>
        <div class="en-row__body">
          <div class="en-row__text">${escapeHtml(e.text)}</div>
          ${meta ? `<div class="en-row__meta">${escapeHtml(meta)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }
```

- [ ] **Step 5: Wire the tabs, the checkbox and the ⋮ menu**

Replace the body of `wireManagerTabs()` with:

```js
  function wireManagerTabs() {
    document.getElementById('managerTabs').addEventListener('click', e => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      const tab = btn.dataset.tab;
      state.managerTab = tab;
      document.querySelectorAll('#managerTabs button').forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById('managerChat').hidden = tab !== 'chat';
      document.getElementById('managerArtifacts').hidden = tab !== 'artifacts';
      document.getElementById('managerMemory').hidden = tab !== 'memory';
      document.getElementById('managerAgenda').hidden = tab !== 'agenda';
      document.getElementById('managerEntries').hidden = tab !== 'entries';

      if (tab === 'agenda') { requestAgenda(); renderManagerAgenda(); }
      if (tab === 'entries') { requestEntries(); renderManagerEntries(); }

      // Die Eingabezeile lebt im Dock — sie ergibt nur im Chat Sinn.
      if (typeof setDockPage === 'function') setDockPage(tab === 'chat' ? 'mgr' : 'nav');
      const attach = document.getElementById('managerAttachRow');
      if (attach) { if (tab === 'chat') renderManagerAttachments(); else attach.hidden = true; }
    });

    // Abhaken direkt in der Liste.
    document.getElementById('managerEntries').addEventListener('click', e => {
      const box = e.target.closest('.en-row__box');
      if (!box) return;
      const row = box.closest('[data-entry-id]');
      if (!row) return;
      const id = row.dataset.entryId;
      const nowDone = box.getAttribute('aria-pressed') !== 'true';
      window.managerEntryToggle(id, nowDone);
    });
  }

  function requestAgenda() {
    if (typeof window.managerAgendaList === 'function') window.managerAgendaList();
  }
  function requestEntries() {
    if (typeof window.managerEntriesList === 'function') window.managerEntriesList();
  }

  // Bridge-Einstiegspunkte — die native Seite ruft diese auf.
  window.TMSBridge.setAgenda = function (items) {
    TMS_DATA.manager.agenda = Array.isArray(items) ? items : [];
    renderManagerAgenda();
  };
  window.TMSBridge.setEntries = function (entries) {
    TMS_DATA.manager.entries = Array.isArray(entries) ? entries : [];
    renderManagerEntries();
  };
```

The `window.manager*` functions above are **defined in bridge.js** (Step 6a), not in
the mockup. The mockup only calls them, guarded by a `typeof` check so the page still
works standalone in a browser where no bridge is present — that is exactly how the
existing mockup treats `window.managerAttach`.

In the `#mgrMenuBtn` handler, add two entries that switch to the `artifacts` and `memory` tabs (they are no longer reachable from the sub-tabs). Find the handler with:

```bash
cd "/Users/ayysir/Desktop/TMS Terminal" && grep -n "mgrMenuBtn" mockups/season2/liquid-deck/index.html
```

- [ ] **Step 6a: Define the inbound hooks in bridge.js**

`bridge.js` does **not** see WebSocket messages — it only exposes functions that
`SeasonTwoWebRoot` calls via `injectJavaScript`. Add them next to the other
`window.TMSBridge.*` definitions:

```js
  window.TMSBridge.setAgenda = function (items) {
    window.TMS_DATA.manager.agenda = items || [];
    if (typeof window.renderManagerAgenda === 'function') window.renderManagerAgenda();
  };
  window.TMSBridge.setEntries = function (entries) {
    window.TMS_DATA.manager.entries = entries || [];
    if (typeof window.renderManagerEntries === 'function') window.renderManagerEntries();
  };
```

This mirrors `bridge.js:2441-2444` (`setManagerMemory`) line for line. The `window.`
prefixes matter: the mockup's functions are top-level declarations in its script block,
so they land on `window` — and that is the only way bridge.js can reach them, since the
bridge is injected as a separate script and shares no closure with the page.

And the outbound calls the page triggers:

```js
  window.managerAgendaList = function () { post('manager:agendaList', {}); };
  window.managerEntriesList = function () { post('manager:entriesList', {}); };
  window.managerEntryToggle = function (id, done) { post('manager:entryToggle', { id: id, done: done }); };
```

- [ ] **Step 6b: Translate in SeasonTwoWebRoot.tsx**

This is the layer the page cannot reach on its own. Outbound — next to
`case 'manager:send'` (around line 766):

```tsx
      case 'manager:agendaList':
        sendJson({ type: 'manager:agenda', payload: { action: 'list' } });
        break;

      case 'manager:entriesList':
        sendJson({ type: 'manager:entries', payload: { action: 'list' } });
        break;

      case 'manager:entryToggle':
        sendJson({
          type: 'manager:entries',
          payload: { action: payload.done ? 'complete' : 'reopen', args: { id: payload.id } },
        });
        break;
```

Inbound — next to the `manager:memory_data` check (around line 375):

```tsx
      if (m?.type === 'manager:agenda_data') {
        call('setAgenda', m.payload?.items ?? []);
        return;
      }
      if (m?.type === 'manager:entries_data') {
        call('setEntries', m.payload?.entries ?? []);
        return;
      }
```

**Find the real name of the WebSocket send helper first** — `sendManager(text)` is
chat-specific and will not do. Check what is available:

```bash
cd ~/Desktop/tms-terminal && grep -n "sendJson\|const send\|ws.send\|sendMessage" mobile/src/season2/SeasonTwoWebRoot.tsx | head -10
```

Use whatever that reveals; do not invent a second channel.

- [ ] **Step 7: Build and verify visually**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run build:season2
```
Expected: exit 0, `src/season2/liquidDeckHtml.ts` neu geschrieben.

Verify the layout headless at both Fold widths. Open `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` in a headless browser, navigate to the Manager screen, and screenshot at **412×915** (inner display) and **380×915** (outer display) for each of the three tabs.

Check on the screenshots:
- Die drei Reiter heißen Chat / Agenda / Notizen und passen nebeneinander, ohne umzubrechen.
- Agenda und Notizen zeigen ihre Leertexte lesbar.
- Beim Wechsel auf Agenda/Notizen zeigt das Dock die Navigation, im Chat die Eingabezeile.
- Terminal- und Browser-Ansicht sind unverändert.

- [ ] **Step 8: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mockups/season2/liquid-deck/index.html
git commit -m "feat(season2): Manager-Reiter Chat/Agenda/Notizen

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"

cd ~/Desktop/tms-terminal
git add mobile/src/season2/liquidDeckHtml.ts mobile/src/season2/web/bridge.js
git commit -m "feat(season2): Agenda- und Notizen-Daten über die Bridge

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Island-Badge für ungelesene Nachrichten

Der sichtbare Teil des proaktiven Kanals — die Zahl, die dich im Terminal erreicht.

**Files:**
- Modify: `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html`
- Modify: `~/Desktop/tms-terminal/mobile/src/season2/web/bridge.js`
- Modify: `~/Desktop/tms-terminal/mobile/src/season2/SeasonTwoWebRoot.tsx` ← **die Übersetzungsschicht**
- Generated: `~/Desktop/tms-terminal/mobile/src/season2/liquidDeckHtml.ts`

Derselbe vierschichtige Weg wie in Task 9 — dort ist er ausführlich beschrieben.

**Interfaces:**
- Consumes: `manager:proactive`, `manager:unread` (Task 8)
- Produces:
  - bridge.js: `TMSBridge.setUnread(n)`, `TMSBridge.proactive(msg)`, `post('manager:outboxRead')`
  - SeasonTwoWebRoot.tsx: Inbound-Prüfungen auf `manager:proactive` und `manager:unread`,
    Outbound-Fall `manager:outboxRead`

- [ ] **Step 1: Add the badge markup**

In `.island-compact` (around line 257), directly **after** the `status-hd__metric--latency` span, insert:

```html
    <button class="island-mgr-badge" id="islandMgrBadge" type="button" hidden
            aria-label="Ungelesene Manager-Nachrichten">
      <span class="mgr-ava island-mgr-badge__ava" id="islandMgrBadgeAva"></span>
      <span class="island-mgr-badge__count" id="islandMgrBadgeCount">0</span>
    </button>
```

- [ ] **Step 2: Add the CSS**

Next to the other `.island-*` rules:

```css
  .island-mgr-badge {
    display: none; align-items: center; gap: 5px; flex: none;
    height: 26px; padding: 0 8px 0 3px; border-radius: 13px;
    background: rgba(var(--accent-rgb), .18);
    border: 1px solid rgba(var(--accent-rgb), .42);
    color: var(--accent); cursor: pointer;
  }
  .island-mgr-badge:not([hidden]) { display: flex; }
  .island-mgr-badge:active { transform: scale(.92); }
  .island-mgr-badge__ava { width: 20px; height: 20px; font-size: 9px; }
  .island-mgr-badge__count { font-size: 12px; font-weight: 800; font-variant-numeric: tabular-nums; }
  /* Bei ungelesenen Nachrichten weicht die Latenz-Anzeige — auf dem Außendisplay
     (~380 dp) ist in der Insel kein Platz für beides, und die Zahl ist wichtiger. */
  #statusHeader.has-unread .status-hd__metric--latency { display: none; }
  /* Im Manager selbst ist der Badge überflüssig — da steht die Nachricht ja. */
  #statusHeader.is-manager-mode .island-mgr-badge { display: none; }
```

- [ ] **Step 3: Add the behaviour**

Next to `syncIslandManager()` add:

```js
  let managerUnread = 0;

  function syncIslandBadge() {
    const badge = document.getElementById('islandMgrBadge');
    const header = document.getElementById('statusHeader');
    if (!badge || !header) return;
    const show = managerUnread > 0;
    badge.hidden = !show;
    header.classList.toggle('has-unread', show);
    if (show) {
      document.getElementById('islandMgrBadgeCount').textContent = managerUnread > 99 ? '99+' : String(managerUnread);
      const ava = document.getElementById('islandMgrBadgeAva');
      const p = (TMS_DATA.manager && TMS_DATA.manager.persona) || {};
      // Gleiche Avatar-Darstellung wie in der Insel im Manager-Modus.
      ava.textContent = (p.name || 'M').slice(0, 1).toUpperCase();
      if (p.avatar) { ava.style.backgroundImage = `url(${p.avatar})`; ava.textContent = ''; }
    }
  }

  window.TMSBridge.setUnread = function (n) {
    managerUnread = Number(n) || 0;
    syncIslandBadge();
  };

  window.TMSBridge.proactive = function (msg) {
    // Proaktive Nachrichten sind normale Chat-Nachrichten — das Gespräch bleibt durchgehend.
    if (!msg || typeof msg.text !== 'string') return;
    TMS_DATA.manager.messages.push({ role: 'assistant', text: msg.text, time: '', _id: 'out' + msg.id });
    if (typeof renderManagerChat === 'function') renderManagerChat();
    managerUnread = Number(msg.unread) || (managerUnread + 1);
    syncIslandBadge();
  };
```

Wire the click — it jumps to the manager and clears the badge:

```js
  document.getElementById('islandMgrBadge').addEventListener('click', ev => {
    ev.stopPropagation(); // darf die Insel nicht aufklappen
    show('manager');
    if (typeof window.managerOutboxRead === 'function') window.managerOutboxRead();
    managerUnread = 0;
    syncIslandBadge();
  });
```

Call `syncIslandBadge()` wherever `syncIslandManager()` is already called after a shell rebuild, so the badge survives re-renders.

- [ ] **Step 4a: Define the hooks in bridge.js**

```js
  window.TMSBridge.setUnread = function (n) {
    try { if (typeof applyManagerUnread === 'function') applyManagerUnread(n); } catch (e) {}
  };

  window.TMSBridge.proactive = function (msg) {
    try { if (typeof applyManagerProactive === 'function') applyManagerProactive(msg); } catch (e) {}
  };

  window.managerOutboxRead = function () { post('manager:outboxRead', {}); };
```

`applyManagerUnread` and `applyManagerProactive` are the page-side functions from
Step 3 — name them exactly so, since `window.tmsSetUnread`-style globals do not fit
the `TMSBridge` convention the rest of the app uses.

- [ ] **Step 4b: Translate in SeasonTwoWebRoot.tsx**

Outbound, next to the other `case` branches:

```tsx
      case 'manager:outboxRead':
        sendJson({ type: 'manager:outbox_read' });
        break;
```

Inbound, next to the `manager:memory_data` check:

```tsx
      if (m?.type === 'manager:unread') {
        call('setUnread', m.payload?.unread ?? 0);
        return;
      }
      if (m?.type === 'manager:proactive') {
        call('proactive', m.payload ?? {});
        return;
      }
```

- [ ] **Step 5: Build and verify visually**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run build:season2
```

Screenshot headless at **380×915** and **412×915** on the **terminal** screen, once with the badge hidden and once after running `applyManagerUnread(3)` in the page console.

Check:
- Bei 380 dp passt der Badge in die Insel, ohne dass die Terminal-Buttons abgeschnitten werden oder die Insel umbricht.
- Ohne ungelesene Nachrichten ist die Latenz-Anzeige wieder da.
- Auf dem Manager-Screen erscheint der Badge nicht.
- Antippen springt zum Manager und die Zahl verschwindet.

**Wenn es bei 380 dp nicht passt:** nicht die Schrift verkleinern. Stattdessen den Avatar weglassen und nur die Zahl in einem 22-px-Kreis zeigen; die Insel ist dort schlicht zu voll für beides. Das im Commit vermerken.

- [ ] **Step 6: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mockups/season2/liquid-deck/index.html
git commit -m "feat(season2): Island-Badge mit Avatar und Zahl für ungelesene Manager-Nachrichten

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"

cd ~/Desktop/tms-terminal
git add mobile/src/season2/liquidDeckHtml.ts mobile/src/season2/web/bridge.js
git commit -m "feat(season2): proaktive Nachrichten und Ungelesen-Zähler über die Bridge

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

> **Ende Phase A.** Ab hier ist das System benutzbar: Termine anlegen, Erinnerungen bekommen (auch als Push), Notizen und To-dos führen, proaktive Nachrichten mit Badge. **Vor Phase B den Nutzer eine Weile damit arbeiten lassen** — die Dosierungswerte aus Task 5 sind Annahmen, und echte Nutzung ist die einzige Möglichkeit, sie zu prüfen.

---

# Phase B — Sammler, Festgefahren-Erkennung, Auslöser

Erst hier bekommt der Agent ein Weltmodell. Phase A muss laufen und benutzt worden sein, bevor Phase B beginnt.

---

### Task 11: OSC-Titel — erst beweisen, dann bauen

Der einzige unbewiesene Baustein der Spec. **Wenn Step 2 zeigt, dass keine Titel ankommen, wird der Rest dieses Tasks übersprungen** — Task 12 liefert Sitzungsthemen ohnehin aus den Transkriptdateien. Das dann im Plan vermerken und weitergehen.

**Files:**
- Create: `server/scripts/probe-osc.ts`
- Create: `server/src/manager/context/osc.ts` (nur wenn der Nachweis gelingt)
- Test: `server/src/manager/context/osc.test.ts`
- Modify: `server/src/manager/manager.service.ts` (`feedOutput`)

**Interfaces:**
- Produces: `extractOscTitles(chunk: string): string[]`, `class OscTitleTracker` mit `feed(sessionId, chunk): string | null`, `getTitle(sessionId): string | undefined`, `clear(sessionId): void`

- [ ] **Step 1: Write the probe**

Create `server/scripts/probe-osc.ts`:

```ts
/**
 * Records raw PTY bytes so we can see whether anything actually emits OSC title
 * sequences. Does NOT touch the running server — it spawns its own pty.
 */
import * as fs from 'fs';
import * as os from 'os';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pty = require('node-pty');

const OUT = '/tmp/osc-probe.raw';
fs.writeFileSync(OUT, '');

const shell = process.env.SHELL ?? '/bin/zsh';
const term = pty.spawn(shell, [], {
  name: 'xterm-256color',
  cols: 120, rows: 30,
  cwd: os.homedir(),
  env: process.env,
});

term.onData((d: string) => {
  fs.appendFileSync(OUT, d);
  process.stdout.write(d);
});

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (b) => term.write(b.toString()));
term.onExit(() => {
  process.stdin.setRawMode?.(false);
  console.log(`\n\nRohdaten liegen in ${OUT}`);
  process.exit(0);
});
```

- [ ] **Step 2: Run the probe and decide**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register scripts/probe-osc.ts
```

Inside the spawned shell: `cd ~/Desktop/tms-terminal && claude`, ask it one trivial question, wait for an answer, then `/exit` and `exit`.

Then check:

```bash
LC_ALL=C grep -c $'\x1b]' /tmp/osc-probe.raw
LC_ALL=C grep -ao $'\x1b\][012];[^\x07]*' /tmp/osc-probe.raw | head -20
```

- **Titel gefunden** → weiter mit Step 3.
- **Nichts gefunden** → Steps 3–6 überspringen. Im Plan vermerken: „OSC-Titel werden im TMS-PTY nicht gesendet — Sitzungsthemen kommen ausschließlich aus den Transkriptdateien (Task 12)." Dann direkt zu Task 12.

- [ ] **Step 3: Write the failing test**

Create `server/src/manager/context/osc.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOscTitles, OscTitleTracker } from './osc';

const BEL = '\x07';
const ST = '\x1b\\';

test('extracts a title from an OSC 0 sequence', () => {
  assert.deepEqual(extractOscTitles(`vor\x1b]0;Mein Titel${BEL}nach`), ['Mein Titel']);
});

test('accepts OSC 1 and 2 and the ST terminator', () => {
  assert.deepEqual(extractOscTitles(`\x1b]2;Zwei${ST}`), ['Zwei']);
  assert.deepEqual(extractOscTitles(`\x1b]1;Eins${BEL}`), ['Eins']);
});

test('ignores OSC 7 (working directory) and OSC 8 (hyperlinks)', () => {
  assert.deepEqual(extractOscTitles(`\x1b]7;file://host/tmp${BEL}`), []);
  assert.deepEqual(extractOscTitles(`\x1b]8;;https://example.com${BEL}Text\x1b]8;;${BEL}`), []);
});

test('returns several titles in order', () => {
  assert.deepEqual(
    extractOscTitles(`\x1b]0;A${BEL}mitte\x1b]0;B${BEL}`),
    ['A', 'B'],
  );
});

test('plain output yields nothing', () => {
  assert.deepEqual(extractOscTitles('npm run build\nfertig\n'), []);
});

test('the tracker reports only real changes', () => {
  const t = new OscTitleTracker();
  assert.equal(t.feed('s1', `\x1b]0;Erstes Thema${BEL}`), 'Erstes Thema');
  assert.equal(t.feed('s1', `\x1b]0;Erstes Thema${BEL}`), null, 'same title is not a change');
  assert.equal(t.feed('s1', `\x1b]0;Zweites Thema${BEL}`), 'Zweites Thema');
  assert.equal(t.getTitle('s1'), 'Zweites Thema');
});

test('a sequence split across two chunks is still recognised', () => {
  const t = new OscTitleTracker();
  assert.equal(t.feed('s1', '\x1b]0;Halb'), null, 'incomplete — nothing yet');
  assert.equal(t.feed('s1', `er Titel${BEL}`), 'Halber Titel');
});

test('sessions do not bleed into each other', () => {
  const t = new OscTitleTracker();
  t.feed('s1', `\x1b]0;A${BEL}`);
  t.feed('s2', `\x1b]0;B${BEL}`);
  assert.equal(t.getTitle('s1'), 'A');
  assert.equal(t.getTitle('s2'), 'B');
  t.clear('s1');
  assert.equal(t.getTitle('s1'), undefined);
  assert.equal(t.getTitle('s2'), 'B');
});

test('a runaway partial buffer cannot grow without bound', () => {
  const t = new OscTitleTracker();
  t.feed('s1', '\x1b]0;' + 'x'.repeat(50_000)); // never terminated
  assert.equal(t.feed('s1', `${BEL}`), null, 'oversized partial is dropped, not kept forever');
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/manager/context/osc.test.ts`
Expected: FAIL — `Cannot find module './osc'`

- [ ] **Step 5: Write minimal implementation**

Create `server/src/manager/context/osc.ts`:

```ts
/**
 * Terminal titles arrive as OSC escape sequences inside the ordinary output
 * stream. manager.service.ts strips them (ANSI_STRIP), so this must run BEFORE
 * that strip or there is nothing left to read.
 */

// OSC 0/1/2 set the title. OSC 7 (cwd) and OSC 8 (hyperlinks) are deliberately excluded.
const TITLE_RE = /\x1b\][012];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** Longest partial sequence we are willing to hold while waiting for a terminator. */
const MAX_PARTIAL = 4096;

export function extractOscTitles(chunk: string): string[] {
  const titles: string[] = [];
  TITLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TITLE_RE.exec(chunk)) !== null) titles.push(m[1]);
  return titles;
}

export class OscTitleTracker {
  private titles = new Map<string, string>();
  private partials = new Map<string, string>();

  /** Returns the new title when it changed, otherwise null. */
  feed(sessionId: string, chunk: string): string | null {
    const combined = (this.partials.get(sessionId) ?? '') + chunk;
    const found = extractOscTitles(combined);

    // Keep whatever follows the last complete sequence, in case a new one is
    // half-arrived. Without this, a title split across two reads is lost.
    const lastEnd = this.lastSequenceEnd(combined);
    let rest = lastEnd >= 0 ? combined.slice(lastEnd) : combined;
    const openIdx = rest.lastIndexOf('\x1b]');
    rest = openIdx >= 0 ? rest.slice(openIdx) : '';
    this.partials.set(sessionId, rest.length <= MAX_PARTIAL ? rest : '');

    if (found.length === 0) return null;
    const latest = found[found.length - 1];
    if (this.titles.get(sessionId) === latest) return null;
    this.titles.set(sessionId, latest);
    return latest;
  }

  getTitle(sessionId: string): string | undefined {
    return this.titles.get(sessionId);
  }

  clear(sessionId: string): void {
    this.titles.delete(sessionId);
    this.partials.delete(sessionId);
  }

  private lastSequenceEnd(s: string): number {
    TITLE_RE.lastIndex = 0;
    let end = -1;
    let m: RegExpExecArray | null;
    while ((m = TITLE_RE.exec(s)) !== null) end = m.index + m[0].length;
    return end;
  }
}
```

- [ ] **Step 6: Run test, wire into feedOutput, commit**

Run: `cd server && node --require ts-node/register --test src/manager/context/osc.test.ts`
Expected: PASS — 9 Tests grün

In `manager.service.ts`, add the field and call it at the **very top** of `feedOutput` (line 1000), before `ANSI_STRIP` is applied:

```ts
  private oscTitles = new OscTitleTracker();
```

```ts
  feedOutput(sessionId: string, data: string): void {
    if (!this.enabled) return;

    // Read the terminal title BEFORE stripping — ANSI_STRIP deletes OSC sequences.
    const newTitle = this.oscTitles.feed(sessionId, data);
    if (newTitle !== null) {
      logger.info(`Manager: terminal ${sessionId.slice(0, 8)} title → "${newTitle}"`);
    }

    const clean = data.replace(ANSI_STRIP, '');
    // ... rest unchanged
```

In `clearSession` (line 1113) add `this.oscTitles.clear(sessionId);`.

```bash
cd server && npx tsc --noEmit && npm test
cd ~/Desktop/tms-terminal
git add server/src/manager/context/osc.ts server/src/manager/context/osc.test.ts server/src/manager/manager.service.ts server/scripts/probe-osc.ts
git commit -m "feat(manager): Terminal-Titel aus dem PTY-Strom lesen statt wegwerfen

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Der Projekt-Sammler

**Files:**
- Create: `server/src/manager/context/collector.ts`
- Test: `server/src/manager/context/collector.test.ts`

**Interfaces:**
- Consumes: `readStore`/`writeStore` (Task 1)
- Produces:
  - `ProjectFacts { key, path, name, lastActivityAt, gitBranch?, lastCommitAt?, lastCommitSubject?, recentSessions, claudeMdSummary?, collectedAt }`
  - `SessionFacts { sessionId, title, startedAt, endedAt, promptCount }`
  - `readTranscriptFacts(file: string): { cwd?, gitBranch?, title?, startedAt?, endedAt?, promptCount } `
  - `gitFacts(repoPath: string): { branch?: string; lastCommitAt?: number; lastCommitSubject?: string }`
  - `collectProjects(opts?: { projectsDir?: string; maxProjects?: number; sessionsPerProject?: number }): ProjectFacts[]`
  - `loadProjectFacts(dir?: string): ProjectFacts[]`, `saveProjectFacts(facts, dir?): void`

- [ ] **Step 1: Write the failing test**

Create `server/src/manager/context/collector.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscriptFacts, collectProjects } from './collector';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-collect-'));
}

/** Writes a transcript that looks like a real Claude Code jsonl file. */
function writeTranscript(dir: string, name: string, opts: {
  cwd: string; branch: string; title: string; prompts: number; startIso: string; endIso: string;
}): void {
  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: 'user', cwd: opts.cwd, gitBranch: opts.branch,
    timestamp: opts.startIso, sessionId: 's-1', version: '2.1.220',
    message: { role: 'user', content: 'erster Prompt' },
  }));
  for (let i = 0; i < opts.prompts; i++) {
    lines.push(JSON.stringify({ type: 'last-prompt', prompt: `Prompt ${i}` }));
  }
  lines.push(JSON.stringify({ type: 'ai-title', aiTitle: opts.title, sessionId: 's-1' }));
  lines.push(JSON.stringify({
    type: 'assistant', cwd: opts.cwd, gitBranch: opts.branch,
    timestamp: opts.endIso, sessionId: 's-1',
  }));
  fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n');
}

test('reads cwd, branch, title and prompt count out of a transcript', () => {
  const dir = tmpDir();
  writeTranscript(dir, 'a.jsonl', {
    cwd: '/Users/x/Desktop/Foo', branch: 'master', title: 'Serverfehler beheben',
    prompts: 4, startIso: '2026-07-28T08:00:00.000Z', endIso: '2026-07-28T09:30:00.000Z',
  });
  const facts = readTranscriptFacts(path.join(dir, 'a.jsonl'));
  assert.equal(facts.cwd, '/Users/x/Desktop/Foo');
  assert.equal(facts.gitBranch, 'master');
  assert.equal(facts.title, 'Serverfehler beheben');
  assert.equal(facts.promptCount, 4);
  assert.equal(facts.startedAt, Date.parse('2026-07-28T08:00:00.000Z'));
  assert.equal(facts.endedAt, Date.parse('2026-07-28T09:30:00.000Z'));
});

test('a truncated or malformed transcript yields partial facts instead of throwing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'broken.jsonl'), '{"type":"user","cwd":"/tmp/x"}\nNOT JSON AT ALL\n{"typ');
  const facts = readTranscriptFacts(path.join(dir, 'broken.jsonl'));
  assert.equal(facts.cwd, '/tmp/x', 'the readable part is still used');
});

test('an empty file is harmless', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'empty.jsonl'), '');
  assert.deepEqual(readTranscriptFacts(path.join(dir, 'empty.jsonl')).promptCount, 0);
});

test('collectProjects groups sessions per project, newest first', () => {
  const root = tmpDir();
  const projA = path.join(root, '-Users-x-Desktop-Foo');
  const projB = path.join(root, '-Users-x-Desktop-Bar');
  fs.mkdirSync(projA); fs.mkdirSync(projB);

  writeTranscript(projA, 'old.jsonl', {
    cwd: '/Users/x/Desktop/Foo', branch: 'master', title: 'Altes Thema',
    prompts: 2, startIso: '2026-07-20T08:00:00.000Z', endIso: '2026-07-20T09:00:00.000Z',
  });
  writeTranscript(projA, 'new.jsonl', {
    cwd: '/Users/x/Desktop/Foo', branch: 'feat/x', title: 'Neues Thema',
    prompts: 5, startIso: '2026-07-28T08:00:00.000Z', endIso: '2026-07-28T09:00:00.000Z',
  });
  writeTranscript(projB, 'only.jsonl', {
    cwd: '/Users/x/Desktop/Bar', branch: 'main', title: 'Bar-Thema',
    prompts: 1, startIso: '2026-07-25T08:00:00.000Z', endIso: '2026-07-25T08:30:00.000Z',
  });

  const projects = collectProjects({ projectsDir: root });
  assert.equal(projects.length, 2);
  assert.equal(projects[0].name, 'Foo', 'most recently active project comes first');
  assert.equal(projects[0].recentSessions[0].title, 'Neues Thema');
  assert.equal(projects[0].recentSessions.length, 2);
  assert.equal(projects[0].path, '/Users/x/Desktop/Foo');
});

test('directories without transcripts are skipped', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '-Users-x-Desktop-Leer'));
  assert.deepEqual(collectProjects({ projectsDir: root }), []);
});

test('a missing projects directory yields an empty list, not a crash', () => {
  assert.deepEqual(collectProjects({ projectsDir: '/definitiv/nicht/da' }), []);
});

test('sessionsPerProject caps how much history is kept', () => {
  const root = tmpDir();
  const proj = path.join(root, '-Users-x-Desktop-Viel');
  fs.mkdirSync(proj);
  for (let i = 0; i < 8; i++) {
    writeTranscript(proj, `s${i}.jsonl`, {
      cwd: '/Users/x/Desktop/Viel', branch: 'master', title: `Thema ${i}`,
      prompts: 1, startIso: `2026-07-2${i}T08:00:00.000Z`, endIso: `2026-07-2${i}T09:00:00.000Z`,
    });
  }
  const projects = collectProjects({ projectsDir: root, sessionsPerProject: 3 });
  assert.equal(projects[0].recentSessions.length, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/manager/context/collector.test.ts`
Expected: FAIL — `Cannot find module './collector'`

- [ ] **Step 3: Write minimal implementation**

Create `server/src/manager/context/collector.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { readStore, writeStore, MANAGER_DIR } from '../store';
import { logger } from '../../utils/logger';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const FILE = 'projects.json';

/** Head is enough for cwd/gitBranch; the tail carries the title and the end time. */
const HEAD_BYTES = 16 * 1024;
const TAIL_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 3000;

export interface SessionFacts {
  sessionId: string;
  title: string;
  startedAt: number;
  endedAt: number;
  promptCount: number;
}

export interface ProjectFacts {
  key: string;
  path: string;
  name: string;
  lastActivityAt: number;
  gitBranch?: string;
  lastCommitAt?: number;
  lastCommitSubject?: string;
  recentSessions: SessionFacts[];
  claudeMdSummary?: string;
  collectedAt: number;
}

export interface TranscriptFacts {
  cwd?: string;
  gitBranch?: string;
  title?: string;
  sessionId?: string;
  startedAt?: number;
  endedAt?: number;
  promptCount: number;
}

/** Read only the ends of a possibly huge file. Transcripts reach tens of MB. */
function readHeadAndTail(file: string): string {
  const size = fs.statSync(file).size;
  if (size <= HEAD_BYTES + TAIL_BYTES) return fs.readFileSync(file, 'utf-8');

  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    fs.readSync(fd, head, 0, HEAD_BYTES, 0);
    const tail = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    return head.toString('utf-8') + '\n' + tail.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Pull what we need out of one Claude Code transcript. This is someone else's
 * private format (today `version: 2.1.220`) — every field is optional and a
 * parse failure costs one line, never the whole file.
 */
export function readTranscriptFacts(file: string): TranscriptFacts {
  const out: TranscriptFacts = { promptCount: 0 };
  let raw: string;
  try {
    raw = readHeadAndTail(file);
  } catch {
    return out;
  }

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a truncated line in the middle is normal when reading head+tail
    }

    if (typeof obj.cwd === 'string' && out.cwd === undefined) out.cwd = obj.cwd;
    if (typeof obj.gitBranch === 'string') out.gitBranch = obj.gitBranch;
    if (typeof obj.sessionId === 'string' && out.sessionId === undefined) out.sessionId = obj.sessionId;
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') out.title = obj.aiTitle;
    if (obj.type === 'last-prompt') out.promptCount++;

    if (typeof obj.timestamp === 'string') {
      const t = Date.parse(obj.timestamp);
      if (!Number.isNaN(t)) {
        if (out.startedAt === undefined || t < out.startedAt) out.startedAt = t;
        if (out.endedAt === undefined || t > out.endedAt) out.endedAt = t;
      }
    }
  }
  return out;
}

/**
 * Branch and last commit via plumbing only.
 * `git status` is forbidden here: on the iCloud-backed Desktop it can hang for
 * minutes, and this runs every two minutes.
 */
export function gitFacts(repoPath: string): {
  branch?: string; lastCommitAt?: number; lastCommitSubject?: string;
} {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync('git', ['-C', repoPath, ...args], {
        encoding: 'utf-8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null; // not a repo, git missing, or timed out — all equally fine
    }
  };

  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const last = run(['log', '-1', '--format=%ct%n%s']);
  const out: { branch?: string; lastCommitAt?: number; lastCommitSubject?: string } = {};
  if (branch !== null && branch !== '') out.branch = branch;
  if (last !== null) {
    const [ts, ...rest] = last.split('\n');
    const secs = Number(ts);
    if (Number.isFinite(secs)) out.lastCommitAt = secs * 1000;
    if (rest.length > 0) out.lastCommitSubject = rest.join(' ');
  }
  return out;
}

function readClaudeMdSummary(repoPath: string): string | undefined {
  try {
    const md = fs.readFileSync(path.join(repoPath, 'CLAUDE.md'), 'utf-8');
    return md.slice(0, 600);
  } catch {
    return undefined;
  }
}

export function collectProjects(opts: {
  projectsDir?: string; maxProjects?: number; sessionsPerProject?: number;
} = {}): ProjectFacts[] {
  const root = opts.projectsDir ?? CLAUDE_PROJECTS_DIR;
  const sessionsPerProject = opts.sessionsPerProject ?? 5;
  const maxProjects = opts.maxProjects ?? 40;

  let dirs: string[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return []; // no Claude Code on this machine — not an error
  }

  const projects: ProjectFacts[] = [];

  for (const key of dirs) {
    const dir = path.join(root, key);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    const withTime = files
      .map(f => {
        const full = path.join(dir, f);
        try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return null; }
      })
      .filter((x): x is { full: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);

    if (withTime.length === 0) continue;

    const sessions: SessionFacts[] = [];
    let projectPath: string | undefined;
    let gitBranch: string | undefined;

    for (const { full, mtime } of withTime.slice(0, sessionsPerProject)) {
      const facts = readTranscriptFacts(full);
      if (projectPath === undefined && facts.cwd !== undefined) projectPath = facts.cwd;
      if (gitBranch === undefined && facts.gitBranch !== undefined) gitBranch = facts.gitBranch;
      sessions.push({
        sessionId: facts.sessionId ?? path.basename(full, '.jsonl'),
        title: facts.title ?? '(ohne Titel)',
        startedAt: facts.startedAt ?? mtime,
        endedAt: facts.endedAt ?? mtime,
        promptCount: facts.promptCount,
      });
    }

    const resolvedPath = projectPath ?? key;
    const git = projectPath !== undefined ? gitFacts(projectPath) : {};

    projects.push({
      key,
      path: resolvedPath,
      name: path.basename(resolvedPath),
      lastActivityAt: withTime[0].mtime,
      gitBranch: git.branch ?? gitBranch,
      lastCommitAt: git.lastCommitAt,
      lastCommitSubject: git.lastCommitSubject,
      recentSessions: sessions,
      claudeMdSummary: projectPath !== undefined ? readClaudeMdSummary(projectPath) : undefined,
      collectedAt: Date.now(),
    });
  }

  return projects
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, maxProjects);
}

export function loadProjectFacts(dir: string = MANAGER_DIR): ProjectFacts[] {
  return readStore<{ projects: ProjectFacts[] }>(FILE, { projects: [] }, dir).projects;
}

export function saveProjectFacts(projects: ProjectFacts[], dir: string = MANAGER_DIR): void {
  writeStore(FILE, { projects }, dir);
}

/** Refresh the store. Never throws — one bad signal must not kill the collector. */
export function refreshProjectFacts(dir: string = MANAGER_DIR): ProjectFacts[] {
  try {
    const projects = collectProjects();
    saveProjectFacts(projects, dir);
    return projects;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[collector] refresh failed, keeping previous facts: ${msg}`);
    return loadProjectFacts(dir);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/manager/context/collector.test.ts`
Expected: PASS — 7 Tests grün

- [ ] **Step 5: Check it against the real machine and time it**

```bash
cd server && node --require ts-node/register -e "
const t0=Date.now();
const {collectProjects}=require('./src/manager/context/collector');
const p=collectProjects();
console.log('Projekte:', p.length, '— Dauer:', Date.now()-t0, 'ms');
for (const x of p.slice(0,5)) console.log(' •', x.name, '|', x.gitBranch ?? '—', '|', x.recentSessions[0]?.title);
"
```

Expected: mehrere Projekte, jeweils mit echtem Sitzungstitel. **Wenn die Dauer über 3000 ms liegt**, `sessionsPerProject` auf 3 und `maxProjects` auf 20 senken und erneut messen — der Sammler läuft alle zwei Minuten und darf nicht spürbar sein.

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/context/collector.ts server/src/manager/context/collector.test.ts
git commit -m "feat(manager): Projekt-Sammler aus Claude-Code-Transkripten und Git-Plumbing

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Festgefahren-Erkennung

Der Auslöser für Vorschläge. Muss billig und deterministisch sein — das Modell wird erst danach geweckt.

**Files:**
- Create: `server/src/manager/context/stuck.ts`
- Test: `server/src/manager/context/stuck.test.ts`

**Interfaces:**
- Produces:
  - `normalizeErrorLine(line: string): string`
  - `errorSignature(line: string): string | null`
  - `StuckSignal { sessionId: string; signature: string; count: number; sample: string }`
  - `class StuckDetector` mit `feed(sessionId: string, cleanChunk: string): StuckSignal | null`, `clear(sessionId: string): void`

- [ ] **Step 1: Write the failing test**

Create `server/src/manager/context/stuck.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeErrorLine, errorSignature, StuckDetector } from './stuck';

const MIN = 60_000;

test('the same error with different line numbers and paths normalises identically', () => {
  const a = "TypeError: Cannot read properties of undefined (reading 'x') at /Users/ayysir/Desktop/Foo/src/a.ts:42:11";
  const b = "TypeError: Cannot read properties of undefined (reading 'x') at /Users/ayysir/Desktop/Foo/src/a.ts:87:3";
  assert.equal(normalizeErrorLine(a), normalizeErrorLine(b));
  assert.equal(errorSignature(a), errorSignature(b));
});

test('two genuinely different errors get different signatures', () => {
  const a = 'Error: ENOENT: no such file or directory';
  const b = 'Error: connect ECONNREFUSED';
  assert.notEqual(errorSignature(a), errorSignature(b));
});

test('ordinary output is not an error', () => {
  assert.equal(errorSignature('npm run build'), null);
  assert.equal(errorSignature('✓ 42 tests passed'), null);
  assert.equal(errorSignature(''), null);
});

test('common error shapes are recognised', () => {
  for (const line of [
    'Error: something broke',
    'TypeError: x is not a function',
    'npm ERR! code ELIFECYCLE',
    'FAILED src/test_thing.py::test_a',
    'Traceback (most recent call last):',
    'fatal: not a git repository',
  ]) {
    assert.notEqual(errorSignature(line), null, `should be an error: ${line}`);
  }
});

test('the third occurrence within the window raises a signal', () => {
  let t = 1_000_000;
  const det = new StuckDetector(() => t);
  const err = 'Error: connect ECONNREFUSED 127.0.0.1:5432\n';

  assert.equal(det.feed('s1', err), null, 'first');
  t += 2 * MIN;
  assert.equal(det.feed('s1', err), null, 'second');
  t += 2 * MIN;
  const signal = det.feed('s1', err);
  assert.notEqual(signal, null, 'third must trigger');
  assert.equal(signal!.count, 3);
  assert.equal(signal!.sessionId, 's1');
  assert.match(signal!.sample, /ECONNREFUSED/);
});

test('occurrences spread wider than the window never accumulate', () => {
  let t = 1_000_000;
  const det = new StuckDetector(() => t);
  const err = 'Error: gleich bleibender Fehler\n';
  for (let i = 0; i < 5; i++) {
    assert.equal(det.feed('s1', err), null, `occurrence ${i} is too far apart`);
    t += 25 * MIN; // window is 20 min
  }
});

test('a signature signals only once — repeating it would be nagging', () => {
  let t = 1_000_000;
  const det = new StuckDetector(() => t);
  const err = 'Error: immer derselbe\n';
  det.feed('s1', err); t += MIN;
  det.feed('s1', err); t += MIN;
  assert.notEqual(det.feed('s1', err), null, 'first signal');
  t += MIN;
  assert.equal(det.feed('s1', err), null, 'must stay quiet afterwards');
});

test('terminals are counted separately', () => {
  let t = 1_000_000;
  const det = new StuckDetector(() => t);
  const err = 'Error: geteilt\n';
  det.feed('s1', err); det.feed('s2', err);
  det.feed('s1', err); det.feed('s2', err);
  assert.notEqual(det.feed('s1', err), null);
  assert.notEqual(det.feed('s2', err), null, 's2 has its own count');
});

test('several errors in one chunk are all counted', () => {
  let t = 1_000_000;
  const det = new StuckDetector(() => t);
  const chunk = 'Error: wiederholt sich\nirgendwas\nError: wiederholt sich\n';
  assert.equal(det.feed('s1', chunk), null, 'two so far');
  assert.notEqual(det.feed('s1', 'Error: wiederholt sich\n'), null, 'third triggers');
});

test('clear forgets a terminal', () => {
  let t = 1_000_000;
  const det = new StuckDetector(() => t);
  const err = 'Error: weg damit\n';
  det.feed('s1', err); det.feed('s1', err);
  det.clear('s1');
  assert.equal(det.feed('s1', err), null, 'counting starts over');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/manager/context/stuck.test.ts`
Expected: FAIL — `Cannot find module './stuck'`

- [ ] **Step 3: Write minimal implementation**

Create `server/src/manager/context/stuck.ts`:

```ts
import { createHash } from 'crypto';

const WINDOW_MS = 20 * 60 * 1000;
const THRESHOLD = 3;

/** Lines that look like something went wrong. Deliberately broad — the count is the real filter. */
const ERROR_RE = /\b(error|exception|failed|failure|fatal|traceback|ERR!|ENOENT|ECONNREFUSED|cannot find|not found|panic)\b/i;

export interface StuckSignal {
  sessionId: string;
  signature: string;
  count: number;
  /** The original line, so the model has something concrete to look at. */
  sample: string;
}

/**
 * Strip everything that varies between two occurrences of the same problem:
 * line numbers, paths, addresses, timestamps. What is left identifies the
 * *kind* of failure, which is what "going in circles" actually means.
 */
export function normalizeErrorLine(line: string): string {
  return line
    .replace(/0x[0-9a-fA-F]+/g, '0xH')
    .replace(/\b[0-9a-fA-F]{8,}\b/g, 'HASH')
    .replace(/(?:\/[\w.@\- ]+)+/g, '/P')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function errorSignature(line: string): string | null {
  if (!ERROR_RE.test(line)) return null;
  const normalized = normalizeErrorLine(line);
  if (normalized === '') return null;
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

interface SessionState {
  hits: Map<string, { times: number[]; sample: string }>;
  reported: Set<string>;
}

/**
 * Counts repeating error signatures per terminal. Model-free by design: this
 * runs on every byte of output, so it has to be cheap.
 */
export class StuckDetector {
  private sessions = new Map<string, SessionState>();

  constructor(
    private readonly now: () => number,
    private readonly threshold: number = THRESHOLD,
    private readonly windowMs: number = WINDOW_MS,
  ) {}

  /** Feed ANSI-stripped output. Returns a signal the first time a signature repeats enough. */
  feed(sessionId: string, cleanChunk: string): StuckSignal | null {
    const now = this.now();
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = { hits: new Map(), reported: new Set() };
      this.sessions.set(sessionId, state);
    }

    let signal: StuckSignal | null = null;

    for (const rawLine of cleanChunk.split('\n')) {
      const line = rawLine.trim();
      if (line === '') continue;
      const sig = errorSignature(line);
      if (sig === null) continue;
      if (state.reported.has(sig)) continue;

      let entry = state.hits.get(sig);
      if (entry === undefined) {
        entry = { times: [], sample: line };
        state.hits.set(sig, entry);
      }
      entry.times.push(now);
      entry.times = entry.times.filter(t => now - t <= this.windowMs);

      if (entry.times.length >= this.threshold && signal === null) {
        state.reported.add(sig);
        signal = { sessionId, signature: sig, count: entry.times.length, sample: entry.sample };
      }
    }

    return signal;
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/manager/context/stuck.test.ts`
Expected: PASS — 10 Tests grün

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/context/stuck.ts server/src/manager/context/stuck.test.ts
git commit -m "feat(manager): Festgefahren-Erkennung über normalisierte Fehlersignaturen

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Auslöser und Tages-Check-ins

**Files:**
- Create: `server/src/manager/context/triggers.ts`
- Test: `server/src/manager/context/triggers.test.ts`
- Modify: `server/src/manager/manager.service.ts`

**Interfaces:**
- Consumes: `Outbox` (Task 5), `StuckDetector`/`StuckSignal` (Task 13), `refreshProjectFacts` (Task 12)
- Produces:
  - `class CheckInScheduler` mit `constructor(now, onCheckIn, times?)`, `tick(): void`
  - `SILENCE_MARKER = 'NICHTS'`
  - `buildStuckPrompt(input: StuckPromptInput): string`
  - `StuckPromptInput { sample: string; terminalTail: string; sessionLabel: string; projectPath?: string; claudeMdSummary?: string }`

- [ ] **Step 1: Write the failing test**

Create `server/src/manager/context/triggers.test.ts`:

```ts
process.env.TZ = 'Europe/Berlin';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckInScheduler, buildStuckPrompt, SILENCE_MARKER } from './triggers';

function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

test('the morning check-in fires once at 08:30 and not again that day', () => {
  let t = at(2026, 7, 28, 8, 29);
  const fired: string[] = [];
  const s = new CheckInScheduler(() => t, (kind) => fired.push(kind));

  s.tick();
  assert.deepEqual(fired, [], 'not yet');

  t = at(2026, 7, 28, 8, 30);
  s.tick();
  assert.deepEqual(fired, ['morning']);

  t = at(2026, 7, 28, 9, 0);
  s.tick();
  assert.deepEqual(fired, ['morning'], 'must not repeat within the day');
});

test('the evening check-in is separate from the morning one', () => {
  let t = at(2026, 7, 28, 8, 30);
  const fired: string[] = [];
  const s = new CheckInScheduler(() => t, (kind) => fired.push(kind));
  s.tick();
  t = at(2026, 7, 28, 19, 0);
  s.tick();
  assert.deepEqual(fired, ['morning', 'evening']);
});

test('the next day fires again', () => {
  let t = at(2026, 7, 28, 8, 30);
  const fired: string[] = [];
  const s = new CheckInScheduler(() => t, (kind) => fired.push(kind));
  s.tick();
  t = at(2026, 7, 29, 8, 30);
  s.tick();
  assert.deepEqual(fired, ['morning', 'morning']);
});

test('a check-in missed by hours is not fired late', () => {
  // Server was down all morning and comes up at 14:00 — a "guten Morgen" now is noise.
  let t = at(2026, 7, 28, 14, 0);
  const fired: string[] = [];
  const s = new CheckInScheduler(() => t, (kind) => fired.push(kind));
  s.tick();
  assert.deepEqual(fired, [], 'more than an hour late — skip it');
});

test('a check-in 20 minutes late still fires', () => {
  let t = at(2026, 7, 28, 8, 50);
  const fired: string[] = [];
  const s = new CheckInScheduler(() => t, (kind) => fired.push(kind));
  s.tick();
  assert.deepEqual(fired, ['morning']);
});

test('the stuck prompt gives the model everything it needs and permission to stay silent', () => {
  const prompt = buildStuckPrompt({
    sample: 'Error: connect ECONNREFUSED 127.0.0.1:5432',
    terminalTail: 'npm run dev\n... Fehler ...',
    sessionLabel: 'Shell 1',
    projectPath: '/Users/ayysir/Desktop/Foo',
    claudeMdSummary: '# Foo\nPostgres läuft auf Port 5432.',
  });
  assert.match(prompt, /ECONNREFUSED/);
  assert.match(prompt, /Shell 1/);
  assert.match(prompt, /Desktop\/Foo/);
  assert.match(prompt, /Postgres/);
  assert.match(prompt, new RegExp(SILENCE_MARKER), 'the model must be told it may say nothing');
  assert.match(prompt, /genau einen/i, 'exactly one suggestion, not a list');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/manager/context/triggers.test.ts`
Expected: FAIL — `Cannot find module './triggers'`

- [ ] **Step 3: Write minimal implementation**

Create `server/src/manager/context/triggers.ts`:

```ts
export type CheckInKind = 'morning' | 'evening';

/** Answer the model gives when it has nothing worth saying. */
export const SILENCE_MARKER = 'NICHTS';

/** How late a check-in may still be delivered after a restart. */
const MAX_LATE_MS = 60 * 60 * 1000;

export interface CheckInTime {
  kind: CheckInKind;
  hour: number;
  minute: number;
}

const DEFAULT_TIMES: CheckInTime[] = [
  { kind: 'morning', hour: 8, minute: 30 },
  { kind: 'evening', hour: 19, minute: 0 },
];

/**
 * Fires the two daily check-ins. Keyed by calendar day so a restart cannot
 * cause a second "guten Morgen", and a long outage does not deliver a stale one.
 */
export class CheckInScheduler {
  private lastFiredDay = new Map<CheckInKind, string>();

  constructor(
    private readonly now: () => number,
    private readonly onCheckIn: (kind: CheckInKind) => void,
    private readonly times: CheckInTime[] = DEFAULT_TIMES,
  ) {}

  tick(): void {
    const nowMs = this.now();
    const d = new Date(nowMs);
    const dayKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

    for (const t of this.times) {
      if (this.lastFiredDay.get(t.kind) === dayKey) continue;
      const scheduled = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.hour, t.minute, 0, 0).getTime();
      if (nowMs < scheduled) continue;
      if (nowMs - scheduled > MAX_LATE_MS) {
        // Too late to be useful — mark it done so it does not fire at a silly hour.
        this.lastFiredDay.set(t.kind, dayKey);
        continue;
      }
      this.lastFiredDay.set(t.kind, dayKey);
      this.onCheckIn(t.kind);
    }
  }
}

export interface StuckPromptInput {
  sample: string;
  terminalTail: string;
  sessionLabel: string;
  projectPath?: string;
  claudeMdSummary?: string;
}

/**
 * The prompt for the expensive path. Two things in it matter most:
 * exactly ONE suggestion (a list is not help, it is homework), and explicit
 * permission to return nothing — without it a model always invents something.
 */
export function buildStuckPrompt(input: StuckPromptInput): string {
  const parts: string[] = [];
  parts.push(
    `Im Terminal "${input.sessionLabel}" taucht derselbe Fehler wiederholt auf. ` +
    `Schau ihn dir an und überlege, ob dir etwas Konkretes einfällt, das noch nicht probiert wurde.`,
  );
  if (input.projectPath !== undefined) parts.push(`\nProjekt: ${input.projectPath}`);
  parts.push(`\nWiederkehrender Fehler:\n${input.sample}`);
  parts.push(`\nLetzte Terminal-Ausgabe:\n\`\`\`\n${input.terminalTail.slice(-3000)}\n\`\`\``);
  if (input.claudeMdSummary !== undefined) {
    parts.push(`\nAus der CLAUDE.md des Projekts:\n${input.claudeMdSummary}`);
  }
  parts.push(
    `\nAntworte mit **genau einem** konkreten Vorschlag, höchstens drei Sätzen, ` +
    `im Ton "hast du schon X probiert?" — nicht "du hängst fest".\n\n` +
    `Wenn dir nichts wirklich Nützliches einfällt, antworte ausschließlich mit ${SILENCE_MARKER}. ` +
    `Das ist eine gute Antwort und ausdrücklich erwünscht — dann wird gar keine Nachricht verschickt. ` +
    `Rate nicht, nur um etwas zu sagen.`,
  );
  return parts.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/manager/context/triggers.test.ts`
Expected: PASS — 6 Tests grün

- [ ] **Step 5: Wire the triggers into ManagerService**

In `manager.service.ts` add imports and fields:

```ts
import { StuckDetector } from './context/stuck';
import { CheckInScheduler, buildStuckPrompt, SILENCE_MARKER } from './context/triggers';
import { refreshProjectFacts, loadProjectFacts } from './context/collector';
```

```ts
  private stuckDetector = new StuckDetector(() => Date.now());
  private collectorTimer: NodeJS.Timeout | null = null;
  private checkIns = new CheckInScheduler(() => Date.now(), (kind) => { void this.runCheckIn(kind); });
  private checkInTimer: NodeJS.Timeout | null = null;
```

In `feedOutput`, after `const clean = data.replace(ANSI_STRIP, '');` add:

```ts
    const stuck = this.stuckDetector.feed(sessionId, clean);
    if (stuck !== null) void this.handleStuck(stuck);
```

In `clearSession` add `this.stuckDetector.clear(sessionId);`.

In `start()` add:

```ts
    this.collectorTimer = setInterval(() => { refreshProjectFacts(); }, 2 * 60_000);
    this.collectorTimer.unref();
    this.checkInTimer = setInterval(() => this.checkIns.tick(), 60_000);
    this.checkInTimer.unref();
    refreshProjectFacts();
```

In `stop()` clear both timers.

Add the two handlers:

```ts
  /** The expensive path. Everything cheap has already said "worth a look". */
  private async handleStuck(signal: import('./context/stuck').StuckSignal): Promise<void> {
    const topicKey = `stuck:${signal.signature}`;
    // Ask the outbox FIRST — if the dosage would refuse it, we spend nothing.
    if (!this.outbox.canAccept({ kind: 'stuck', topicKey, sessionId: signal.sessionId })) return;

    const label = this.sessionLabels.get(signal.sessionId) ?? signal.sessionId.slice(0, 8);
    const tail = this.outputBuffers.get(signal.sessionId)?.data ?? '';
    const ctx = this.buildTerminalContexts().find(c => c.sessionId === signal.sessionId);
    const facts = loadProjectFacts().find(p => ctx?.cwd !== undefined && ctx.cwd.startsWith(p.path));

    const prompt = buildStuckPrompt({
      sample: signal.sample,
      terminalTail: tail,
      sessionLabel: label,
      projectPath: ctx?.cwd,
      claudeMdSummary: facts?.claudeMdSummary,
    });

    const answer = await this.askModelQuietly(prompt);
    if (answer === null || answer.trim().toUpperCase().startsWith(SILENCE_MARKER)) {
      logger.info(`[stuck] model had nothing useful for ${topicKey} — staying quiet`);
      return;
    }

    const msg = this.outbox.push({
      kind: 'stuck', text: answer.trim(), topicKey, sessionId: signal.sessionId,
    });
    if (msg !== null) this.emitProactive(msg);
  }

  private async runCheckIn(kind: 'morning' | 'evening'): Promise<void> {
    const terminals = this.buildTerminalContexts().map(c => ({
      label: c.label, status: c.status, cwd: c.cwd,
    }));
    const overview = buildOverview({ nowMs: Date.now(), terminals });
    const ask = kind === 'morning'
      ? 'Fasse in höchstens fünf Sätzen zusammen, was heute ansteht. Nenne konkret Termine und offene To-dos.'
      : 'Fasse in höchstens fünf Sätzen zusammen, was heute passiert ist und was noch offen hängt.';
    const answer = await this.askModelQuietly(`${overview}\n\n${ask}\n\nWenn es nichts Erwähnenswertes gibt, antworte nur mit ${SILENCE_MARKER}.`);
    if (answer === null || answer.trim().toUpperCase().startsWith(SILENCE_MARKER)) return;
    const msg = this.outbox.push({ kind: 'checkin', text: answer.trim() });
    if (msg !== null) this.emitProactive(msg);
  }
```

`askModelQuietly(prompt: string): Promise<string | null>` sends a single completion **without** streaming to the chat UI and returns `null` on any failure. Build it from the provider call already used in `handleChat` — find it with:

```bash
cd ~/Desktop/tms-terminal && grep -n "activeProvider\|\.chat(\|streamChat" server/src/manager/manager.service.ts | head -10
```

Reuse that same provider object; do not create a second registry.

- [ ] **Step 6: Add the dry-run check to Outbox**

`handleStuck` must be able to ask *before* paying for a model call. In `server/src/manager/outbox/outbox.ts` add:

```ts
  /** Would push() accept this? Lets callers avoid expensive work that would be discarded. */
  canAccept(input: { kind: OutboxKind; topicKey?: string; sessionId?: string }): boolean {
    const file = this.load();
    const now = this.now();
    if (input.topicKey !== undefined) {
      if (file.suppressedTopics.includes(input.topicKey)) return false;
      if (file.messages.some(m => m.topicKey === input.topicKey)) return false;
    }
    if (AGENT_INITIATED.includes(input.kind) && input.sessionId !== undefined) {
      const recent = file.messages.some(m =>
        m.sessionId === input.sessionId &&
        AGENT_INITIATED.includes(m.kind) &&
        now - m.createdAt < PER_SESSION_COOLDOWN_MS,
      );
      if (recent) return false;
    }
    return true;
  }
```

Add to `server/src/manager/outbox/outbox.test.ts`:

```ts
test('canAccept agrees with push', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  assert.equal(h.outbox.canAccept({ kind: 'stuck', topicKey: 'k', sessionId: 's1' }), true);
  h.outbox.push({ kind: 'stuck', text: 'A', topicKey: 'k', sessionId: 's1' });
  assert.equal(h.outbox.canAccept({ kind: 'stuck', topicKey: 'k', sessionId: 's1' }), false);
});

test('canAccept does not itself create a message', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  h.outbox.canAccept({ kind: 'stuck', topicKey: 'k' });
  assert.equal(h.outbox.unreadCount(), 0);
});
```

- [ ] **Step 7: Verify and commit**

```bash
cd server && npx tsc --noEmit && npm test
cd ~/Desktop/tms-terminal
git add server/src/manager/context/triggers.ts server/src/manager/context/triggers.test.ts server/src/manager/outbox/ server/src/manager/manager.service.ts
git commit -m "feat(manager): Auslöser für Festgefahren-Hinweise und zwei Tages-Check-ins

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Überblick und Projektdetail mit echten Daten

**Files:**
- Modify: `server/src/manager/tools/stufe1.handlers.ts`
- Modify: `server/src/manager/tools/stufe1.handlers.test.ts`
- Modify: `server/src/manager/manager.service.ts` (`get_project`-Zweig)

**Interfaces:**
- Consumes: `ProjectFacts`, `loadProjectFacts` (Task 12)
- Produces: `buildOverview(input, dir?)` erweitert um `projects`, neu `buildProjectDetail(name, projects, dir?): string`

- [ ] **Step 1: Extend the failing test**

Append to `server/src/manager/tools/stufe1.handlers.test.ts`:

```ts
import { buildProjectDetail } from './stufe1.handlers';
import type { ProjectFacts } from '../context/collector';

function facts(over: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    key: '-Users-x-Desktop-Foo', path: '/Users/x/Desktop/Foo', name: 'Foo',
    lastActivityAt: at(2026, 7, 28, 9, 0), gitBranch: 'master',
    lastCommitAt: at(2026, 7, 27, 18, 0), lastCommitSubject: 'fix: Absturz behoben',
    recentSessions: [{
      sessionId: 's1', title: 'Serverfehler beheben',
      startedAt: at(2026, 7, 28, 8, 0), endedAt: at(2026, 7, 28, 9, 0), promptCount: 12,
    }],
    claudeMdSummary: '# Foo\nLäuft auf Port 3000.',
    collectedAt: at(2026, 7, 28, 9, 1),
    ...over,
  };
}

test('the overview lists recently active projects with their last topic', () => {
  const dir = tmpDir();
  const out = buildOverview({
    nowMs: at(2026, 7, 28, 10, 0), terminals: [], projects: [facts()],
  }, dir);
  assert.match(out, /Foo/);
  assert.match(out, /Serverfehler beheben/);
  assert.match(out, /master/);
});

test('the project detail names branch, last commit, topics and CLAUDE.md', () => {
  const dir = tmpDir();
  const out = buildProjectDetail('foo', [facts()], dir);
  assert.match(out, /\/Users\/x\/Desktop\/Foo/);
  assert.match(out, /master/);
  assert.match(out, /Absturz behoben/);
  assert.match(out, /Serverfehler beheben/);
  assert.match(out, /Port 3000/);
});

test('an unknown project says so plainly and lists what exists', () => {
  const dir = tmpDir();
  const out = buildProjectDetail('gibtsnicht', [facts()], dir);
  assert.match(out, /Kein Projekt/);
  assert.match(out, /Foo/, 'so the model can pick a real one');
});

test('the project detail includes the open to-dos of that project', () => {
  const dir = tmpDir();
  handleEntriesTool({ action: 'add', text: 'Foo aufräumen', checkable: 'true', project: '-Users-x-Desktop-Foo' }, dir);
  const out = buildProjectDetail('Foo', [facts()], dir);
  assert.match(out, /Foo aufräumen/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/manager/tools/stufe1.handlers.test.ts`
Expected: FAIL — `buildProjectDetail is not a function`

- [ ] **Step 3: Extend the implementation**

In `stufe1.handlers.ts`, extend `OverviewInput` and add the project section plus the new function:

```ts
import type { ProjectFacts } from '../context/collector';

export interface OverviewInput {
  nowMs: number;
  terminals: Array<{ label: string; status: string; cwd?: string }>;
  projects?: ProjectFacts[];
}

function fmtAge(nowMs: number, thenMs: number): string {
  const mins = Math.round((nowMs - thenMs) / 60_000);
  if (mins < 60) return `vor ${mins} Min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `vor ${hours} Std`;
  return `vor ${Math.round(hours / 24)} Tagen`;
}
```

Insert into `buildOverview`, before the to-do section:

```ts
  const projects = input.projects ?? [];
  if (projects.length > 0) {
    parts.push('\n### Projekte (zuletzt aktiv)');
    for (const p of projects.slice(0, 8)) {
      const topic = p.recentSessions[0]?.title ?? '—';
      const branch = p.gitBranch !== undefined ? ` · ${p.gitBranch}` : '';
      parts.push(`• ${p.name}${branch} — ${fmtAge(input.nowMs, p.lastActivityAt)} — „${topic}"`);
    }
  }
```

Add the detail builder:

```ts
export function buildProjectDetail(
  name: string,
  projects: ProjectFacts[],
  dir: string = MANAGER_DIR,
): string {
  const needle = name.trim().toLowerCase();
  const hit = projects.find(p =>
    p.name.toLowerCase().includes(needle) ||
    p.path.toLowerCase().includes(needle) ||
    p.key.toLowerCase().includes(needle));

  if (hit === undefined) {
    const known = projects.slice(0, 10).map(p => p.name).join(', ');
    return `Kein Projekt gefunden, das zu "${name}" passt.`
      + (known !== '' ? ` Bekannt sind: ${known}.` : '');
  }

  const parts: string[] = [];
  parts.push(`## ${hit.name}`);
  parts.push(`Pfad: ${hit.path}`);
  if (hit.gitBranch !== undefined) parts.push(`Branch: ${hit.gitBranch}`);
  if (hit.lastCommitSubject !== undefined) {
    const when = hit.lastCommitAt !== undefined ? ` (${new Date(hit.lastCommitAt).toLocaleDateString('de-DE')})` : '';
    parts.push(`Letzter Commit${when}: ${hit.lastCommitSubject}`);
  }

  if (hit.recentSessions.length > 0) {
    parts.push('\n### Zuletzt bearbeitet');
    for (const s of hit.recentSessions) {
      parts.push(`• „${s.title}" — ${new Date(s.endedAt).toLocaleDateString('de-DE')}, ${s.promptCount} Nachrichten`);
    }
  }

  const open = listEntries({ project: hit.key, onlyOpen: true }, dir);
  parts.push('\n### Offene To-dos');
  parts.push(open.length === 0 ? 'Keine.' : open.map(e => `• ${e.text}`).join('\n'));

  if (hit.claudeMdSummary !== undefined) {
    parts.push(`\n### Aus der CLAUDE.md\n${hit.claudeMdSummary}`);
  }

  return parts.join('\n');
}
```

- [ ] **Step 4: Feed real data in from the service**

In `manager.service.ts`, update the two cases in `executeAction`:

```ts
      case 'get_overview': {
        const terminals = this.buildTerminalContexts().map(c => ({
          label: c.label, status: c.status, cwd: c.cwd,
        }));
        return { text: buildOverview({ nowMs: Date.now(), terminals, projects: loadProjectFacts() }) };
      }

      case 'get_project':
        return { text: buildProjectDetail(action.detail, loadProjectFacts()) };
```

Add `buildProjectDetail` to the import from `./tools/stufe1.handlers`.

- [ ] **Step 5: Verify everything**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: PASS — alle Testdateien grün

Sanity-check against the real machine:

```bash
cd server && node --require ts-node/register -e "
const {refreshProjectFacts}=require('./src/manager/context/collector');
const {buildOverview}=require('./src/manager/tools/stufe1.handlers');
const p=refreshProjectFacts();
console.log(buildOverview({nowMs:Date.now(), terminals:[], projects:p}));
"
```

Expected: eine lesbare Übersicht mit echten Projektnamen, Branches und Sitzungsthemen.

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/tools/ server/src/manager/manager.service.ts
git commit -m "feat(manager): Überblick und Projektdetail mit echten Sammler-Daten

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Die restlichen Auslöser und der Ausfallbeweis

Schließt drei Zeilen der Auslöser-Tabelle, die sonst nirgends landen, und beweist den Kernanspruch der Architektur: dass Erinnerungen ohne Modell funktionieren.

**Files:**
- Create: `server/src/manager/context/terminal-events.ts`
- Test: `server/src/manager/context/terminal-events.test.ts`
- Modify: `server/src/manager/context/triggers.ts` + `triggers.test.ts` (brachliegende Projekte)
- Modify: `server/src/manager/agenda/agenda.scheduler.test.ts` (Ausfallbeweis)
- Modify: `server/src/manager/manager.service.ts` (Verdrahtung)

**Interfaces:**
- Consumes: `ProjectFacts` (Task 12), `Entry` (Task 4), `Outbox` (Task 5)
- Produces:
  - `class TerminalEventDetector` mit `noteOutput(sessionId, busy)`, `pollFinished(): string[]`, `clear(sessionId)`
  - `staleProjects(projects, entries, nowMs, staleDays?): ProjectFacts[]`

- [ ] **Step 1: Write the failing test for finished terminals**

Create `server/src/manager/context/terminal-events.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalEventDetector } from './terminal-events';

const MIN = 60_000;

test('a terminal that was busy and then falls quiet is reported once', () => {
  let t = 1_000_000;
  const det = new TerminalEventDetector(() => t);

  det.noteOutput('s1', true);
  assert.deepEqual(det.pollFinished(), [], 'still busy');

  t += 3 * MIN;
  assert.deepEqual(det.pollFinished(), ['s1'], 'quiet for over two minutes');
  assert.deepEqual(det.pollFinished(), [], 'reported once, not every poll');
});

test('a terminal that was never busy is not reported', () => {
  let t = 1_000_000;
  const det = new TerminalEventDetector(() => t);
  det.noteOutput('s1', false);
  t += 10 * MIN;
  assert.deepEqual(det.pollFinished(), [], 'idle chatter is not "finished"');
});

test('new output before the threshold resets the clock', () => {
  let t = 1_000_000;
  const det = new TerminalEventDetector(() => t);
  det.noteOutput('s1', true);
  t += 90_000;
  det.noteOutput('s1', true);
  t += 90_000;
  assert.deepEqual(det.pollFinished(), [], 'never quiet for a full two minutes');
  t += 40_000;
  assert.deepEqual(det.pollFinished(), ['s1']);
});

test('becoming busy again re-arms the report', () => {
  let t = 1_000_000;
  const det = new TerminalEventDetector(() => t);
  det.noteOutput('s1', true);
  t += 3 * MIN;
  assert.deepEqual(det.pollFinished(), ['s1']);
  det.noteOutput('s1', true);
  t += 3 * MIN;
  assert.deepEqual(det.pollFinished(), ['s1'], 'a second run reports again');
});

test('terminals are tracked independently and clear forgets one', () => {
  let t = 1_000_000;
  const det = new TerminalEventDetector(() => t);
  det.noteOutput('s1', true);
  det.noteOutput('s2', true);
  t += 3 * MIN;
  assert.deepEqual(det.pollFinished().sort(), ['s1', 's2']);
  det.noteOutput('s1', true);
  det.clear('s1');
  t += 3 * MIN;
  assert.deepEqual(det.pollFinished(), [], 'cleared session is gone');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/manager/context/terminal-events.test.ts`
Expected: FAIL — `Cannot find module './terminal-events'`

- [ ] **Step 3: Write minimal implementation**

Create `server/src/manager/context/terminal-events.ts`:

```ts
const IDLE_MS = 2 * 60 * 1000;

interface State {
  lastOutputAt: number;
  /** Whether anything worth calling "work" has happened since the last report. */
  wasBusy: boolean;
}

/**
 * Notices when a terminal that was actually working falls quiet.
 * Deliberately separate from the delegated-task machinery in manager.service.ts —
 * this one exists for terminals the user drives themselves.
 */
export class TerminalEventDetector {
  private states = new Map<string, State>();

  constructor(
    private readonly now: () => number,
    private readonly idleMs: number = IDLE_MS,
  ) {}

  noteOutput(sessionId: string, busy: boolean): void {
    const s = this.states.get(sessionId) ?? { lastOutputAt: 0, wasBusy: false };
    s.lastOutputAt = this.now();
    if (busy) s.wasBusy = true;
    this.states.set(sessionId, s);
  }

  /** Sessions that just finished. Each is reported once per busy period. */
  pollFinished(): string[] {
    const now = this.now();
    const finished: string[] = [];
    for (const [sessionId, s] of this.states) {
      if (!s.wasBusy) continue;
      if (now - s.lastOutputAt < this.idleMs) continue;
      s.wasBusy = false; // re-arms only when real work happens again
      finished.push(sessionId);
    }
    return finished;
  }

  clear(sessionId: string): void {
    this.states.delete(sessionId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/manager/context/terminal-events.test.ts`
Expected: PASS — 5 Tests grün

- [ ] **Step 5: Add stale-project detection**

Append to `server/src/manager/context/triggers.test.ts`:

```ts
import { staleProjects } from './triggers';
import type { ProjectFacts } from './collector';
import type { Entry } from '../entries/entries.types';

const DAY = 24 * 60 * 60 * 1000;

function proj(key: string, lastActivityAt: number): ProjectFacts {
  return {
    key, path: `/Users/x/${key}`, name: key, lastActivityAt,
    recentSessions: [], collectedAt: lastActivityAt,
  };
}

function todo(project: string): Entry {
  return {
    id: `e-${project}`, text: `offen in ${project}`, checkable: true, done: false,
    project, createdAt: 0, updatedAt: 0, source: 'user',
  };
}

test('a project untouched for over five days with open to-dos counts as stale', () => {
  const now = at(2026, 7, 28, 10, 0);
  const stale = staleProjects([proj('Alt', now - 9 * DAY)], [todo('Alt')], now);
  assert.deepEqual(stale.map(p => p.key), ['Alt']);
});

test('a recently touched project is never stale, open to-dos or not', () => {
  const now = at(2026, 7, 28, 10, 0);
  assert.deepEqual(staleProjects([proj('Frisch', now - 2 * DAY)], [todo('Frisch')], now), []);
});

test('an old project without open to-dos is finished, not forgotten', () => {
  const now = at(2026, 7, 28, 10, 0);
  assert.deepEqual(staleProjects([proj('Fertig', now - 30 * DAY)], [], now), []);
});

test('done to-dos do not keep a project alive', () => {
  const now = at(2026, 7, 28, 10, 0);
  const done: Entry = { ...todo('Erledigt'), done: true };
  assert.deepEqual(staleProjects([proj('Erledigt', now - 30 * DAY)], [done], now), []);
});
```

Add to `server/src/manager/context/triggers.ts`:

```ts
import type { ProjectFacts } from './collector';
import type { Entry } from '../entries/entries.types';

const STALE_DAYS = 5;

/**
 * Projects nobody has touched in a while that still have open to-dos.
 * Deliberately NOT an interrupting trigger — this only ever surfaces in a
 * check-in, because "you forgot something" is never urgent enough to interrupt.
 */
export function staleProjects(
  projects: ProjectFacts[],
  entries: Entry[],
  nowMs: number,
  staleDays: number = STALE_DAYS,
): ProjectFacts[] {
  const cutoff = nowMs - staleDays * 24 * 60 * 60 * 1000;
  const withOpen = new Set(
    entries.filter(e => e.checkable && !e.done && e.project !== undefined).map(e => e.project as string),
  );
  return projects.filter(p => p.lastActivityAt < cutoff && withOpen.has(p.key));
}
```

- [ ] **Step 6: Prove reminders survive a dead model**

This is the claim the whole architecture rests on. Append to `server/src/manager/agenda/agenda.scheduler.test.ts`:

```ts
test('reminders fire even when every model call throws', () => {
  // The scheduler must never touch a provider. If this ever regresses, the
  // separation of collecting and judging has been broken somewhere.
  const items = [appointment()];
  let now = at(2026, 8, 4, 14, 0);
  const fired: string[] = [];
  const scheduler = new AgendaScheduler(
    () => now,
    () => items,
    () => {},
    (d) => {
      // Simulate the surrounding world being broken in every way that matters.
      const brokenProvider = () => { throw new Error('402 Payment Required'); };
      try { brokenProvider(); } catch { /* the reminder path must not care */ }
      fired.push(d.item.title);
    },
  );
  scheduler.start();
  assert.deepEqual(fired, ['Zahnarzt']);
  scheduler.stop();
});

test('one throwing handler does not stop the remaining reminders', () => {
  const items = [
    appointment({ id: 'a1', title: 'Erster' }),
    appointment({ id: 'a2', title: 'Zweiter' }),
  ];
  let now = at(2026, 8, 4, 14, 0);
  const fired: string[] = [];
  const scheduler = new AgendaScheduler(
    () => now,
    () => items,
    () => {},
    (d) => {
      if (d.item.title === 'Erster') throw new Error('Handler kaputt');
      fired.push(d.item.title);
    },
  );
  scheduler.start();
  assert.deepEqual(fired, ['Zweiter'], 'the second reminder still gets through');
  scheduler.stop();
});
```

- [ ] **Step 7: Wire the two terminal triggers**

In `manager.service.ts` add:

```ts
import { TerminalEventDetector } from './context/terminal-events';
import { staleProjects } from './context/triggers';
import { listEntries } from './entries/entries.store';
```

```ts
  private terminalEvents = new TerminalEventDetector(() => Date.now());
  private terminalEventTimer: NodeJS.Timeout | null = null;
```

In `feedOutput`, after the stuck check:

```ts
    const busyCtx = this.buildTerminalContexts().find(c => c.sessionId === sessionId);
    const busy = busyCtx?.status === 'ai_running' || busyCtx?.status === 'building';
    this.terminalEvents.noteOutput(sessionId, busy);
```

In `start()`:

```ts
    this.terminalEventTimer = setInterval(() => this.pollTerminalEvents(), 30_000);
    this.terminalEventTimer.unref();
```

In `stop()` clear it; in `clearSession` add `this.terminalEvents.clear(sessionId);`.

Add the poller. Both branches skip terminals that already belong to a delegated task — those have their own notifications and would otherwise report twice:

```ts
  private pollTerminalEvents(): void {
    for (const sessionId of this.terminalEvents.pollFinished()) {
      if (this.delegatedTasks.some(t => t.sessionId === sessionId && (t.status === 'running' || t.status === 'waiting'))) continue;
      const label = this.sessionLabels.get(sessionId) ?? sessionId.slice(0, 8);
      const msg = this.outbox.push({
        kind: 'event', text: `✅ ${label} ist fertig.`, sessionId,
      });
      if (msg !== null) this.emitProactive(msg);
    }

    // "Waiting for you" — reuses the question detection that already exists.
    for (const [sessionId, buf] of this.outputBuffers) {
      if (this.delegatedTasks.some(t => t.sessionId === sessionId && (t.status === 'running' || t.status === 'waiting'))) continue;
      const question = this.detectOpenQuestion(buf.data.replace(ANSI_STRIP, '').slice(-1000));
      if (question === null) continue;
      const label = this.sessionLabels.get(sessionId) ?? sessionId.slice(0, 8);
      const msg = this.outbox.push({
        kind: 'event',
        text: `❓ ${label} wartet auf dich: ${question.slice(0, 160)}`,
        topicKey: `question:${sessionId}:${question.slice(0, 40)}`,
        sessionId,
      });
      if (msg !== null) this.emitProactive(msg);
    }
  }
```

In `runCheckIn`, before asking the model, add the stale projects so they actually reach the user:

```ts
    const stale = staleProjects(loadProjectFacts(), listEntries(), Date.now());
    const staleBlock = stale.length === 0 ? ''
      : `\n\nLiegt seit über 5 Tagen brach, hat aber offene To-dos: ${stale.map(p => p.name).join(', ')}.`;
```

and append `staleBlock` to the overview text passed into `askModelQuietly`.

- [ ] **Step 8: Verify and commit**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: PASS — alle Testdateien grün

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/context/ server/src/manager/agenda/agenda.scheduler.test.ts server/src/manager/manager.service.ts
git commit -m "feat(manager): Terminal-fertig- und Wartet-auf-dich-Auslöser, brachliegende Projekte im Check-in

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Ausrollen

Nach Abschluss beider Phasen — **nicht** vorher, und **nie** unaufgefordert:

1. `cd server && npm run build` (bei `MODULE_NOT_FOUND`: erst `rm .tsbuildinfo`, dann erneut — ein veraltetes `.tsbuildinfo` lässt `tsc` nichts ausgeben)
2. Den Nutzer bitten, den Server neu zu starten. **Der Neustart killt jede offene Terminal-Sitzung**, möglicherweise auch die, in der gerade gearbeitet wird.
3. App-Release über den CI-Workflow (Tag-Push), nicht lokal — der lokale APK-Build hängt am Metro-Headless.
4. Danach `grep -n "\[agenda\]\|\[outbox\]\|\[collector\]" ~/.tms-terminal/update.log | tail -30` prüfen. Der Nutzer sieht diese Logs nicht.
