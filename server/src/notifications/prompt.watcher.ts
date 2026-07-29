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

// ── Singleton für ws.handler ─────────────────────────────────────────────────
// getScreen kommt aus dem Terminal-Manager und wird spät gebunden, damit dieses
// Modul nicht vom Manager abhängt.
let screenSource: (sessionId: string) => Promise<ScreenView | null> = async () => null;

export function setScreenSource(fn: (sessionId: string) => Promise<ScreenView | null>): void {
  screenSource = fn;
}

export const screenPromptWatcher = new ScreenPromptWatcher({
  getScreen: (sessionId) => screenSource(sessionId),
});
