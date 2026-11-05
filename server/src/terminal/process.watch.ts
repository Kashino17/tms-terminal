/**
 * Vordergrundprogramm pro Terminal beobachten — für Windows.
 *
 * Unter macOS/Linux sieht der Spiegel-Emulator, wenn eine Vollbild-TUI startet
 * (alternativer Bildschirm, DECSET 1049), und erst DANN wird der Prozessname
 * nachgeschlagen. Unter Windows verarbeitet ConPTY den alternativen Bildschirm
 * intern und gibt ihn nicht weiter (node-pty mit System-ConPTY, ohne
 * Passthrough) — der Server sieht den Start von vim/OpenCode also nie. Die App
 * braucht den Namen aber: OpenCode bekommt darüber den Maus-Modus, und jede
 * Vollbild-TUI die echte Kartenhöhe statt der virtuellen 200 Zeilen.
 *
 * Darum unter Windows: nach jeder Ausgabe-Pause nachsehen, gedrosselt (ein
 * PowerShell-Start kostet spürbar CPU) — mit nachlaufender Prüfung, damit ein
 * Wechsel innerhalb der Sperrzeit (vim beendet) nicht verloren geht.
 */
export interface ProcessWatchDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  /** Vordergrundprogramm der Session (null = unbekannt). */
  read: (sessionId: string) => Promise<string | null>;
  /** Neuer Name → an die App melden. */
  report: (sessionId: string, name: string) => void;
  minIntervalMs?: number;
}

interface Entry { lastAt: number; sent?: string; trailing?: unknown; busy: boolean }

export class ProcessWatch {
  private entries = new Map<string, Entry>();
  constructor(private readonly deps: ProcessWatchDeps) {}

  /** Nach einer Ausgabe-Pause aufrufen. */
  poke(sessionId: string): void {
    const e = this.entries.get(sessionId) ?? { lastAt: -Infinity, busy: false };
    this.entries.set(sessionId, e);
    const min = this.deps.minIntervalMs ?? 4000;
    const wait = e.lastAt + min - this.deps.now();
    if (wait > 0 || e.busy) {
      // Gesperrt: genau EINE nachlaufende Prüfung am Ende der Sperrzeit.
      if (e.trailing === undefined) {
        e.trailing = this.deps.setTimer(() => { e.trailing = undefined; this.poke(sessionId); }, Math.max(wait, 50));
      }
      return;
    }
    e.lastAt = this.deps.now();
    e.busy = true;
    void this.deps.read(sessionId).then((name) => {
      e.busy = false;
      if (!this.entries.has(sessionId)) return; // inzwischen beendet
      if (!name || name === e.sent) return;
      e.sent = name;
      this.deps.report(sessionId, name);
    }, () => { e.busy = false; });
  }

  forget(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (e?.trailing !== undefined) this.deps.clearTimer(e.trailing);
    this.entries.delete(sessionId);
  }
}
