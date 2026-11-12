/**
 * Tests fuer den Samsung DeX USB-C Monitor-Modus (Variante A):
 *  1) DeX-Nachrichten in SeasonTwoWebRoot.tsx liegen VOR dem Server-Verbindungs-Guard
 *  2) computeDeXViewportSpec berechnet 16px-ausgerichtete 4:3 iPad-Aufloesungen ohne schwarze Balken
 *  3) Direct-Touch & Apple Pencil (touch/pen) sowie Terminal-Split-Stage in bridge.js
 *  4) One UI 8 VirtualDisplay-Flags & H.264 Annex-B Framing in DeXShellServer.java
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const webRootSource = readFileSync(join(here, '../src/season2/SeasonTwoWebRoot.tsx'), 'utf8');
const bridgeSource = readFileSync(join(here, '../src/season2/web/bridge.js'), 'utf8');
const dexJavaSource = readFileSync(
  join(here, '../android/app/src/main/java/com/tms/terminal/dex/DeXShellServer.java'),
  'utf8',
);

test('alle dex:-Nachrichten in SeasonTwoWebRoot stehen VOR dem Server-Verbindungs-Guard', () => {
  const guardIdx = webRootSource.indexOf('if (!ws || !anchorId) return;');
  assert.notEqual(guardIdx, -1, 'Server-Guard muss existieren');

  for (const msg of ['dex:openTether', 'dex:startEngine', 'dex:manualStop']) {
    const idx = webRootSource.indexOf(`case '${msg}'`);
    assert.notEqual(idx, -1, `case '${msg}' fehlt in SeasonTwoWebRoot.tsx`);
    assert.ok(
      idx < guardIdx,
      `case '${msg}' muss VOR dem Server-Guard stehen, damit Fold 7 ↔ iPad ohne PC-Server funktioniert`,
    );
  }
});

test('computeDeXViewportSpec berechnet 16px-ausgerichtete 4:3 Vollbild-Aufloesung fuer das iPad', () => {
  const start = bridgeSource.indexOf('function computeDeXViewportSpec(vw, vh, dpr)');
  const end = bridgeSource.indexOf('window.computeDeXViewportSpec = computeDeXViewportSpec;');
  assert.ok(start > 0 && end > start, 'computeDeXViewportSpec muss in bridge.js existieren');

  const ctx = vm.createContext({ Math, Number });
  vm.runInContext(bridgeSource.slice(start, end), ctx);

  // Klassisches 4:3 iPad (1024x768 @ 2x) -> 2048x1536 @ 60fps
  const ipad43 = ctx.computeDeXViewportSpec(1024, 768, 2);
  assert.equal(ipad43.maxWidth, 2048);
  assert.equal(ipad43.maxHeight, 1536);
  assert.equal(ipad43.fps, 60);
  assert.equal(ipad43.bitrateKbps, 6000);
  assert.equal(ipad43.mode, 'dex');
  assert.equal(ipad43.localCursor, true);
  assert.equal(ipad43.maxWidth % 16, 0);
  assert.equal(ipad43.maxHeight % 16, 0);

  // Auch hochkant gemeldete Maße werden fuer den DeX-Monitor quer ausgerichtet
  const portraitCall = ctx.computeDeXViewportSpec(768, 1024, 2);
  assert.deepEqual(portraitCall, ipad43);

  // 11" iPad Pro (1194x834) -> durch 16 teilbare Hoehe (1424)
  const ipadPro11 = ctx.computeDeXViewportSpec(1194, 834, 2);
  assert.equal(ipadPro11.maxWidth, 2048);
  assert.equal(ipadPro11.maxHeight, 1424);
  assert.equal(ipadPro11.maxHeight % 16, 0);
});

test('bridge.js stellt startDeXMonitor, stopDeXMonitor, Direct-Touch und Terminal-Split-Dock bereit', () => {
  assert.ok(bridgeSource.includes('window.TMSBridge.startDeXMonitor = function'), 'startDeXMonitor fehlt');
  assert.ok(bridgeSource.includes('window.TMSBridge.stopDeXMonitor = function'), 'stopDeXMonitor fehlt');
  assert.ok(bridgeSource.includes('window.TMSBridge.setDeXHostStatus = function'), 'setDeXHostStatus fehlt');
  // Finger/Stift bedient die Buehne im DeX-Modus direkt (rxIsDirect im Mockup); Tastatur,
  // Trackpad-Hover und -Scrollen kommen nativ vom iPad (TMSUsbRelay) ueber dexInput.
  assert.ok(bridgeSource.includes('window.TMSBridge.dexInput = function'), 'native iPad-Eingaben (dexInput) fehlen');
  assert.ok(bridgeSource.includes('dexTerminalDock'), 'DeX + Terminal Split-Stage Dock fehlt');
});

test('DeXShellServer.java enthaelt One UI 8 DeX VirtualDisplay-Flags, Annex-B Header und Display-Input-Injektion', () => {
  assert.ok(
    dexJavaSource.includes('VIRTUAL_DISPLAY_FLAG_SHOULD_SHOW_SYSTEM_DECORATIONS'),
    'SHOULD_SHOW_SYSTEM_DECORATIONS Flag fuer One UI 8 DeX fehlt',
  );
  assert.ok(
    dexJavaSource.includes('VIRTUAL_DISPLAY_FLAG_TRUSTED'),
    'TRUSTED Flag fuer DeX System-Dekorationen & Input fehlt',
  );
  assert.ok(
    dexJavaSource.includes('VIRTUAL_DISPLAY_FLAG_OWN_DISPLAY_GROUP'),
    'OWN_DISPLAY_GROUP Flag fuer unabhaengigen Fold-7-Hauptbildschirm fehlt',
  );
  assert.ok(
    dexJavaSource.includes('getDeclaredMethod("setDisplayId", int.class)'),
    'Zielgerichtete Input-Injektion auf die DeX-displayId fehlt',
  );
  assert.ok(
    dexJavaSource.includes('public static byte[] packAccessUnit'),
    '5-Byte TMSRemote Annex-B Paketierung fehlt',
  );
});
