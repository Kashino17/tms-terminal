// Dateien-Ansichten: Pfade im Format des SERVERS (Mac/Linux und Windows).
// Fehlerbild 2026-11-05: Nach dem Wechsel Windows → Mac fragte die Leiste den
// Mac nach "C:\Users\…\Desktop" (HTTP 400) und blieb dort hängen; „Aufwärts“
// verstand unter Windows keine Backslashes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parentDir, joinDir, isWindowsPath } from '../src/season2/web/filePaths.ts';

const html = fs.readFileSync(new URL('../../mockups/season2/liquid-deck/index.html', import.meta.url), 'utf8');
const block = /\/\/ ── TMS-TEST-EXPORT: fsPath ──([\s\S]*?)\/\/ ── \/TMS-TEST-EXPORT ──/.exec(html)[1];
const page = vm.createContext({});
vm.runInContext(block + ';this.fsParent = fsParent; this.fsCrumbs = fsCrumbs;', page);

const PARENTS = [
  ['C:\\Users\\kashi\\Desktop', 'C:\\Users\\kashi'],
  ['C:\\Users', 'C:\\'],
  ['C:\\', 'C:\\'],
  ['C:\\Users\\kashi\\Desktop\\', 'C:\\Users\\kashi'],
  ['/Users/ayysir/Desktop', '/Users/ayysir'],
  ['/Users', '/'],
  ['/', '/'],
  ['~', '~'],
  ['~/Desktop', '~'],
];
test('Aufwärts: App und Seite rechnen gleich — Mac und Windows', () => {
  for (const [p, want] of PARENTS) {
    assert.equal(parentDir(p), want, `App: ${p}`);
    assert.equal(page.fsParent(p), want, `Seite: ${p}`);
  }
});
test('Ordner öffnen hängt im Trennzeichen des Servers an', () => {
  assert.equal(joinDir('C:\\Users\\kashi', 'Desktop/'), 'C:\\Users\\kashi\\Desktop');
  assert.equal(joinDir('C:\\', 'Users'), 'C:\\Users');
  assert.equal(joinDir('/Users/ayysir/', 'Desktop/'), '/Users/ayysir/Desktop');
  assert.equal(joinDir('~', 'Desktop'), '~/Desktop');
  assert.equal(isWindowsPath('C:\\x'), true);
  assert.equal(isWindowsPath('/Users/x'), false);
});
test('Brotkrumen führen zu gültigen Server-Pfaden', () => {
  const plain = (x) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(plain(page.fsCrumbs('C:\\Users\\kashi\\Desktop')).map((c) => c.target),
    ['C:\\', 'C:\\Users', 'C:\\Users\\kashi', 'C:\\Users\\kashi\\Desktop']);
  assert.deepEqual(plain(page.fsCrumbs('/Users/ayysir')).map((c) => c.target), ['/Users', '/Users/ayysir']);
  assert.deepEqual(plain(page.fsCrumbs('~/Desktop')).map((c) => c.target), ['~', '~/Desktop']);
});
