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
/** ANSI-geklebte Reste („Yes,andalwaysallow…") haben kein Wortende. */
const AFFIRMATIVE_GLUED_RE = /^(yes|ja|allow|approve)[,A-Z]/i;

const YN_DEFAULT_NO = /\[y\/N\]\s*:?\s*$/;   // Vorgabe Nein → 'y' nötig
const YN_DEFAULT_YES = /\[Y\/n\]\s*:?\s*$/;  // Vorgabe Ja  → Enter genügt
const YN_NEUTRAL = /\((y\/n|yes\/no)\)\s*:?\s*$/i;

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
      const affirmative = AFFIRMATIVE_RE.test(first.text) || AFFIRMATIVE_GLUED_RE.test(first.text);
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
    if (YN_DEFAULT_NO.test(line)) return { kind: 'confirm', key: 'y\r', question: q, options: [] };
    if (YN_DEFAULT_YES.test(line)) return { kind: 'confirm', key: '\r', question: q, options: [] };
    if (YN_NEUTRAL.test(line)) return { kind: 'confirm', key: 'y\r', question: q, options: [] };
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
