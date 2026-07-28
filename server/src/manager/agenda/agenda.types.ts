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
