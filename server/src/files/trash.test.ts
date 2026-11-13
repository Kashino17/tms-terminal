import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trashPaths, winTrashCommand } from './file.handler';

test('Sammel-Löschen: ein Fehler stoppt nicht den Rest, Fehlschläge werden gemeldet', () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.tms-trash-test-'));
  try {
    const a = path.join(dir, 'a.txt'), sub = path.join(dir, 'ordner'), b = path.join(dir, 'b.txt');
    fs.writeFileSync(a, 'a'); fs.mkdirSync(sub); fs.writeFileSync(path.join(sub, 'x'), 'x'); fs.writeFileSync(b, 'b');
    const done: string[] = [];
    const r = trashPaths([a, sub, b], (p) => { if (p === a) throw new Error('gesperrt'); done.push(p); });
    assert.deepEqual(done, [sub, b], 'Ordner und weitere Dateien trotzdem');
    assert.equal(r.trashed, 2);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].path, a);
    assert.match(r.failed[0].error, /gesperrt/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Sammel-Löschen: außerhalb Home, Schutzordner und Fehlendes landen bei failed', () => {
  const r = trashPaths(['/etc/hosts', '~/.ssh', '~/gibt-es-nicht-' + Date.now()], () => { throw new Error('darf nicht aufgerufen werden'); });
  assert.equal(r.trashed, 0);
  assert.equal(r.failed.length, 3);
});

test('Windows: Ordner per DeleteDirectory, Dateien per DeleteFile, Pfad nur über die Umgebung', () => {
  const c = winTrashCommand("C:\\Users\\x\\Desktop\\Kunden $neu 'alt'");
  assert.equal(c.file, 'powershell.exe');
  const script = c.args.join(' ');
  assert.match(script, /DeleteDirectory/);
  assert.match(script, /DeleteFile/);
  assert.match(script, /Test-Path -LiteralPath \$p -PathType Container/);
  assert.match(script, /SendToRecycleBin/);
  assert.doesNotMatch(script, /Kunden/, 'Pfad steht nicht im Befehl (kein Quoting-Risiko)');
  assert.equal(c.env.TMS_TRASH_PATH, "C:\\Users\\x\\Desktop\\Kunden $neu 'alt'");
});
