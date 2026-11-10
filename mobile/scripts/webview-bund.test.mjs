/**
 * Bund-Karten in der echten Seite (gebautes liquidDeckHtml) mit nachgebautem
 * ReactNativeWebView: Explorer, Zwischenablage, Snippets, Upload-Ziel.
 * Läuft nur mit Playwright (TMS_VIZ_PW), sonst übersprungen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const PW = process.env.TMS_VIZ_PW;

if (!PW) {
  test('Bund-Seitenprüfung übersprungen (kein Playwright)', { skip: 'TMS_VIZ_PW nicht gesetzt' }, () => {});
} else {
  const require = createRequire(join(PW, 'index.js'));
  const { chromium } = require('playwright');

  async function boot(vp = { width: 412, height: 915 }) {
    const src = readFileSync(process.env.TMS_DECK_TS || join(here, '../src/season2/web/liquidDeckHtml.ts'), 'utf8');
    const html = JSON.parse(src.match(/export const LIQUID_DECK_HTML = (".*");\s*$/s)[1]);
    const file = join(tmpdir(), `tms-webview-bund-${process.pid}.html`);
    writeFileSync(file, html);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: vp });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.__posts = [];
      window.ReactNativeWebView = { postMessage: (m) => window.__posts.push(JSON.parse(m)) };
    });
    try {
    await page.goto('file://' + file);
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      window.TMSBridge.setServers([
        { id: 'A', name: 'MacBook', host: 'a', port: 1, status: 'online', active: true, caps: ['dictation'], sessions: 0, os: 'macOS', latency: 10 },
        { id: 'B', name: 'Windows PC', host: 'b', port: 1, status: 'online', active: true, caps: [], sessions: 0, os: 'Windows', latency: 20 },
      ]);
    });
    } catch (e) { await browser.close(); throw e; }
    const posts = (type) => page.evaluate((t) => window.__posts.filter((p) => p.type === t), type);
    return { browser, page, errors, posts };
  }

  test('Explorer: startet auf ~/Desktop, zeigt echte Liste, Ordner-Tipp lädt Unterordner', async () => {
    const { browser, page, errors, posts } = await boot();
    try {
      await page.evaluate(() => window.__bundTool('files'));
      await page.waitForTimeout(400);
      assert.deepEqual((await posts('files:listRaw')).map((p) => p.payload.path), ['~/Desktop']);
      assert.match(await page.textContent('.fx2-list'), /Lädt/);
      await page.evaluate(() => window.TMSBridge.setFilesDir('/Users/x/Desktop', [
        { name: 'Kunden', path: '/Users/x/Desktop/Kunden', isDir: true, size: 0, modified: Date.now() },
        { name: 'rechnung.pdf', path: '/Users/x/Desktop/rechnung.pdf', isDir: false, size: 2048, modified: Date.now() },
      ], 'A'));
      const txt = await page.textContent('.fx2-list');
      assert.match(txt, /Kunden/); assert.match(txt, /rechnung\.pdf/);
      await page.click('.fx2-row[data-n="Kunden"]');
      await page.waitForTimeout(200);
      assert.equal((await posts('files:listRaw')).pop().payload.path, '/Users/x/Desktop/Kunden');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Explorer: Liste eines anderen Geräts wird verworfen und neu angefragt', async () => {
    const { browser, page, posts } = await boot();
    try {
      await page.evaluate(() => window.__bundTool('files'));
      await page.waitForTimeout(300);
      await page.evaluate(() => window.TMSBridge.setFilesDir('C:\\Users\\x\\Desktop', [{ name: 'win.txt', path: 'C:\\Users\\x\\Desktop\\win.txt', isDir: false, size: 1, modified: 0 }], 'B'));
      await page.waitForTimeout(400);
      assert.doesNotMatch(await page.textContent('.fx2-list'), /win\.txt/);
      assert.ok((await posts('files:listRaw')).length >= 2, 'neu angefragt');
    } finally { await browser.close(); }
  });

  test('Papierkorb: Bestätigung, dann trashMany mit allen gewählten Pfaden', async () => {
    const { browser, page, posts } = await boot();
    try {
      await page.evaluate(() => window.__bundTool('files'));
      await page.waitForTimeout(300);
      await page.evaluate(() => window.TMSBridge.setFilesDir('/Users/x/Desktop', [
        { name: 'a.txt', path: '/Users/x/Desktop/a.txt', isDir: false, size: 1, modified: 0 },
        { name: 'b.txt', path: '/Users/x/Desktop/b.txt', isDir: false, size: 1, modified: 0 },
      ], 'A'));
      await page.click('.fx2 [data-fx="select"]');
      await page.click('.fx2-row[data-n="a.txt"]');
      await page.click('.fx2-row[data-n="b.txt"]');
      await page.click('[data-bulk="trash"]');
      await page.waitForTimeout(300);
      assert.match(await page.textContent('.fx2-confirm'), /2 Elemente in den Papierkorb/);
      assert.equal((await posts('files:trashMany')).length, 0, 'erst nach Bestätigung');
      await page.click('.fx2-confirm [data-c="yes"]');
      await page.waitForTimeout(200);
      assert.deepEqual((await posts('files:trashMany'))[0].payload.paths.sort(), ['/Users/x/Desktop/a.txt', '/Users/x/Desktop/b.txt']);
    } finally { await browser.close(); }
  });

  test('Zwischenablage: Öffnen fragt das Handy, Einträge kommen mit Quelle', async () => {
    const { browser, page, posts } = await boot();
    try {
      await page.evaluate(() => window.__bundTool('clipboard'));
      await page.waitForTimeout(300);
      assert.equal((await posts('clipboard:open')).length, 1);
      await page.evaluate(() => window.TMSBridge.setClips([
        { id: 'c1', text: 'npm test', src: 'A', at: Date.now(), pinned: true },
        { id: 'c2', text: 'Hallo', src: 'phone', at: Date.now() - 2 * 864e5, pinned: false },
      ]));
      const txt = await page.textContent('.cb2-list');
      assert.match(txt, /npm test/); assert.match(txt, /Angeheftet/i); assert.match(txt, /Hallo/);
    } finally { await browser.close(); }
  });

  test('Snippets: starten leer, Liste kommt aus der App', async () => {
    const { browser, page, posts } = await boot();
    try {
      await page.evaluate(() => window.__bundTool('snippets'));
      await page.waitForTimeout(300);
      assert.match(await page.textContent('.sn2'), /Noch keine Snippets/);
      assert.ok((await posts('tool:open')).some((p) => p.payload.tool === 'snippets'));
      await page.evaluate(() => window.TMSBridge.setTool('snippets', [{ id: 's1', label: 'Tests', cmd: 'npm test' }]));
      assert.match(await page.textContent('.sn2'), /npm test/);
    } finally { await browser.close(); }
  });

  test('Bund-Karte: kein Demo-Knopf, Ping aktualisiert sich, Hinzufügen geht an die App', async () => {
    const { browser, page, errors, posts } = await boot();
    try {
      assert.equal(await page.locator('.bund-demo').count(), 0);
      assert.equal(await page.locator('.bund-dev').count(), 2);
      await page.evaluate(() => window.TMSBridge.setServerLatency({ A: 42, B: 87 }));
      assert.match(await page.textContent('[data-dev-lat="B"]'), /87 ms/);
      await page.evaluate(() => document.querySelector('.bund-add').click());
      assert.equal((await posts('server:add')).length, 1);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Fernzugriff → holen: Explorer bleibt auf dem gewählten Gerät', async () => {
    const { browser, page, errors, posts } = await boot();
    try {
      await page.evaluate(() => window.rxOpenFilesOn('B', 'C:\\Users\\x\\Downloads'));
      await page.waitForTimeout(300);
      assert.equal((await posts('files:openOn'))[0].payload.id, 'B');
      await page.evaluate(() => window.TMSBridge.setFilesDir('C:\\Users\\x\\Downloads', [{ name: 'setup.exe', path: 'C:\\Users\\x\\Downloads\\setup.exe', isDir: false, size: 9, modified: 0 }], 'B'));
      await page.waitForTimeout(300);
      assert.match(await page.textContent('.fx2-list'), /setup\.exe/);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Ohne Terminal vorne gilt das Gerät der App (MacBook offline)', async () => {
    const { browser, page, posts } = await boot();
    try {
      await page.evaluate(() => {
        window.TMS_DATA.sessions.length = 0;
        window.TMSBridge.setActiveDevice('B');
        window.__bundTool('files');
      });
      await page.waitForTimeout(300);
      await page.evaluate(() => window.TMSBridge.setFilesDir('C:\\Users\\x\\Desktop', [{ name: 'win.txt', path: 'C:\\Users\\x\\Desktop\\win.txt', isDir: false, size: 1, modified: 0 }], 'B'));
      await page.waitForTimeout(300);
      assert.match(await page.textContent('.fx2-list'), /win\.txt/);
    } finally { await browser.close(); }
  });

  test('Zwischenablage: Gerätefilter aus echten Geräten, Leeren erst nach Bestätigung', async () => {
    const { browser, page, posts } = await boot();
    try {
      await page.evaluate(() => window.__bundTool('clipboard'));
      await page.evaluate(() => window.TMSBridge.setClips([
        { id: 'c1', text: 'vom mac', src: 'A', at: Date.now(), pinned: false },
        { id: 'c2', text: 'vom pc', src: 'B', at: Date.now(), pinned: false },
      ]));
      await page.click('.cb2-f[data-f="B"]');
      const txt = await page.textContent('.cb2-list');
      assert.match(txt, /vom pc/); assert.doesNotMatch(txt, /vom mac/);
      await page.click('[data-cb="clear"]');
      await page.waitForTimeout(250);
      assert.match(await page.textContent('.fx2-confirm'), /Verlauf leeren/);
      assert.equal((await posts('clipboard:clear')).length, 0, 'erst nach Bestätigung');
      await page.click('.fx2-confirm [data-c="yes"]');
      assert.equal((await posts('clipboard:clear')).length, 1);
    } finally { await browser.close(); }
  });

  test('Desk: Diktat-Status aus caps, „+“ legt ein Terminal auf dem Gerät an', async () => {
    const { browser, page, errors, posts } = await boot({ width: 750, height: 800 });
    try {
      await page.evaluate(() => { window.dispatchEvent(new Event('resize')); });
      await page.waitForTimeout(500);
      assert.ok(await page.evaluate(() => document.body.classList.contains('desk')), 'Desk an');
      assert.match(await page.textContent('#deskSide .ds-foot'), /Diktat bereit/);
      await page.click('#deskSide [data-add="B"]');
      await page.waitForTimeout(300);
      const c = (await posts('terminal:create')).pop();
      assert.ok(c, 'terminal:create gesendet');
      assert.equal(c.payload.serverId, 'B');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Desk: Status-Wechsel erscheint in der Seitenleiste ohne Terminalwechsel', async () => {
    const { browser, page } = await boot({ width: 750, height: 800 });
    try {
      await page.evaluate(() => { window.dispatchEvent(new Event('resize')); });
      await page.waitForTimeout(500);
      const id = await page.evaluate(() => { window.__newTermServer = 'A'; window.addTerminal(); window.__newTermServer = null; const s = window.TMS_DATA.sessions[window.TMS_DATA.sessions.length - 1]; s.status = 'running'; window.TMSBridge.setServers(window.TMS_DATA.servers); return s.id; });
      await page.waitForTimeout(300);
      await page.evaluate((i) => window.updateStatusChip(i, 'waiting'), id);
      await page.waitForTimeout(400);
      assert.match(await page.textContent('#deskSide'), /FRAGE/);
    } finally { await browser.close(); }
  });

  test('Ohne Insel: ⋮-Menü hat Neues Terminal + Fernzugriff je Gerät', async () => {
    const { browser, page, errors, posts } = await boot();
    try {
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('statusHeader')).display), 'none', 'Insel weg');
      await page.evaluate(() => { window.__newTermServer = 'A'; window.addTerminal(); window.__newTermServer = null; });
      await page.waitForTimeout(400);
      await page.evaluate(() => document.querySelector('.term-card .card-menu-btn').click());
      await page.waitForTimeout(300);
      const txt = await page.textContent('.card-menu');
      assert.match(txt, /Neues Terminal/); assert.match(txt, /Fernzugriff/);
      assert.equal(await page.evaluate(() => document.querySelector('.card-menu [data-bm-list="term"]').hidden), true, 'Geräte erst nach dem Aufklappen');
      await page.evaluate(() => document.querySelector('.card-menu [data-bm-open="term"]').click());
      await page.waitForTimeout(150);
      const devs = await page.evaluate(() => [...document.querySelectorAll('.card-menu [data-bm-list="term"] .bm-dev__name')].map((x) => x.textContent));
      assert.deepEqual(devs, ['MacBook', 'Windows PC'], 'untereinander aufgelistet');
      assert.ok(await page.locator('.card-menu').count(), 'Menü bleibt beim Aufklappen offen');
      const before = (await posts('terminal:create')).length;
      await page.evaluate(() => document.querySelector('.card-menu [data-bm="term"][data-srv="B"]').click());
      await page.waitForTimeout(300);
      const c = (await posts('terminal:create')).slice(before);
      assert.equal(c.length, 1); assert.equal(c[0].payload.serverId, 'B');
      assert.equal(await page.locator('.card-menu').count(), 0, 'Menü zu');
      await page.evaluate(() => { window.__remoteCalls = []; window.__openRemoteFor = (id) => window.__remoteCalls.push(id); });
      await page.evaluate(() => document.querySelector('.term-card .card-menu-btn').click());
      await page.waitForTimeout(300);
      await page.evaluate(() => document.querySelector('.card-menu [data-bm-open="remote"]').click());
      await page.evaluate(() => document.querySelector('.card-menu [data-bm="remote"][data-srv="B"]').click());
      assert.deepEqual(await page.evaluate(() => window.__remoteCalls), ['B']);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  // Antwortet wie die App: tool:open → setTool mit Daten (so lief die Schleife).
  const fakeRN = (page) => page.evaluate(() => {
    const rn = window.ReactNativeWebView, orig = rn.postMessage;
    rn.postMessage = (m) => {
      orig(m);
      const { type, payload } = JSON.parse(m);
      if (type === 'tool:open') setTimeout(() => {
        if (payload.tool === 'snippets') window.TMSBridge.setTool('snippets', []);
        if (payload.tool === 'files') window.TMSBridge.setTool('files', [], '~');
        if (payload.tool === 'screenshots') window.TMSBridge.setTool('screenshots', []);
      }, 30);
    };
  });

  test('Snippets: öffnen, anlegen, mit ✕ schließen — kein Wieder-Aufspringen', async () => {
    const { browser, page, errors, posts } = await boot();
    try {
      await fakeRN(page);
      await page.evaluate(() => window.openToolSheet('snippets'));
      await page.waitForTimeout(700);
      assert.ok((await posts('tool:open')).length <= 1, 'keine Schleife: ' + (await posts('tool:open')).length);
      await page.evaluate(() => document.querySelector('.sn2 [data-sn="new"]').click());
      await page.waitForTimeout(200);
      assert.equal(await page.locator('#snName').count(), 1, 'Formular zum Anlegen');
      await page.evaluate(() => document.querySelector('.sn2 [data-sn="close"]').click());
      await page.waitForTimeout(900);
      assert.equal(await page.evaluate(() => document.querySelector('.sn2').hidden), true, 'zu und bleibt zu');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Explorer: Tipp aufs Terminal dahinter schließt die halbe Karte', async () => {
    const { browser, page, posts } = await boot();
    try {
      await fakeRN(page);
      await page.evaluate(() => window.openToolSheet('files'));
      await page.waitForTimeout(500);
      await page.mouse.click(200, 120); // oberhalb der halben Karte = Terminal-Bereich
      await page.waitForTimeout(500);
      await page.evaluate(() => window.TMSBridge.setTool('files', [], '~')); // spätere Antwort der App
      await page.waitForTimeout(600);
      assert.equal(await page.evaluate(() => document.querySelector('.fx2').classList.contains('is-open')), false, 'Explorer zu');
      assert.ok((await posts('tool:open')).length <= 1);
    } finally { await browser.close(); }
  });

  test('Bilder: alte Karte mit Kamera + Galerie, schließt nach dem Upload, keine zweite Galerie', async () => {
    const { browser, page, posts } = await boot();
    try {
      await fakeRN(page);
      await page.evaluate(() => window.openToolSheet('screenshots'));
      await page.waitForTimeout(500);
      assert.equal((await posts('shot:capture')).length, 0, 'Galerie nicht ungefragt');
      assert.equal(await page.locator('#shotCaptureBtn').count(), 1, 'Kamera');
      assert.equal(await page.locator('#shotPickBtn').count(), 1, 'Galerie');
      await page.evaluate(() => document.getElementById('shotPickBtn').click());
      await page.evaluate(() => { window.TMSBridge.uploadProgress(0, 2, 'A'); window.TMSBridge.uploadProgress(1, 2, 'A'); });
      await page.waitForTimeout(300);
      assert.match(await page.textContent('#toolSheetWrap'), /1 von 2/);
      await page.evaluate(() => { window.TMSBridge.uploadProgress(2, 2, 'A'); window.TMSBridge.uploadFinished([], '2 Bilder hochgeladen'); });
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => { const w = document.getElementById('toolSheetWrap'); return w.hidden || !w.classList.contains('is-open') && getComputedStyle(w).visibility !== 'visible' || getComputedStyle(w).display === 'none' || getComputedStyle(w).opacity === '0'; }), true, 'Karte zu');
      const caps = await posts('shot:capture');
      assert.equal(caps.length, 1, 'genau eine Galerie');
      assert.equal(caps[0].payload.source, 'library');
      assert.ok('cardId' in caps[0].payload, 'Zielkarte steht fest');
    } finally { await browser.close(); }
  });

  test('Fernzugriff aktiv: ruhiger grüner Ring um ⋮, Puls nur einmal beim Zurückkehren, Menü ohne Bewegung', async () => {
    const { browser, page, errors } = await boot();
    try {
      await page.evaluate(() => { window.__newTermServer = 'A'; window.addTerminal(); window.__newTermServer = null; });
      await page.waitForTimeout(400);
      const btn = () => page.evaluate(() => { const b = document.querySelector('.term-card .card-menu-btn'); const a = getComputedStyle(b, '::after'); return { border: getComputedStyle(b).borderTopColor, anim: a.animationName, iter: a.animationIterationCount }; });
      const plain = (await btn()).border;
      await page.evaluate(() => window.__setRemoteAlive('B', true));
      let st = await btn();
      assert.notEqual(st.border, plain, 'grüner Ring sichtbar');
      assert.equal(st.anim, 'none', 'kein Dauer-Pulsieren');
      // Vom Fernzugriff zurück zu den Terminals → genau ein Puls
      await page.evaluate(() => { document.body.classList.add('remote-focus'); });
      await page.waitForTimeout(100);
      await page.evaluate(() => { document.body.classList.remove('remote-focus'); });
      await page.waitForTimeout(150);
      st = await btn();
      assert.equal(st.anim, 'tmsLivePulse', 'Puls beim Zurückkehren');
      assert.equal(st.iter, '1', 'genau einmal');
      await page.waitForTimeout(3200);
      st = await btn();
      assert.equal(st.anim, 'none', 'danach Ruhe');
      assert.notEqual(st.border, plain, 'Ring bleibt');
      // Menü: Hinweis ohne Bewegung, aufgeklappt am laufenden Gerät
      await page.evaluate(() => document.querySelector('.term-card .card-menu-btn').click());
      await page.waitForTimeout(250);
      const rowAnim = await page.evaluate(() => getComputedStyle(document.querySelector('.card-menu [data-bm-open="remote"] .bm-ic'), '::after').animationName);
      assert.equal(rowAnim, 'none');
      assert.ok(await page.evaluate(() => document.querySelector('.card-menu [data-bm-open="remote"]').classList.contains('is-live')), 'Zeile markiert');
      await page.evaluate(() => document.querySelector('.card-menu [data-bm-open="remote"]').click());
      await page.waitForTimeout(150);
      assert.ok(await page.evaluate(() => document.querySelector('.card-menu [data-bm="remote"][data-srv="B"]').classList.contains('is-alive')), 'laufendes Gerät markiert');
      await page.evaluate(() => { document.querySelectorAll('.card-menu').forEach((m) => m.remove()); document.body.classList.add('compact-terminal'); document.body.classList.remove('desk'); });
      assert.equal((await btn()).border, plain, 'Splitscreen: kein Ring');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Fernzugriff beenden aus dem ⋮-Menü: ✕, Rückfrage, Abbrechen/Beenden', async () => {
    const { browser, page, errors } = await boot();
    try {
      await page.evaluate(() => { window.__newTermServer = 'A'; window.addTerminal(); window.__newTermServer = null; });
      await page.waitForTimeout(400);
      await page.evaluate(() => { window.__setRemoteAlive('B', true); window.__closed = []; window.__closeRemoteDevice = (id) => window.__closed.push(id); });
      const openList = async () => {
        await page.evaluate(() => document.querySelector('.term-card .card-menu-btn').click());
        await page.waitForTimeout(250);
        await page.evaluate(() => document.querySelector('.card-menu [data-bm-open="remote"]').click());
        await page.waitForTimeout(150);
      };
      await openList();
      assert.equal(await page.locator('.card-menu [data-bm-stop="A"]').count(), 0, 'nur laufende Sitzungen haben ✕');
      await page.evaluate(() => document.querySelector('.card-menu [data-bm-stop="B"]').click());
      await page.waitForTimeout(150);
      assert.match(await page.textContent('.card-menu'), /Fernzugriff auf Windows PC beenden\?/);
      await page.evaluate(() => document.querySelector('.card-menu [data-bm-confirm="no"]').click());
      await page.waitForTimeout(150);
      assert.deepEqual(await page.evaluate(() => window.__closed), [], 'Abbrechen beendet nichts');
      assert.equal(await page.locator('.card-menu [data-bm-stop="B"]').count(), 1, 'Liste wieder da');
      await page.evaluate(() => document.querySelector('.card-menu [data-bm-stop="B"]').click());
      await page.waitForTimeout(150);
      await page.evaluate(() => document.querySelector('.card-menu [data-bm-confirm="yes"]').click());
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => window.__closed), ['B']);
      assert.equal(await page.locator('.card-menu').count(), 0, 'Menü zu');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
