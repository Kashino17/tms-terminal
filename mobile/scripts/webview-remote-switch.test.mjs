/**
 * Fernzugriff: Wechsel zwischen zwei Geräten (MAC | WIN) — headless im Browser.
 *
 * Begründung: beim Wechsel flackerte das Bild zwischen beiden Rechnern. Das
 * Schließen der alten Bildverbindung meldet sich erst eine Netz-Runde später
 * (onclose) — da stand die neue Verbindung oft schon. Der späte onclose der
 * ALTEN Verbindung warf die NEUE weg (ws = null), plante einen "Neuversuch" und
 * ließ die weggeworfene weiterlaufen: zwei Bildströme speisten denselben
 * Dekoder. Und die Zugangsdaten kamen ohne Gerätekennung zurück — eine späte
 * Antwort für das vorige Gerät lenkte den nächsten Neuversuch dorthin.
 *
 *   TMS_VIZ_PW=<pfad-zu-playwright> node --test scripts/webview-remote-switch.test.mjs
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
  test('Fernzugriff-Wechsel-Pruefung uebersprungen (kein Playwright)', { skip: 'TMS_VIZ_PW nicht gesetzt' }, () => {});
} else {
  const require = createRequire(join(PW, 'index.js'));
  const { chromium } = require('playwright');

  async function boot() {
    const src = readFileSync(SOURCE, 'utf8');
    const html = JSON.parse(src.match(/export const LIQUID_DECK_HTML = (".*");\s*$/s)[1]);
    const file = join(tmpdir(), `tms-webview-remote-${process.pid}.html`);
    writeFileSync(file, html);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.__posts = [];
      window.ReactNativeWebView = { postMessage: (m) => window.__posts.push(JSON.parse(m)) };
      // Nachgebaute Bildverbindung: wir entscheiden, wann sie öffnet und
      // wann ihr onclose kommt — wie eine echte Netz-Runde später.
      window.__socks = [];
      class FakeWS {
        constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.__socks.push(this); }
        send(d) { this.sent.push(d); }
        close() { if (this.readyState < 2) this.readyState = 2; }
      }
      FakeWS.OPEN = 1;
      window.WebSocket = FakeWS;
      window.__open = (i) => { const s = window.__socks[i]; s.readyState = 1; s.onopen && s.onopen(); };
      window.__closed = (i) => { const s = window.__socks[i]; s.readyState = 3; s.onclose && s.onclose(); };
      // Nachgebauter Dekoder: Rückstand (decodeQueueSize) stellt der Test ein.
      window.__decoded = 0;
      window.__queue = 0;
      window.VideoDecoder = class {
        constructor() { this.state = 'unconfigured'; }
        configure() { this.state = 'configured'; }
        get decodeQueueSize() { return window.__queue; }
        decode() { window.__decoded++; }
        close() { this.state = 'closed'; }
      };
      window.EncodedVideoChunk = class { constructor(o) { Object.assign(this, o); } };
      window.__frame = (i, key) => {
        const b = new Uint8Array(12); b[0] = 0x01 | (key ? 0x80 : 0);
        window.__socks[i].onmessage({ data: b.buffer });
      };
      window.__startedWith = (i, extra) => {
        const s = window.__socks[i];
        s.onmessage({ data: JSON.stringify({ type: 'remote:started', payload: Object.assign({ width: 100, height: 60, scale: 1 }, extra) }) });
      };
      window.__started = (i) => {
        const s = window.__socks[i];
        s.onmessage && s.onmessage({ data: JSON.stringify({ type: 'remote:started', payload: { width: 100, height: 60, scale: 1 } }) });
      };
    });
    await page.goto('file://' + file);
    await page.waitForTimeout(1200);
    return { browser, page, errors };
  }

  const MAC = { id: 'mac', host: 'mac.host', port: 8767, token: 'tm' };
  const WIN = { id: 'win', host: 'win.host', port: 8767, token: 'tw' };

  test('später onclose der alten Verbindung wirft die neue nicht weg', async () => {
    const { browser, page, errors } = await boot();
    try {
      const r = await page.evaluate(async ({ MAC, WIN }) => {
        window.TMSRemote.switchTo('mac');
        window.TMSBridge.setRemoteTarget(MAC);
        window.__open(0); window.__started(0);
        window.TMSRemote.switchTo('win');
        window.TMSBridge.setRemoteTarget(WIN);
        window.__open(1); window.__started(1);
        window.__closed(0);                 // Mac bestätigt das Schließen erst jetzt
        await new Promise((r) => setTimeout(r, 1200));
        window.TMSRemote.input({ t: 'b', b: 'l', d: true });
        return {
          socks: window.__socks.map((s) => s.url.split('/')[2]),
          winGotInput: window.__socks[1].sent.some((d) => d.indexOf('"t":"b"') >= 0),
          winStillOpen: window.__socks[1].readyState === 1,
        };
      }, { MAC, WIN });
      assert.deepEqual(errors, []);
      assert.deepEqual(r.socks, ['mac.host:8767', 'win.host:8767'], 'kein zusätzlicher Neuversuch');
      assert.equal(r.winStillOpen, true);
      assert.equal(r.winGotInput, true, 'Eingaben gehen an die laufende WIN-Verbindung');
    } finally { await browser.close(); }
  });

  test('späte Zugangsdaten fürs vorige Gerät lenken nicht um', async () => {
    const { browser, page, errors } = await boot();
    try {
      const r = await page.evaluate(async ({ MAC, WIN }) => {
        window.TMSRemote.switchTo('mac');
        window.TMSRemote.switchTo('win');    // schnell weiter, bevor MAC antwortet
        window.TMSBridge.setRemoteTarget(WIN);
        window.TMSBridge.setRemoteTarget(MAC); // Antwort fürs vorige Gerät kommt zu spät
        window.__open(0); window.__started(0);
        window.__closed(0);                  // Netzabbruch → Neuversuch
        await new Promise((r) => setTimeout(r, 1200));
        return window.__socks.map((s) => s.url.split('/')[2]);
      }, { MAC, WIN });
      assert.deepEqual(errors, []);
      assert.deepEqual(r, ['win.host:8767', 'win.host:8767']);
    } finally { await browser.close(); }
  });

  test('Bilder einer abgelösten Verbindung erreichen den Dekoder nicht', async () => {
    const { browser, page } = await boot();
    try {
      const r = await page.evaluate(async ({ MAC, WIN }) => {
        window.TMSRemote.switchTo('mac');
        window.TMSBridge.setRemoteTarget(MAC);
        window.__open(0); window.__started(0);
        window.TMSRemote.switchTo('win');
        window.TMSBridge.setRemoteTarget(WIN);
        window.__open(1);
        // Ein Mac-Steuerbefehl, der noch unterwegs war, darf den WIN-Zustand nicht setzen.
        const old = window.__socks[0];
        old.onmessage && old.onmessage({ data: JSON.stringify({ type: 'remote:started', payload: { width: 777, height: 333, scale: 1 } }) });
        return { w: window.remoteState.w, running: window.remoteState.running };
      }, { MAC, WIN });
      assert.notEqual(r.w, 777);
      assert.equal(r.running, false, 'WIN läuft erst mit seinem eigenen remote:started');
    } finally { await browser.close(); }
  });

  // Windows kann kein Vollbild auf Anfrage liefern: ein kurzer Rückstand im
  // Dekoder (Relais liefert Bilder gebündelt) darf dort kein Standbild auslösen.
  for (const [name, extra, expectDrop] of [
    ['Windows: kurzer Dekoder-Rückstand wird aufgeholt statt verworfen', { keyframeOnDemand: false }, false],
    ['Mac: Rückstand → Vollbild anfordern wie bisher', {}, true],
  ]) {
    test(name, async () => {
      const { browser, page, errors } = await boot();
      try {
        const r = await page.evaluate(({ MAC, extra }) => {
          window.TMSRemote.switchTo('mac');
          window.TMSBridge.setRemoteTarget(MAC);
          window.__open(0); window.__startedWith(0, extra);
          window.__frame(0, true);
          window.__queue = 5;
          window.__frame(0, false);
          return {
            decoded: window.__decoded,
            askedKey: window.__socks[0].sent.some((d) => d.indexOf('remote:keyframe') >= 0),
          };
        }, { MAC, extra });
        assert.deepEqual(errors, []);
        assert.equal(r.askedKey, expectDrop);
        assert.equal(r.decoded, expectDrop ? 1 : 2);
      } finally { await browser.close(); }
    });
  }

  // Nutzer-Screenshot: auf WIN stand "Mac per Fingerabdruck entsperren" und der
  // Touch-ID-Knopf. Der Sperrzustand des Macs darf den Wechsel nicht überleben,
  // und ein Gerät ohne Entsperren zeigt den Knopf gar nicht.
  test('Mac-Sperrhinweis und Touch ID verschwinden auf WIN', async () => {
    const { browser, page, errors } = await boot();
    try {
      const r = await page.evaluate(({ MAC, WIN }) => {
        show('remote');
        const vis = (sel) => { const el = document.querySelector(sel); return !!el && !el.hidden && getComputedStyle(el).display !== 'none'; };
        window.TMSRemote.switchTo('mac');
        window.TMSBridge.setRemoteTarget(MAC);
        window.__open(0); window.__startedWith(0, { unlock: true });
        window.__socks[0].onmessage({ data: JSON.stringify({ type: 'remote:locked', payload: { locked: true } }) });
        const onMac = { banner: vis('#remoteLockBanner'), touch: vis('[data-btn="touchid"]') };
        window.TMSRemote.switchTo('win');
        window.TMSBridge.setRemoteTarget(WIN);
        window.__open(1);
        const connecting = { banner: vis('#remoteLockBanner') };
        window.__startedWith(1, { unlock: false });
        const onWin = { banner: vis('#remoteLockBanner'), touch: vis('[data-btn="touchid"]') };
        return { onMac, connecting, onWin };
      }, { MAC, WIN });
      assert.deepEqual(errors, []);
      assert.deepEqual(r.onMac, { banner: true, touch: true }, 'am gesperrten Mac: Hinweis + Knopf');
      assert.equal(r.connecting.banner, false, 'schon beim Verbinden ist der Mac-Hinweis weg');
      assert.deepEqual(r.onWin, { banner: false, touch: false }, 'auf WIN weder Hinweis noch Touch ID');
    } finally { await browser.close(); }
  });
}
