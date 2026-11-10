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
import { createServer } from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '../src/season2/web');
const PW = process.env.TMS_VIZ_PW;
const SOURCE = process.env.TMS_DECK_TS || join(WEB, 'liquidDeckHtml.ts');

if (!PW) {
  test('Fernzugriff-Wechsel-Pruefung uebersprungen (kein Playwright)', { skip: 'TMS_VIZ_PW nicht gesetzt' }, () => {});
} else {
  const require = createRequire(join(PW, 'index.js'));
  const { chromium } = require('playwright');

  /** Die Rolle von React Native fuer Datei-Inhalte (fileTransfer.ts) — in Node,
   *  denn die Seite selbst darf nicht ins lokale Netz laden. */
  async function nativeFiles(page, filesBase, m) {
    const reply = (d) => page.evaluate(([id, d]) => window.TMSBridge.netReply(id, d), [m.payload.reqId, d]).catch(() => {});
    const p = m.payload;
    if (m.type === 'files:uploadPart') {
      if (p.part === 0) {
        const caps = await fetch(`${p.base}/files/upload?caps=1&token=${p.token}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
        if (!caps.parts) return reply({ error: 'Server zu alt — am Rechner „tms-terminal update“ ausführen' });
      }
      const q = new URLSearchParams({ dir: p.dir, name: p.name, up: p.up, part: String(p.part), enc: 'b64', token: p.token });
      if (p.final) q.set('final', '1');
      if (p.final && p.reveal) q.set('reveal', '1');
      const r = await fetch(`${p.base}/files/upload?${q}`, { method: 'POST', body: p.b64 });
      const d = await r.json().catch(() => ({}));
      return reply(r.ok ? { ok: true, result: d } : { error: d.error || `HTTP ${r.status}` });
    }
    if (m.type === 'files:fetchPreview') {
      const r = await fetch(`${filesBase}/files/download?path=${encodeURIComponent(p.path)}&token=tok`);
      if (!r.ok) return reply({ error: `HTTP ${r.status}` });
      const buf = Buffer.from(await r.arrayBuffer());
      return reply(p.kind === 'img' ? { src: `data:${r.headers.get('content-type')};base64,${buf.toString('base64')}` } : { opened: true });
    }
  }

  async function boot(viewport = { width: 412, height: 915 }, { filesBase = '' } = {}) {
    const src = readFileSync(SOURCE, 'utf8');
    const html = JSON.parse(src.match(/export const LIQUID_DECK_HTML = (".*");\s*$/s)[1]);
    const file = join(tmpdir(), `tms-webview-remote-${process.pid}.html`);
    writeFileSync(file, html);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport });
    const errors = [];
    await page.exposeFunction('__rnNative', (raw) => nativeFiles(page, filesBase, JSON.parse(raw)));
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.__posts = [];
      window.ReactNativeWebView = { postMessage: (m) => { window.__posts.push(JSON.parse(m)); if (/"files:(uploadPart|fetchPreview)"/.test(m)) window.__rnNative(m); } };
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
        constructor() { this.state = 'unconfigured'; (window.__decoders = window.__decoders || []).push(this); }
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
      // Ton: jede geplante Wiedergabe mitzählen (Dauer in Sekunden).
      window.__played = 0;
      window.__playedSec = 0;
      const origStart = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...a) {
        window.__played++; window.__playedSec += this.buffer ? this.buffer.duration : 0;
        return origStart.apply(this, a);
      };
      window.__sound = (i, b64) => {
        const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const b = new Uint8Array(5 + raw.length); b[0] = 0x02; b.set(raw, 5);
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
    // Wie in der App (SeasonTwoWebRoot: baseUrl https://tms.local) — nur so
    // greifen Chromiums Sperren fuer Anfragen ins lokale Netz auch hier.
    await page.route('https://tms.local/', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
    await page.goto('https://tms.local/');
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
        // Fernzugriff v2: Touch ID liegt im Menue (Geraete-Chip), nicht mehr dauerhaft auf dem Trackpad.
        const touchVis = () => { document.getElementById('rxMenuBtn').click(); const v = vis('#remoteTouchId'); window.rxCloseSheet(); return v; };
        window.TMSRemote.switchTo('mac');
        window.TMSBridge.setRemoteTarget(MAC);
        window.__open(0); window.__startedWith(0, { unlock: true });
        window.__socks[0].onmessage({ data: JSON.stringify({ type: 'remote:locked', payload: { locked: true } }) });
        const onMac = { banner: vis('#remoteLockBanner'), touch: touchVis() };
        window.TMSRemote.switchTo('win');
        window.TMSBridge.setRemoteTarget(WIN);
        window.__open(1);
        const connecting = { banner: vis('#remoteLockBanner') };
        window.__startedWith(1, { unlock: false });
        const onWin = { banner: vis('#remoteLockBanner'), touch: touchVis() };
        return { onMac, connecting, onWin };
      }, { MAC, WIN });
      assert.deepEqual(errors, []);
      assert.deepEqual(r.onMac, { banner: true, touch: true }, 'am gesperrten Mac: Hinweis + Knopf');
      assert.equal(r.connecting.banner, false, 'schon beim Verbinden ist der Mac-Hinweis weg');
      assert.deepEqual(r.onWin, { banner: false, touch: false }, 'auf WIN weder Hinweis noch Touch ID');
    } finally { await browser.close(); }
  });

  // Ton aufs Handy: echte Opus-Pakete vom Mac-Helfer (aufgenommen mit
  // --audio, 48 kHz Stereo, 20 ms) laufen durch den echten WebCodecs-Dekoder
  // in die Wiedergabe — und nur, wenn der Schalter an ist.
  const OPUS = JSON.parse(readFileSync(join(here, 'fixtures/remote-opus-sample.json'), 'utf8'));
  for (const on of [true, false]) {
    test(on ? 'Ton an: Mac-Ton wird auf dem Handy abgespielt' : 'Ton aus: nichts wird abgespielt', async () => {
      const { browser, page, errors } = await boot();
      try {
        const r = await page.evaluate(async ({ MAC, OPUS, on }) => {
          if (on) window.TMSRemote.toggleOption('audio');
          window.TMSRemote.switchTo('mac');
          window.TMSBridge.setRemoteTarget(MAC);
          window.__open(0); window.__startedWith(0, { audio: on });
          const start = JSON.parse(window.__socks[0].sent.find((d) => d.indexOf('remote:start') >= 0)).payload;
          for (const p of OPUS) window.__sound(0, p);
          await new Promise((res) => setTimeout(res, 800));
          return {
            asked: start.audio, played: window.__played, sec: window.__playedSec,
            acks: window.__socks[0].sent.filter((d) => d.indexOf('remote:ack') >= 0).length,
          };
        }, { MAC, OPUS, on });
        assert.deepEqual(errors, []);
        assert.equal(r.asked, on, 'der Wunsch geht im Sitzungsstart mit');
        assert.equal(r.acks, 0, 'Ton-Pakete werden nicht als Bilder quittiert');
        if (on) {
          assert.ok(r.played >= OPUS.length * 0.9, `abgespielt ${r.played} von ${OPUS.length}`);
          assert.ok(Math.abs(r.sec - OPUS.length * 0.02) < 0.1, `Dauer ${r.sec.toFixed(2)} s`);
        } else {
          assert.equal(r.played, 0);
        }
      } finally { await browser.close(); }
    });
  }

  // Nutzer: "Wenn ich zurück zum Terminal gehe, sollte der Fernzugriff aus sein" —
  // vorher lief die Sitzung im Hintergrund weiter (Vorhang/Ton am Rechner blieben
  // an), und jede Wiederverbindung meldete erneut "Server zu alt".
  test('Fernzugriff verlassen: nur das Bild ruht, die Sitzung bleibt; zurück zeigt es wieder', async () => {
    const { browser, page, errors } = await boot();
    try {
      const r = await page.evaluate(async ({ MAC }) => {
        document.body.classList.remove('is-locked');
        show('remote');
        window.TMSRemote.switchTo('mac');
        window.TMSBridge.setRemoteTarget(MAC);
        window.__open(0); window.__startedWith(0, {});
        show('terminals');
        const s0 = window.__socks[0];
        const has = (t) => s0.sent.some((d) => d.indexOf(t) >= 0);
        const left = { stopSent: has('remote:stop'), hidden: has('"visible":false'), open: s0.readyState === 1, socks: window.__socks.length };
        window.TMSRemote.suspend();              // App in den Hintergrund
        window.TMSRemote.resume();               // und zurück, Terminal offen
        await new Promise((res) => setTimeout(res, 50));
        const onTerminals = { socks: window.__socks.length, shown: has('"visible":true') };
        show('remote');
        await new Promise((res) => setTimeout(res, 50));
        return { left, onTerminals, back: { socks: window.__socks.length, shown: has('"visible":true'), open: s0.readyState === 1 },
                 dot: document.body.classList.contains('remote-alive') };
      }, { MAC });
      assert.deepEqual(errors, []);
      assert.deepEqual(r.left, { stopSent: false, hidden: true, open: true, socks: 1 }, 'beim Verlassen läuft die Sitzung weiter, nur ohne Bild');
      assert.deepEqual(r.onTerminals, { socks: 1, shown: false }, 'im Terminal kommt kein Bild');
      assert.deepEqual(r.back, { socks: 1, shown: true, open: true }, 'zurück: dieselbe Verbindung, Bild wieder an');
      assert.equal(r.dot, true, 'grüner Punkt: Fernzugriff aktiv');
    } finally { await browser.close(); }
  });

  // Sparsam, solange das Bild nicht zu sehen ist: der Hardware-Dekoder wird
  // freigegeben (er hielt sonst einen Codec des Handys belegt, solange die
  // Sitzung nur gehalten wurde), und nachzügelnde Bilder bauen keinen neuen.
  test('Fernzugriff verlassen gibt den Dekoder frei; zurück baut ihn mit dem ersten Vollbild neu', async () => {
    const { browser, page, errors } = await boot();
    try {
      const r = await page.evaluate(async ({ MAC }) => {
        document.body.classList.remove('is-locked');
        show('remote');
        window.TMSRemote.switchTo('mac');
        window.TMSBridge.setRemoteTarget(MAC);
        window.__open(0); window.__startedWith(0, {});
        window.__frame(0, true); window.__frame(0, false);
        const open = () => (window.__decoders || []).filter((d) => d.state !== 'closed').length;
        const watching = { decoded: window.__decoded, open: open() };
        show('terminals');                       // im Terminal weiterarbeiten
        const afterLeave = { open: open() };
        window.__frame(0, false); window.__frame(0, true);   // Nachzügler von unterwegs
        const late = { decoded: window.__decoded, open: open(), made: window.__decoders.length };
        show('remote');
        await new Promise((res) => setTimeout(res, 50));
        window.__frame(0, false);                // vor dem Vollbild: nichts
        const beforeKey = window.__decoded;
        window.__frame(0, true); window.__frame(0, false);
        return { watching, afterLeave, late, beforeKey, back: { decoded: window.__decoded, open: open() } };
      }, { MAC });
      assert.deepEqual(errors, []);
      assert.deepEqual(r.watching, { decoded: 2, open: 1 });
      assert.deepEqual(r.afterLeave, { open: 0 }, 'Bild weg → Dekoder freigegeben');
      assert.deepEqual(r.late, { decoded: 2, open: 0, made: 1 }, 'Nachzügler: nichts dekodiert, kein neuer Dekoder');
      assert.equal(r.beforeKey, 2, 'zurück: ohne Vollbild wird nichts gezeichnet');
      assert.deepEqual(r.back, { decoded: 4, open: 1 }, 'mit dem Vollbild läuft das Bild wieder');
    } finally { await browser.close(); }
  });

  test('Gerätewechsel beendet das vorige Gerät nicht; ✕ beendet wirklich', async () => {
    const { browser, page, errors } = await boot();
    try {
      const r = await page.evaluate(async ({ MAC, WIN }) => {
        document.body.classList.remove('is-locked');
        show('remote');
        window.TMSRemote.switchTo('mac');
        window.TMSBridge.setRemoteTarget(MAC);
        window.__open(0); window.__startedWith(0, {});
        window.TMSRemote.switchTo('win');
        window.TMSBridge.setRemoteTarget(WIN);
        window.__open(1); window.__startedWith(1, {});
        const macStopped = window.__socks[0].sent.some((d) => d.indexOf('remote:stop') >= 0);
        const aliveBoth = window.__remoteAliveIds().sort();
        window.TMSRemote.stop();                 // ✕ im Fernzugriff
        return { macStopped, aliveBoth, winStopped: window.__socks[1].sent.some((d) => d.indexOf('remote:stop') >= 0),
                 aliveAfter: window.__remoteAliveIds() };
      }, { MAC, WIN });
      assert.deepEqual(errors, []);
      assert.equal(r.macStopped, false, 'MAC-Sitzung ruht nur');
      assert.deepEqual(r.aliveBoth, ['mac', 'win']);
      assert.equal(r.winStopped, true);
      assert.deepEqual(r.aliveAfter, ['mac'], 'nur MAC läuft noch');
    } finally { await browser.close(); }
  });

  test('Insel: grüner Punkt, „Fernzugriff aktiv“ mit Öffnen/Schließen; Schließen beendet die ruhende Sitzung', async () => {
    const { browser, page, errors } = await boot();
    try {
      const r = await page.evaluate(async ({ MAC, WIN }) => {
        document.body.classList.remove('is-locked');
        show('remote');
        window.TMSRemote.switchTo('mac');
        window.TMSBridge.setRemoteTarget(MAC);
        window.__open(0); window.__startedWith(0, {});
        window.TMSRemote.switchTo('win');
        window.TMSBridge.setRemoteTarget(WIN);
        window.__open(1); window.__startedWith(1, {});
        show('terminals');
        const dot = getComputedStyle(document.getElementById('islandRemoteDot')).display !== 'none';
        document.getElementById('statusHeader').click();
        await new Promise((res) => setTimeout(res, 100));
        const rows = [...document.querySelectorAll('.isl-remote-row')].length;
        // MAC schließen: es steht keine Bildverbindung zu ihm — die App holt Zugangsdaten und schickt remote:stop.
        document.querySelector('[data-ralive-close="mac"]').click();
        const asked = window.__posts.filter((p) => p.type === 'remote:open').map((p) => p.payload.id).pop();
        window.TMSBridge.setRemoteTarget(MAC);
        const closer = window.__socks[window.__socks.length - 1];
        closer.readyState = 1; closer.onopen();
        const stopSent = closer.sent.some((d) => d.indexOf('remote:stop') >= 0);
        closer.onmessage({ data: JSON.stringify({ type: 'remote:stopped', payload: { reason: 'x' } }) });
        await new Promise((res) => setTimeout(res, 50));
        return { dot, rows, asked, stopSent, alive: window.__remoteAliveIds(), winStillOpen: window.__socks[1].readyState === 1,
                 rowsAfter: [...document.querySelectorAll('.isl-remote-row')].length };
      }, { MAC, WIN });
      assert.deepEqual(errors, []);
      assert.equal(r.dot, true);
      assert.equal(r.rows, 2);
      assert.equal(r.asked, 'mac');
      assert.equal(r.stopSent, true);
      assert.deepEqual(r.alive, ['win']);
      assert.equal(r.winStillOpen, true, 'WIN bleibt unberührt');
      assert.equal(r.rowsAfter, 1);
    } finally { await browser.close(); }
  });

  test('Hinweis "Server zu alt" nur einmal und nur im Fernzugriff; passt auf den Bildschirm', async () => {
    const { browser, page, errors } = await boot();
    try {
      const r = await page.evaluate(async ({ MAC }) => {
        document.body.classList.remove('is-locked');
        show('remote');
        window.TMSRemote.toggleOption('audio');
        await new Promise((res) => setTimeout(res, 2800)); // Schalter-Hinweis abwarten
        const count = () => [...document.querySelectorAll('#toasts .toast')].filter((t) => /zu alt/.test(t.textContent)).length;
        window.TMSRemote.switchTo('mac');
        window.TMSBridge.setRemoteTarget(MAC);
        window.__open(0); window.__startedWith(0, {});   // alter Server: meldet nichts
        window.__startedWith(0, {});                     // Wiederverbindung
        window.__startedWith(0, {});
        const n = count();
        const t = [...document.querySelectorAll('#toasts .toast')].find((x) => /zu alt/.test(x.textContent));
        const box = t.getBoundingClientRect();
        return { n, left: box.left, right: box.right, vw: window.innerWidth, lines: Math.round(box.height / 17) };
      }, { MAC });
      assert.deepEqual(errors, []);
      assert.equal(r.n, 1, 'nur einmal');
      assert.ok(r.left >= 0 && r.right <= r.vw, `ganz sichtbar (${r.left}..${r.right} von ${r.vw})`);
    } finally { await browser.close(); }
  });
  // Fernzugriff v2: das Bild IST das Trackpad — kein eigener Pad-Bereich,
  // das Bild fuellt die Flaeche, Gesten auf dem Bild werden zu Eingaben,
  // und die Handy-Tastatur macht das Bild nie kleiner.
  test('v2: Bild füllt die Fläche, Gesten senden Zeiger/Klick/Scroll, Tastatur verkleinert nicht', async () => {
    const { browser, page, errors } = await boot();
    try {
      const r = await page.evaluate(async ({ MAC }) => {
        show('remote');
        window.TMSRemote.switchTo('mac');
        window.TMSBridge.setRemoteTarget(MAC);
        window.__open(0);
        window.__startedWith(0, { width: 1600, height: 1000, scale: 2, localCursor: true });
        window.__socks[0].onmessage({ data: JSON.stringify({ type: 'remote:cursor', payload: { x: 0.5, y: 0.5 } }) });
        const ok = document.querySelector('.rx-coach__ok'); if (ok) ok.click();
        const st = document.getElementById('remoteStage');
        const rect = () => document.getElementById('remoteView').getBoundingClientRect();
        const sr = st.getBoundingClientRect(), v0 = rect();
        const out = {
          canvas: [document.getElementById('remoteCanvas').width, document.getElementById('remoteCanvas').height],
          fills: v0.left <= sr.left + 1 && v0.right >= sr.right - 1 && v0.top <= sr.top + 1 && v0.bottom >= sr.bottom - 1,
          cursorShown: getComputedStyle(document.getElementById('rxCursor')).display !== 'none',
          noPadArea: !document.querySelector('.rx-padhint, .remote-pad, #remoteSeg'),
        };
        const n0 = window.__socks[0].sent.length;
        const pe = (type, id, x, y) => st.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: 'touch' }));
        const wait = (ms) => new Promise((res) => setTimeout(res, ms));
        pe('pointerdown', 1, 200, 400); for (let i = 1; i <= 8; i++) { await wait(16); pe('pointermove', 1, 200 + i * 8, 400); } pe('pointerup', 1, 264, 400);
        await wait(60); pe('pointerdown', 1, 200, 400); await wait(40); pe('pointerup', 1, 200, 400);
        await wait(60); pe('pointerdown', 1, 200, 400); pe('pointerdown', 2, 260, 400); await wait(40); pe('pointerup', 1, 200, 400); pe('pointerup', 2, 260, 400);
        await wait(60); pe('pointerdown', 1, 200, 500); pe('pointerdown', 2, 260, 500);
        for (let i = 1; i <= 6; i++) { await wait(16); pe('pointermove', 1, 200, 500 - i * 10); pe('pointermove', 2, 260, 500 - i * 10); }
        pe('pointerup', 1, 200, 440); pe('pointerup', 2, 260, 440);
        await wait(80);
        const ev = window.__socks[0].sent.slice(n0).map((d) => { try { return JSON.parse(d); } catch (e) { return {}; } });
        out.move = ev.some((e) => e.t === 'd' && e.dx > 0);
        out.left = ev.some((e) => e.t === 'b' && e.b === 'l' && e.d) && ev.some((e) => e.t === 'b' && e.b === 'l' && !e.d);
        out.right = ev.some((e) => e.t === 'b' && e.b === 'r' && e.d);
        out.scroll = ev.some((e) => e.t === 's' && e.dy < 0);
        // Handy-Tastatur auf: Flaeche schrumpft (wie adjustResize) — Bild darf nicht kleiner werden.
        const before = rect().width;
        document.getElementById('remoteIme').focus();
        window.layoutRemoteStage();
        out.imeNotSmaller = rect().width >= before - 1;
        out.modsRow = getComputedStyle(document.getElementById('rxMods')).display !== 'none';
        return out;
      }, { MAC });
      assert.deepEqual(errors, []);
      assert.deepEqual(r.canvas, [1600, 1000], 'Canvas in Bildgroesse');
      assert.equal(r.noPadArea, true, 'kein eigener Trackpad-Bereich mehr');
      assert.equal(r.fills, true, 'zugeklappt fuellt das Bild die Flaeche');
      assert.equal(r.cursorShown, true, 'Zeiger sichtbar, sobald der Mac ihn meldet');
      assert.equal(r.move, true, 'Wischen bewegt den Zeiger');
      assert.equal(r.left, true, 'Tippen = Linksklick');
      assert.equal(r.right, true, 'Zwei-Finger-Tipp = Rechtsklick');
      assert.equal(r.scroll, true, 'Zwei Finger schieben = Scrollen');
      assert.equal(r.imeNotSmaller, true, 'Tastatur auf: Bild wird nicht kleiner');
      assert.equal(r.modsRow, true, 'Tastatur auf: Sondertasten-Reihe da');
    } finally { await browser.close(); }
  });
  // Dateien Handy ⇄ Rechner aus dem Fernzugriff: Senden laedt per POST
  // /files/upload ans Fernzugriff-Geraet (ohne CORS-Vorabfrage), Holen oeffnet
  // den Explorer DES Geraets am gewaehlten Ordner (iCloud Drive als Krumen).
  test('Dateien: Senden lädt ans Fernzugriff-Gerät, Holen öffnet dessen Explorer (iCloud)', async () => {
    // Nachgebauter Server im Stueck-Modus (server/src/files/upload.handler.ts).
    const got = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const q = new URL(req.url, 'http://x').searchParams;
        got.push({ method: req.method, url: req.url, q, body: q.get('enc') === 'b64' ? Buffer.from(body, 'base64').toString() : body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET') return res.end(JSON.stringify({ parts: true }));
        const name = q.get('name');
        res.end(JSON.stringify(q.get('final') === '1' ? { name, path: '/Users/x/Downloads/TMS/' + name } : { ok: true }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const { browser, page, errors } = await boot();
    try {
      const r = await page.evaluate(async ({ port }) => {
        const MACT = { id: 'mac', host: '127.0.0.1', port, token: 'tok' };
        window.TMS_DATA.servers = [{ id: 'mac', name: 'MacBook', host: '127.0.0.1', port, status: 'online', primary: true, active: true }];
        window.__remoteSrv = 'mac';
        show('remote');
        window.TMSRemote.switchTo('mac');
        window.TMSBridge.setRemoteTarget(MACT);
        window.__open(0); window.__startedWith(0, {});
        document.getElementById('rxMenuBtn').click();
        const tile = !!document.querySelector('[data-act="files"]');
        document.querySelector('[data-act="files"]').click();
        const dirs = Array.from(document.querySelectorAll('[data-dir]')).map((b) => b.textContent);
        // Senden (der Dateiwaehler selbst ist Android — hier direkt mit File-Objekten)
        const up = await new Promise((res) => window.rxUpload(
          [new File(['hallo welt'], 'notiz.txt', { type: 'text/plain' }), new File(['xy'], 'b.png', { type: 'image/png' })],
          '~/Downloads/TMS', null, (error, saved) => res({ error, saved: saved.map((s) => s.name) })));
        // Holen: iCloud Drive
        window.__posts.length = 0;
        document.querySelector('[data-dir="~/Library/Mobile Documents/com~apple~CloudDocs"]').click();
        const post = window.__posts.find((m) => m.type === 'files:openOn');
        // Seit v1.134 ist der Explorer das fx2-Panel (bund.js) — es liegt über dem Fernzugriff.
        const filesShown = !document.querySelector('.fx2').hidden;
        const loadingText = (document.querySelector('.fx2 .fx2-empty') || {}).textContent;
        const listedBeforeSwitch = window.__posts.some((m) => m.type === 'files:listRaw');
        window.fsSetDir('/Users/x/Library/Mobile Documents/com~apple~CloudDocs/Projekte', [], 'mac');
        const crumbs = Array.from(document.querySelectorAll('.fx2-crumb')).map((b) => b.textContent);
        return { tile, dirs, up, post: post && post.payload, filesShown, loadingText, listedBeforeSwitch, crumbs };
      }, { port });
      assert.deepEqual(errors, []);
      assert.equal(r.tile, true, 'Dateien-Kachel im Menue');
      assert.ok(r.dirs.some((d) => d.includes('iCloud Drive')) && r.dirs.some((d) => d.includes('Schreibtisch')), 'Schnellzugriffe');
      assert.equal(r.up.error, null);
      assert.deepEqual(r.up.saved, ['notiz.txt', 'b.png']);
      // Die Seite schickt nichts selbst — die App fragt erst die Faehigkeit ab, dann Stuecke.
      const posts = got.filter((g) => g.method === 'POST');
      assert.equal(got.filter((g) => g.method === 'GET').length, 2, 'je Datei eine Faehigkeits-Abfrage');
      assert.equal(posts[0].body, 'hallo welt');
      const q0 = posts[0].q, q1 = posts[1].q;
      assert.equal(q0.get('dir'), '~/Downloads/TMS');
      assert.equal(q0.get('token'), 'tok');
      assert.equal(q0.get('final'), '1');
      assert.equal(q0.get('reveal'), null, 'nur die letzte Datei wird gezeigt');
      assert.equal(q1.get('reveal'), '1');
      assert.deepEqual(r.post, { id: 'mac', path: '~/Library/Mobile Documents/com~apple~CloudDocs' });
      assert.equal(r.filesShown, true);
      assert.equal(r.loadingText, 'Lädt …');
      assert.equal(r.listedBeforeSwitch, false, 'nicht beim alten Geraet listen');
      assert.deepEqual(r.crumbs, ['☁ iCloud Drive', 'Projekte']);
    } finally { await browser.close(); srv.close(); }
  });

  test('Holen: Vorschau-Inhalte holt die App — die Seite lädt nichts selbst aus dem Tailnet', async () => {
    // Echter Fall: Chromium sperrt <img>/<video>/<iframe> von https://tms.local ins
    // lokale Netz (Tailscale 100.x) — die Vorschau blieb leer.
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const hits = [];
    const srv = createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const filesBase = `http://127.0.0.1:${srv.address().port}`;
    const { browser, page, errors } = await boot({ width: 768, height: 820 }, { filesBase });
    try {
      await page.evaluate((filesBase) => {
        window.TMS_DATA.servers = [{ id: 'mac', name: 'MacBook', host: '127.0.0.1', port: 1, status: 'online', primary: true, active: true }];
        window.__remoteSrv = 'mac';
        show('remote');
        window.TMSRemote.switchTo('mac');
        window.TMSBridge.setRemoteTarget({ id: 'mac', host: '127.0.0.1', port: 1, token: 'tok' });
        window.__open(0); window.__startedWith(0, {});
        document.getElementById('rxMenuBtn').click();
        document.querySelector('[data-act="files"]').click();
        document.querySelector('[data-dir="~/Desktop"]').click();
        window.TMSBridge.setFilesBase(filesBase, 'tok');
        window.fsSetDir('/Users/x/Desktop', [
          { name: 'foto.png', path: '/Users/x/Desktop/foto.png', isDir: false, size: 70, modified: 1 },
          { name: 'clip.mp4', path: '/Users/x/Desktop/clip.mp4', isDir: false, size: 70, modified: 1 },
          { name: 'Augen.HEIC', path: '/Users/x/Desktop/Augen.HEIC', isDir: false, size: 70, modified: 1 },
        ], 'mac');
      }, filesBase);
      await page.waitForTimeout(700); // Panel fährt ein
      const tap = async (sel) => { const b = await page.locator(sel).boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
      await tap('.fx2-row[data-n="foto.png"]');
      await page.waitForFunction(() => { const i = document.querySelector('.pv.is-on img'); return i && i.naturalWidth > 0; }, null, { timeout: 4000 });
      const img = await page.evaluate(() => {
        const pv = document.querySelector('.pv'), i = pv.querySelector('img'), sb = pv.querySelector('[data-pv="share"]').getBoundingClientRect();
        const t = document.elementFromPoint(sb.x + sb.width / 2, sb.y + sb.height / 2);
        return { src: i.getAttribute('src').slice(0, 22), shareOnTop: !!(t && t.closest('[data-pv="share"]')) };
      });
      await tap('.pv [data-pv="share"]');
      await tap('.pv [data-pv="close"]');
      await tap('.fx2-row[data-n="clip.mp4"]');
      await page.waitForFunction(() => /Player geöffnet/.test((document.querySelector('.pv.is-on .pv-body') || {}).textContent || ''), null, { timeout: 4000 });
      // HEIC kann die WebView nicht zeigen → Android-Betrachter statt kaputtem <img>
      await tap('.pv [data-pv="close"]');
      await tap('.fx2-row[data-n="Augen.HEIC"]');
      await page.waitForFunction(() => /Foto im Betrachter geöffnet/.test((document.querySelector('.pv.is-on .pv-body') || {}).textContent || ''), null, { timeout: 4000 });
      const r = await page.evaluate(() => ({
        posts: window.__posts.filter((m) => /^files:/.test(m.type)).map((m) => m.type + (m.payload.kind ? ':' + m.payload.kind : '')),
        toastZ: +getComputedStyle(document.getElementById('toasts')).zIndex,
        pvZ: +getComputedStyle(document.querySelector('.pv')).zIndex,
        hasVideoTag: !!document.querySelector('.pv video'),
      }));
      assert.deepEqual(errors, []);
      assert.equal(img.src, 'data:image/png;base64,', 'Bild kommt als data:-URL von der App');
      assert.equal(img.shareOnTop, true, 'Teilen-Knopf liegt oben');
      assert.deepEqual(r.posts, ['files:openOn', 'files:fetchPreview:img', 'files:share', 'files:fetchPreview:vid', 'files:fetchPreview:heic']);
      assert.equal(r.hasVideoTag, false, 'kein <video> mit Tailnet-Adresse');
      assert.ok(r.toastZ > r.pvZ, 'Meldungen liegen über der Vorschau');
      assert.ok(hits.every((u) => u.startsWith('/files/download')) && hits.length === 3, 'nur die App (Node) hat geladen');
    } finally { await browser.close(); srv.close(); }
  });
}
