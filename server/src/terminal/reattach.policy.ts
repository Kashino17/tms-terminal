/**
 * Entscheidung beim Wiederanhängen eines Clients: Rückstand abspielen oder
 * Bildschirm zurücksetzen?
 *
 * Hintergrund: Claude & Co. malen ihre Live-UI cursor-relativ in-place. Diese
 * Frames sind nur für GENAU die Terminalbreite gültig, mit der sie gemalt
 * wurden. Hat sich die Breite während der Abwesenheit geändert (Falten, Drehen,
 * Schriftgröße), ist der Detach-Puffer unbrauchbar: abgespielt gegen die neue
 * Breite erzeugt er die verklebten/gedoppelten Zeilen. Dann lieber den Schirm
 * leeren und die TUI per SIGWINCH (der Resize folgt direkt auf den Reattach)
 * ein frisches Bild malen lassen.
 */

/** Ergebnis der Reattach-Planung. */
export interface ReattachPlan {
  /** Vor allem anderen die Clear-Sequenz an den Client schicken. */
  clear: boolean;
  /** Den Detach-Puffer (ggf. auf den geleerten Schirm) nachspülen. */
  replay: boolean;
}

/** Leert Schirm UND Scrollback-Historie und setzt Attribute/Ränder zurück.
 *  Läuft als ganz normale terminal:output-Nachricht durch die bestehende
 *  Leitung — xterm.js versteht CSI 3 J (Historie leeren) nativ, und der
 *  Client-Scrollback-Store zeichnet die Sequenz mit auf, sodass auch spätere
 *  Replays sich selbst bereinigen. */
export const CLEAR_SEQUENCE = '\x1b[0m\x1b[r\x1b[2J\x1b[3J\x1b[H';

/**
 * @param sessionCols Breite, mit der die Session zuletzt lief (Stand vor dem Reattach)
 * @param clientCols  Breite, die der Client jetzt meldet — undefined auf
 *                    Selbstheilungs-Pfaden, die die Maße nicht kennen
 * @param overflowed  true, wenn der Detach-Puffer übergelaufen ist (der Anfang
 *                    des Stroms fehlt — der Client stiege mitten im Frame ein)
 */
export function planReattach(
  sessionCols: number,
  clientCols: number | undefined,
  overflowed: boolean,
): ReattachPlan {
  // Ohne Maße keine Aussage über die Geometrie — Verhalten von heute.
  if (clientCols === undefined) return { clear: false, replay: true };
  // Breite geändert: Puffer wurde für die alte Breite gemalt → verwerfen.
  if (clientCols !== sessionCols) return { clear: true, replay: false };
  // Mitten im Strom einsteigen ist ok — aber nur gegen einen sauberen Schirm,
  // damit die cursor-relativen Frames keine alte Historie zerschreiben.
  if (overflowed) return { clear: true, replay: true };
  return { clear: false, replay: true };
}

/**
 * Mit Spiegel-Emulator (emulator.mirror.ts) gibt es einen dritten Weg: statt
 * Replay ODER Leeren ein fertiges Vollbild in Client-Breite. Das braucht der
 * Client aber nur, wenn sein Stand vom Server-Stand abweichen kann:
 *
 *  - es lief Ausgabe auf, während er weg war (Puffer nicht leer), oder
 *  - seine Breite passt nicht mehr zu der, mit der die Session lief, oder
 *  - der Detach-Puffer ist übergelaufen (sein Anfang fehlt).
 *
 * Ist nichts davon der Fall (der häufigste Fall: App kurz in den Hintergrund
 * und zurück, nichts passiert), bleibt der Client unangetastet — ein
 * unnötiges Clear+Snapshot ließe den Karteninhalt sichtbar zucken.
 */
export function wantsSnapshot(
  sessionCols: number,
  clientCols: number | undefined,
  bufferedBytes: number,
  overflowed: boolean,
): boolean {
  if (bufferedBytes > 0 || overflowed) return true;
  return clientCols !== undefined && clientCols !== sessionCols;
}
