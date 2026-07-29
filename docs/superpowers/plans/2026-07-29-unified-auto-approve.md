# Einheitliches Auto-Approve — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-Approve erkennt Berechtigungs-Prompts aller AI-Harnesse zuverlässig auf dem echten Bildschirm, beantwortet sie auch bei geschlossener App, und meldet Umfragen stattdessen per Push mit Sprung ins betroffene Terminal.

**Architecture:** Die Prompt-Erkennung wechselt vom ANSI-gestrippten Byte-Strom auf den bereits vorhandenen Spiegel-Emulator (`SessionMirror`, `@xterm/headless`), der pro Session mitläuft. Ein neuer, reiner Klassifikator liest die gerenderten Bildschirmzeilen plus Cursorposition; ein neuer Beobachter bewertet nach jedem Datenpaket und danach im 500-ms-Takt weiter, solange ein Prompt wartet. Der alte Byte-Weg bleibt als Rückfall, wenn kein Spiegel existiert.

**Tech Stack:** TypeScript, Node 20, `node --test` mit `ts-node/register`, `@xterm/headless` 6, `node-pty`, React Native (Expo), Firebase Cloud Messaging.

**Spec:** `docs/superpowers/specs/2026-07-29-unified-auto-approve-design.md`

## Global Constraints

- Arbeitsverzeichnis Server + App: `~/Desktop/tms-terminal`, Branch `feat/manager-chat-redesign`. Der Branch bewegt sich durch parallele Jobs — vor jedem Commit `git pull --ff-only` versuchen.
- Die Mockup-Quelle für die Season-2-Oberfläche liegt in einem ANDEREN Verzeichnis: `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html`. Nur dort wird die Seite bearbeitet, nie `liquidDeckHtml.ts` direkt. Nach jeder Mockup-Änderung `cd mobile && npm run build:season2` und die erzeugte `liquidDeckHtml.ts` mitcommitten.
- Server-Tests laufen mit `cd server && npm test` (Glob: `src/**/*.test.ts`). Neue Testdateien müssen deshalb unter `server/src/` liegen, auch wenn ihre Fixtures woanders liegen.
- Server-Build: `cd server && rm -f .tsbuildinfo && npx tsc`. Das Löschen ist Pflicht — eine veraltete `.tsbuildinfo` lässt `tsc` nichts erzeugen und der Start scheitert mit `MODULE_NOT_FOUND`.
- UI-Texte auf Deutsch, Code-Bezeichner und Kommentare auf Englisch (Kommentare in bestehenden deutschsprachigen Dateien dürfen deutsch bleiben).
- Auto-Approve drückt ausschließlich Enter auf die vorausgewählte erste Option. Es wird nie eine andere Option angesteuert, nie eine „immer erlauben"-Option gewählt.
- Push-Benachrichtigungen gibt es NUR für Umfragen (`kind: 'question'`), nie für Berechtigungen.
- Der Server-Neustart am Ende wird NICHT vom Umsetzenden ausgeführt — er beendet die Sitzung, die den Umbau macht. Er steht als letzter Schritt im Plan und wird dem Nutzer übergeben.

---

## Dateien

**Neu (Server):**
- `server/src/notifications/prompt.classifier.ts` — reiner Klassifikator: Bildschirm rein, Prompt-Klasse raus. Keine Seiteneffekte, kein Zustand.
- `server/src/notifications/prompt.classifier.test.ts` — Unit-Tests mit handgeschriebenen Bildschirmen.
- `server/src/notifications/prompt.watcher.ts` — `ScreenPromptWatcher`: Entprellung, Wiederholungstakt, Dedup über Prompt-Fingerabdruck.
- `server/src/notifications/prompt.watcher.test.ts` — Tests mit gefälschter Uhr und gefälschtem `getScreen`.
- `server/src/notifications/prompt.replay.test.ts` — spielt aufgezeichnete PTY-Ströme durch einen echten `SessionMirror` und prüft die Klasse.
- `server/src/websocket/auto.approve.state.ts` — der Auto-Approve-Schalter pro Session als eigenes Modul (damit Snapshotter und Restore ihn ohne Zyklus über `ws.handler` erreichen).
- `server/tools/capture-harness.js` — Aufnahmewerkzeug für den Fixture-Korpus.
- `server/test/fixtures/harness/*.jsonl` + `server/test/fixtures/harness/manifest.json` — der Korpus.

**Geändert (Server):**
- `server/src/terminal/emulator.mirror.ts` — `ScreenView` + `screen()`.
- `server/src/terminal/terminal.manager.ts` — `getScreen(sessionId)`.
- `server/src/notifications/prompt.detector.ts` — Callback bekommt `reason`, damit der Handler Prompt von „KI fertig" unterscheiden kann.
- `server/src/websocket/approval.util.ts` — `evaluateGate({key, …})` ergänzen; Bestehendes unangetastet.
- `server/src/websocket/ws.handler.ts` — Beobachter verdrahten, Push für Umfragen, Zustandsmodul benutzen.
- `server/src/terminal/restore/snapshot.types.ts`, `snapshotter.ts`, `restore.ts`, `server/src/index.ts` — Schalter überlebt Neustart.
- `shared/protocol.ts` — `terminal:prompt_detected` bekommt `kind`.

**Geändert (App):**
- `mobile/src/services/notifications.service.ts` — Tap auf eine Umfrage-Meldung merkt sich die Session.
- `mobile/src/season2/SeasonTwoWebRoot.tsx` — verbraucht die gemerkte Session, benutzt `kind` vom Server statt eigener Rateerei.
- `mobile/src/season2/web/bridge.js` — `focusSession`.
- `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` — `focusTerminal` als Global freigeben.

---

## Task 1: Bildschirm aus dem Spiegel lesen

**Files:**
- Modify: `server/src/terminal/emulator.mirror.ts`
- Modify: `server/src/terminal/terminal.manager.ts`
- Test: `server/src/terminal/emulator.mirror.test.ts`

**Interfaces:**
- Produces: `ScreenView` (`{ rows: string[]; cursorX: number; cursorY: number; cols: number }`), `SessionMirror.screen(): ScreenView`, `TerminalManager.getScreen(sessionId: string): Promise<ScreenView | null>`

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

An `server/src/terminal/emulator.mirror.test.ts` anhängen:

```ts
test('screen() liefert die sichtbaren Zeilen und die Cursorposition', async () => {
  const m = new SessionMirror(20, 5);
  // Zeile 1 schreiben, dann Cursor hoch + rechts bewegen — genau das, was eine
  // TUI beim Neuzeichnen tut und was im Byte-Strom unsichtbar wird.
  m.feed('Hallo\r\nWelt\r\n');
  m.feed('\x1b[2A\x1b[3C');
  await m.flushed();

  const s = m.screen();
  assert.equal(s.cols, 20);
  assert.equal(s.rows.length, 5);
  assert.equal(s.rows[0], 'Hallo');
  assert.equal(s.rows[1], 'Welt');
  assert.equal(s.rows[2], '');
  assert.equal(s.cursorY, 0, 'zwei Zeilen hoch von Zeile 2');
  assert.equal(s.cursorX, 3);
});

test('screen() macht Cursor-Vorwärtssprünge als echte Leerzeichen sichtbar', async () => {
  const m = new SessionMirror(20, 3);
  // Harnesse malen Abstände als Cursorbewegung statt als Leerzeichen.
  m.feed('1.\x1b[1CYes');
  await m.flushed();
  assert.equal(m.screen().rows[0], '1. Yes');
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd ~/Desktop/tms-terminal/server && npm test 2>&1 | grep -A 3 "screen()"`
Expected: FAIL — `m.screen is not a function`

- [ ] **Step 3: `ScreenView` und `screen()` ergänzen**

In `server/src/terminal/emulator.mirror.ts` oberhalb der Klasse:

```ts
/** Der WAHRE Bildschirm einer Session: was ein Mensch sähe, nicht was durch
 *  die Leitung kam. Die Prompt-Erkennung arbeitet ausschließlich hierauf. */
export interface ScreenView {
  /** Sichtbare Zeilen, oben nach unten. Nachlaufende Leerzeichen entfernt. */
  rows: string[];
  cursorX: number;
  /** Index in `rows` — nicht im Scrollback. */
  cursorY: number;
  cols: number;
}
```

Als Methode in `SessionMirror`, direkt nach `serializeNow()`:

```ts
  /**
   * Der sichtbare Bildschirm als Text. Synchron — wie `serializeNow()` direkt
   * nach `flushed()` aufrufen, sonst fehlen noch nicht verarbeitete Bytes.
   */
  screen(): ScreenView {
    const buf = this.term.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      rows.push(line ? line.translateToString(true) : '');
    }
    return { rows, cursorX: buf.cursorX, cursorY: buf.cursorY, cols: this.term.cols };
  }
```

- [ ] **Step 4: `getScreen` im Manager ergänzen**

In `server/src/terminal/terminal.manager.ts` — Import erweitern:

```ts
import { SessionMirror, type ScreenView } from './emulator.mirror';
```

Als öffentliche Methode der Klasse (neben `getAttachGen`):

```ts
  /**
   * Der echte Bildschirm einer Session, nachdem der Spiegel alle bisherigen
   * Bytes verarbeitet hat. `null`, wenn kein Spiegel existiert (dann läuft die
   * Prompt-Erkennung auf dem alten Byte-Weg weiter).
   */
  async getScreen(sessionId: string): Promise<ScreenView | null> {
    const mirror = this.mirrors.get(sessionId);
    if (!mirror) return null;
    await mirror.flushed();
    return mirror.screen();
  }
```

- [ ] **Step 5: Tests laufen lassen**

