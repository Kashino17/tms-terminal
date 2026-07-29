/**
 * Spielt echte, aufgezeichnete PTY-Ströme durch einen echten Spiegel und prüft,
 * was der Klassifikator daraus macht. Das ist die einzige Prüfung, die eine
 * neue Harness-Version abfängt, bevor sie am Handy auffällt.
 *
 * Neue Aufnahmen: `node tools/capture-harness.js` (siehe Kopf jener Datei),
 * dann Bildschirm sichten und einen Eintrag in manifest.json ergänzen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SessionMirror } from '../terminal/emulator.mirror';
import { classifyScreen } from './prompt.classifier';

const DIR = path.resolve(__dirname, '../../test/fixtures/harness');
const MANIFEST = path.join(DIR, 'manifest.json');

interface Entry { file: string; cols: number; expect: string; note: string }

const entries: Entry[] = fs.existsSync(MANIFEST)
  ? (JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Entry[])
  : [];

test('Fixture-Korpus ist nicht leer', () => {
  assert.ok(entries.length > 0, 'mindestens eine Aufnahme muss im Manifest stehen');
});

for (const entry of entries) {
  test(`Replay: ${entry.file} → ${entry.expect} (${entry.note})`, async () => {
    const file = path.join(DIR, entry.file);
    assert.ok(fs.existsSync(file), `Aufnahme fehlt: ${entry.file}`);

    const mirror = new SessionMirror(entry.cols, 30);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const chunk = JSON.parse(line) as { t: number; d: string };
      mirror.feed(Buffer.from(chunk.d, 'base64').toString('utf8'));
    }
    await mirror.flushed();

    const view = mirror.screen();
    const cls = classifyScreen(view);
    assert.equal(cls.kind, entry.expect, `Bildschirm:\n${view.rows.join('\n')}`);
    if (entry.expect === 'permission') assert.equal(cls.key, '\r');
    if (entry.expect === 'question') assert.equal(cls.key, null);
    mirror.dispose();
  });
}
