/**
 * Fold-Ansichten in der echten Seite (gebautes liquidDeckHtml): Farbschein
 * um Karte und Eingabe, Abdunkeln-Knopf im Split.
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
  test('Fold-Seitenprüfung übersprungen (kein Playwright)', { skip: 'TMS_VIZ_PW nicht gesetzt' }, () => {});
} else {
  const require = createRequire(join(PW, 'index.js'));
  const { chromium } = require('playwright');

  /** init: läuft vor der Seite (z. B. gemerkte Wahl vorbelegen). */
  async function boot(vp, init) {
    const src = readFileSync(process.env.TMS_DECK_TS || join(here, '../src/season2/web/liquidDeckHtml.ts'), 'utf8');
    const html = JSON.parse(src.match(/export const LIQUID_DECK_HTML = (".*");\s*$/s)[1]);
    const file = join(tmpdir(), `tms-webview-fold-${process.pid}.html`);
    writeFileSync(file, html);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: vp });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.ReactNativeWebView = { postMessage: () => {} };
    });
    if (init) await page.addInitScript(init);
    try {
      await page.goto('file://' + file);
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        window.TMSBridge.setServers([
          { id: 'A', name: 'MacBook', host: 'a', port: 1, status: 'online', active: true, caps: ['dictation'], sessions: 0, os: 'macOS', latency: 10 },
        ]);
        for (let i = 0; i < 2; i++) window.addTerminal();
        show('terminals');
        setActive(0);
      });
      await page.waitForTimeout(300);
    } catch (e) { await browser.close(); throw e; }
    return { browser, page, errors };
  }

  /** Fold-Form erzwingen (derselbe Haken wie im Mockup-Umschalter). */
  async function mode(page, m) {
    await page.evaluate((x) => window.TMSFold.setForce(x), m);
    await page.waitForTimeout(450);
  }
  const css = (page, sel, prop) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [sel, prop]);
  const dimmed = (page) => page.evaluate(() => document.body.classList.contains('fv-dim'));

  const OPEN = { width: 750, height: 560 };

  test('Schein: Eingabe ohne Lichthof, Karte nur feine Linie', async () => {
    const { browser, page, errors } = await boot(OPEN);
    try {
      await mode(page, 'closed');
      const plain = await css(page, '#dock', 'boxShadow');
      await mode(page, 'split-open');
      assert.equal(await css(page, '#dock', 'boxShadow'), plain, 'Eingabe trägt keinen eigenen Ring/Lichthof');
      const card = await css(page, '.stack-card.fv-focus', 'boxShadow');
      assert.match(card, /0px 0px 0px 1px$/, 'Karte: 1 px Linie ohne Unschärfe');
      assert.equal(card.replace(/\([^)]*\)/g, '').split(',').length, 1, 'Karte: genau ein Schatten');
      // Fokuswechsel: kurzer Akzent auf dem Rand, danach wieder Ruhe.
      await page.evaluate(() => setActive(1));
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => document.getElementById('dock').classList.contains('fv-pulse')), false);
      assert.equal(await css(page, '#dock', 'boxShadow'), plain);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Abdunkeln: Knopf nur im Split', async () => {
    const { browser, page } = await boot(OPEN);
    try {
      for (const [m, want] of [['closed', false], ['open', false], ['split-open', true], ['split-closed', true]]) {
        await mode(page, m);
        assert.equal((await css(page, '#fvDimBtn', 'display')) !== 'none', want, m);
      }
    } finally { await browser.close(); }
  });

  test('Abdunkeln: Tipp dunkelt, zweiter Tipp hellt auf', async () => {
    const { browser, page, errors } = await boot(OPEN);
    try {
      await mode(page, 'split-open');
      assert.equal(await dimmed(page), false);
      assert.equal(await css(page, '#fvDim', 'pointerEvents'), 'none');
      await page.click('#fvDimBtn');
      await page.waitForTimeout(400);
      assert.equal(await dimmed(page), true);
      assert.equal(await page.getAttribute('#fvDimBtn', 'aria-pressed'), 'true');
      assert.equal(await page.getAttribute('#fvDimBtn', 'aria-label'), 'Wieder hell');
      assert.equal(await css(page, '#fvDim', 'opacity'), '0.65');
      assert.equal(await page.evaluate(() => localStorage.getItem('tms-fold-dim')), '1');
      // Echter Klick: gelingt nur, wenn der Schleier keinen Tipp schluckt.
      await page.click('#fvDimBtn', { timeout: 2000 });
      await page.waitForTimeout(400);
      assert.equal(await dimmed(page), false);
      assert.equal(await page.getAttribute('#fvDimBtn', 'aria-pressed'), 'false');
      assert.equal(await page.getAttribute('#fvDimBtn', 'aria-label'), 'Abdunkeln');
      assert.equal(await css(page, '#fvDim', 'opacity'), '0');
      assert.equal(await page.evaluate(() => localStorage.getItem('tms-fold-dim')), null);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('Abdunkeln: nur im Split, Wahl bleibt gemerkt', async () => {
    const { browser, page } = await boot(OPEN);
    try {
      await mode(page, 'split-open');
      await page.click('#fvDimBtn');
      await mode(page, 'open');
      assert.equal(await dimmed(page), false, 'Vollbild ist immer hell');
      assert.equal(await css(page, '#fvDim', 'opacity'), '0');
      await mode(page, 'split-closed');
      assert.equal(await dimmed(page), true, 'zurück im Split wieder dunkel');
    } finally { await browser.close(); }
  });

  test('Abdunkeln: Neustart im Split startet dunkel', async () => {
    const { browser, page } = await boot(OPEN, () => {
      localStorage.setItem('tms-fold-dim', '1');
      localStorage.setItem('tms-fold-force', 'split-open');
    });
    try {
      assert.equal(await dimmed(page), true);
      assert.equal(await page.getAttribute('#fvDimBtn', 'aria-pressed'), 'true');
    } finally { await browser.close(); }
  });

  test('Abdunkeln: schaltet auch, wenn der Speicher wirft', async () => {
    const { browser, page, errors } = await boot(OPEN, () => {
      const boom = () => { throw new Error('kein Speicher'); };
      Storage.prototype.setItem = boom;
      Storage.prototype.removeItem = boom;
    });
    try {
      await page.evaluate(() => { window.__fold.force = 'split-open'; window.__fold.mode = ''; window.TMSFold.apply(); });
      await page.waitForTimeout(450);
      await page.click('#fvDimBtn');
      assert.equal(await dimmed(page), true);
      await page.click('#fvDimBtn');
      assert.equal(await dimmed(page), false);
      assert.deepEqual(errors.filter((e) => /kein Speicher/.test(e)), []);
    } finally { await browser.close(); }
  });

  test('Abdunkeln: schmale Zeile behält Platz für die Eingabe', async () => {
    const { browser, page } = await boot({ width: 380, height: 420 });
    try {
      await mode(page, 'split-closed');
      const box = await page.evaluate(() => {
        const r = (id) => document.getElementById(id).getBoundingClientRect();
        return { input: document.getElementById('dockInput').clientWidth, send: r('dockSendBtn').right, dock: r('dock').right, dim: r('fvDimBtn').width };
      });
      assert.ok(box.dim > 0, 'Knopf sichtbar');
      assert.ok(box.input >= 120, `Eingabe breit genug (${box.input})`);
      assert.ok(box.send <= box.dock + 0.5, 'Senden bleibt in der Zeile');
    } finally { await browser.close(); }
  });
}
