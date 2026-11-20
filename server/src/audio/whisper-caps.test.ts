import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dictationAvailable } from './whisper-sidecar';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-'));
const script = path.join(tmp, 'whisper_sidecar_mlx.py');
const py = path.join(tmp, 'python3');

test('ohne Sidecar-Skript: kein Diktat', () => {
  assert.strictEqual(dictationAvailable(script, py, 'darwin'), false);
});

test('Skript + venv-Python auf macOS: Diktat verfügbar', () => {
  fs.writeFileSync(script, '');
  fs.writeFileSync(py, '');
  assert.strictEqual(dictationAvailable(script, py, 'darwin'), true);
});

test('Windows: nie (mlx gibt es nur auf dem Mac)', () => {
  assert.strictEqual(dictationAvailable(script, py, 'win32'), false);
});
