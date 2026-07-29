#!/usr/bin/env node
/**
 * Zeichnet den ROHEN PTY-Byte-Strom eines AI-Harness auf, während es einen
 * Prompt zeigt. Ergebnis ist eine JSONL-Datei ({t, d-base64}), die im Test
 * durch einen echten Terminal-Emulator gespielt wird.
 *
 * Ohne diese Aufnahmen bleibt jede Prompt-Erkennung Behauptung: die Harnesse
 * malen ihre Boxen sehr unterschiedlich, und neue Versionen ändern das.
 *
 *   node tools/capture-harness.js <out.jsonl> <cols> <totalMs> <cmd> [args...]
 *
 * Eingaben werden zeitgesteuert über die Umgebungsvariable STEPS geschickt:
 *   STEPS='[{"at":9000,"in":"Lies /etc/hosts"},{"at":10500,"in":"\r"}]'
 * CAPTURE_CWD setzt das Arbeitsverzeichnis der Aufnahme.
 */
const pty = require('node-pty');
const fs = require('fs');

const [outfile, colsArg, totalArg, cmd, ...args] = process.argv.slice(2);
if (!outfile || !cmd) {
  console.error('Aufruf: node tools/capture-harness.js <out.jsonl> <cols> <totalMs> <cmd> [args...]');
  process.exit(2);
}
const cols = Number(colsArg) || 40;
const totalMs = Number(totalArg) || 40000;
const steps = JSON.parse(process.env.STEPS || '[]');

const start = Date.now();
const out = fs.createWriteStream(outfile);

const term = pty.spawn(cmd, args, {
  name: 'xterm-256color',
  cols,
  rows: 30,
  cwd: process.env.CAPTURE_CWD || process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color', CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' },
});

term.onData((d) => {
  out.write(JSON.stringify({ t: Date.now() - start, d: Buffer.from(d, 'utf8').toString('base64') }) + '\n');
});

for (const s of steps) setTimeout(() => { try { term.write(s.in); } catch { /* PTY schon tot */ } }, s.at);

setTimeout(() => {
  try { term.kill(); } catch { /* schon beendet */ }
  out.end(() => { console.log(`Aufnahme geschrieben: ${outfile}`); process.exit(0); });
}, totalMs);
