import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const pw = process.env.TMS_VIZ_PW;

if (!pw) {
  test('terminal creation in the WebView', { skip: 'TMS_VIZ_PW not set' }, () => {});
} else {
  const require = createRequire(join(pw, 'index.js'));
  const { chromium } = require('playwright');
  const source = readFileSync(process.env.TMS_TERMINAL_HTML || join(here, '../src/season2/web/liquidDeckHtml.ts'), 'utf8');
  const html = JSON.parse(source.match(/export const LIQUID_DECK_HTML = (".*");\s*$/s)[1]);

  async function withPage(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'tms-terminal-webview-'));
    const file = join(dir, 'index.html');
    writeFileSync(file, html);
    const browser = await chromium.launch({ executablePath: process.env.TMS_VIZ_BROWSER || undefined });
    try {
      const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(() => {
        window.__posted = [];
        window.ReactNativeWebView = { postMessage: s => window.__posted.push(JSON.parse(s)) };
      });
      await page.goto(pathToFileURL(file).href, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.TMSBridge);
      await fn(page);
      assert.deepEqual(errors, [], 'the built page must run without errors');
    } finally {
      await browser.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function creates(page, count) {
    await page.waitForFunction(n => window.__posted.filter(m => m.type === 'terminal:create').length >= n,
      count, { timeout: 2000 });
    return page.evaluate(() => window.__posted.filter(m => m.type === 'terminal:create'));
  }

  test('the + button requests exactly one real terminal with valid dimensions', async () => {
    await withPage(async page => {
      await page.locator('#addTerminalBtn').click();
      const requests = await creates(page, 1);
      assert.equal(requests.length, 1);
      const p = requests[0].payload;
      assert.ok(p.cardId);
      assert.ok(Number.isInteger(p.cols) && p.cols > 0 && p.cols <= 500);
      assert.ok(Number.isInteger(p.rows) && p.rows > 0 && p.rows <= 200);
      await page.evaluate(p => {
        window.TMSBridge.bindSession(p.cardId, 'new-session');
        window.TMSBridge.output('new-session', 'shell started\r\n');
      }, p);
      await page.waitForFunction(id => document.querySelector('.card-body[data-card-id="' + id + '"]').textContent.includes('shell started'), p.cardId);
      await page.waitForTimeout(400);
      assert.equal((await creates(page, 1)).length, 1, 'binding/output must not create another PTY');
    });
  });

  test('busy session headers cannot postpone a new terminal until output stops', async () => {
    await withPage(async page => {
      await page.evaluate(() => {
        window.TMSBridge.restoreSessions([{ sessionId: 'existing', name: 'Existing' }]);
        let tick = 0;
        window.__busy = setInterval(() => {
          window.TMSBridge.output('existing', 'working\r\n');
          window.TMSBridge.setCardTitle('existing', 'Working ' + (++tick));
          window.TMSBridge.setSessionStatus('existing', 'running');
        }, 20);
      });
      await page.locator('#addTerminalBtn').click();
      const requests = await creates(page, 1);
      assert.equal(requests.length, 1, 'the new card needs its own creation request while updates continue');
      await page.waitForTimeout(500);
      assert.equal((await creates(page, 1)).length, 1);
      await page.evaluate(() => clearInterval(window.__busy));
    });
  });

  test('rapid + clicks create one distinct request per card', async () => {
    await withPage(async page => {
      await page.evaluate(() => { window.addTerminal(); window.addTerminal(); window.addTerminal(); });
      const requests = await creates(page, 3);
      assert.equal(requests.length, 3);
      assert.equal(new Set(requests.map(m => m.payload.cardId)).size, 3);
      await page.waitForTimeout(600);
      assert.equal((await creates(page, 3)).length, 3);
    });
  });

  test('restoring and rebuilding cards reuses their sessions', async () => {
    await withPage(async page => {
      await page.evaluate(() => window.TMSBridge.restoreSessions([
        { sessionId: 'existing-1', name: 'One' },
        { sessionId: 'existing-2', name: 'Two' },
      ]));
      await page.waitForFunction(() => window.__posted.filter(m => m.type === 'terminal:attach').length === 2);
      await page.locator('[data-view="list"]').click();
      await page.waitForTimeout(700);
      assert.equal(await page.evaluate(() => window.__posted.filter(m => m.type === 'terminal:create').length), 0);
      await page.locator('#addTerminalCta').click();
      const requests = await creates(page, 1);
      assert.equal(requests.length, 1, 'the list view must also create a real terminal');
    });
  });
}