Run: `cd ~/Desktop/tms-terminal/server && npm test`
Expected: PASS, keine bestehenden Tests kaputt

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/terminal/emulator.mirror.ts server/src/terminal/emulator.mirror.test.ts server/src/terminal/terminal.manager.ts
git commit -m "feat(server): Spiegel liefert den sichtbaren Bildschirm (ScreenView)"
```

---

## Task 2: Klassifikator

**Files:**
- Create: `server/src/notifications/prompt.classifier.ts`
- Test: `server/src/notifications/prompt.classifier.test.ts`

**Interfaces:**
- Consumes: `ScreenView` aus Task 1
- Produces:
  - `interface PromptOption { n: number | null; selected: boolean; text: string }`
  - `interface PromptClass { kind: 'permission' | 'confirm' | 'question' | 'none'; key: string | null; question: string; options: PromptOption[] }`
  - `classifyScreen(screen: ScreenView): PromptClass`
  - `promptFingerprint(cls: PromptClass): string`
  - `parseOption(line: string): PromptOption | null`
  - `findOptionBlock(rows: string[]): { options: PromptOption[]; startY: number; endY: number } | null`

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

`server/src/notifications/prompt.classifier.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { classifyScreen, promptFingerprint, type PromptClass } from './prompt.classifier';
import type { ScreenView } from '../terminal/emulator.mirror';

/** Baut einen Bildschirm aus Zeilen. cursorY zeigt standardmäßig auf die letzte Zeile. */
function screen(rows: string[], cursorY = rows.length - 1, cursorX = 0): ScreenView {
  return { rows, cursorX, cursorY, cols: 40 };
}

// Aufgezeichnet aus einer echten Sitzung bei 40 Spalten (siehe Spec).
const CLAUDE_PERMISSION = [
  '  Read(/etc/hosts · lines 1-1)',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, allow reading from etc/',
  '      during this session',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
];

test('Claude-Berechtigungsbox → permission, Enter', () => {
  const cls = classifyScreen(screen(CLAUDE_PERMISSION, 3, 1));
  assert.equal(cls.kind, 'permission');
  assert.equal(cls.key, '\r');
  assert.equal(cls.question, 'Do you want to proceed?');
  assert.equal(cls.options.length, 3);
  assert.equal(cls.options[0].text, 'Yes');
});

test('Codex-Berechtigung (Allow-Formulierung) → permission', () => {
  const cls = classifyScreen(screen([
    ' Codex wants to run `npm test`',
    '',
    ' ❯ 1. Allow this request and continue',
    '   2. Allow for this session',
    '   3. Cancel this tool call',
    '',
    ' esc to cancel',
  ], 2, 1));
  assert.equal(cls.kind, 'permission');
  assert.equal(cls.key, '\r');
});

test('Gemini-Radioliste ohne Nummern → permission', () => {
  const cls = classifyScreen(screen([
    ' Allow execution of `rm -rf build`?',
    '',
    ' ● Yes, allow once',
    ' ○ Yes, allow always',
    ' ○ No, suggest changes (esc)',
  ], 2, 1));
  assert.equal(cls.kind, 'permission');
  assert.equal(cls.key, '\r');
});

test('Auswahlfrage mit inhaltlichen Antworten → question, keine Taste', () => {
  const cls = classifyScreen(screen([
    ' Welchen Ansatz sollen wir nehmen?',
    ' ❯ 1. Redis als Cache',
    '   2. In-Memory-Map',
    '   3. Gar kein Cache',
    '',
    ' Esc to cancel',
  ], 1, 1));
  assert.equal(cls.kind, 'question');
  assert.equal(cls.key, null);
  assert.equal(cls.question, 'Welchen Ansatz sollen wir nehmen?');
});

test('Formular-Umfrage schlägt die Ja-Option → question', () => {
  // Codex-Formular: die erste Option ist zwar ja-artig, aber es ist ein
  // mehrteiliges Formular. Der Formularhinweis gewinnt immer.
  const cls = classifyScreen(screen([
    ' Question requested',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Answer required fields before submitting.',
  ], 1, 1));
  assert.equal(cls.kind, 'question');
  assert.equal(cls.key, null);
});

test('Nummerierte Aufzählung im Fließtext ist kein Prompt', () => {
  const cls = classifyScreen(screen([
    'Ich habe drei Dinge geändert:',
    '1. Yes-Pfad korrigiert',
    '2. Test ergänzt',
    '3. Doku aktualisiert',
    '',
    '❯ ',
  ], 5, 2));
  assert.equal(cls.kind, 'none');
});

test('Eingabezeile unten, nichts wartet', () => {
  const cls = classifyScreen(screen([
    '  Fertig.',
    '',
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────',
  ], 3, 2));
  assert.equal(cls.kind, 'none');
});

test('[y/N] am Zeilenende mit Cursor dahinter → confirm mit y', () => {
  const cls = classifyScreen(screen([
    'Überschreiben? [y/N] ',
  ], 0, 21));
  assert.equal(cls.kind, 'confirm');
  assert.equal(cls.key, 'y\r');
});

test('[Y/n] am Zeilenende → confirm mit Enter', () => {
  const cls = classifyScreen(screen([
    'Fortfahren? [Y/n] ',
  ], 0, 18));
  assert.equal(cls.kind, 'confirm');
  assert.equal(cls.key, '\r');
});

test('Ja/Nein-Muster mitten im Fließtext ist kein Prompt', () => {
  const cls = classifyScreen(screen([
    'Das Skript fragt am Ende mit [y/N] nach.',
    'Ich habe es angepasst.',
    '',
    '❯ ',
  ], 3, 2));
  assert.equal(cls.kind, 'none');
});

test('Task-Liste unter der Box verdeckt den Prompt nicht', () => {
  const cls = classifyScreen(screen([
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel',
    ' 15 tasks (8 done, 2 in progress)',
    ' ■ Detektor umbauen',
    ' □ Tests ergänzen',
  ], 1, 1));
  assert.equal(cls.kind, 'permission');
});

test('Fingerabdruck bleibt gleich, wenn nur die Auswahl wandert', () => {
  const a = classifyScreen(screen(CLAUDE_PERMISSION, 3, 1));
  const moved = [...CLAUDE_PERMISSION];
  moved[3] = '   1. Yes';
  moved[4] = ' ❯ 2. Yes, allow reading from etc/';
  const b = classifyScreen(screen(moved, 4, 1));
  assert.equal(promptFingerprint(a), promptFingerprint(b));
});

test('Fingerabdruck ändert sich bei einer anderen Frage', () => {
  const a = classifyScreen(screen(CLAUDE_PERMISSION, 3, 1));
  const other = [...CLAUDE_PERMISSION];
  other[0] = '  Bash(rm -rf build)';
  other[2] = ' Do you want to run this command?';
  const b = classifyScreen(screen(other, 3, 1));
  assert.notEqual(promptFingerprint(a), promptFingerprint(b));
});

test('leerer Bildschirm → none', () => {
  assert.equal(classifyScreen(screen(['', '', ''], 0, 0)).kind, 'none');
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd ~/Desktop/tms-terminal/server && npm test 2>&1 | head -20`
Expected: FAIL — `Cannot find module './prompt.classifier'`

- [ ] **Step 3: Den Klassifikator schreiben**

`server/src/notifications/prompt.classifier.ts`:

```ts
/**
 * Erkennt auf dem GERENDERTEN Bildschirm, ob ein Prompt wartet und welcher Art.
 *
 * Warum auf dem Bildschirm und nicht auf dem Byte-Strom: TUIs zeichnen mit
 * Cursorbewegungen neu. Entfernt man daraus die Steuerzeichen, bleiben falsch
 * geschnittene Zeilen, verschluckte Leerzeichen und Hunderte Geisterzeilen
 * übrig — die erste Option klebte dort an der Frage und war für jeden Parser
 * unsichtbar. Der Emulator führt die Bewegungen aus; danach ist der Bildschirm
 * schlicht Text in Zeilen, bei jedem Harness gleich.
 *
 * Rein und ohne Zustand — der ganze Zeitablauf steckt in prompt.watcher.ts.
 */
import type { ScreenView } from '../terminal/emulator.mirror';

export interface PromptOption {
  /** Nummer bei nummerierten Listen, sonst null (Radiolisten wie Gemini). */
  n: number | null;
  /** Auswahlmarke davor (❯) oder gefüllter Radiopunkt. */
  selected: boolean;
  text: string;
}

export interface PromptClass {
  kind: 'permission' | 'confirm' | 'question' | 'none';
  /** Die Taste, die zustimmt. `null` heißt: NIE automatisch drücken. */
  key: string | null;
  question: string;
  options: PromptOption[];
}

const NONE: PromptClass = { kind: 'none', key: null, question: '', options: [] };

/** So weit über dem letzten Inhalt wird nach dem Optionsblock gesucht. */
const TAIL_SCAN = 16;

/** Nur eine echte Box zeichnet so etwas — eine KI schreibt es nicht im Fließtext. */
const CHROME_RE = /(esc\s+to\s+cancel|use\s+arrow\s+keys|enter\s+to\s+(confirm|accept|continue|select)|tab\s+to\s+amend|↑↓|press\s+enter\s+to)/i;

/** Formular-/Mehrfachauswahl-Hinweise. Schlagen jede Ja-Erkennung. */
const FORM_RE = /(answer\s+required\s+fields|type\s+your\s+answer|question\s+\d+\s+of\s+\d+|frage\s+\d+\s+von\s+\d+|select\s+all\s+that\s+apply|mehrfachauswahl)/i;

/** Belegt aus den installierten Harnessen: Claude „Yes", Codex „Allow this
 *  request and continue", Gemini „Yes, allow once". */
const AFFIRMATIVE_RE = /^(yes|ja|allow|approve|proceed|continue|run|accept)\b/i;

const YN_DEFAULT_NO  = /\[y\/N\]\s*:?\s*$/;   // Vorgabe Nein → 'y' nötig
const YN_DEFAULT_YES = /\[Y\/n\]\s*:?\s*$/;   // Vorgabe Ja  → Enter genügt
const YN_NEUTRAL     = /\((y\/n|yes\/no)\)\s*:?\s*$/i;

const OPTION_RE = /^\s*(❯|▶|›|>)?\s*(?:([1-9])[.)]\s*)?([●◉○◯])?\s*(\S.*)$/;
const DIVIDER_RE = /^[─━═╌\-_]{3,}$/;

/** Eine Zeile ist nur dann eine Option, wenn sie nummeriert ist ODER einen
 *  Radiopunkt trägt. Sonst wäre jede Textzeile eine Option. */
export function parseOption(line: string): PromptOption | null {
  const m = OPTION_RE.exec(line);
  if (!m) return null;
  const [, mark, num, radio, text] = m;
  if (!num && !radio) return null;
  return {
    n: num ? Number(num) : null,
    selected: !!mark || radio === '●' || radio === '◉',
    text: text.trim(),
  };
}

/**
 * Der LETZTE Optionsblock auf dem Bildschirm. Bewusst der letzte: eine
 * nummerierte Aufzählung weiter oben im Fließtext der KI ist keine Box.
 */
export function findOptionBlock(
  rows: string[],
): { options: PromptOption[]; startY: number; endY: number } | null {
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === '') last--;
  if (last < 0) return null;

  // Vom Ende nach oben durch Fußzeile und Status-Chrome bis zur ersten Option.
  let y = last;
  let scanned = 0;
  while (y >= 0 && scanned < TAIL_SCAN && parseOption(rows[y]) === null) { y--; scanned++; }
  if (y < 0 || parseOption(rows[y]) === null) return null;

  const endY = y;
  const options: PromptOption[] = [];
  while (y >= 0) {
    const opt = parseOption(rows[y]);
    if (opt) { options.unshift(opt); y--; continue; }
    // Umbrochene Fortsetzung einer Option („during this session").
    if (options.length > 0 && /^\s{3,}\S/.test(rows[y])) { y--; continue; }
    break;
  }
  return { options, startY: y + 1, endY };
}

