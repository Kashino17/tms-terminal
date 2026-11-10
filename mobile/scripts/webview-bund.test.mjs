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

  // Der echte Weg bis zum Rechner (nachgebildete Verbindungen): die Sitzung
  // läuft, der Nutzer ist zurück im Terminal (Bild pausiert, Verbindung offen).
  // „Beenden“ im ⋮-Menü muss das Stopp über DIESE Verbindung schicken und den
  // grünen Ring erst nach der Bestätigung des Rechners wegnehmen.
  async function fakeRemote(page, { answer = true } = {}) {
    await page.evaluate((answer) => {
      window.__socks = [];
      window.WebSocket = class {
        constructor(url) {
          this.url = url; this.sent = []; this.readyState = 0; window.__socks.push(this);
          setTimeout(() => {
            this.readyState = 1; this.onopen && this.onopen();
          }, 10);
        }
        send(d) {
          this.sent.push(d);
          const t = JSON.parse(d).type;
          const reply = (type) => setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ type, payload: { width: 100, height: 50, scale: 1, fps: 30, reason: 'x' } }) }), 5);
          if (t === 'remote:start') reply('remote:started');
          if (t === 'remote:stop' && answer) reply('remote:stopped'); // stumm = Rechner setzt das Stopp nicht um
        }
        close() { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose && this.onclose({}), 5); }
      };
    }, answer);
    await page.evaluate(() => {
      window.__newTermServer = 'A'; window.addTerminal(); window.__newTermServer = null;
      window.__tmsOpenRemote('B');
      window.TMSBridge.setRemoteTarget({ id: 'B', host: 'b', port: 1, token: 't' });
      window.TMSRemote.start('auto');
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => window.TMSRemote.suspend()); // zurück im Terminal
    await page.waitForTimeout(400);
  }
  async function endFromMenu(page) {
    await page.evaluate(() => document.querySelector('.term-card .card-menu-btn').click());
    await page.waitForTimeout(250);
    await page.evaluate(() => document.querySelector('.card-menu [data-bm-open="remote"]').click());
    await page.waitForTimeout(150);
    await page.evaluate(() => document.querySelector('.card-menu [data-bm-stop="B"]').click());
    await page.waitForTimeout(150);
    await page.evaluate(() => document.querySelector('.card-menu [data-bm-confirm="yes"]').click());
    await page.waitForTimeout(100);
  }
  const alive = (page) => page.evaluate(() => document.body.classList.contains('remote-alive'));

  test('Fernzugriff beenden aus dem Menü erreicht den Rechner über die offene Verbindung', async () => {
    const { browser, page, errors, posts } = await boot();
    try {
      await fakeRemote(page);
      assert.equal(await alive(page), true, 'Sitzung läuft');
      await endFromMenu(page);
      const live = await page.evaluate(() => window.__socks[0].sent.map((d) => JSON.parse(d).type));
      assert.ok(live.includes('remote:stop'), 'Stopp geht über die laufende Verbindung: ' + live.join(','));
      // Zur Bestätigung zusätzlich über eine frische Verbindung (falls die alte halb tot ist).
      const ask = (await posts('remote:open')).pop();
      assert.equal(ask.payload.id, 'B');
      assert.equal(ask.payload.closing, true, 'App weiß, dass es ums Beenden geht');
      await page.evaluate(() => window.TMSBridge.setRemoteTarget({ id: 'B', host: 'b', port: 1, token: 't' }));
      await page.waitForTimeout(150);
      assert.equal(await alive(page), false, 'Ring weg — der Rechner hat bestätigt');
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => window.__socks.filter((s) => s.readyState !== 3).length), 0, 'keine Verbindung bleibt offen, kein Neuaufbau');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Fernzugriff beenden: Rechner bestätigt nicht → Ring bleibt, ehrliche Meldung', async () => {
    const { browser, page, errors } = await boot();
    try {
      await fakeRemote(page, { answer: false });
      await page.evaluate(() => { window.__tmsCloseConfirmMs = 1500; window.__toasts = []; const t = window.toast; window.toast = (m) => { window.__toasts.push(m); return t && t(m); }; });
      // Halb tote Verbindung: das Stopp darüber kommt nie an.
      await page.evaluate(() => { window.__socks[0].send = function (d) { this.sent.push(d); }; });
      await endFromMenu(page);
      await page.evaluate(() => window.TMSBridge.setRemoteTarget({ id: 'B', host: 'b', port: 1, token: 't' }));
      await page.waitForTimeout(1000);
      assert.equal(await alive(page), true, 'ohne Bestätigung nicht „beendet“ (früher nach 0,8 s blind)');
      await page.waitForTimeout(900);
      assert.equal(await alive(page), true, 'nicht bestätigt = weiter als laufend markiert');
      assert.ok((await page.evaluate(() => window.__toasts)).some((m) => /nicht erreichbar/.test(m)));
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Einstellungen: eine Seite, echte Werte aus der App, Schalter senden an die App', async () => {
    const { browser, page, errors, posts } = await boot();
    try {
      await page.evaluate(() => { document.body.classList.remove('is-locked'); window.show('settings'); });
      await page.waitForTimeout(300);
      // Ohne Werte der App: nichts Erfundenes
      assert.match(await page.textContent('.st-quick'), /Wird geprüft/);
      assert.equal(await page.locator('#bubbleSettingsGroup, .settings-group, #s2ClassicSettings').count(), 0, 'alte Gruppen sind weg');
      await page.evaluate(() => {
        window.TMSBridge.setSettings({ voicePrompt: true, browserBridge: false, persistent: true, appLock: true, lockGrace: 300, version: '1.141.0', prevVersion: { version: '1.140.0', size: '31 MB' } });
        window.TMSBridge.bubbleStatus({ serviceOn: true, bound: true, enabled: true, snoozedUntil: 0, keepAlive: true, notifications: true });
      });
      await page.waitForTimeout(150);
      assert.match(await page.textContent('.st-quick'), /Aktiv/);
      assert.match(await page.textContent('.st-cat[data-st-go="sicherheit"]'), /App-Sperre an · entsperrt 5 Min\./);
      assert.match(await page.textContent('.st-cat[data-st-go="diktat"]'), /KI-Prompt an/);
      assert.match(await page.textContent('.st-cat[data-st-go="app"]'), /Version 1\.141\.0/);
      // Bubble-Schalter im Schnellzugriff → bestehende Bubble-Nachricht
      await page.click('.st-quick .switch');
      assert.deepEqual((await posts('bubble:toggle')).pop().payload, { enabled: false });
      // Unterseite + Schalter → settings:set
      await page.click('.st-cat[data-st-go="diktat"]');
      await page.waitForTimeout(200);
      assert.ok((await posts('bubble:status')).length >= 1, 'frischer Bubble-Stand beim Öffnen');
      await page.click('[data-st-row="voice-prompt"] .switch');
      assert.deepEqual((await posts('settings:set')).pop().payload, { key: 'voicePrompt', value: false });
      // Zurück-Geste: Unterseite → Übersicht, Bildschirm bleibt
      await page.evaluate(() => window.TMSBridge.handleBack());
      await page.waitForTimeout(150);
      assert.equal(await page.locator('.st-head').count(), 0);
      assert.equal(await page.evaluate(() => document.querySelector('[data-screen="settings"]').hidden), false);
      // App-Sperre: fragt die App (PIN), kippt nicht selbst um
      await page.click('.st-cat[data-st-go="sicherheit"]');
      await page.waitForTimeout(150);
      await page.click('[data-st-row="app-lock"] .switch');
      assert.deepEqual((await posts('settings:set')).pop().payload, { key: 'appLock', value: false });
      assert.equal(await page.evaluate(() => document.querySelector('[data-st-switch="appLock"]').checked), true, 'bleibt an, bis die App es bestätigt');
      await page.click('[data-st-act="lock:now"]');
      assert.equal((await posts('lock:now')).length, 1);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Einstellungen: Gebetsruf automatisch (Methode nach Land), Erlaubnis-Liste, nächster Azān', async () => {
    const { browser, page, errors, posts } = await boot();
    try {
      await page.evaluate(() => {
        document.body.classList.remove('is-locked');
        window.TMSBridge.setPrayer([{ name: 'Fajr', time: '05:12' }, { name: 'Dhuhr', time: '13:10' }],
          { location: { label: 'Kuala Lumpur, Malaysia' }, method: { id: 'auto', name: 'JAKIM (Malaysia)', auto: true, country: 'MY' },
            adhan: { enabled: true, wecker: false, selected: 'nafees' },
            perms: { notifications: true, exactAlarms: true, overlay: false, fullscreen: true, battery: false, location: true, backgroundLocation: false },
            next: { name: 'Asr', at: new Date(2026, 10, 10, 16, 48).getTime(), exact: true } });
        window.TMSBridge.setUpdateState({ status: 'available', current: '1.140.0', latest: 'v1.141.0', notes: '', size: 1000 });
        window.show('settings');
      });
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('updBar')).display), 'none', 'Leiste weg auf den Einstellungen');
      assert.equal(await page.locator('.st-cat[data-st-go="app"] .st-badge').count(), 1, 'Update als Abzeichen');
      assert.equal(await page.locator('.st-cat[data-st-go="gebet"] .st-dot--warn').count(), 1, 'fehlende Erlaubnisse = Hinweis');
      assert.match(await page.textContent('.st-cat[data-st-go="gebet"]'), /2 Erlaubnisse fehlen/);
      await page.click('.st-cat[data-st-go="gebet"]');
      await page.waitForTimeout(150);
      assert.match(await page.textContent('[data-st-row="adhan-next"]'), /Nächster Azān: Asr · 16:48/);
      assert.match(await page.textContent('[data-st-row="adhan-method"]'), /JAKIM \(Malaysia\)/, 'Methode automatisch angezeigt');
      assert.equal(await page.locator('[data-st-pick="adhan.method"]').count(), 0, 'keine Methodenwahl mehr');
      assert.match(await page.textContent('[data-st-row="adhan-reciter"]'), /Ahmad al-Nafees/);
      assert.match(await page.textContent('[data-st-row="adhan-loc"]'), /Kuala Lumpur/);
      await page.click('[data-st-row="adhan-wecker"] .switch');
      assert.deepEqual((await posts('adhan:wecker')).pop().payload, { enabled: true });
      // Fehlende Erlaubnis → richtige Android-Seite; erteilte stehen als „Erlaubt“
      assert.match(await page.textContent('[data-st-row="perm-fullscreen"]'), /Erlaubt/);
      await page.click('[data-st-row="perm-overlay"] [data-st-act]');
      assert.deepEqual((await posts('adhan:perms')).pop().payload, { which: 'overlay' });
      await page.click('[data-st-row="perm-backgroundLocation"] [data-st-act]');
      assert.deepEqual((await posts('adhan:perms')).pop().payload, { which: 'backgroundLocation' });
      // Zurück aus Android: neuer Stand vom Handy
      await page.evaluate(() => window.TMSBridge.setAdhanStatus({ nextName: 'Asr', nextAt: new Date(2026, 10, 10, 16, 48).getTime(), nextExact: true, method: 'JAKIM (Malaysia)', country: 'MY',
        perms: { notifications: true, exactAlarms: true, overlay: true, fullscreen: true, battery: true, location: true, backgroundLocation: true } }));
      await page.waitForTimeout(100);
      assert.match(await page.textContent('[data-st-row="perm-overlay"]'), /Erlaubt/);
      await page.evaluate(() => window.TMSBridge.handleBack());
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.st-cat[data-st-go="gebet"] .st-dot--warn').count(), 0, 'alles erlaubt = kein Hinweis');
      // Suche springt zur Zeile
      await page.fill('#stSearch', 'pin');
      await page.waitForTimeout(150);
      assert.match(await page.textContent('.st-results'), /PIN|App-Sperre/);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Update: schlichte Leiste — Laden in der App, Fortschritt, Installieren, ✕, Karte auf der Bund-Seite', async () => {
    const { browser, page, errors, posts } = await boot();
    try {
      const MB = 1048576;
      await page.evaluate(() => { document.body.classList.remove('is-locked'); });
      await page.evaluate((mb) => window.TMSBridge.setUpdateState({ status: 'available', current: '1.138.0', latest: 'v1.139.0', notes: 'Neu: Updates in der App', size: 31 * mb }), MB);
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.getElementById('updBar').hidden), false, 'Leiste sichtbar ohne Neustart');
      assert.match(await page.textContent('#updBar'), /Update 1\.139\.0/);
      assert.equal(await page.locator('.update-pill').count(), 0, 'keine Glas-Pille mehr');
      await page.evaluate(() => document.querySelector('#updBar [data-up="notes"]').click());
      assert.match(await page.textContent('#updBar'), /Updates in der App/, 'Was ist neu');
      await page.evaluate(() => document.querySelector('#updBar [data-up="download"]').click());
      assert.equal((await posts('update:download')).length, 1, 'Laden in der App (kein Browser)');
      await page.evaluate((mb) => window.TMSBridge.setUpdateState({ status: 'downloading', current: '1.138.0', latest: 'v1.139.0', notes: '', size: 31 * mb, received: 15.5 * mb }), MB);
      assert.match(await page.textContent('#updBar'), /50 %/);
      await page.evaluate((mb) => window.TMSBridge.setUpdateState({ status: 'ready', current: '1.138.0', latest: 'v1.139.0', notes: '', size: 31 * mb, received: 31 * mb }), MB);
      await page.evaluate(() => document.querySelector('#updBar [data-up="install"]').click());
      assert.equal((await posts('update:install')).length, 1);
      // Sofort sichtbares Warten, kein zweiter Installer bei weiteren Tipps
      assert.match(await page.textContent('#updBar'), /Installer öffnet sich/);
      assert.equal(await page.locator('#updBar .upd-spin').count(), 1, 'Ladekreis statt Knopf');
      assert.equal(await page.locator('#updBar [data-up="install"]').count(), 0, 'kein zweites Antippen möglich');
      // Erst die Android-Erlaubnis: Hinweis statt allgemeinem Warten
      await page.evaluate((mb) => window.TMSBridge.setUpdateState({ status: 'installing', note: 'Erlaube „Apps installieren“ für TMS — danach geht es von selbst weiter', current: '1.138.0', latest: 'v1.139.0', notes: '', size: 31 * mb, received: 31 * mb }), MB);
      assert.match(await page.textContent('#updBar'), /Erlaube „Apps installieren“ für TMS/);
      // Zurück ohne Installation: ehrlicher Hinweis, Knopf wieder da
      await page.evaluate((mb) => window.TMSBridge.setUpdateState({ status: 'ready', note: 'Nicht installiert? Nochmal tippen', current: '1.138.0', latest: 'v1.139.0', notes: '', size: 31 * mb, received: 31 * mb }), MB);
      assert.match(await page.textContent('#updBar'), /Nicht installiert\? Nochmal tippen/);
      assert.equal(await page.locator('#updBar [data-up="install"]').count(), 1);
      // Wegtippen (bei einer neuen, noch nicht geladenen Version)
      await page.evaluate((mb) => window.TMSBridge.setUpdateState({ status: 'available', current: '1.138.0', latest: 'v1.140.0', notes: '', size: 31 * mb }), MB);
      await page.evaluate(() => document.querySelector('#updBar [data-up="dismiss"]').click());
      assert.equal(await page.evaluate(() => document.getElementById('updBar').hidden), true, 'ausgeblendet');
      // Bund-Seite: ruhige Karte statt Leiste
      await page.evaluate(() => { show('servers'); });
      await page.waitForTimeout(300);
      assert.equal(await page.locator('[data-screen="servers"] .upd--card').count(), 1, 'Karte auf der Bund-Seite');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  // Flackern: v1.145.0 nahm den Karten dahinter das Glas — im Emulator besser,
  // am Fold flackerte es danach DAUERND. Emulator ≠ Gerät. Darum: Standard wie
  // bis v1.144 (Glas auf allen Karten), und in Darstellung › Terminal-Karten
  // lassen sich die Varianten am Gerät live vergleichen (bleibt gespeichert).
  test('Terminal-Karten: Standard Glas überall, umschaltbar auf „nur vorne“ und „Matt“', async () => {
    const { browser, page, errors } = await boot();
    try {
      await page.evaluate(() => { for (let i = 0; i < 4; i++) window.addTerminal(); show('terminals'); setActive(1); });
      await page.waitForTimeout(450);
      const cards = () => page.evaluate(() => [...document.querySelectorAll('.stack-card')].map((c) => {
        const cs = getComputedStyle(c);
        const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
        const a = m && m[1].split(',').length === 4 ? Number(m[1].split(',')[3]) : 1;
        return { active: c.classList.contains('is-active'), blur: cs.backdropFilter !== 'none', alpha: a };
      }));
      let c = await cards();
      assert.ok(c.length >= 4, 'Karten da');
      assert.equal(c.filter((x) => x.blur).length, c.length, 'Standard: jede Karte mit Glas (wie v1.144)');
      // Umschalten über die Einstellungen
      const pick = async (v) => {
        await page.evaluate(() => { show('settings'); window.__settingsOpen('darstellung'); });
        await page.waitForTimeout(200);
        await page.click('[data-st-row="card-look"]');
        await page.click(`[data-st-pick="cardLook"][data-v="${v}"]`);
        await page.evaluate(() => show('terminals'));
        await page.waitForTimeout(200);
      };
      await pick('front');
      c = await cards();
      assert.equal(c.filter((x) => x.blur).length, 1, 'nur vorne: genau eine Karte mit Glas');
      assert.ok(c.find((x) => x.active).blur, 'nur vorne: die vordere Karte');
      await pick('matte');
      c = await cards();
      assert.equal(c.filter((x) => x.blur).length, 0, 'Matt: keine Unschärfe');
      assert.ok(c.every((x) => x.alpha === 1), 'Matt: deckend — nichts scheint durch');
      assert.equal(await page.evaluate(() => localStorage.getItem('tms-card-look')), 'matte', 'bleibt gespeichert');
      await pick('glass');
      c = await cards();
      assert.equal(c.filter((x) => x.blur).length, c.length, 'zurück auf Glas');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  // Dauerflackern/Stromfresser: der pulsierende „LÄUFT“-Punkt lief endlos. Eine
  // endlose Animation hält das Zeichnen wach — gemessen 99 statt 0 Bilder in
  // 6 s, solange ein Terminal arbeitet; jedes Bild rechnet alles Milchglas neu.
  test('Arbeitendes Terminal: nach drei Pulsen läuft keine Animation mehr; Punktleiste wird nicht grundlos neu gebaut', async () => {
    const { browser, page, errors } = await boot();
    try {
      await page.evaluate(() => { for (let i = 0; i < 3; i++) window.addTerminal(); show('terminals'); });
      await page.waitForTimeout(300);
      await page.evaluate(() => document.querySelectorAll('.status-chip').forEach((c) => { c.dataset.status = 'running'; }));
      await page.waitForTimeout(300);
      const running = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.target && a.effect.target.closest('#stack')).length);
      assert.ok(await running() > 0, 'der Punkt pulsiert beim Zustandswechsel');
      await page.waitForTimeout(4500);
      assert.equal(await running(), 0, 'danach Ruhe — nichts hält das Zeichnen wach');
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.status-chip[data-status="running"] .dot')).opacity), '1', 'Punkt bleibt sichtbar stehen');
      // Punktleiste: dieselbe Geräteliste nochmal → kein Neuaufbau
      const dot = await page.evaluateHandle(() => document.querySelector('.ts-seg'));
      await page.evaluate(() => window.TMSBridge.setServers(JSON.parse(JSON.stringify(window.TMS_DATA.servers))));
      assert.equal(await page.evaluate((d) => d.isConnected, dot), true, 'Punkte bleiben dieselben Elemente');
      // … aber ein neues Terminal erscheint weiterhin
      const before = await page.locator('.ts-seg').count();
      await page.evaluate(() => { window.addTerminal(); window.renderTermSwitcher(); });
      assert.equal(await page.locator('.ts-seg').count(), before + 1);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  // Am Fold aufgenommen (screenrecord): bei JEDEM Terminalwechsel war die
  // Tastenleiste 4–5 Bilder lang leer und die Gerätelinie weg — sie wurde pro
  // Wechsel gelöscht und neu gebaut. Sie bleibt jetzt stehen; die Tasten
  // wirken auf das Terminal, das beim Drücken vorne ist.
  test('Tastenleiste: bleibt beim Terminalwechsel stehen und wirkt auf das Terminal vorne', async () => {
    const { browser, page, errors } = await boot();
    try {
      await page.evaluate(() => { for (let i = 0; i < 3; i++) window.addTerminal(); show('terminals'); setActive(0); toggleKeysPanel(); });
      await page.waitForTimeout(700);
      const esc = await page.evaluateHandle(() => document.querySelector('#globalKeys [data-tt-key="esc"]'));
      assert.ok(await page.evaluate((e) => !!e && e.isConnected, esc), 'Leiste offen');
      await page.evaluate(() => { window.__keys = []; window.handleTermKey = (k, id) => window.__keys.push([k, id]); });
      const target = () => page.evaluate(() => window.dockTargetId());
      const first = await target();
      await page.evaluate((e) => e.click(), esc);
      // Wechsel: dieselben Tasten-Elemente, kein Neuaufbau
      await page.evaluate(() => setActive(2));
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate((e) => e.isConnected, esc), true, 'Tasten sind noch dieselben Elemente');
      const second = await target();
      assert.notEqual(second, first);
      await page.evaluate((e) => e.click(), esc);
      await page.evaluate(() => document.querySelector('#globalKeys [data-tt-cursor="↑"]').click());
      assert.deepEqual(await page.evaluate(() => window.__keys), [['esc', first], ['esc', second], ['up', second]], 'Taste trifft das Terminal vorne');
      // Auswahl-Taste zeigt den Zustand des Terminals vorne
      await page.evaluate(() => document.querySelector('#globalKeys [data-tt-key="selectmode"]').click());
      assert.equal(await page.evaluate(() => document.querySelector('#globalKeys [data-tt-key="selectmode"]').classList.contains('is-on')), true);
      await page.evaluate(() => setActive(0));
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.querySelector('#globalKeys [data-tt-key="selectmode"]').classList.contains('is-on')), false, 'anderes Terminal: Auswahl aus');
      // Schließen und wieder öffnen geht weiter
      await page.evaluate(() => { toggleKeysPanel(); });
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => document.getElementById('globalKeys').hidden), true);
      await page.evaluate(() => { toggleKeysPanel(); });
      await page.waitForTimeout(300);
      assert.equal(await page.locator('#globalKeys [data-tt-key="esc"]').count(), 1);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
