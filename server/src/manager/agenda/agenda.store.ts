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