/** Die nächste sinnvolle Zeile über dem Block — der Fragetext. */
function questionAbove(rows: string[], startY: number): string {
  for (let y = startY - 1; y >= 0 && y >= startY - 6; y--) {
    const t = rows[y].trim();
    if (!t) continue;
    if (CHROME_RE.test(t)) continue;
    if (DIVIDER_RE.test(t)) continue;
    return t.slice(0, 160);
  }
  return '';
}

export function classifyScreen(screen: ScreenView): PromptClass {
  const rows = screen.rows;
  const tail = rows.slice(-TAIL_SCAN).join('\n');

  const block = findOptionBlock(rows);
  if (block !== null && block.options.length >= 2) {
    // Nummerierte Listen müssen bei 1 beginnen und lückenlos aufsteigen —
    // sonst ist es Prosa, die zufällig mit Ziffern anfängt.
    const numbered = block.options.filter((o) => o.n !== null);
    const wellFormed = numbered.length === 0
      || (numbered[0].n === 1 && numbered.every((o, i) => o.n === i + 1));

    const cursorInBlock = screen.cursorY >= block.startY && screen.cursorY <= block.endY;
    const hasChrome = block.options.some((o) => o.selected)
      || CHROME_RE.test(tail)
      || cursorInBlock;

    if (wellFormed && hasChrome) {
      const question = questionAbove(rows, block.startY);
      if (FORM_RE.test(tail)) {
        return { kind: 'question', key: null, question, options: block.options };
      }
      const first = block.options[0];
      const affirmative = AFFIRMATIVE_RE.test(first.text)
        // ANSI-geklebte Reste („Yes,andalwaysallow…") haben kein Wortende.
        || /^(yes|ja|allow|approve)[,A-Z]/i.test(first.text);
      return affirmative
        ? { kind: 'permission', key: '\r', question, options: block.options }
        : { kind: 'question', key: null, question, options: block.options };
    }
  }

  if (FORM_RE.test(tail)) {
    return { kind: 'question', key: null, question: questionAbove(rows, rows.length), options: [] };
  }

  // Klassisches Ja/Nein: nur wenn der Cursor auf genau dieser Zeile blinkt.
  // Steht das Muster mitten im Text, wartet nichts.
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === '') last--;
  if (last >= 0 && screen.cursorY === last) {
    const line = rows[last];
    const q = line.trim().slice(0, 160);
    if (YN_DEFAULT_NO.test(line))  return { kind: 'confirm', key: 'y\r', question: q, options: [] };
    if (YN_DEFAULT_YES.test(line)) return { kind: 'confirm', key: '\r',  question: q, options: [] };
    if (YN_NEUTRAL.test(line))     return { kind: 'confirm', key: 'y\r', question: q, options: [] };
  }

  return NONE;
}

/**
 * Kennzeichen des wartenden Prompts — bewusst OHNE die Auswahlmarke und ohne
 * tickende Statuszeilen. Bleibt stabil, solange dieselbe Frage wartet, und
 * ändert sich, sobald es eine andere ist. Grundlage für Entprellung, für den
 * Abbruch der Wiederholungskette und für „ein Push je Frage".
 */
export function promptFingerprint(cls: PromptClass): string {
  if (cls.kind === 'none') return '';
  const s = `${cls.kind}|${cls.question}|${cls.options.map((o) => o.text).join('|')}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}
```

- [ ] **Step 4: Tests laufen lassen**

Run: `cd ~/Desktop/tms-terminal/server && npm test 2>&1 | tail -20`
Expected: PASS, alle 14 neuen Tests grün

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/notifications/prompt.classifier.ts server/src/notifications/prompt.classifier.test.ts
git commit -m "feat(server): harness-unabhaengiger Prompt-Klassifikator auf Bildschirmzeilen"
```

---

## Task 3: Aufnahmewerkzeug und Fixture-Korpus

**Files:**
- Create: `server/tools/capture-harness.js`
- Create: `server/test/fixtures/harness/manifest.json`
- Create: `server/test/fixtures/harness/*.jsonl`
- Test: `server/src/notifications/prompt.replay.test.ts`

**Interfaces:**
- Consumes: `classifyScreen` aus Task 2, `SessionMirror` aus Task 1
- Produces: Fixture-Format `{"t": <ms>, "d": "<base64>"}` je Zeile; `manifest.json` als `Array<{ file: string; cols: number; expect: 'permission' | 'confirm' | 'question' | 'none'; note: string }>`

- [ ] **Step 1: Das Aufnahmewerkzeug schreiben**

`server/tools/capture-harness.js`:

```js
#!/usr/bin/env node
/**
 * Zeichnet den ROHEN PTY-Byte-Strom eines AI-Harness auf, während es einen
 * Prompt zeigt. Ergebnis ist eine JSONL-Datei ({t, d-base64}), die im Test
 * durch einen echten Terminal-Emulator gespielt wird.
 *
 * Ohne diese Aufnahmen bleibt jede Prompt-Erkennung Behauptung: die Harnesse
 * malen ihre Boxen sehr unterschiedlich, und neue Versionen ändern das.
 *
 *   node tools/capture-harness.js <out.jsonl> <cols> <totalMs> <cmd> [args...]
 *
 * Eingaben werden zeitgesteuert über die Umgebungsvariable STEPS geschickt:
 *   STEPS='[{"at":9000,"in":"Lies /etc/hosts"},{"at":10500,"in":"\r"}]'
 * CAPTURE_CWD setzt das Arbeitsverzeichnis der Aufnahme.
 */
const pty = require('node-pty');
const fs = require('fs');

const [outfile, colsArg, totalArg, cmd, ...args] = process.argv.slice(2);
if (!outfile || !cmd) {
  console.error('Aufruf: node tools/capture-harness.js <out.jsonl> <cols> <totalMs> <cmd> [args...]');
  process.exit(2);
}
const cols = Number(colsArg) || 40;
const totalMs = Number(totalArg) || 40000;
const steps = JSON.parse(process.env.STEPS || '[]');

const start = Date.now();
const out = fs.createWriteStream(outfile);

const term = pty.spawn(cmd, args, {
  name: 'xterm-256color',
  cols,
  rows: 30,
  cwd: process.env.CAPTURE_CWD || process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color', CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' },
});

term.onData((d) => {
  out.write(JSON.stringify({ t: Date.now() - start, d: Buffer.from(d, 'utf8').toString('base64') }) + '\n');
});

for (const s of steps) setTimeout(() => { try { term.write(s.in); } catch { /* PTY schon tot */ } }, s.at);

setTimeout(() => {
  try { term.kill(); } catch { /* schon beendet */ }
  out.end(() => { console.log(`Aufnahme geschrieben: ${outfile}`); process.exit(0); });
}, totalMs);
```

- [ ] **Step 2: Die vorhandene Claude-Aufnahme übernehmen**

Eine bereits erstellte, echte Aufnahme (Berechtigungsbox bei 40 Spalten) liegt unter
`/private/tmp/claude-501/-Users-ayysir-Desktop-TMS-Terminal/816d8215-18a5-42b0-9318-0f17d6b6e8dc/scratchpad/claude-perm-40.jsonl`.
Falls die Datei nicht mehr existiert, mit Schritt 3 neu aufnehmen.

```bash
cd ~/Desktop/tms-terminal/server
mkdir -p test/fixtures/harness
SRC=/private/tmp/claude-501/-Users-ayysir-Desktop-TMS-Terminal/816d8215-18a5-42b0-9318-0f17d6b6e8dc/scratchpad/claude-perm-40.jsonl
[ -f "$SRC" ] && cp "$SRC" test/fixtures/harness/claude-permission-40.jsonl && wc -l test/fixtures/harness/claude-permission-40.jsonl
```

- [ ] **Step 3: Weitere Harnesse aufnehmen**

Jede Aufnahme braucht einen Ordner, in dem der Harness schon eingerichtet und
vertrauenswürdig ist, sonst nimmt man nur den Vertrauensdialog auf.

```bash
cd ~/Desktop/tms-terminal/server
mkdir -p /tmp/harness-cap && cd /tmp/harness-cap && echo hello > note.txt
cd ~/Desktop/tms-terminal/server

