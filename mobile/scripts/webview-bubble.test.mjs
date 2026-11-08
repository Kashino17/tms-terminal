/**
 * Diktat-Bubble in den Season-2-Einstellungen — headless im Browser.
 *
 * Begruendung: bridge.js haengt die Gruppe an renderSettings() an. Ein
 * gleichnamiges `var` im Bridge-IIFE machte die Huelle einmal rekursiv: die
 * Seite startete nicht (kein bridge:ready, keine TMSBridge-Methoden), und der
 * Fehler war im Quelltext unsichtbar.
 *
 *   TMS_VIZ_PW=<pfad-zu-playwright> node --test scripts/webview-bubble.test.mjs
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

if (!PW) {
  test('Bubble-WebView-Pruefung uebersprungen (kein Playwright)', { skip: 'TMS_VIZ_PW nicht gesetzt' }, () => {});
} else {
  const require = createRequire(join(PW, 'index.js'));
  const { chromium } = require('playwright');

  async function boot() {
    const src = readFileSync(SOURCE, 'utf8');
    const html = JSON.parse(src.match(/export const LIQUID_DECK_HTML = (".*");\s*$/s)[1]);
    const file = join(tmpdir(), `tms-webview-bubble-${process.pid}.html`);
    writeFileSync(file, html);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
    const posts = [];
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.exposeFunction('__post', (m) => posts.push(JSON.parse(m)));
    await page.addInitScript(() => { window.ReactNativeWebView = { postMessage: (m) => window.__post(m) }; });
    await page.goto('file://' + file);
    await page.waitForTimeout(1200);
    return { browser, page, posts, errors };
  }

  test('die Seite startet die Bruecke trotz Bubble-Huelle um renderSettings', async () => {
    const { browser, page, posts, errors } = await boot();
    try {
      assert.deepEqual(errors, []);
      assert.equal(posts.filter((m) => m.type === 'bridge:ready').length, 1);
      assert.equal(await page.evaluate(() => typeof window.TMSBridge.setServers), 'function');
    } finally { await browser.close(); }
  });

  test('Einstellungen zeigen die Diktat-Bubble und melden Klicks an RN', async () => {
    const { browser, page, posts } = await boot();
    try {
      await page.evaluate(() => { document.body.classList.remove('is-locked'); show('settings'); });
      await page.evaluate(() => window.TMSBridge.bubbleStatus({ serviceOn: true, enabled: true, snoozedUntil: Date.now() + 60000 }));
      assert.match(await page.textContent('#bubbleSettingsGroup'), /Diktat-Bubble[\s\S]*Aktiv[\s\S]*Schläft bis/);
      await page.click('#bubbleWakeRow');
      await page.click('#bubbleSettingsGroup label.switch');
      const sent = posts.map((m) => m.type);
      assert.ok(sent.includes('bubble:status'));
      assert.ok(sent.includes('bubble:wake'));
      assert.deepEqual(posts.find((m) => m.type === 'bubble:toggle').payload, { enabled: false });
    } finally { await browser.close(); }
  });

  // Wispr-Vorbild: die Einstellungen zeigen, ob der Hintergrund-Schutz laeuft,
  // und fuehren mit einem Tipp zur fehlenden Erlaubnis bzw. starten ihn.
  test('Hintergrund-Schutz: Zustand sichtbar, Tipp fuehrt zur Loesung', async () => {
    const { browser, page, posts } = await boot();
    try {
      await page.evaluate(() => { document.body.classList.remove('is-locked'); show('settings'); });
      const row = () => page.textContent('#bubbleKeepRow');
      const st = (o) => page.evaluate((x) => window.TMSBridge.bubbleStatus(Object.assign({ serviceOn: true, enabled: true, snoozedUntil: 0 }, x)), o);

      await st({ keepAlive: true, notifications: true });
      assert.match(await row(), /Hintergrund-Schutz[\s\S]*Aktiv/);
      await page.click('#bubbleKeepRow');
      assert.equal(posts.filter((m) => m.type === 'bubble:notify' || m.type === 'bubble:keepalive').length, 0);

      await st({ keepAlive: true, notifications: false });
      assert.match(await row(), /Benachrichtigung/);
      await page.click('#bubbleKeepRow');
      assert.equal(posts.filter((m) => m.type === 'bubble:notify').length, 1);

      await st({ keepAlive: false, notifications: true });
      assert.match(await row(), /Nicht aktiv/);
      await page.click('#bubbleKeepRow');
      assert.equal(posts.filter((m) => m.type === 'bubble:keepalive').length, 1);

      // Bubble in TMS ausgeschaltet: kein Schutz noetig, keine Zeile.
      await st({ enabled: false, keepAlive: false, notifications: true });
      assert.equal(await page.$('#bubbleKeepRow'), null);
    } finally { await browser.close(); }
  });

  test('Von Android gestoppt: nicht mehr "An", Tipp oeffnet den Schalter', async () => {
    const { browser, page, posts } = await boot();
    try {
      await page.evaluate(() => { document.body.classList.remove('is-locked'); show('settings'); });
      const st = (o) => page.evaluate((x) => window.TMSBridge.bubbleStatus(Object.assign({ serviceOn: true, enabled: true, snoozedUntil: 0, keepAlive: true, notifications: true }, x)), o);

      // Switch on, but Android does not bind it any more.
      await st({ bound: false });
      const row = await page.textContent('#bubbleServiceRow');
      assert.match(row, /Von Android gestoppt/);
      assert.match(row, /Gestoppt/);
      assert.doesNotMatch(row, /\bAn\b/);
      // Controls that cannot work while it is stopped are hidden.
      assert.equal(await page.$('#bubbleEnabledSwitch'), null);
      assert.equal(await page.$('#bubbleKeepRow'), null);
      await page.click('#bubbleServiceRow');
      assert.equal(posts.filter((m) => m.type === 'bubble:open').length, 1);

      // Repaired (or an older native build that does not report bound): normal again.
      await st({ bound: true });
      assert.match(await page.textContent('#bubbleServiceRow'), /Aktiv/);
      assert.notEqual(await page.$('#bubbleEnabledSwitch'), null);
      await st({});
      assert.match(await page.textContent('#bubbleServiceRow'), /Aktiv/);
      assert.equal(await page.$('#bubbleExitRow'), null);

      // Diagnose: the last exit reason is shown (escaped), so the cause is visible without adb.
      await st({ bound: false, lastExitAt: new Date(2026, 10, 8, 3, 12).getTime(), lastExit: 'Von Hand gestoppt <x>' });
      const exit = await page.textContent('#bubbleExitRow');
      assert.match(exit, /Letzter Abbruch/);
      assert.match(exit, /08\.11\. 03:12/);
      assert.match(exit, /Von Hand gestoppt <x>/);
    } finally { await browser.close(); }
  });
}
