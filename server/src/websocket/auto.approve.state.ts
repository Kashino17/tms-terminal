/**
 * Der Auto-Approve-Schalter pro Session — bewusst ein eigenes Modul.
 *
 * Er lag vorher als Map in ws.handler.ts. Damit kamen weder der Snapshotter
 * (der ihn mitschreiben soll) noch die Wiederherstellung (die ihn setzen soll)
 * an ihn heran, ohne einen Import-Zyklus über den WebSocket-Handler zu bauen.
 */
const state = new Map<string, boolean>();

export function isAutoApprove(sessionId: string): boolean {
  return state.get(sessionId) ?? false;
}

export function setAutoApprove(sessionId: string, on: boolean): void {
  state.set(sessionId, on);
}

export function clearAutoApprove(sessionId: string): void {
  state.delete(sessionId);
}