# Claude Code — Berechtigung (Datei außerhalb des Arbeitsordners lesen)
CAPTURE_CWD=/tmp/harness-cap \
STEPS='[{"at":9000,"in":"Lies /etc/hosts und nenne nur die erste Zeile"},{"at":10500,"in":"\r"}]' \
node tools/capture-harness.js test/fixtures/harness/claude-permission-40.jsonl 40 40000 "$(command -v claude)"

# Codex — Befehlsfreigabe
CAPTURE_CWD=/tmp/harness-cap \
STEPS='[{"at":9000,"in":"Fuehre `ls -la /etc` aus"},{"at":10500,"in":"\r"}]' \
node tools/capture-harness.js test/fixtures/harness/codex-permission-40.jsonl 40 45000 "$(command -v codex)"

# Gemini CLI — Befehlsausfuehrung
CAPTURE_CWD=/tmp/harness-cap \
STEPS='[{"at":9000,"in":"Fuehre `ls -la /etc` aus"},{"at":10500,"in":"\r"}]' \
node tools/capture-harness.js test/fixtures/harness/gemini-permission-40.jsonl 40 45000 "$(command -v gemini)"

# Kimi
CAPTURE_CWD=/tmp/harness-cap \
STEPS='[{"at":10000,"in":"Lies /etc/hosts"},{"at":11500,"in":"\r"}]' \
node tools/capture-harness.js test/fixtures/harness/kimi-permission-40.jsonl 40 45000 "$(command -v kimi)"
```

Jede Aufnahme danach sichten, bevor sie ins Manifest kommt:

```bash
cd ~/Desktop/tms-terminal/server
node -e '
const {Terminal}=require("@xterm/headless");const fs=require("fs");
const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const t=new Terminal({cols:Number(process.argv[2]),rows:30,scrollback:1500,allowProposedApi:true});
for(const r of rows) t.write(Buffer.from(r.d,"base64").toString("utf8"));
t.write("",()=>{const b=t.buffer.active;for(let y=0;y<t.rows;y++){const l=b.getLine(b.viewportY+y);console.log(String(y).padStart(2)+" | "+(l?l.translateToString(true):""));}console.log("cursor",b.cursorX,b.cursorY);process.exit(0);});
' test/fixtures/harness/codex-permission-40.jsonl 40
```

Zeigt die Ausgabe keine wartende Box (z. B. weil der Harness nicht eingeloggt
war oder zu lange gedacht hat), die Aufnahme löschen und mit längerem `totalMs`
wiederholen. **Nur Aufnahmen ins Manifest eintragen, deren Bildschirm man
gesehen hat.** Eine Aufnahme, die sich nicht erzeugen lässt (Harness nicht
eingerichtet), wird ausgelassen und im Commit-Text genannt — der Test läuft
über das Manifest und schlägt deshalb nicht wegen einer fehlenden Datei fehl.

- [ ] **Step 4: Manifest anlegen**

`server/test/fixtures/harness/manifest.json` — nur Einträge für tatsächlich
vorhandene, gesichtete Aufnahmen:

```json
[
  {
    "file": "claude-permission-40.jsonl",
    "cols": 40,
    "expect": "permission",
    "note": "Claude Code, Read ausserhalb des Arbeitsordners, Optionen Yes / Yes-allow / No"
  }
]
```

- [ ] **Step 5: Den Replay-Test schreiben**

`server/src/notifications/prompt.replay.test.ts`:

```ts
/**
 * Spielt echte, aufgezeichnete PTY-Ströme durch einen echten Spiegel und prüft,
 * was der Klassifikator daraus macht. Das ist die einzige Prüfung, die eine
 * neue Harness-Version abfängt, bevor sie am Handy auffällt.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { SessionMirror } from '../terminal/emulator.mirror';
import { classifyScreen } from './prompt.classifier';

const DIR = path.resolve(__dirname, '../../test/fixtures/harness');
const MANIFEST = path.join(DIR, 'manifest.json');

interface Entry { file: string; cols: number; expect: string; note: string }

const entries: Entry[] = fs.existsSync(MANIFEST)
  ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  : [];

test('Fixture-Korpus ist nicht leer', () => {
  assert.ok(entries.length > 0, 'mindestens eine Aufnahme muss im Manifest stehen');
});

for (const entry of entries) {
  test(`Replay: ${entry.file} → ${entry.expect} (${entry.note})`, async () => {
    const file = path.join(DIR, entry.file);
    assert.ok(fs.existsSync(file), `Aufnahme fehlt: ${entry.file}`);

    const mirror = new SessionMirror(entry.cols, 30);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const chunk = JSON.parse(line) as { t: number; d: string };
      mirror.feed(Buffer.from(chunk.d, 'base64').toString('utf8'));
    }
    await mirror.flushed();

    const cls = classifyScreen(mirror.screen());
    assert.equal(cls.kind, entry.expect, `Bildschirm:\n${mirror.screen().rows.join('\n')}`);
    if (entry.expect === 'permission') assert.equal(cls.key, '\r');
    if (entry.expect === 'question') assert.equal(cls.key, null);
    mirror.dispose();
  });
}
```

- [ ] **Step 6: Tests laufen lassen**

Run: `cd ~/Desktop/tms-terminal/server && npm test 2>&1 | grep -E "Replay|Fixture"`
Expected: PASS für jede Aufnahme im Manifest

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/tools/capture-harness.js server/test/fixtures/harness server/src/notifications/prompt.replay.test.ts
git commit -m "test(server): Aufnahmewerkzeug und Harness-Korpus als Regressionstest"
```

---

## Task 4: Der Bildschirm-Beobachter

**Files:**
- Create: `server/src/notifications/prompt.watcher.ts`
- Test: `server/src/notifications/prompt.watcher.test.ts`

**Interfaces:**
- Consumes: `classifyScreen`, `promptFingerprint`, `PromptClass` aus Task 2; `ScreenView` aus Task 1
- Produces:
  - `type ScreenPromptCallback = (cls: PromptClass, attempt: number) => void`
  - `class ScreenPromptWatcher` mit `watch(sessionId, cb)`, `unwatch(sessionId)`, `poke(sessionId)`, `resolved(sessionId)`
  - `interface ScreenPromptWatcherDeps { getScreen(sessionId: string): Promise<ScreenView | null>; setTimeoutFn?; clearTimeoutFn? }`
  - Konstanten `SETTLE_MS = 50`, `RECHECK_MS = 500`, `MAX_RECHECKS = 60`
  - `export const screenPromptWatcher: ScreenPromptWatcher` (Singleton, wie `promptDetector`)

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

`server/src/notifications/prompt.watcher.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { ScreenPromptWatcher, SETTLE_MS, RECHECK_MS } from './prompt.watcher';
import type { ScreenView } from '../terminal/emulator.mirror';
import type { PromptClass } from './prompt.classifier';

/** Steuerbare Uhr: Timer laufen erst, wenn der Test sie vorspult. */
function fakeTimers() {
  let now = 0;
  const pending: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  return {
    setTimeoutFn: (fn: () => void, ms: number) => { const id = nextId++; pending.push({ at: now + ms, fn, id }); return id; },
    clearTimeoutFn: (h: unknown) => { const i = pending.findIndex((p) => p.id === h); if (i >= 0) pending.splice(i, 1); },
    /** Spult vor und lässt fällige Timer laufen; wartet Microtasks ab. */
    async advance(ms: number) {
      now += ms;
      for (;;) {
        const i = pending.findIndex((p) => p.at <= now);
        if (i < 0) break;
        const [t] = pending.splice(i, 1);
        t.fn();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      }
    },
  };
}

const PERMISSION_ROWS = [
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel',
];
const IDLE_ROWS = ['  Fertig.', '', '❯ '];

function view(rows: string[], cursorY: number): ScreenView {
  return { rows, cursorX: 1, cursorY, cols: 40 };
}

test('meldet einen wartenden Prompt nach der Entprellung', async () => {
  const clock = fakeTimers();
  const seen: Array<{ cls: PromptClass; attempt: number }> = [];
  const w = new ScreenPromptWatcher({
    getScreen: async () => view(PERMISSION_ROWS, 1),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (cls, attempt) => seen.push({ cls, attempt }));

  w.poke('s1');
  await clock.advance(SETTLE_MS);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].cls.kind, 'permission');
  assert.equal(seen[0].attempt, 0);
});

