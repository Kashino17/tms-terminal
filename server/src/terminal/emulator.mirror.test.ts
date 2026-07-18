/**
 * Regressionstests zum echten Fehlerbild der App: verschränkte, gedoppelte und
 * zerrissene Terminalzeilen (Screenshots vom 18.07.).
 *
 * Bewiesene Ursache: Cursor-relative TUI-Frames (Claude/Ink) sind nur für die
 * Breite gültig, für die sie gemalt wurden. Der alte Reattach spielte den rohen
 * Detach-Puffer nach — nach einem Breitenwechsel entstehen daraus exakt die
 * Artefakte. Der Spiegel-Emulator macht das Replay überflüssig: sein Snapshot
 * ist per Konstruktion korrekt für die angefragte Breite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terminal } from '@xterm/headless';
import { SessionMirror } from './emulator.mirror';

/** Ink-artiger Live-Region-Maler: N Zeilen Frame, dann cursor-up N + repaint. */
function makeFrames(cols: number, frameLines: number, frames: number): string {
  let out = '';
  for (let f = 0; f < frames; f++) {
    if (f > 0) out += `\x1b[${frameLines}A\r`;
    for (let l = 0; l < frameLines; l++) {
      const text = `Frame${String(f).padStart(2, '0')} Zeile${String(l).padStart(2, '0')} ` +
        'x'.repeat(Math.max(0, cols - 22 - (f % 7)));
      out += '\x1b[2K' + text.slice(0, cols) + (l < frameLines - 1 ? '\r\n' : '');
    }
  }
  return out;
}

/** Sichtbarer Text eines (Client-)Terminals, leere Zeilen weggelassen. */
function visibleText(term: Terminal): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buf.baseY + term.rows; i++) {
    const line = buf.getLine(i);
    const s = line ? line.translateToString(true) : '';
    if (s.trim()) out.push(s);
  }
  return out;
}

const write = (t: Terminal, d: string) => new Promise<void>((r) => t.write(d, r));

test('Snapshot nach Breitenwechsel ist sauber — wo das rohe Replay Zeilensalat erzeugt', async () => {
  // Während der Abwesenheit malt die TUI 8 Frames für 46 Spalten.
  const stream = makeFrames(46, 6, 8);

  // ALTER Weg (Kontrollgruppe): Replay in einen Client, der inzwischen 38 Spalten hat.
  const replayClient = new Terminal({ cols: 38, rows: 12, scrollback: 500, allowProposedApi: true });
  await write(replayClient, stream);
  const replayed = visibleText(replayClient);
  // Der Salat, den die Screenshots zeigen: mehr Zeilen als ein Frame, Fragmente vermischt.
  assert.ok(replayed.length > 6, `Kontrollgruppe: Replay bei falscher Breite erzeugt Müll (${replayed.length} Zeilen)`);

  // NEUER Weg: Spiegel konsumiert den Strom in Session-Breite, Snapshot in Client-Breite.
  const mirror = new SessionMirror(46, 12);
  mirror.feed(stream);
  mirror.resize(38, 12);
  await mirror.flushed();
  const snap = mirror.serializeNow();

  const snapClient = new Terminal({ cols: 38, rows: 12, scrollback: 500, allowProposedApi: true });
  await write(snapClient, snap);
  const lines = visibleText(snapClient);

  // Genau der letzte Frame, jede Zeile exakt einmal, nichts verschränkt.
  const frame7 = lines.filter((l) => l.replace(/\s/g, '').includes('Frame07'));
  assert.equal(frame7.length >= 6, true, `alle 6 Zeilen des letzten Frames sind da (${frame7.length})`);
  for (let l = 0; l < 6; l++) {
    const hits = lines.filter((x) => x.includes(`Frame07 Zeile${String(l).padStart(2, '0')}`));
    assert.equal(hits.length, 1, `Zeile ${l} des letzten Frames genau einmal (${hits.length}×)`);
  }
  // Keine Zeile enthält Fragmente ZWEIER Frames (das Verschränkungs-Symptom).
  for (const l of lines) {
    const marks = l.match(/Frame\d\d/g) ?? [];
    assert.ok(new Set(marks).size <= 1, `keine verschränkte Zeile: "${l}"`);
  }
});

test('Snapshot stellt TUI-Eingabemodi wieder her (DECCKM, Bracketed Paste)', async () => {
  const mirror = new SessionMirror(46, 12);
  mirror.feed('\x1b[?1h\x1b[?2004hmenu');
  await mirror.flushed();
  const snap = mirror.serializeNow();
  assert.ok(snap.includes('\x1b[?1h'), 'DECCKM (Application Cursor Keys) im Snapshot');
  assert.ok(snap.includes('\x1b[?2004h'), 'Bracketed-Paste-Modus im Snapshot');
});

test('Snapshot enthält Scrollback-Historie, nicht nur das Vollbild', async () => {
  const mirror = new SessionMirror(46, 5);
  let stream = '';
  for (let i = 0; i < 40; i++) stream += `historie-${i}\r\n`;
  mirror.feed(stream);
  await mirror.flushed();
  const snap = mirror.serializeNow();
  assert.ok(snap.includes('historie-10'), 'aus dem Sichtfeld gescrollte Zeilen sind im Snapshot');
  assert.ok(snap.includes('historie-39'), 'die letzte Zeile ist im Snapshot');
});
