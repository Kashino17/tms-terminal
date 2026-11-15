import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DictationCaptureStore, DictationCapture } from './dictation.capture';

const tmpDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tms-dict-cap-')), 'captures');
const cap = (id: string, at: number): DictationCapture => ({
  id, at, samples: new Float32Array(16000).fill(0.25),
  pieces: [{ from: 0, to: 16000, raw: 'neunundvierzig', text: 'neunundvierzig' }], text: 'neunundvierzig',
});

test('saves the audio as 16 kHz WAV next to a JSON with pieces and text', () => {
  const dir = tmpDir();
  const st = new DictationCaptureStore(dir, 30, () => 1000);
  st.save(cap('d1', 1000));
  const files = fs.readdirSync(dir).sort();
  assert.strictEqual(files.length, 2);
  const wav = fs.readFileSync(path.join(dir, files.find((f) => f.endsWith('.wav'))!));
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.readUInt32LE(24), 16000);
  assert.strictEqual(wav.length, 44 + 16000 * 2);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, files.find((f) => f.endsWith('.json'))!), 'utf8'));
  assert.strictEqual(meta.id, 'd1');
  assert.strictEqual(meta.text, 'neunundvierzig');
  assert.strictEqual(meta.audioSecs, 1);
  assert.deepStrictEqual(meta.pieces, [{ from: 0, to: 16000, raw: 'neunundvierzig', text: 'neunundvierzig' }]);
});

test('owner-only: directory 0700, files 0600', () => {
  const dir = tmpDir();
  new DictationCaptureStore(dir, 30, () => 1000).save(cap('d1', 1000));
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  for (const f of fs.readdirSync(dir)) assert.strictEqual(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
});

test('keeps only the newest N dictations', () => {
  const dir = tmpDir();
  const st = new DictationCaptureStore(dir, 3, () => 10_000);
  for (let i = 0; i < 5; i++) st.save(cap(`d${i}`, 1000 + i));
  const ids = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).id).sort();
  assert.deepStrictEqual(ids, ['d2', 'd3', 'd4']);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).length, 3);
});

test('drops dictations older than three days', () => {
  const dir = tmpDir();
  const day = 24 * 3600_000;
  let now = 0;
  const st = new DictationCaptureStore(dir, 30, () => now);
  st.save(cap('old', 0));
  now = 4 * day;
  st.save(cap('new', now));
  const ids = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).id);
  assert.deepStrictEqual(ids, ['new']);
});
