// Bund: kein Hauptserver. Welches Gerät bedient Dateien, Upload, Diktat?
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeDeviceId, deviceForSession, dictationDeviceId, speechDeviceId, deviceColor } from '../src/season2/bund/devices.core.mjs';

const mac = { id: 'srv-mac', online: true, caps: ['dictation'] };
const win = { id: 'srv-win', online: true, caps: [] };
const map = { s1: 'srv-mac', s2: 'srv-win' };

test('Terminal vorne bestimmt das Gerät', () => {
  assert.equal(activeDeviceId('s2', map, [mac, win]), 'srv-win');
  assert.equal(activeDeviceId('s1', map, [mac, win]), 'srv-mac');
});

test('MacBook offline, Terminal vorne auf WIN → WIN', () => {
  assert.equal(activeDeviceId('s2', map, [{ ...mac, online: false }, win]), 'srv-win');
});

test('kein Terminal vorne → erstes online-Gerät, nie ein offline-Gerät', () => {
  assert.equal(activeDeviceId(null, map, [{ ...mac, online: false }, win]), 'srv-win');
  assert.equal(activeDeviceId(null, map, [{ ...mac, online: false }]), null);
});

test('Terminal eines unbekannten Geräts → erstes online', () => {
  assert.equal(activeDeviceId('s9', map, [mac, win]), 'srv-mac');
});

test('deviceForSession', () => {
  assert.equal(deviceForSession(map, 's2', [mac, win]), 'srv-win');
  assert.equal(deviceForSession(map, 's9', [mac, win]), null);
});

test('Diktat: erstes online-Gerät mit caps.dictation, sonst null', () => {
  assert.equal(dictationDeviceId([win, mac]), 'srv-mac');
  assert.equal(dictationDeviceId([{ ...mac, online: false }, win]), null);
});

test('Gerätefarben nach Position', () => {
  assert.equal(deviceColor(0), '#9b8cff');
  assert.equal(deviceColor(1), '#3bc9db');
  assert.equal(deviceColor(2), '#f59f00');
  assert.equal(deviceColor(3), '#9b8cff');
});

test('Vorlesen in der geklonten Stimme: das Gerät, das sie hat — sonst keins (dann spricht das Handy selbst)', () => {
  const mac = { id: 'mac', online: true, caps: ['dictation', 'speech'] };
  const win = { id: 'win', online: true, caps: [] };
  assert.equal(speechDeviceId([win, mac]), 'mac');
  assert.equal(speechDeviceId([win, { ...mac, online: false }]), null, 'Mac nicht erreichbar');
  assert.equal(speechDeviceId([win, { id: 'alt', online: true, caps: ['dictation'] }]), null, 'älterer Server ohne Stimme');
});
