export type RepeatRule = 'none' | 'yearly' | 'monthly' | 'weekly' | 'daily';

export interface AgendaReminder {
  id: string;
  /** Minutes BEFORE the occurrence. 0 = at the appointment itself. */
  offsetMinutes: number;
  /**
   * Wall-clock identity of the occurrence this reminder last fired for,
   * e.g. "2026-08-04T08:00".
   *
   * Deliberately NOT an epoch timestamp. The user travels across timezones, and
   * the epoch of "the same" occurrence shifts when the machine's zone changes —
   * an epoch here made reminders fire a second time after flying west. A
   * wall-clock string is stable no matter where the laptop is.
   */
  firedFor?: string;
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
  /**
   * IANA zone this appointment is anchored to, e.g. "Europe/Berlin".
   *
   * Absent means **floating**: the appointment travels with the user, so 08:00
   * is 08:00 wherever they are. That is what a daily routine or a birthday means.
   * Set means **anchored**: a dentist appointment booked in Berlin stays Berlin
   * time even when the user is in Bangkok.
   *
   * Default: one-off appointments are anchored to the zone they were created in,
   * repeating ones float. That matches what people mean without having to ask.
   */
  tz?: string;
  reminders: AgendaReminder[];
  source: 'user' | 'agent';
  createdAt: number;
}

export interface AgendaFile {
  items: AgendaItem[];
}
