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
      assert.match(await page.textContent('#deskSide'), /Wartet auf dich/, 'früher die Marke FRAGE — jetzt steht dort, was los ist');
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
        window.TMSBridge.setSettings({ browserBridge: false, persistent: true, appLock: true, lockGrace: 300, version: '1.141.0', prevVersion: { version: '1.140.0', size: '31 MB' } });
        window.TMSBridge.bubbleStatus({ serviceOn: true, bound: true, enabled: true, snoozedUntil: 0, keepAlive: true, notifications: true });
      });
      await page.waitForTimeout(150);
      assert.match(await page.textContent('.st-quick'), /Aktiv/);
      assert.match(await page.textContent('.st-cat[data-st-go="sicherheit"]'), /App-Sperre an · entsperrt 5 Min\./);
      // Der KI-Prompt-Schalter ist weg (2026-11-11); die Zeile nennt Bubble und — sobald der Diktat-Rechner antwortet — Wörterbuch und Tempo.
      assert.match(await page.textContent('.st-cat[data-st-go="diktat"]'), /Bubble aktiv/);
      assert.doesNotMatch(await page.textContent('.st-cat[data-st-go="diktat"]'), /KI-Prompt/);
      assert.match(await page.textContent('.st-cat[data-st-go="app"]'), /Version 1\.141\.0/);
      // Bubble-Schalter im Schnellzugriff → bestehende Bubble-Nachricht
      await page.click('.st-quick .switch');
      assert.deepEqual((await posts('bubble:toggle')).pop().payload, { enabled: false });
      // Unterseite „Diktat & Sprache“
      await page.click('.st-cat[data-st-go="diktat"]');
      await page.waitForTimeout(200);
      assert.ok((await posts('bubble:status')).length >= 1, 'frischer Bubble-Stand beim Öffnen');
      assert.ok((await posts('dict:get')).length >= 1, 'Wörterbuch wird beim Öffnen angefragt');
      // Unterseite + Schalter → settings:set (hier: Login-Links unter „Terminal“)
      await page.evaluate(() => window.__settingsOpen('terminal'));
      await page.click('[data-st-row="browser-bridge"] .switch');
      assert.deepEqual((await posts('settings:set')).pop().payload, { key: 'browserBridge', value: true });
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

  // Arbeitsfläche matt als Standard: am Fold gemessen braucht ein Bild mit
  // Milchglas 21–26 ms (über dem 16,6-ms-Fenster), matt 12–15 ms. Glas bleibt
  // wählbar. „Glas nur vorne" (v1.145.0) flackerte am Gerät dauernd — entfernt.
  test('Arbeitsfläche: Standard matt (Karten, Tastenleiste, Eingabezeile), Glas wählbar', async () => {
    const { browser, page, errors } = await boot();
    try {
      await page.evaluate(() => { for (let i = 0; i < 4; i++) window.addTerminal(); show('terminals'); setActive(1); toggleKeysPanel(); });
      await page.waitForTimeout(700);
      const look = () => page.evaluate(() => {
        const one = (el) => { const cs = getComputedStyle(el); const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
          return { blur: cs.backdropFilter !== 'none', alpha: m && m[1].split(',').length === 4 ? Number(m[1].split(',')[3]) : 1 }; };
        return { cards: [...document.querySelectorAll('.stack-card')].map(one), keys: one(document.getElementById('globalKeys')), dock: one(document.getElementById('dock')) };
      });
      let l = await look();
      assert.ok(l.cards.length >= 4, 'Karten da');
      assert.equal(l.cards.filter((x) => x.blur).length, 0, 'Standard: keine Karte mit Unschärfe');
      assert.ok(l.cards.every((x) => x.alpha === 1), 'Karten deckend — nichts scheint durch');
      assert.deepEqual([l.keys.blur, l.keys.alpha, l.dock.blur, l.dock.alpha], [false, 1, false, 1], 'Tastenleiste + Eingabezeile matt und deckend');
      const pick = async (v) => {
        await page.evaluate(() => { show('settings'); window.__settingsOpen('darstellung'); });
        await page.waitForTimeout(200);
        await page.click('[data-st-row="card-look"]');
        await page.click(`[data-st-pick="cardLook"][data-v="${v}"]`);
        await page.evaluate(() => show('terminals'));
        await page.waitForTimeout(200);
      };
      await pick('glass');
      l = await look();
      assert.equal(l.cards.filter((x) => x.blur).length, l.cards.length, 'Glas: jede Karte');
      assert.deepEqual([l.keys.blur, l.dock.blur], [true, true], 'Glas: auch die Leisten');
      assert.equal(await page.evaluate(() => localStorage.getItem('tms-card-look')), 'glass', 'bleibt gespeichert');
      await pick('matte');
      l = await look();
      assert.equal(l.cards.filter((x) => x.blur).length, 0, 'zurück auf matt');
      // Alte Auswahl aus v1.145.1 („nur vorne") fällt auf den Standard zurück
      await page.evaluate(() => localStorage.setItem('tms-card-look', 'front'));
      await page.reload(); await page.waitForTimeout(600);
      assert.equal(await page.evaluate(() => document.body.classList.contains('cards-matte')), true);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  // Dauerflackern/Stromfresser: der pulsierende „LÄUFT“-Punkt lief endlos. Eine
  // endlose Animation hält das Zeichnen wach — gemessen 99 statt 0 Bilder in
  // 6 s, solange ein Terminal arbeitet; jedes Bild rechnet alles Milchglas neu.
  test('Arbeitendes Terminal: nach drei Pulsen läuft keine Animation mehr; Punktleiste wird nicht grundlos neu gebaut', async () => {
    const { browser, page, errors } = await boot();
    try {
      await page.evaluate(() => {
        window.TMSBridge.restoreSessions([1, 2, 3].map((n) => ({ sessionId: 'S-' + n, name: 'T' + n, serverId: 'A' })));
        show('terminals');
      });
      await page.waitForTimeout(300);
      await page.evaluate(() => window.TMSBridge.setActivities(Object.fromEntries([1, 2, 3].map((n) => ['S-' + n, { task: 'Thema ' + n, state: 'working' }]))));
      await page.waitForTimeout(300);
      const running = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.target && a.effect.target.closest('#stack')).length);
      assert.ok(await running() > 0, 'der Punkt pulsiert beim Zustandswechsel');
      await page.waitForTimeout(4500);
      assert.equal(await running(), 0, 'danach Ruhe — nichts hält das Zeichnen wach');
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#stack .card-task[data-state="working"] .card-task__dot')).opacity), '1', 'Punkt bleibt sichtbar stehen');
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

  // Sparmodus: die Seite meldet, welches Terminal wirklich zu sehen ist — der
  // Server bündelt danach die Ausgabe der verdeckten (am Fold: ~13 Nachrichten/s
  // von KI-Spinnern, die meisten für Terminals, die niemand sah).
  test('Aufmerksamkeit: die Seite meldet das Terminal vorne, „keins“ auf anderen Bildschirmen, „alle“ in der Übersicht', async () => {
    const { browser, page, errors, posts } = await boot();
    try {
      await page.evaluate(() => {
        window.TMSBridge.restoreSessions([
          { sessionId: 'S-A', name: 'Eins', serverId: 'A' },
          { sessionId: 'S-B', name: 'Zwei', serverId: 'A' },
        ]);
        show('terminals'); setActive(0);
      });
      await page.waitForTimeout(500);
      const last = async () => { const p = await posts('term:focus'); return p.length ? p[p.length - 1].payload.focus : undefined; };
      assert.equal(await last(), 'S-A', 'Terminal vorne');
      await page.evaluate(() => setActive(1));
      await page.waitForTimeout(100);
      assert.equal(await last(), 'S-B', 'nach dem Wechsel das andere');
      const n = (await posts('term:focus')).length;
      await page.evaluate(() => setActive(1));
      assert.equal((await posts('term:focus')).length, n, 'kein Wechsel → keine Meldung');
      await page.evaluate(() => show('servers'));
      assert.equal(await last(), '', 'anderer Bildschirm: kein Terminal zu sehen');
      await page.evaluate(() => show('terminals'));
      assert.equal(await last(), 'S-B', 'zurück bei den Terminals');
      await page.evaluate(() => { toggleOverview(true); document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await page.waitForTimeout(500);
      assert.equal(await last(), null, 'Übersicht: mehrere sichtbar → alle live');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  // Am Fold gemessen: 22 Aufnahme-Balken liefen unsichtbar endlos weiter und
  // hielten den Compositor der Seite bei 7 % Rechenzeit (angehalten: 1 %).
  test('Aufnahme-Balken bewegen sich nur während einer Aufnahme', async () => {
    const { browser, page, errors } = await boot();
    try {
      await page.evaluate(() => { for (let i = 0; i < 2; i++) window.addTerminal(); show('terminals'); });
      await page.waitForTimeout(400);
      const bars = () => page.evaluate(() => document.getAnimations().filter((a) => a.animationName === 'rec-bounce' && a.playState === 'running').length);
      assert.equal(await bars(), 0, 'Ruhe: kein Balken animiert');
      await page.evaluate(() => { window.dockRecordingStart(); });
      await page.waitForTimeout(400);
      assert.ok(await bars() > 0, 'Aufnahme läuft: Balken bewegen sich');
      // Verarbeiten: Balken stehen still (flache Linie), obwohl die Seite noch „rec" ist
      await page.evaluate(() => { window.dockRecordingTranscribing(); });
      await page.waitForTimeout(300);
      assert.equal(await bars(), 0, 'beim Verarbeiten stehen die Balken');
      await page.evaluate(() => { window.dockRecordingEnd('', 'term'); });
      await page.waitForTimeout(500);
      assert.equal(await bars(), 0, 'Aufnahme vorbei: wieder Ruhe');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  // Jeder Ping weckt das Funkmodul. Alle 3 s lohnt nur, wenn der Wert auch zu
  // sehen ist — zugeklappt mit Terminal vorne steht er nirgends.
  test('Ping-Anzeige: die Seite meldet, ob gerade ein Ping-Wert zu sehen ist', async () => {
    const { browser, page, errors, posts } = await boot();
    try {
      await page.evaluate(() => {
        window.TMSBridge.restoreSessions([{ sessionId: 'S-A', name: 'Eins', serverId: 'A' }]);
        show('terminals'); setActive(0);
      });
      await page.waitForTimeout(500);
      const last = async () => { const p = await posts('term:focus'); return p.length ? p[p.length - 1].payload : null; };
      assert.deepEqual(await last(), { focus: 'S-A', latency: false }, 'Terminal vorne (schmal): kein Ping-Wert sichtbar');
      await page.evaluate(() => show('servers'));
      assert.deepEqual(await last(), { focus: '', latency: true }, 'Bund-Seite zeigt die Geräte mit Ping');
      await page.evaluate(() => show('terminals'));
      assert.deepEqual(await last(), { focus: 'S-A', latency: false });
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  // Am Emulator gemessen: Tastendruck → sichtbar 85 ms bei 2 ms Netz — 60 ms
  // davon eine feste Wartezeit vor JEDEM Neuzeichnen. Die Drossel bleibt für
  // Dauerausgabe, aber das erste Zeichen nach einer Pause kommt sofort.
  test('Terminal zeichnet das erste Zeichen nach einer Pause sofort, Dauerausgabe bleibt gedrosselt', async () => {
    const { browser, page, errors } = await boot();
    try {
      await page.evaluate(() => {
        window.TMSBridge.restoreSessions([{ sessionId: 'S-A', name: 'Eins', serverId: 'A' }]);
        show('terminals'); setActive(0);
      });
      await page.waitForTimeout(600);
      const r = await page.evaluate(async () => {
        const body = document.querySelector('.card-body[data-card-id]');
        const until = (text, t0) => new Promise((resolve) => {
          const done = () => { if (body.textContent.indexOf(text) >= 0) { mo.disconnect(); resolve(performance.now() - t0); return true; } return false; };
          const mo = new MutationObserver(done);
          mo.observe(body, { childList: true, subtree: true, characterData: true });
          setTimeout(() => { mo.disconnect(); resolve(-1); }, 1500);
        });
        const lat = [];
        for (const word of ['ERSTES', 'ZWEITES', 'DRITTES']) {
          await new Promise((res) => setTimeout(res, 250)); // Pause → nächste Ausgabe ist „die erste"
          const t0 = performance.now();
          const seen = until(word, t0);
          window.TMSBridge.output('S-A', word + '\r\n');
          lat.push(Math.round(await seen));
        }
        // Dauerausgabe: 40 Häppchen in ~200 ms → höchstens eine Handvoll Neuzeichnungen
        let renders = 0;
        const mo = new MutationObserver(() => { renders++; });
        mo.observe(body, { childList: true, subtree: true });
        for (let i = 0; i < 40; i++) { window.TMSBridge.output('S-A', 'strom ' + i + '\r\n'); await new Promise((res) => setTimeout(res, 5)); }
        await new Promise((res) => setTimeout(res, 200));
        mo.disconnect();
        return { lat, renders, hasLast: body.textContent.indexOf('strom 39') >= 0 };
      });
      assert.ok(r.lat.every((ms) => ms >= 0 && ms < 40), `erste Ausgabe nach Pause sofort sichtbar (gemessen: ${r.lat.join(', ')} ms)`);
      assert.ok(r.renders <= 8, `Dauerausgabe bleibt gedrosselt (${r.renders} Neuzeichnungen für 40 Häppchen)`);
      assert.equal(r.hasLast, true, 'nichts geht verloren');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  // ── Woran gearbeitet wird ────────────────────────────────────────────────
  // Statt der Marke LÄUFT/BEREIT steht unter dem Titel: Ordner · Zustand ·
  // Aufgabe. Die Aufgabe ist der Titel, den das KI-Werkzeug seiner Sitzung
  // selbst gibt (Server: terminal:activity).
  test('Kartenkopf: statt LÄUFT/BEREIT steht dort, woran gearbeitet wird', async () => {
    const { browser, page, errors } = await boot();
    try {
      await page.evaluate(() => {
        window.TMSBridge.setActivities({ 'S-C': { task: 'Kam vor der Karte', state: 'done' } }); // Stand beim Verbinden, Karten folgen
        window.TMSBridge.restoreSessions(['A', 'B', 'C'].map((n) => ({ sessionId: 'S-' + n, name: 'Term ' + n, serverId: 'A' })));
        show('terminals'); setActive(0);
      });
      await page.waitForTimeout(500);
      const card = (sid) => page.evaluate((id) => {
        const sess = window.TMS_DATA.sessions.find((x) => x.name === 'Term ' + id.slice(2));
        const el = document.querySelector(`#stack .term-card[data-id="${sess.id}"]`);
        const task = el.querySelector('.card-task');
        const btn = el.querySelector('.read-btn');
        return {
          // Ordner + Aufgabe, wie sie nebeneinander stehen (ohne das Geräte-Kürzel davor)
          line: (el.querySelector('.card-folder').textContent + (task ? task.textContent : '')).replace(/\s+/g, ' ').trim(),
          state: task ? task.dataset.state : null,
          text: task ? task.querySelector('.card-task__text').textContent : null,
          read: !!btn && !btn.hidden, dot: !!btn && btn.classList.contains('has-new'),
        };
      }, sid);
      assert.equal(await page.locator('#stack .term-card .status-chip').count(), 0, 'die Marke LÄUFT/BEREIT ist weg');
      assert.deepEqual(await card('S-A'), { line: '~', state: null, text: null, read: false, dot: false }, 'normale Shell: nur der Ordner, kein Lesen-Knopf');
      assert.deepEqual(await card('S-C'), { line: '~·Kam vor der Karte', state: 'done', text: 'Kam vor der Karte', read: true, dot: false }, 'Aufgabe, die vor der Karte ankam');

      await page.evaluate(() => {
        window.TMSBridge.setSessionCwd('S-A', '/Users/x/Developer/tms-terminal');
        window.TMSBridge.setActivities({ 'S-A': { task: 'Kampagnen-Bericht bauen', state: 'working' }, 'S-B': { task: '', state: 'done' } });
      });
      assert.deepEqual(await card('S-A'), { line: 'tms-terminal·Kampagnen-Bericht bauen', state: 'working', text: 'Kampagnen-Bericht bauen', read: true, dot: false });
      assert.deepEqual(await card('S-B'), { line: '~', state: null, text: null, read: true, dot: false }, 'ruhende Sitzung ohne Thema: keine Aufgabe, aber lesbar');
      // Der Ordner wechselt: die Aufgabe bleibt stehen.
      await page.evaluate(() => window.TMSBridge.setSessionCwd('S-A', '/Users/x/Desktop/ads-cockpit'));
      assert.equal((await card('S-A')).line, 'ads-cockpit·Kampagnen-Bericht bauen');

      // Rückfrage (Prompt-Erkennung): „Wartet auf dich", danach wieder die Arbeit.
      await page.evaluate(() => window.TMSBridge.setSessionStatus('S-A', 'waiting'));
      assert.deepEqual([(await card('S-A')).state, (await card('S-A')).line], ['waiting', 'ads-cockpit·Wartet auf dich·Kampagnen-Bericht bauen']);
      await page.evaluate(() => window.TMSBridge.setSessionStatus('S-A', 'running'));
      assert.equal((await card('S-A')).state, 'working');

      // Fertig geworden: vorne kein Punkt (man sieht es), verdeckt ein Punkt am Buch.
      await page.evaluate(() => window.TMSBridge.setActivities({ 'S-B': { task: 'Tests reparieren', state: 'working' } }));
      await page.evaluate(() => window.TMSBridge.setActivities({ 'S-A': { task: 'Kampagnen-Bericht bauen', state: 'done' }, 'S-B': { task: 'Tests reparieren', state: 'done' } }));
      assert.deepEqual([(await card('S-A')).dot, (await card('S-B')).dot], [false, true]);
      // Neue Runde: der Punkt gilt der alten Antwort nicht mehr.
      await page.evaluate(() => window.TMSBridge.setActivities({ 'S-B': { task: 'Tests reparieren', state: 'working' } }));
      assert.equal((await card('S-B')).dot, false);

      // Punktleiste: der Hinweis beim Wechsel nennt die Aufgabe in der zweiten Zeile.
      await page.evaluate(() => setActive(1));
      await page.waitForTimeout(250);
      assert.match(await page.evaluate(() => document.querySelector('.term-switcher__label').textContent), /Term B\nTests reparieren/);
      await page.evaluate(() => setActive(0));

      // Claude beendet, die Shell setzt ihren eigenen Titel: Zeile und Knopf verschwinden.
      await page.evaluate(() => window.TMSBridge.setActivities({ 'S-A': null }));
      assert.deepEqual(await card('S-A'), { line: 'ads-cockpit', state: null, text: null, read: false, dot: false });
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  // ── Antwort lesen ────────────────────────────────────────────────────────
  test('Lesemodus: holt die Antworten vom Rechner und setzt sie sauber (Tabelle, Code, Liste), blättert, kopiert', async () => {
    const { browser, page, errors, posts } = await boot();
    try {
      await page.evaluate(() => {
        window.TMSBridge.restoreSessions([{ sessionId: 'S-A', name: 'Energie', serverId: 'A' }, { sessionId: 'S-B', name: 'Ads', serverId: 'A' }]);
        show('terminals'); setActive(0);
        window.TMSBridge.setActivities({ 'S-A': { task: 'Tiefenanalyse', state: 'done' }, 'S-B': { task: 'Bericht', state: 'working' } });
      });
      await page.waitForTimeout(500);
      await page.click('#stack .stack-card.is-active .read-btn');
      await page.waitForTimeout(450);
      assert.deepEqual((await posts('reader:get')).map((p) => p.payload), [{ sessionId: 'S-A' }], 'fragt die Sitzung des Terminals vorne an');
      assert.equal(await page.evaluate(() => document.getElementById('reader').hidden), false);
      assert.match(await page.textContent('.rd-body'), /Antwort wird geladen/);
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('dock')).visibility), 'hidden', 'Eingabezeile weicht dem Lesen');

      const md = '## Ergebnis\n\nAlles **behoben** mit `npm test`.\nZweite Zeile.\n\n| Lücke | vorher | jetzt | Quelle |\n|---|---|---|---|\n| Pings | alle 3 s | alle 12 s | Messung |\n\n### Befehl\n\n```\ntms-terminal update\n```\n\n- eins\n  - unterpunkt\n- zwei\n\n1. erstens\n2. zweitens\n\n<img src=x onerror="window.__xss=1">';
      await page.evaluate((m) => window.TMSBridge.readerAnswers('S-A', { open: false, answers: [
        { prompt: 'Erste Frage', md: 'Alte Antwort', at: Date.now() - 3 * 3600_000 },
        { prompt: 'Geh in die Tiefe', md: m, at: Date.now() - 120_000 },
      ] }), md);
      const view = () => page.evaluate(() => ({
        sub: document.querySelector('.rd-title small').textContent,
        name: document.querySelector('.rd-title strong span').textContent,
        count: document.querySelector('.rd-count').textContent,
        prompt: document.querySelector('.rd-prompt summary span').textContent,
        h: [...document.querySelectorAll('.rd-body h2, .rd-body h3')].map((x) => x.tagName + ':' + x.textContent),
        p: document.querySelector('.rd-body p') ? document.querySelector('.rd-body p').innerHTML : '',
        cards: !!document.querySelector('.rd-table.is-cards'),
        cells: [...document.querySelectorAll('.rd-table td')].map((x) => x.dataset.label + '=' + x.textContent),
        code: document.querySelector('.rd-code pre') ? document.querySelector('.rd-code pre').textContent : null,
        nested: !!document.querySelector('.rd-body ul > li > ul > li'),
        ol: document.querySelectorAll('.rd-body ol > li').length,
        img: document.querySelectorAll('.rd-body img').length,
      }));
      const v = await view();
      assert.equal(v.name, 'Energie');
      assert.equal(v.sub, 'Letzte Antwort · vor 2 Min.');
      assert.equal(v.count, '2 / 2');
      assert.equal(v.prompt, 'Geh in die Tiefe');
      assert.deepEqual(v.h, ['H2:Ergebnis', 'H3:Befehl']);
      assert.equal(v.p, 'Alles <strong>behoben</strong> mit <code>npm test</code>.<br>Zweite Zeile.');
      assert.equal(v.cards, true, 'vier Spalten auf schmalem Schirm: Karten statt seitlich scrollen');
      assert.deepEqual(v.cells, ['Lücke=Pings', 'vorher=alle 3 s', 'jetzt=alle 12 s', 'Quelle=Messung']);
      assert.equal(v.code, 'tms-terminal update');
      assert.equal(v.nested, true); assert.equal(v.ol, 2);
      assert.equal(v.img, 0, 'HTML aus der Antwort wird als Text gezeigt, nie ausgeführt');
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'nichts ragt seitlich hinaus');

      // Kopieren: die Antwort, wie sie geschrieben wurde
      await page.click('[data-rd="copy"]');
      assert.equal((await posts('clipboard:write')).pop().payload.text, md);
      await page.click('.rd-code [data-rd="copycode"]');
      assert.equal((await posts('clipboard:write')).pop().payload.text, 'tms-terminal update');
      // Inhalt springt zur Überschrift
      await page.click('[data-rd="toc"]');
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-pop="toc"] button')].map((b) => b.textContent)), ['Ergebnis', 'Befehl']);
      await page.click('[data-pop="toc"] button:nth-of-type(2)');
      // Blättern
      await page.click('[data-rd="older"]');
      const o = await view();
      assert.deepEqual([o.sub, o.count, o.prompt, o.p], ['Ältere Antwort · vor 3 Std.', '1 / 2', 'Erste Frage', 'Alte Antwort']);
      assert.equal(await page.evaluate(() => document.querySelector('[data-rd="older"]').disabled), true);

      // Antworten: zurück ins Terminal, Eingabe bereit
      await page.click('[data-rd="reply"]');
      await page.waitForTimeout(700);
      assert.equal(await page.evaluate(() => document.getElementById('reader').hidden), true);
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'dockInput');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Lesemodus: arbeitet Claude weiter, steht das dabei; wird er fertig, rückt die neue Antwort nach; Gründe statt leerer Seite', async () => {
    const { browser, page, errors, posts } = await boot();
    try {
      await page.evaluate(() => {
        window.TMSBridge.restoreSessions([{ sessionId: 'S-A', name: 'Energie', serverId: 'A' }, { sessionId: 'S-B', name: 'Ads', serverId: 'A' }]);
        show('terminals'); setActive(0);
        window.TMSBridge.setActivities({ 'S-A': { task: 'Bericht bauen', state: 'working' }, 'S-B': { task: 'Alt', state: 'working' } });
        window.TMSBridge.setActivities({ 'S-B': { task: 'Alt', state: 'done' } }); // verdeckt fertig geworden → Punkt
      });
      await page.waitForTimeout(400);
      await page.click('#stack .stack-card.is-active .read-btn');
      await page.waitForTimeout(300);
      await page.evaluate(() => window.TMSBridge.readerAnswers('S-A', { open: true, answers: [{ prompt: 'davor', md: 'Letzte fertige Antwort', at: Date.now() }] }));
      assert.match(await page.textContent('.rd-note'), /Claude arbeitet gerade weiter: Bericht bauen/);
      assert.equal(await page.evaluate(() => document.querySelector('.rd-note').hidden), false);
      assert.equal(await page.textContent('.rd-count'), '', 'eine Antwort: kein Zähler');
      // Fertig: der Lesemodus fragt von selbst neu und zeigt die neue Antwort.
      await page.evaluate(() => window.TMSBridge.setActivities({ 'S-A': { task: 'Bericht bauen', state: 'done' } }));
      await page.waitForTimeout(600);
      assert.equal((await posts('reader:get')).length, 2);
      await page.evaluate(() => window.TMSBridge.readerAnswers('S-A', { open: false, answers: [
        { prompt: 'davor', md: 'Letzte fertige Antwort', at: Date.now() }, { prompt: 'Bau den Bericht', md: 'Der Bericht steht.', at: Date.now() }] }));
      assert.equal(await page.textContent('.rd-body p'), 'Der Bericht steht.');
      assert.equal(await page.evaluate(() => document.querySelector('.rd-note').hidden), true);
      assert.equal(await page.evaluate(() => !!document.querySelector('#stack .stack-card.is-active .read-btn.has-new')), false, 'gerade gelesen: kein Punkt');
      await page.click('[data-rd="close"]');
      await page.waitForTimeout(500);

      // Zweites Terminal: Punkt da, verschwindet beim Öffnen; der Rechner nennt einen Grund.
      await page.evaluate(() => setActive(1));
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => !!document.querySelector('#stack .stack-card.is-active .read-btn.has-new')), true);
      await page.click('#stack .stack-card.is-active .read-btn');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => !!document.querySelector('#stack .stack-card.is-active .read-btn.has-new')), false);
      await page.evaluate(() => window.TMSBridge.readerAnswers('S-B', { open: false, answers: [], reason: 'no-transcript' }));
      assert.match(await page.textContent('.rd-body'), /führt keinen Verlauf.*neues Terminal/s);
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-rd="copy"]')).visibility), 'hidden');
      // Späte Antwort einer alten Anfrage darf die Seite nicht überschreiben.
      await page.click('[data-rd="close"]');
      await page.waitForTimeout(450);
      await page.evaluate(() => window.TMSBridge.readerAnswers('S-B', { open: false, answers: [{ prompt: '', md: 'zu spät', at: 0 }] }));
      assert.equal(await page.evaluate(() => document.getElementById('reader').hidden), true);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Aufgeklappt: Seitenleiste und Kopfzeile zeigen die Aufgabe, der Lesemodus liegt neben der Seitenleiste', async () => {
    const { browser, page, errors, posts } = await boot({ width: 750, height: 830 });
    try {
      await page.evaluate(() => {
        window.TMSBridge.restoreSessions([{ sessionId: 'S-A', name: 'Energie', serverId: 'A' }, { sessionId: 'S-B', name: 'Shell', serverId: 'A' }]);
        show('terminals');
        window.TMSBridge.setActivities({ 'S-A': { task: 'Tiefenanalyse Energie', state: 'working' } });
      });
      await page.waitForTimeout(700);
      await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close())); // „Dein Terminal" nach dem Anlegen
      await page.evaluate(() => { const row = [...document.querySelectorAll('.ds-row')].find((r) => /Energie/.test(r.textContent)); if (row) row.click(); });
      await page.waitForTimeout(500);
      const rows = await page.evaluate(() => [...document.querySelectorAll('.ds-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
      assert.ok(rows.some((r) => /Energie.*Tiefenanalyse Energie/.test(r)), 'Seitenleiste nennt die Aufgabe: ' + JSON.stringify(rows));
      assert.ok(!rows.some((r) => /LÄUFT|BEREIT/.test(r)), 'keine Marke mehr');
      assert.match(await page.textContent('#compactTerminalHeader small'), /Tiefenanalyse Energie/);
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('compactRead')).display !== 'none'), true);
      await page.click('#compactRead');
      await page.waitForTimeout(450);
      assert.deepEqual((await posts('reader:get')).map((p) => p.payload), [{ sessionId: 'S-A' }]);
      const left = await page.evaluate(() => Math.round(document.getElementById('reader').getBoundingClientRect().left));
      const side = await page.evaluate(() => Math.round(document.getElementById('deskSide').getBoundingClientRect().right));
      assert.equal(left, side, 'die Seitenleiste bleibt sichtbar');
      // Terminal ohne KI: kein Lesen-Knopf in der Kopfzeile
      await page.click('[data-rd="close"]');
      await page.evaluate(() => { const row = [...document.querySelectorAll('.ds-row')].find((r) => /Shell/.test(r.textContent)); if (row) row.click(); });
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('compactRead')).display), 'none');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Lesemodus: Vorlesen schickt die Stücke ohne Code ans Handy, markiert das gesprochene und lässt sich anhalten', async () => {
    const { browser, page, errors, posts } = await boot();
    try {
      await page.evaluate(() => {
        window.TMSBridge.restoreSessions([{ sessionId: 'S-A', name: 'Energie', serverId: 'A' }]);
        show('terminals'); setActive(0);
        window.TMSBridge.setActivities({ 'S-A': { task: 'Thema', state: 'done' } });
      });
      await page.waitForTimeout(400);
      await page.click('#stack .stack-card.is-active .read-btn');
      await page.waitForTimeout(300);
      await page.evaluate(() => window.TMSBridge.readerAnswers('S-A', { open: false, answers: [{ prompt: 'x', at: Date.now(),
        md: '## Ergebnis\n\nAlles ist behoben.\n\n```\nnpm test\n```\n\n- erster Punkt\n\n| Lücke | Jetzt |\n|---|---|\n| Pings | alle 12 s |' }] }));
      assert.equal(await page.evaluate(() => document.querySelector('[data-rd="speak"]').hidden), false);
      await page.click('[data-rd="speak"]');
      const sent = (await posts('reader:speak')).pop().payload;
      assert.deepEqual(sent, { parts: ['Ergebnis', 'Alles ist behoben.', 'erster Punkt', 'Pings', 'Jetzt: alle 12 s'], german: true }, 'Code wird nicht vorgelesen; Tabellenzellen nennen ihre Spalte');
      assert.match(await page.textContent('[data-rd="speak"]'), /Anhalten/);
      // Das Handy meldet, wo die Stimme ist.
      await page.evaluate(() => window.TMSBridge.readerSpeech({ index: 1 }));
      assert.equal(await page.evaluate(() => document.querySelector('.rd-body .is-speaking').textContent), 'Alles ist behoben.');
      await page.evaluate(() => window.TMSBridge.readerSpeech({ index: 2 }));
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.rd-body .is-speaking')].map((x) => x.textContent)), ['erster Punkt']);
      // Fertig: Knopf zurück, Markierung weg.
      await page.evaluate(() => window.TMSBridge.readerSpeech({ done: true }));
      assert.match(await page.textContent('[data-rd="speak"]'), /Vorlesen/);
      assert.equal(await page.locator('.rd-body .is-speaking').count(), 0);
      // Anhalten von Hand und beim Schließen.
      await page.click('[data-rd="speak"]');
      await page.click('[data-rd="speak"]');
      assert.equal((await posts('reader:speakStop')).length, 1);
      await page.click('[data-rd="speak"]');
      await page.click('[data-rd="close"]');
      assert.equal((await posts('reader:speakStop')).length, 2, 'Lesemodus zu: die Stimme schweigt');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
