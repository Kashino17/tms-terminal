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
