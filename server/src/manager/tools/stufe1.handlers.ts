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

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the tz argument coming from the model.
 * "floating" / "mitreisend" forces a travelling appointment; a named zone anchors
 * it; anything else is left to the store's default (one-off = anchored here,
 * repeating = floating).
 */
function resolveTzArg(raw: string | undefined): { tz?: string | null; error?: string } {
  if (raw === undefined || raw.trim() === '') return {};
  const v = raw.trim();
  if (v === 'floating' || v === 'mitreisend') return { tz: null };
  if (!isValidTimeZone(v)) {
    return { error: `Fehler: "${v}" ist keine gültige Zeitzone. Nutze einen IANA-Namen wie "Europe/Berlin" oder "floating".` };
  }
  return { tz: v };
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
    const tzArg = resolveTzArg(args.tz);
    if (tzArg.error !== undefined) return tzArg.error;
    const offsets = parseOffsets(args.reminder_offsets);
    const item = addAgendaItem({
      title, at, note: args.note, allDay: isTrue(args.all_day),
      repeat, reminderOffsets: offsets, tz: tzArg.tz, source: 'user',
    }, dir);
    const rep = repeat === 'none' ? '' : `, ${REPEAT_LABEL[repeat]}`;
    // Show the time as the appointment itself means it, not as the machine
    // happens to be set right now — the user travels between zones.
    const occurrenceMs = wallTimeToEpoch(parseWallTime(at)!, item.tz);
    const zoneNote = item.tz !== undefined
      ? ` (feste Zeit in ${item.tz})`
      : ' (reist mit dir mit)';
    return `Termin angelegt: "${title}" am ${fmtDateTime(occurrenceMs, item.allDay)}${rep}${zoneNote}`
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
    if (args.tz !== undefined) {
      const tzArg = resolveTzArg(args.tz);
      if (tzArg.error !== undefined) return tzArg.error;
      patch.tz = tzArg.tz ?? undefined;
    }
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
