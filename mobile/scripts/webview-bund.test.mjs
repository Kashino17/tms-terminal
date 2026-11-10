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

  async function boot() {
    const src = readFileSync(join(here, '../src/season2/web/liquidDeckHtml.ts'), 'utf8');
    const html = JSON.parse(src.match(/export const LIQUID_DECK_HTML = (".*");\s*$/s)[1]);
    const file = join(tmpdir(), `tms-webview-bund-${process.pid}.html`);
    writeFileSync(file, html);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
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

  test('Bilder: Galerie direkt, mit Zielkarte', async () => {
    const { browser, page, posts } = await boot();
    try {
      await page.evaluate(() => window.__bundTool('screenshots'));
      const p = (await posts('shot:capture'))[0];
      assert.equal(p.payload.source, 'library');
      assert.ok('cardId' in p.payload);
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
}
