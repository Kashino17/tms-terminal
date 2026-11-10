/**
 * Einstellungen › Diktat & Sprache: Woerterbuch, Tempo, Bubble — headless im
 * Browser, gegen die GEBAUTE Seite (liquidDeckHtml.ts).
 *
 * Begruendung: Das Woerterbuch liegt auf dem Rechner, der transkribiert. Die
 * Seite zeigt nur, was er meldet, und schickt jede Aenderung als Nachricht.
 * Geprueft wird genau diese Naht — und dass nichts als Attrappe dasteht.
 *
 *   TMS_VIZ_PW=<pfad-zu-playwright> node --test scripts/webview-dictionary.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '../src/season2/web');
const PW = process.env.TMS_VIZ_PW;
const SOURCE = process.env.TMS_DECK_TS || join(WEB, 'liquidDeckHtml.ts');

const STATE = {
  entries: [
    { id: 'a1', term: 'Wispr Flow', heard: ['Vispa Flow', 'Whisperflow'], source: 'manual', uses: 14, createdAt: 3 },
    { id: 'b2', term: 'Tailscale', heard: ['Tail Scale'], source: 'seed', uses: 31, createdAt: 2 },
    { id: 'c3', term: 'Fernzugriff', heard: [], source: 'seed', uses: 0, createdAt: 1 },
  ],
  speed: { count: 4, medianMs: 460, under700: 0.75, waits: [380, 420, 500, 830] },
};

if (!PW) {
  test('Woerterbuch-WebView-Pruefung uebersprungen (kein Playwright)', { skip: 'TMS_VIZ_PW nicht gesetzt' }, () => {});
} else {
  const require = createRequire(join(PW, 'index.js'));
  const { chromium } = require('playwright');

  async function boot(width = 412) {
    const src = readFileSync(SOURCE, 'utf8');
    const html = JSON.parse(src.match(/export const LIQUID_DECK_HTML = (".*");\s*$/s)[1]);
    const file = join(tmpdir(), `tms-webview-dict-${process.pid}.html`);
    writeFileSync(file, html);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width, height: 915 } });
    const posts = [];
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.exposeFunction('__post', (m) => posts.push(JSON.parse(m)));
    await page.addInitScript(() => { window.ReactNativeWebView = { postMessage: (m) => window.__post(m) }; });
    await page.goto('file://' + file);
    await page.waitForTimeout(1200);
    await page.evaluate(() => { document.body.classList.remove('is-locked'); show('settings'); window.__settingsOpen('diktat'); });
    return { browser, page, posts, errors };
  }
  const sent = (posts, type) => posts.filter((m) => m.type === type);

  test('die Seite fragt das Woerterbuch an und zeigt Begriffe, Hoerfehler und Zaehler', async () => {
    const { browser, page, posts, errors } = await boot();
    try {
      assert.equal(sent(posts, 'dict:get').length >= 1, true);
      assert.match(await page.textContent('[data-screen="settings"]'), /wird geladen/);
      await page.evaluate((s) => window.TMSBridge.setDictionary(s), STATE);
      const text = await page.textContent('#dwList');
      assert.match(text, /Wispr Flow[\s\S]*Vispa Flow, Whisperflow[\s\S]*14×/);
      assert.match(text, /Fernzugriff/);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Hinzufuegen, Hoerfehler ergaenzen und entfernen, Loeschen gehen als Nachricht an den Rechner', async () => {
    const { browser, page, posts } = await boot();
    try {
      await page.evaluate((s) => window.TMSBridge.setDictionary(s), STATE);
      await page.fill('#dwAdd', 'Liquid Deck');
      await page.click('[data-st-act="dw:add"]');
      assert.deepEqual(sent(posts, 'dict:add').at(-1).payload, { term: 'Liquid Deck' });
      // Nach dem Hinzufügen ist das Feld leer — und die Liste wieder vollständig.
      assert.equal(await page.$$eval('#dwList .dw-item:not([hidden])', (els) => els.length), 3);

      await page.click('[data-st-act="dw:open:b2"]');
      await page.fill('#dwHeard', 'Tailskale');
      await page.click('[data-st-act="dw:heard:b2"]');
      assert.deepEqual(sent(posts, 'dict:update').at(-1).payload, { id: 'b2', heard: ['Tail Scale', 'Tailskale'] });

      await page.click('[data-st-act="dw:unheard:b2:0"]');
      assert.deepEqual(sent(posts, 'dict:update').at(-1).payload, { id: 'b2', heard: [] });

      await page.click('[data-st-act="dw:del:b2"]');
      assert.deepEqual(sent(posts, 'dict:remove').at(-1).payload, { id: 'b2' });
    } finally { await browser.close(); }
  });

  test('Tippen im Feld filtert die Liste; ein neuer Stand vom Rechner nimmt das Getippte nicht weg', async () => {
    const { browser, page } = await boot();
    try {
      await page.evaluate((s) => window.TMSBridge.setDictionary(s), STATE);
      await page.fill('#dwAdd', 'tail');
      assert.deepEqual(await page.$$eval('#dwList .dw-item:not([hidden]) b', (els) => els.map((e) => e.textContent)), ['Tailscale']);
      await page.focus('#dwAdd');
      await page.evaluate((s) => window.TMSBridge.setDictionary({ ...s, speed: { ...s.speed, medianMs: 500 } }), STATE);
      assert.equal(await page.inputValue('#dwAdd'), 'tail');
    } finally { await browser.close(); }
  });

  test('Reiter Diktat zeigt das gemessene Tempo; ohne Messwerte einen ruhigen Hinweis', async () => {
    const { browser, page } = await boot();
    try {
      await page.evaluate((s) => window.TMSBridge.setDictionary(s), STATE);
      await page.click('[data-st-act="dw:tab:dictation"]');
      assert.match(await page.textContent('.dw-tempo'), /0,46 s[\s\S]*75 % unter 0,7 s/);
      assert.equal(await page.$$eval('.dw-tempo__bars i', (els) => els.length), 4);
      await page.evaluate((s) => window.TMSBridge.setDictionary({ ...s, speed: { count: 0, medianMs: 0, under700: 0, waits: [] } }), STATE);
      assert.match(await page.textContent('.dw-tempo'), /Noch keine Diktate gemessen/);
    } finally { await browser.close(); }
  });

  test('Reiter Bubble zeigt die bisherigen Zeilen und meldet Klicks', async () => {
    const { browser, page, posts } = await boot();
    try {
      await page.evaluate(() => window.TMSBridge.bubbleStatus({ serviceOn: true, bound: true, enabled: true, snoozedUntil: 0, keepAlive: true, notifications: true }));
      await page.click('[data-st-act="dw:tab:bubble"]');
      assert.match(await page.textContent('[data-screen="settings"]'), /Mikrofon in allen Apps[\s\S]*Bubble anzeigen[\s\S]*Hintergrund-Schutz/);
      await page.click('.st-detail [data-st-act="bubble:snooze"]');   // (die Übersicht hat denselben Knopf, auf dem Handy ist sie hier nicht zu sehen)
      assert.equal(sent(posts, 'bubble:snooze').length, 1);
    } finally { await browser.close(); }
  });

  test('ohne erreichbaren Diktat-Rechner und bei altem Server steht das da — keine leere Liste', async () => {
    const { browser, page } = await boot();
    try {
      await page.evaluate(() => window.TMSBridge.setDictionary({ offline: true }));
      assert.match(await page.textContent('[data-screen="settings"]'), /Diktat-Rechner ist nicht erreichbar/);
      assert.equal(await page.$('#dwList'), null);
      await page.evaluate(() => window.TMSBridge.setDictionary({ unsupported: true }));
      assert.match(await page.textContent('[data-screen="settings"]'), /braucht ein Update/);
    } finally { await browser.close(); }
  });

  test('keine Attrappen: kein KI-Prompt-Schalter, nichts zu Denkpausen, Fluestern oder Lernen', async () => {
    const { browser, page } = await boot();
    try {
      await page.evaluate((s) => window.TMSBridge.setDictionary(s), STATE);
      for (const tab of ['words', 'dictation', 'bubble']) {
        await page.click(`[data-st-act="dw:tab:${tab}"]`);
        const text = await page.textContent('[data-screen="settings"] .st-detail');
        assert.doesNotMatch(text, /KI-Prompt|Denkpause|Flüster|Aus Korrekturen lernen|Neu gelernt/, tab);
      }
    } finally { await browser.close(); }
  });

  test('alle Einstellungsseiten sind matt: keine Unschaerfe auf den Karten', async () => {
    const { browser, page } = await boot();
    try {
      await page.evaluate((s) => window.TMSBridge.setDictionary(s), STATE);
      const blurs = async () => page.$$eval('[data-screen="settings"] .glass, [data-screen="settings"] .dw-card', (els) => els.map((e) => getComputedStyle(e).backdropFilter || getComputedStyle(e).webkitBackdropFilter).filter((v) => v && v !== 'none'));
      assert.deepEqual(await blurs(), []);
      await page.evaluate(() => window.__settingsOpen('app'));
      assert.deepEqual(await blurs(), []);
    } finally { await browser.close(); }
  });

  test('aufgeklappter Fold: Uebersicht links, Woerterbuch rechts, nichts laeuft ueber den Rand', async () => {
    const { browser, page } = await boot(840);
    try {
      await page.evaluate((s) => window.TMSBridge.setDictionary(s), STATE);
      assert.equal(await page.isVisible('.st-hub'), true);
      assert.equal(await page.isVisible('#dwList'), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    } finally { await browser.close(); }
  });
}
