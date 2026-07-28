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
