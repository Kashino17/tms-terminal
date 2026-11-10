/**
 * "What is this terminal working on?" — read from the title the AI tool gives
 * its own terminal (OSC 0/2), which the session mirror already sees.
 *
 * Shapes taken from the real server log (200 000+ title changes):
 *   "◐ Topic" / "◑ Topic" / "⠧ Topic"   a spinner glyph: working
 *   "✳ Topic"                           at rest: done
 *   "[ ! ] Action Required | Topic | …" waiting for the user
 * A plain shell title ("user@host:~/dir", "zsh") is not a task.
 */
export type ActivityState = 'working' | 'waiting' | 'done';
export interface Activity { task: string; state: ActivityState }

const MAX_TASK = 160;
/** Titles that say nothing about the work. */
const GENERIC = new Set(['claude code', 'claude', 'codex', 'opencode', 'gemini']);
const REST_GLYPH = '✳';
/** Spinner glyphs: half circles, braille dots, and the usual stars/dots. */
const SPINNER = /^[◐-◓⠀-⣿✢✳✶✻✽·∙●○◦*+]$/u;

function clean(task: string): string {
  // eslint-disable-next-line no-control-regex
  let t = task.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  // "⠸ ⠸ | Hikari": repeated glyphs and a leading separator are decoration.
  for (;;) {
    const first = [...t][0];
    if (first && (SPINNER.test(first) || first === REST_GLYPH || first === '|')) t = t.slice(first.length).trim();
    else break;
  }
  if (GENERIC.has(t.toLowerCase())) return '';
  return [...t].slice(0, MAX_TASK).join('');
}

export function parseActivityTitle(title: string): Activity | null {
  const raw = (title || '').trim();
  if (!raw) return null;

  const need = raw.match(/^\[\s*!\s*\]\s*Action Required\s*\|\s*([^|]+)/i);
  if (need) return { task: clean(need[1]), state: 'waiting' };

  const chars = [...raw];
  const glyph = chars[0];
  // A glyph, then a space, then the topic.
  if (chars.length < 3 || chars[1] !== ' ') return null;
  if (glyph === REST_GLYPH) return { task: clean(chars.slice(2).join('')), state: 'done' };
  if (SPINNER.test(glyph)) return { task: clean(chars.slice(2).join('')), state: 'working' };
  return null;
}

export function sameActivity(a: Activity | null, b: Activity | null): boolean {
  if (a === null || b === null) return a === b;
  return a.task === b.task && a.state === b.state;
}
