/**
 * Server-seitiger Spiegel-Emulator pro Session (tmux-Prinzip).
 *
 * Warum: Beim Wiederanhängen wurde bisher der rohe Detach-Puffer (bis 300 KB
 * ANSI) in das Client-Terminal nachgespielt. Diese Bytes sind cursor-relative
 * Frames, gemalt für GENAU die Breite von damals — nach Falten/Drehen oder
 * mitten im Frame abgespielt erzeugen sie die verklebten, verschränkten und
 * gedoppelten Zeilen. Ein Replay kann das prinzipbedingt nicht sauber lösen.
 *
 * Stattdessen konsumiert dieser Spiegel denselben Byte-Strom wie der Client
 * und hält damit den WAHREN Bildschirm + Historie. Beim Wiederanhängen bekommt
 * der Client kein Replay mehr, sondern ein fertiges, in seiner aktuellen
 * Breite serialisiertes Vollbild (inkl. Scrollback) — korrekt per Konstruktion,
 * egal was während der Abwesenheit passiert ist.
 */
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

/** Historie im Spiegel. Muss >= dem sein, was der Client anzeigen kann
 *  (Season-2-DOM-Fenster: 800 Zeilen), klein genug für 50 Sessions im RAM. */
const MIRROR_SCROLLBACK = 1500;
/** So viele Historie-Zeilen wandern maximal ins Snapshot. */
const SNAPSHOT_SCROLLBACK = 1000;

export class SessionMirror {
  private term: Terminal;
  private serializer: SerializeAddon;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: MIRROR_SCROLLBACK,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
  }

  /** Denselben Byte-Strom füttern, der auch zum Client geht (Reihenfolge zählt). */
  feed(data: string): void {
    this.term.write(data);
  }

  /** Im Gleichschritt mit der PTY halten — sofort, ohne Debounce (reflowt nur den Spiegel). */
  resize(cols: number, rows: number): void {
    if (this.term.cols === cols && this.term.rows === rows) return;
    this.term.resize(cols, rows);
  }

  get cols(): number { return this.term.cols; }
  get rows(): number { return this.term.rows; }

  /**
   * Wartet den Parser-Rückstand ab (write ist asynchron): ein leeres write
   * reiht sich hinter alle offenen Häppchen ein. Löst die Promise im
   * Write-Callback auf — die anschließende Microtask läuft, BEVOR ein neues
   * PTY-Ereignis dazwischenkommen kann. Wer im `.then` sofort serialisiert,
   * bekommt also einen exakten Schnittpunkt: alles davor Gefütterte ist im
   * Snapshot, alles danach läuft als normale Live-Ausgabe hinterher.
   */
  flushed(): Promise<void> {
    return new Promise((resolve) => this.term.write('', () => resolve()));
  }

  /**
   * Vollbild + Historie als ANSI-Strom, gültig für die AKTUELLE Spiegel-Größe.
   * Synchron — direkt nach `flushed()` aufrufen (siehe dort).
   *
   * Das Ergebnis stellt auch die Eingabe-Modi wieder her, die eine TUI vor dem
   * Abriss eingeschaltet hatte: ohne DECCKM kämen z. B. Pfeiltasten in Claudes
   * Auswahlmenü nach einem Reattach falsch kodiert an.
   */
  serializeNow(): string {
    let out = this.serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK });
    const modes = this.term.modes;
    if (modes.applicationCursorKeysMode) out += '\x1b[?1h';
    if (modes.bracketedPasteMode) out += '\x1b[?2004h';
    if (modes.applicationKeypadMode) out += '\x1b=';
    if (!modes.wraparoundMode) out += '\x1b[?7l';
    return out;
  }

  dispose(): void {
    this.term.dispose();
  }
}