test('meldet denselben Prompt immer wieder, bis er gelöst ist', async () => {
  const clock = fakeTimers();
  const seen: number[] = [];
  const w = new ScreenPromptWatcher({
    getScreen: async () => view(PERMISSION_ROWS, 1),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (_cls, attempt) => seen.push(attempt));

  w.poke('s1');
  await clock.advance(SETTLE_MS);
  await clock.advance(RECHECK_MS);
  await clock.advance(RECHECK_MS);

  assert.deepEqual(seen, [0, 1, 2], 'ein wartender Prompt erzeugt keine Ausgabe — ohne Takt bliebe er ewig liegen');
});

test('resolved() stoppt den Takt', async () => {
  const clock = fakeTimers();
  const seen: number[] = [];
  const w = new ScreenPromptWatcher({
    getScreen: async () => view(PERMISSION_ROWS, 1),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (_cls, attempt) => { seen.push(attempt); w.resolved('s1'); });

  w.poke('s1');
  await clock.advance(SETTLE_MS);
  await clock.advance(RECHECK_MS * 3);

  assert.deepEqual(seen, [0]);
});

test('derselbe Prompt darf sich später wiederholen', async () => {
  // Zweimal derselbe Befehl heißt zweimal dieselbe Frage. Würde der gelöste
  // Fingerabdruck nicht zurückgesetzt, sobald der Bildschirm frei ist, bliebe
  // die zweite Frage für immer unbeantwortet.
  const clock = fakeTimers();
  const seen: string[] = [];
  let rows = PERMISSION_ROWS;
  const w = new ScreenPromptWatcher({
    getScreen: async () => view(rows, rows === PERMISSION_ROWS ? 1 : 2),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (cls) => { seen.push(cls.question); w.resolved('s1'); });

  w.poke('s1');
  await clock.advance(SETTLE_MS);

  rows = IDLE_ROWS;              // beantwortet, Box weg
  w.poke('s1');
  await clock.advance(SETTLE_MS);

  rows = PERMISSION_ROWS;        // exakt dieselbe Frage kommt erneut
  w.poke('s1');
  await clock.advance(SETTLE_MS);

  assert.deepEqual(seen, ['Do you want to proceed?', 'Do you want to proceed?']);
});

test('verschwundener Prompt beendet den Takt', async () => {
  const clock = fakeTimers();
  const seen: number[] = [];
  let rows = PERMISSION_ROWS;
  const w = new ScreenPromptWatcher({
    getScreen: async () => view(rows, rows === PERMISSION_ROWS ? 1 : 2),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (_cls, attempt) => seen.push(attempt));

  w.poke('s1');
  await clock.advance(SETTLE_MS);
  rows = IDLE_ROWS;                 // Box beantwortet, Bildschirm leer
  await clock.advance(RECHECK_MS);
  await clock.advance(RECHECK_MS);

  assert.deepEqual(seen, [0]);
});

test('ein NEUER Prompt startet wieder bei attempt 0', async () => {
  const clock = fakeTimers();
  const seen: Array<{ q: string; attempt: number }> = [];
  let rows = PERMISSION_ROWS;
  const w = new ScreenPromptWatcher({
    getScreen: async () => view(rows, 1),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (cls, attempt) => { seen.push({ q: cls.question, attempt }); w.resolved('s1'); });

  w.poke('s1');
  await clock.advance(SETTLE_MS);

  rows = [' Do you want to run this command?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'];
  w.poke('s1');
  await clock.advance(SETTLE_MS);

  assert.equal(seen.length, 2);
  assert.equal(seen[1].attempt, 0);
  assert.equal(seen[1].q, 'Do you want to run this command?');
});

test('Umfragen bekommen keinen Wiederholungstakt', async () => {
  const clock = fakeTimers();
  const seen: number[] = [];
  const w = new ScreenPromptWatcher({
    getScreen: async () => view([
      ' Welchen Ansatz nehmen wir?',
      ' ❯ 1. Redis',
      '   2. In-Memory',
      '',
      ' Esc to cancel',
    ], 1),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (_cls, attempt) => seen.push(attempt));

  w.poke('s1');
  await clock.advance(SETTLE_MS);
  await clock.advance(RECHECK_MS * 3);

  assert.deepEqual(seen, [0], 'bei einer Umfrage gibt es nichts zu wiederholen — sie wird nie automatisch beantwortet');
});

test('ohne Spiegel passiert nichts', async () => {
  const clock = fakeTimers();
  const seen: number[] = [];
  const w = new ScreenPromptWatcher({
    getScreen: async () => null,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (_cls, attempt) => seen.push(attempt));

  w.poke('s1');
  await clock.advance(SETTLE_MS + RECHECK_MS);

  assert.deepEqual(seen, []);
});

test('unwatch räumt auf', async () => {
  const clock = fakeTimers();
  const seen: number[] = [];
  const w = new ScreenPromptWatcher({
    getScreen: async () => view(PERMISSION_ROWS, 1),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (_cls, attempt) => seen.push(attempt));
  w.poke('s1');
  w.unwatch('s1');
  await clock.advance(SETTLE_MS + RECHECK_MS * 2);
  assert.deepEqual(seen, []);
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd ~/Desktop/tms-terminal/server && npm test 2>&1 | head -20`
Expected: FAIL — `Cannot find module './prompt.watcher'`

- [ ] **Step 3: Den Beobachter schreiben**

`server/src/notifications/prompt.watcher.ts`:

```ts
/**
 * Beobachtet den Bildschirm einer Session und meldet wartende Prompts.
 *
 * Warum ein Takt und nicht nur eine Flanke: ein wartender Prompt erzeugt KEINE
 * weitere Ausgabe. Die alte, rein ereignisgesteuerte Erkennung feuerte deshalb
 * genau einmal — und wenn dieser eine Moment ungünstig lag (der Nutzer tippte
 * gerade, oder die Box war erst halb gezeichnet), war die Bestätigung für immer
 * verloren und das Terminal stand still. Solange also ein beantwortbarer Prompt
 * sichtbar ist, wird er im Takt erneut gemeldet, bis er gelöst ist oder
 * verschwindet.
 */
import type { ScreenView } from '../terminal/emulator.mirror';
import { classifyScreen, promptFingerprint, type PromptClass } from './prompt.classifier';

/** Entprellung nach einem Datenpaket — mehrere Frames werden zu einer Prüfung. */
export const SETTLE_MS = 50;
/** Abstand der Wiederholungen, solange ein beantwortbarer Prompt wartet. */
export const RECHECK_MS = 500;
/** Danach wird aufgegeben (~30 s). */
export const MAX_RECHECKS = 60;

export type ScreenPromptCallback = (cls: PromptClass, attempt: number) => void;

export interface ScreenPromptWatcherDeps {
  /** Liefert den echten Bildschirm oder null, wenn es keinen Spiegel gibt. */
  getScreen: (sessionId: string) => Promise<ScreenView | null>;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

interface SessionState {
  cb: ScreenPromptCallback;
  settleTimer: unknown | null;
  recheckTimer: unknown | null;
  /** Fingerabdruck des zuletzt gemeldeten Prompts. */
  activeFp: string;
  /** Fingerabdruck des zuletzt gelösten Prompts — der wird nicht neu gemeldet. */
  resolvedFp: string;
  attempt: number;
}

export class ScreenPromptWatcher {
  private sessions = new Map<string, SessionState>();
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (handle: unknown) => void;

  constructor(private deps: ScreenPromptWatcherDeps) {
    this.setT = deps.setTimeoutFn ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; });
    this.clearT = deps.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  watch(sessionId: string, cb: ScreenPromptCallback): void {
    const prev = this.sessions.get(sessionId);
    if (prev) { prev.cb = cb; return; }   // Reattach: Zustand behalten, nur neu verdrahten
    this.sessions.set(sessionId, {
      cb, settleTimer: null, recheckTimer: null, activeFp: '', resolvedFp: '', attempt: 0,
    });
  }

  unwatch(sessionId: string): void {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    if (st.settleTimer !== null) this.clearT(st.settleTimer);
    if (st.recheckTimer !== null) this.clearT(st.recheckTimer);
    this.sessions.delete(sessionId);
  }

  /** Nach jedem PTY-Paket aufrufen. Entprellt selbst. */
  poke(sessionId: string): void {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    if (st.settleTimer !== null) this.clearT(st.settleTimer);
    st.settleTimer = this.setT(() => {
      st.settleTimer = null;
      void this.evaluate(sessionId, false);
    }, SETTLE_MS);
  }

  /** Nach einem abgeschickten Tastendruck aufrufen — beendet den Takt für diesen Prompt. */
  resolved(sessionId: string): void {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    st.resolvedFp = st.activeFp;
    st.attempt = 0;
    if (st.recheckTimer !== null) { this.clearT(st.recheckTimer); st.recheckTimer = null; }
  }

  private async evaluate(sessionId: string, isRecheck: boolean): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st) return;

    const screen = await this.deps.getScreen(sessionId);
    if (!this.sessions.has(sessionId)) return;   // während des await abgemeldet
    if (screen === null) return;                 // kein Spiegel → alter Weg übernimmt

    const cls = classifyScreen(screen);
    const fp = promptFingerprint(cls);

    if (cls.kind === 'none') {
      // Der Bildschirm ist frei — auch die Erinnerung an den gelösten Prompt
      // wird gelöscht. Sonst bliebe eine WIEDERHOLTE, wortgleiche Frage
      // (zweimal derselbe Befehl) für immer unbeantwortet, weil ihr
      // Fingerabdruck noch als „schon erledigt" gälte.
      st.activeFp = '';
      st.resolvedFp = '';
      st.attempt = 0;
      if (st.recheckTimer !== null) { this.clearT(st.recheckTimer); st.recheckTimer = null; }
      return;
    }

    if (fp === st.resolvedFp) return;            // schon beantwortet, wartet nur noch auf den Abbau

    if (fp !== st.activeFp) {
      // Ein anderer Prompt als zuletzt — von vorn zählen.
      st.activeFp = fp;
      st.attempt = 0;
    } else if (isRecheck) {
      st.attempt += 1;
    } else {
      // Derselbe Prompt, neues Datenpaket (Neuzeichnen). Nicht doppelt melden;
      // der Takt kümmert sich um Wiederholungen.
      this.armRecheck(sessionId, cls);
      return;
    }

    st.cb(cls, st.attempt);
    this.armRecheck(sessionId, cls);
  }

  /** Takt nur für beantwortbare Prompts — bei einer Umfrage gibt es nichts zu wiederholen. */
  private armRecheck(sessionId: string, cls: PromptClass): void {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    if (st.recheckTimer !== null) { this.clearT(st.recheckTimer); st.recheckTimer = null; }
    if (cls.key === null) return;
    if (st.attempt >= MAX_RECHECKS) return;
    st.recheckTimer = this.setT(() => {
      st.recheckTimer = null;
      void this.evaluate(sessionId, true);
    }, RECHECK_MS);
  }
}
```

Am Dateiende das Singleton, das `ws.handler` benutzt — es wird in Task 5 verdrahtet:

```ts
// Wird in ws.handler.ts benutzt. getScreen kommt aus dem Terminal-Manager und
// wird spät gebunden, damit dieses Modul nicht vom Manager abhängt.
let screenSource: (sessionId: string) => Promise<ScreenView | null> = async () => null;

export function setScreenSource(fn: (sessionId: string) => Promise<ScreenView | null>): void {
  screenSource = fn;
}

export const screenPromptWatcher = new ScreenPromptWatcher({
  getScreen: (sessionId) => screenSource(sessionId),
});
```

- [ ] **Step 4: Tests laufen lassen**

Run: `cd ~/Desktop/tms-terminal/server && npm test 2>&1 | tail -20`
Expected: PASS, alle 8 neuen Tests grün

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/notifications/prompt.watcher.ts server/src/notifications/prompt.watcher.test.ts
git commit -m "feat(server): Bildschirm-Beobachter mit Wiederholungstakt statt Einmal-Schuss"
```

---

## Task 5: Verdrahtung im WebSocket-Handler

**Files:**
- Create: `server/src/websocket/auto.approve.state.ts`
- Modify: `shared/protocol.ts:222-226`
- Modify: `server/src/websocket/approval.util.ts`
- Modify: `server/src/notifications/prompt.detector.ts`
- Modify: `server/src/terminal/terminal.manager.ts`
- Modify: `server/src/websocket/ws.handler.ts`
- Test: `server/src/websocket/approval.util.test.ts`

**Interfaces:**
- Consumes: `screenPromptWatcher`, `setScreenSource` aus Task 4; `PromptClass`, `promptFingerprint` aus Task 2; `TerminalManager.getScreen` aus Task 1
- Produces:
  - `evaluateGate(inp: { key: string | null; pendingLen: number; sinceInputMs: number }): ApprovalGateResult`
  - `isAutoApprove(sessionId): boolean`, `setAutoApprove(sessionId, on): void`, `clearAutoApprove(sessionId): void`
  - `TerminalManager.hasMirror(sessionId: string): boolean`
  - `PromptCallback` bekommt `context.reason: 'prompt' | 'ai-finished'`
  - `TerminalPromptDetectedMessage.payload.kind?: 'permission' | 'confirm' | 'question'`

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

An `server/src/websocket/approval.util.test.ts` anhängen:

```ts
test('evaluateGate: fertiger Schlüssel wird durchgereicht', () => {
  const r = evaluateGate({ key: '\r', pendingLen: 0, sinceInputMs: 99_999 });
  assert.equal(r.gate, 'send');
  assert.equal(r.gate === 'send' ? r.key : null, '\r');
});

test('evaluateGate: kein Schlüssel → nur melden', () => {
  assert.equal(evaluateGate({ key: null, pendingLen: 0, sinceInputMs: 99_999 }).gate, 'notify-only');
});

test('evaluateGate: Tippen pausiert', () => {
  assert.equal(evaluateGate({ key: '\r', pendingLen: 0, sinceInputMs: 500 }).gate, 'paused-typing');
});

test('evaluateGate: ungesendeter Text blockiert', () => {
  assert.equal(evaluateGate({ key: '\r', pendingLen: 3, sinceInputMs: 5000 }).gate, 'blocked-pending');
});

test('evaluateGate: veralteter Zähler blockiert nicht mehr', () => {
  const r = evaluateGate({ key: '\r', pendingLen: 3, sinceInputMs: PENDING_STALE_MS + 1 });
  assert.equal(r.gate, 'send');
});
```

Den Import in derselben Datei erweitern: `evaluateGate` ergänzen.

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd ~/Desktop/tms-terminal/server && npm test 2>&1 | head -20`
Expected: FAIL — `evaluateGate is not a function`

- [ ] **Step 3: `evaluateGate` ergänzen**

Ans Ende von `server/src/websocket/approval.util.ts`, unterhalb von `evaluateApprovalGate`:

```ts
/**
 * Dasselbe Tor wie `evaluateApprovalGate`, aber mit bereits entschiedenem
 * Schlüssel. Der Bildschirm-Klassifikator (prompt.classifier.ts) bestimmt die
 * Taste; hier geht es nur noch um die Frage, ob JETZT gedrückt werden darf.
 *
 * `evaluateApprovalGate` bleibt für den Rückfallweg auf dem Byte-Strom.
 */
export function evaluateGate(inp: {
  key: string | null;
  pendingLen: number;
  sinceInputMs: number;
}): ApprovalGateResult {
  if (inp.key === null) return { gate: 'notify-only' };
  if (inp.pendingLen > 0 && inp.sinceInputMs < PENDING_STALE_MS) return { gate: 'blocked-pending' };
  if (inp.sinceInputMs < TYPING_PAUSE_MS) return { gate: 'paused-typing' };
  return { gate: 'send', key: inp.key };
}
```

- [ ] **Step 4: Tests laufen lassen**

Run: `cd ~/Desktop/tms-terminal/server && npm test 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: `reason` im Detektor-Callback ergänzen**

In `server/src/notifications/prompt.detector.ts` den Typ ändern:

```ts
/** Prompt callback. `context.window` is the cleaned text the match was found in,
 *  so the caller can decide which keystroke approves it (e.g. Enter vs 'y').
 *  `context.reason` unterscheidet einen wartenden Prompt von der Meldung
 *  „die KI ist fertig" — der Handler behandelt beide völlig verschieden. */
export type PromptCallback = (
  snippet: string,
  context?: { window: string; reason: 'prompt' | 'ai-finished' },
) => void;
```

Und die drei Aufrufstellen ergänzen:

- Im Fast-Path (`this.callbacks.get(sessionId)?.(snippet, { window: fastWindow });`):
  ```ts
  this.callbacks.get(sessionId)?.(snippet, { window: fastWindow, reason: 'prompt' });
  ```
- Am Ende von `_check` (`this.callbacks.get(sessionId)?.(snippet, { window: tail });`):
  ```ts
  this.callbacks.get(sessionId)?.(snippet, { window: tail, reason: shellReturned ? 'ai-finished' : 'prompt' });
  ```

- [ ] **Step 6: Protokoll erweitern**

`shared/protocol.ts:222-226` ersetzen durch:

```ts
export interface TerminalPromptDetectedMessage {
  type: 'terminal:prompt_detected';
  sessionId: string;
  payload: {
    snippet: string;
    hasPendingInput?: boolean;
    /** Einstufung des Servers. Die App rät sie nicht mehr selbst aus dem Text. */
    kind?: 'permission' | 'confirm' | 'question';
  };
}
```

- [ ] **Step 7: Das Zustandsmodul für Auto-Approve anlegen**

Der Schalter lag als Map in `ws.handler.ts`. Task 6 braucht ihn im Snapshotter
und in der Wiederherstellung — beide kämen dort nur über einen Import-Zyklus
heran. Deshalb bekommt er jetzt ein eigenes Modul.

`server/src/websocket/auto.approve.state.ts`:

```ts
/**
 * Der Auto-Approve-Schalter pro Session — bewusst ein eigenes Modul.
 *
 * Er lag vorher als Map in ws.handler.ts. Damit kamen weder der Snapshotter
 * (der ihn mitschreiben soll) noch die Wiederherstellung (die ihn setzen soll)
 * an ihn heran, ohne einen Import-Zyklus über den WebSocket-Handler zu bauen.
 */
const state = new Map<string, boolean>();

export function isAutoApprove(sessionId: string): boolean {
  return state.get(sessionId) ?? false;
}

export function setAutoApprove(sessionId: string, on: boolean): void {
  state.set(sessionId, on);
}

export function clearAutoApprove(sessionId: string): void {
  state.delete(sessionId);
}
```

In `server/src/websocket/ws.handler.ts` die Zeile
`const serverAutoApprove = new Map<string, boolean>();` samt Kommentar löschen
und alle Verwendungen ersetzen:

- `serverAutoApprove.set(sid, enabled)` → `setAutoApprove(sid, enabled)`
- `serverAutoApprove.get(sessionId)` → `isAutoApprove(sessionId)`
- `serverAutoApprove.delete(msg.sessionId)` → `clearAutoApprove(msg.sessionId)`

- [ ] **Step 8: Die Push-Funktion für Umfragen schreiben**

In `server/src/websocket/ws.handler.ts` auf Modulebene, neben `persistedTokens`:

```ts
// Ein Push je wartender Frage. Der Fingerabdruck stammt aus dem Klassifikator
// und bleibt stabil, solange dieselbe Frage auf dem Schirm steht — ohne ihn
// würde jeder Neuzeichen-Frame eine weitere Benachrichtigung auslösen.
const lastQuestionPush = new Map<string, string>();

/**
 * Meldet eine Umfrage ans Handy. NUR für Umfragen: Berechtigungen beantwortet
 * der Server selbst, dafür will niemand geweckt werden.
 * Die Daten tragen die sessionId, damit ein Tipp auf die Meldung genau dieses
 * Terminal öffnet (siehe notifications.service.ts).
 */
function pushQuestion(sessionId: string, label: string, question: string, fp: string): void {
  if (lastQuestionPush.get(sessionId) === fp) return;
  lastQuestionPush.set(sessionId, fp);

  if (persistedTokens.size === 0) {
    logger.warn('Frage-Push uebersprungen — kein FCM-Token registriert');
    return;
  }
  const hostname = require('os').hostname().replace(/\.local$/, '');
  const title = `\u{2753} Rückfrage · ${hostname} · ${label}`;
  const body = question.trim().slice(0, 120) || 'Das Terminal wartet auf deine Auswahl';

  logger.info(`Frage-Push: "${title}" — "${body}"`);
  for (const token of persistedTokens) {
    void fcmService
      .send(token, title, body, { sessionId, type: 'prompt', kind: 'question' })
      .catch(() => { persistedTokens.delete(token); });
  }
}
```

- [ ] **Step 9: Den Handler verdrahten**

In `server/src/websocket/ws.handler.ts`:

Imports ergänzen:

```ts
import { computePendingLen, chooseApprovalKey, evaluateApprovalGate, evaluateGate } from './approval.util';
import { screenPromptWatcher, setScreenSource } from '../notifications/prompt.watcher';
import { promptFingerprint, type PromptClass } from '../notifications/prompt.classifier';
import { isAutoApprove, setAutoApprove, clearAutoApprove } from './auto.approve.state';
```

Direkt unter der bestehenden `globalManager.detachFeedCallback`-Zuweisung am Dateianfang:

```ts
// Der Beobachter liest den Bildschirm über den Manager — spät gebunden, damit
// das Beobachter-Modul nichts vom Terminal-Manager wissen muss.
setScreenSource((sessionId) => globalManager.getScreen(sessionId));
```

Und dieselbe Callback-Zuweisung um den Anstoß erweitern:

```ts
globalManager.detachFeedCallback = (sessionId, data) => {
  promptDetector.feed(sessionId, data);
  screenPromptWatcher.poke(sessionId);
  idleDetector.activity(sessionId);
};
```

In `watchSession` den bestehenden `onPrompt` so abändern, dass der Byte-Weg nur
noch als Rückfall dient — die erste Zeile im Rumpf:

```ts
    const onPrompt = (snippet: string, context?: { window: string; reason: 'prompt' | 'ai-finished' }): void => {
      // Gibt es einen Spiegel, gehört die Prompt-Behandlung dem Bildschirm-Weg.
      // Der Byte-Weg meldet dann nur noch „die KI ist fertig".
      if (context?.reason === 'prompt' && globalManager.hasMirror(sessionId)) return;
```

Dafür braucht `terminal.manager.ts` eine kleine Auskunft (neben `getScreen`):

```ts
  /** Hat diese Session einen Spiegel? Entscheidet, welcher Erkennungsweg gilt. */
  hasMirror(sessionId: string): boolean {
    return this.mirrors.has(sessionId);
  }
```

Innerhalb von `watchSession`, hinter der bestehenden `promptDetector.watch/rewatch`-Zeile,
den Bildschirm-Weg registrieren:

```ts
    // ── Bildschirm-Weg: die eigentliche Auto-Approve-Logik ──
    screenPromptWatcher.watch(sessionId, (cls: PromptClass, attempt: number) => {
      const label = terminalLabel(sessionId);

      if (cls.key !== null) {
        // Berechtigung oder Ja/Nein — beantwortbar.
        if (isAutoApprove(sessionId)) {
          const gate = evaluateGate({
            key: cls.key,
            pendingLen: pendingInputLen.get(sessionId) ?? 0,
            sinceInputMs: Date.now() - (lastUserInputAt.get(sessionId) ?? 0),
          });
          if (gate.gate === 'send') {
            logger.info(`Auto-approve: sende ${JSON.stringify(gate.key)} fuer ${sessionId.slice(0, 8)}${attempt ? ` (Versuch ${attempt})` : ''}`);
            globalManager.write(sessionId, gate.key);
            pendingInputLen.set(sessionId, 0);   // unser Tastendruck ist keine Nutzereingabe
            screenPromptWatcher.resolved(sessionId);
            return;
          }
          if (attempt === 0) {
            logger.info(`Auto-approve: VERSCHOBEN fuer ${sessionId.slice(0, 8)} (${gate.gate}) — wird wiederholt`);
          }
          if (attempt >= 1) return;   // der Takt versucht es weiter, ohne die App zuzuspammen
        }
        if (attempt === 0) {
          send(ws, {
            type: 'terminal:prompt_detected',
            sessionId,
            payload: {
              snippet: cls.question,
              hasPendingInput: (pendingInputLen.get(sessionId) ?? 0) > 0,
              kind: cls.kind === 'confirm' ? 'confirm' : 'permission',
            },
          });
        }
        return;
      }

      // Umfrage: nie beantworten. Melden und einmalig pushen.
      if (attempt === 0) {
        send(ws, {
          type: 'terminal:prompt_detected',
          sessionId,
          payload: { snippet: cls.question, hasPendingInput: false, kind: 'question' },
        });
        pushQuestion(sessionId, label, cls.question, promptFingerprint(cls));
      }
    });
```

Eine kleine Hilfsfunktion für die Beschriftung, direkt über `watchSession` —
dieselbe Logik, die der Idle-Push schon benutzt:

```ts
  /** „Shell 3" — dieselbe Beschriftung wie beim Idle-Push. */
  const terminalLabel = (sessionId: string): string => {
    const num = [...ownedSessions].indexOf(sessionId) + 1;
    return num > 0 ? `Shell ${num}` : 'Terminal';
  };
```

Die drei Stellen, an denen `promptDetector.feed(...)` steht (in `terminal:create`,
in `terminal:reattach` und die schon geänderte `detachFeedCallback`), jeweils um
`screenPromptWatcher.poke(sessionId);` erweitern.

In `terminal:close` und in den `onClose`-Callbacks neben `promptDetector.unwatch(...)`
jeweils ergänzen:

```ts
        screenPromptWatcher.unwatch(sessionId);
        lastQuestionPush.delete(sessionId);
```

- [ ] **Step 10: Bauen und Tests laufen lassen**

Run: `cd ~/Desktop/tms-terminal/server && rm -f .tsbuildinfo && npx tsc --noEmit && npm test 2>&1 | tail -15`
Expected: keine Typfehler, alle Tests grün

- [ ] **Step 11: Commit**

```bash
cd ~/Desktop/tms-terminal
git add shared/protocol.ts server/src/websocket/approval.util.ts server/src/websocket/approval.util.test.ts server/src/notifications/prompt.detector.ts server/src/websocket/ws.handler.ts server/src/websocket/auto.approve.state.ts server/src/terminal/terminal.manager.ts
git commit -m "feat(server): Auto-Approve laeuft ueber den Bildschirm-Beobachter, Push bei Umfragen"
```

---

## Task 6: Auto-Approve überlebt den Neustart

**Files:**
- Modify: `server/src/websocket/ws.handler.ts`
- Modify: `server/src/terminal/restore/snapshot.types.ts:8-24`
- Modify: `server/src/terminal/restore/snapshotter.ts:11-14, 70-79`
- Modify: `server/src/terminal/restore/restore.ts:18-31, 118`
- Modify: `server/src/index.ts:121-132`
- Test: `server/src/terminal/restore/restore.test.ts`

**Interfaces:**
- Produces: `isAutoApprove(sessionId): boolean`, `setAutoApprove(sessionId, on): void`, `clearAutoApprove(sessionId): void`
- `SnapshotEntry.autoApprove?: boolean`
- `SnapshotSource.autoApproveFor(id: string): boolean`
- `RestoreDeps.applyAutoApprove?: (id: string, on: boolean) => void`

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

An `server/src/terminal/restore/restore.test.ts` anhängen:

```ts
test('wiederhergestellte Sitzung bekommt ihren Auto-Approve-Schalter zurück', async () => {
  const applied: Array<{ id: string; on: boolean }> = [];
  const result = await restoreTerminals({
    now: () => 1000,
    takeSnapshot: () => ({
      capturedAt: 1000,
      serverPid: 4242,
      entries: [
        { id: 'a', cwd: '/tmp', cols: 80, rows: 24, autoApprove: true },
        { id: 'b', cwd: '/tmp', cols: 80, rows: 24, autoApprove: false },
        { id: 'c', cwd: '/tmp', cols: 80, rows: 24 },
      ],
    }),
    isPidAlive: () => false,
    createSession: () => true,
    writeToSession: () => {},
    markSession: () => {},
    applyAutoApprove: (id, on) => applied.push({ id, on }),
    maxSessions: 10,
    setTimeoutFn: (fn) => { void fn; return 0; },
  });

  assert.equal(result.restored.length, 3);
  assert.deepEqual(applied, [
    { id: 'a', on: true },
    { id: 'b', on: false },
  ], 'nur gespeicherte Werte werden gesetzt — fehlt der Wert, bleibt es beim Standard');
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd ~/Desktop/tms-terminal/server && npm test 2>&1 | grep -A 5 "Auto-Approve-Schalter"`
Expected: FAIL — `applied` ist leer

- [ ] **Step 3: Den Schalter sofort sichern, statt auf den 30-Sekunden-Takt zu warten**

In `server/src/websocket/ws.handler.ts` im `client:set_auto_approve`-Zweig direkt
nach `setAutoApprove(sid, enabled)`:

```ts
        captureSoon();
```

Import ergänzen, falls noch nicht vorhanden:

```ts
import { captureSoon } from '../terminal/restore/snapshotter';
```

- [ ] **Step 4: Snapshot um das Feld erweitern**

In `server/src/terminal/restore/snapshot.types.ts` innerhalb von `SnapshotEntry`
nach `rows: number;`:

```ts
  /**
   * Auto-Approve-Schalter dieser Session. Ohne ihn ist Auto-Approve nach jedem
   * Server-Neustart still aus, bis die App sich meldet — genau die Lücke, in
   * der es so aussieht, als drücke der Server wieder nicht.
   */
  autoApprove?: boolean;
```

In `server/src/terminal/restore/snapshotter.ts` das Interface erweitern:

```ts
export interface SnapshotSource {
  listSessions(): Array<{ id: string; pid: number; cols: number; rows: number; cwd?: string }>;
  labelFor(id: string): string | undefined;
  autoApproveFor(id: string): boolean;
}
```

und im `entries.push({...})` ergänzen:

```ts
          autoApprove: this.deps.source.autoApproveFor(s.id),
```

- [ ] **Step 5: Wiederherstellung anschließen**

In `server/src/terminal/restore/restore.ts` das Interface erweitern:

```ts
  /** Setzt den gespeicherten Auto-Approve-Schalter wieder. */
  applyAutoApprove?: (id: string, on: boolean) => void;
```

und in `restoreOne` direkt nach `result.restored.push(entry.id);`:

```ts
  if (entry.autoApprove !== undefined) deps.applyAutoApprove?.(entry.id, entry.autoApprove);
```

- [ ] **Step 6: In index.ts verdrahten**

In `server/src/index.ts` den Import ergänzen:

```ts
import { isAutoApprove, setAutoApprove } from './websocket/auto.approve.state';
```

Im `new Snapshotter({...})`-Aufruf die Quelle erweitern (neben `labelFor`):

```ts
      autoApproveFor: (id) => isAutoApprove(id),
```

Im `restoreTerminals({...})`-Aufruf ergänzen:

```ts
    applyAutoApprove: (id, on) => setAutoApprove(id, on),
```

- [ ] **Step 7: Bauen und Tests laufen lassen**

Run: `cd ~/Desktop/tms-terminal/server && rm -f .tsbuildinfo && npx tsc --noEmit && npm test 2>&1 | tail -15`
Expected: keine Typfehler, alle Tests grün (auch die bestehenden Snapshotter-Tests —
sie brauchen in ihrer `SnapshotSource`-Attrappe jetzt ein `autoApproveFor: () => false`)

- [ ] **Step 8: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/websocket/ws.handler.ts server/src/terminal/restore server/src/index.ts
git commit -m "feat(server): Auto-Approve-Schalter ueberlebt den Server-Neustart"
```

---

## Task 7: App — Tipp auf die Umfrage öffnet das Terminal

**Files:**
- Modify: `mobile/src/services/notifications.service.ts:67-83`
- Modify: `mobile/src/season2/SeasonTwoWebRoot.tsx:421-448, 470-480`
- Modify: `mobile/src/season2/web/bridge.js` (im `window.TMSBridge`-Objekt ab Zeile 1005)
- Modify: `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html:3367-3379`

**Interfaces:**
- Consumes: `terminal:prompt_detected` mit `payload.kind` und die FCM-Daten `{ type: 'prompt', kind: 'question', sessionId }` — beides aus Task 5
- Produces: `consumePendingPromptSessionId(): string | null`; Bridge-Befehl `TMSBridge.focusSession(sessionId)`; Global `window.focusTerminal`

- [ ] **Step 1: `focusTerminal` im Mockup freigeben**

In `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` bei den
übrigen Freigaben (Zeile ~8137, wo `window.setDockPage = setDockPage;` steht) ergänzen:

```js
  window.focusTerminal = focusTerminal;
```

- [ ] **Step 2: Mockup neu bauen**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run build:season2 && git diff --stat src/season2/web/liquidDeckHtml.ts
```
Expected: `liquidDeckHtml.ts` geändert

- [ ] **Step 3: `focusSession` in der Bridge ergänzen**

In `mobile/src/season2/web/bridge.js` innerhalb des `window.TMSBridge`-Objekts,
neben `bindSession`:

```js
    /** Ein Push auf eine Umfrage wurde angetippt — genau dieses Terminal zeigen. */
    focusSession: function (sessionId) {
      var cardId = cardOf(sessionId);
      if (!cardId) return;
      if (typeof window.setDockPage === 'function') window.setDockPage('term');
      if (typeof window.focusTerminal === 'function') window.focusTerminal(cardId);
      if (window.__tmsState) window.__tmsState.activeCardId = cardId;
      if (typeof window.syncDockTerminal === 'function') window.syncDockTerminal();
      if (typeof window.renderTermSwitcher === 'function') window.renderTermSwitcher();
    },
```

- [ ] **Step 4: Die angetippte Session merken**

In `mobile/src/services/notifications.service.ts` neben den anderen Zwischenspeichern:

```ts
// ── Angetippte Umfrage-Meldung ───────────────────────────────────────────────
// Der Server pusht bei einer Umfrage mit { type: 'prompt', sessionId }.
// SeasonTwoWebRoot holt den Wert ab und springt in genau dieses Terminal.
let _pendingPromptSessionId: string | null = null;

/** Liest und verbraucht die angetippte Umfrage-Session (null, wenn keine). */
export function consumePendingPromptSessionId(): string | null {
  const sid = _pendingPromptSessionId;
  _pendingPromptSessionId = null;
  return sid;
}
```

und in `registerNotificationResponseHandler` im Listener ergänzen:

```ts
    if (data?.type === 'prompt' && typeof data.sessionId === 'string') {
      _pendingPromptSessionId = data.sessionId;
    }
```

- [ ] **Step 5: In Season 2 verbrauchen**

In `mobile/src/season2/SeasonTwoWebRoot.tsx` den Import erweitern:

```ts
import { consumePendingBrowserBridgeUrl, consumePendingPromptSessionId } from '../services/notifications.service';
```

Neben dem bestehenden Effekt, der `consumePendingBrowserBridgeUrl()` abholt
(um Zeile 470), einen gleich gebauten Effekt ergänzen:

```tsx
  // Eine angetippte Umfrage-Meldung springt in ihr Terminal — beim Start und
  // jedes Mal, wenn die App wieder in den Vordergrund kommt.
  useEffect(() => {
    if (!ready) return;
    const jump = (): void => {
      const sid = consumePendingPromptSessionId();
      if (sid) call('focusSession', sid);
    };
    jump();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') jump(); });
    return () => sub.remove();
  }, [ready, call]);
```

- [ ] **Step 6: Die eigene Rateerei durch die Server-Einstufung ersetzen**

In `mobile/src/season2/SeasonTwoWebRoot.tsx` im `terminal:prompt_detected`-Zweig
(Zeile ~421) die Zeile

```ts
        if (info.kind === 'question') return;
```

ersetzen durch:

```ts
        // Der Server stuft ein (prompt.classifier.ts) — auf dem echten
        // Bildschirm, nicht auf einem Textschnipsel. `describePrompt` bleibt
        // nur noch für die Darstellung (Werkzeug, Ziel, Optionen) zuständig.
        const kind = (m.payload as { kind?: string } | undefined)?.kind ?? info.kind;
        if (kind === 'question') return;
```

- [ ] **Step 7: Typprüfung**

Run: `cd ~/Desktop/tms-terminal/mobile && npx tsc --noEmit 2>&1 | head -20`
Expected: keine neuen Fehler

- [ ] **Step 8: Commit**

Das Mockup liegt in einem anderen Worktree und wird dort einzeln committet.

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mockups/season2/liquid-deck/index.html
git commit -m "feat(mockup): focusTerminal als Global freigeben"

cd ~/Desktop/tms-terminal
git add mobile/src/services/notifications.service.ts mobile/src/season2/SeasonTwoWebRoot.tsx mobile/src/season2/web/bridge.js mobile/src/season2/web/liquidDeckHtml.ts
git commit -m "feat(app): Tipp auf eine Umfrage-Meldung oeffnet das betroffene Terminal"
```

---

## Task 8: Abnahme und Ausliefern

**Files:** keine Codeänderung

- [ ] **Step 1: Gesamtlauf**

```bash
cd ~/Desktop/tms-terminal/server && rm -f .tsbuildinfo && npx tsc && npm test 2>&1 | tail -25
```
Expected: Build erzeugt `dist/`, alle Tests grün

- [ ] **Step 2: Prüfen, dass `dist` wirklich entstanden ist**

```bash
cd ~/Desktop/tms-terminal/server && ls -la dist/server/src/index.js && ls dist/server/src/notifications/
```
Expected: `index.js` vorhanden, `prompt.classifier.js` und `prompt.watcher.js` vorhanden

- [ ] **Step 3: Remote-Stand prüfen und schieben**

```bash
cd ~/Desktop/tms-terminal && git fetch origin && git status -sb | head -3
git pull --rebase origin feat/manager-chat-redesign && git push origin feat/manager-chat-redesign
cd "/Users/ayysir/Desktop/TMS Terminal" && git push origin master
```

- [ ] **Step 4: An den Nutzer übergeben — Server-Neustart**

Der Neustart beendet die Sitzung, die diesen Umbau gemacht hat, und wird daher
NICHT vom Umsetzenden ausgeführt. Dem Nutzer diesen Befehl geben:

```
! pkill -f "tms-terminal" ; tms-terminal
```

- [ ] **Step 5: App-Release über CI**

```bash
cd ~/Desktop/tms-terminal/mobile
# Version in app.json + android/app/build.gradle anheben, dann:
git add app.json android/app/build.gradle && git commit -m "chore(release): vX.Y.Z"
git tag vX.Y.Z && git push origin vX.Y.Z
```

Lokal bauen funktioniert nicht (Metro hängt headless) — der Tag-Push löst den
GitHub-Actions-Workflow aus, der das APK baut und als Release anhängt.

- [ ] **Step 6: Abnahme am Gerät**

Vom Nutzer prüfen lassen, mit Server-Log als Beleg
(`grep -E "Auto-approve|Frage-Push" ~/.tms-terminal/update.log | tail -20`):

1. Claude Code um eine Datei außerhalb des Arbeitsordners bitten, App schließen.
   Erwartung: Log zeigt `Auto-approve: sende "\r"`, das Terminal läuft weiter.
2. Während die Box steht, in der App Text in die Eingabezeile tippen und nicht
   abschicken. Erwartung: `VERSCHOBEN`, und sobald die Zeile leer ist, folgt
   `sende "\r" (Versuch N)` — nicht erst beim nächsten Prompt.
3. Eine Auswahlfrage stellen lassen. Erwartung: kein Enter, ein Push
   „❓ Rückfrage · …", und ein Tipp darauf öffnet genau dieses Terminal.
4. Server neu starten, während Auto-Approve an war und die App zu ist.
   Erwartung: das nächste Berechtigungsfenster wird trotzdem bestätigt.

---

## Selbstprüfung des Plans

**Abdeckung der Spec:**

| Spec-Abschnitt | Task |
|---|---|
| 1 Spiegel wird Quelle | 1 |
| 2 Auslöser sofort + selbstheilend | 4 |
| 3 Klassifikator | 2 |
| 4 Torwächter + Retry | 5 |
| 5 Umfrage → Push mit Sprung | 5, 7 |
| 6 Zustand überlebt Neustart | 6 |
| 7 Aufnahme-Korpus | 3 |
| Fehlerfälle (kein Spiegel → Rückfall) | 5, Step 9 (`hasMirror`) |
| Fehlerfälle (kein FCM-Token) | 5, Step 8 |
| Prüfen (Unit/Replay/Gerät) | 2, 3, 8 |
