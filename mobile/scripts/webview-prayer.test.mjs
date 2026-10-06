/**
 * Was die gebaute Seite wirklich kann — headless im Browser geprueft.
 *
 * Begruendung: Die drei Fehler, die dieser Test festhält, sind alle im Quelltext
 * unsichtbar. Der erste sass im Build (doppelter <script>-Tag, die Seite startete
 * mit einem SyntaxError), der zweite in einer Reihenfolge (var post = … wurde
 * ausgewertet, BEVOR die Bruecke geladen war) und der dritte in CSS-Regeln, die
 * sich gegenseitig ueberschrieben haben. Alle drei haetten die Oberflaeche
 * stumm gemacht, ohne dass irgendetwas geredet haette — und keiner davon steht
 * in einer .ts-Datei, die `tsc` sieht.
 *
 * Der Test braucht Playwright, das NICHT im Repo liegt. Er laeuft deshalb nur
 * mit gesetztem TMS_VIZ_PW:
 *
 *   TMS_VIZ_PW=<pfad-zu-playwright> npm run test:webview
 *
 * Ohne die Variable meldet er sich als uebersprungen — kein Fehler, kein
 * Download einer neuen Abhaengigkeit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '../src/season2/web');

const PW = process.env.TMS_VIZ_PW;
if (!PW) {
  test('WebView-Pruefung uebersprungen (kein Playwright)', { skip: 'TMS_VIZ_PW nicht gesetzt' }, () => {});
} else {
  const require = createRequire(join(PW, 'index.js'));
  const { chromium } = require('playwright');

  const TIMES = [
    { name: 'Fajr', de: 'Fajr', ar: 'الفجر', time: '05:12' },
    { name: 'Sunrise', de: 'Sunrise', ar: 'الشروق', time: '06:41' },
    { name: 'Dhuhr', de: 'Dhuhr', ar: 'الظهر', time: '13:18' },
    { name: 'Asr', de: 'Asr', ar: 'العصر', time: '16:52' },
    { name: 'Maghrib', de: 'Maghrib', ar: 'المغرب', time: '19:34' },
    { name: 'Isha', de: 'Isha', ar: 'العشاء', time: '21:06' },
  ];
  const META = {
    location: { label: 'München, Deutschland', lat: 48.14, lon: 11.58 },
    date: { readable: '1 Oktober 2026', hijri: '19. Rabi al-Awwal' },
    method: { id: 3, name: 'MWL' },
    adhan: { enabled: true, wecker: false, selected: 'mishary' },
    perms: { notifications: true, exactAlarms: false },
  };

  /** HTML aus dem gebauten TypeScript-File holen und als Datei ablegen. */
  function loadPage() {
    const src = readFileSync(join(WEB, 'liquidDeckHtml.ts'), 'utf8');
    const html = JSON.parse(src.match(/export const LIQUID_DECK_HTML = (".*");\s*$/s)[1]);
    const file = join(WEB, '.webview-test.html');
    require('node:fs').writeFileSync(file, html);
    return 'file://' + file;
  }

  async function withPage(fn) {
    const url = loadPage();
    const bridge = readFileSync(join(WEB, 'bridge.js'), 'utf8');
    const prayer = readFileSync(join(WEB, 'prayerBridge.js'), 'utf8');
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      await page.waitForTimeout(400);
      await page.evaluate(([b, p]) => {
        window.__posted = [];
        window.ReactNativeWebView = {
          postMessage: (s) => { try { window.__posted.push(JSON.parse(s)); } catch {} },
        };
        eval(p.replace(/^export /gm, '') + '\nwindow.__tmsNormalizePrayer=normalizePrayerPayload;');
        eval(b);
      }, [bridge, prayer]);
      await page.waitForTimeout(250);
      return await fn(page, errors);
    } finally {
      await browser.close();
    }
  }

  test('die gebaute Seite laeuft ohne SyntaxError', async () => {
    await withPage(async (page, errors) => {
      assert.deepEqual(errors, [], 'die Seite startet nicht sauber — siehe Fehler');
    });
  });

  test('kein doppelter script-Tag im Build', () => {
    const src = readFileSync(join(WEB, 'liquidDeckHtml.ts'), 'utf8');
    const html = JSON.parse(src.match(/export const LIQUID_DECK_HTML = (".*");\s*$/s)[1]);
    assert.equal((html.match(/<script><script>/g) || []).length, 0);
    assert.ok(html.includes('__tmsNormalizePrayer = normalizePrayerPayload'));
  });

  test('post() wird spaet gebunden — die Bruecke kommt nach dem Mockup', async () => {
    await withPage(async (page) => {
      const r = await page.evaluate(([t, m]) => {
        window.TMSBridge.setPrayer(t, m);
        window.show('settings');
        const c = document.querySelector('#adhanEnabled');
        if (!c) return { missing: true };
        c.checked = false;
        c.dispatchEvent(new Event('change', { bubbles: true }));
        return { sent: window.__posted.map((p) => p.type) };
      }, [TIMES, META]);
      assert.ok(!r.missing, 'die Azān-Gruppe fehlt — die Einstellungen zeigen sie nicht');
      assert.ok(r.sent.includes('adhan:toggle'),
        `der Schalter schickt nichts. gesendet: ${r.sent.join(', ')}. `
        + 'Typisch: `var post = window.__tmsPost` — das wird ausgewertet, bevor die Brücke da ist.');
    });
  });

  test('alle acht Nachrichten kommen bei der App an', async () => {
    await withPage(async (page) => {
      const sent = await page.evaluate(([t, m]) => {
        const out = [];
        const rec = () => out.push(...window.__posted.map((p) => p.type));
        window.TMSBridge.setPrayer(t, m);
        window.show('settings');
        window.__posted.length = 0;
        const fire = (sel, ev = 'click') => { const e = document.querySelector(sel); if (e) e.dispatchEvent(new Event(ev, { bubbles: true })); };
        const toggle = document.querySelector('#adhanEnabled');
        toggle.checked = false; toggle.dispatchEvent(new Event('change', { bubbles: true })); rec();
        toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true })); rec();
        fire('#adhanWecker', 'change'); rec();
        fire('#adhanTestBtn'); rec();
        fire('#adhanExactRow'); rec();
        fire('#adhanReciterRow'); rec();
        document.querySelector('[data-adhan-pick="nafees"]')?.click(); rec();
        fire('#adhanMethodRow'); rec();
        document.querySelector('[data-adhan-pick="2"]')?.click(); rec();
        fire('#adhanLocationRow'); rec();
        document.querySelector('#locLat').value = '48,14';
        document.querySelector('#locLon').value = '11.58';
        document.querySelector('#locLabel').value = 'München';
        fire('#locSave'); rec();
        return [...new Set(out)];
      }, [TIMES, META]);

      for (const want of [
        'adhan:toggle', 'adhan:wecker', 'adhan:test', 'adhan:perms',
        'adhan:reciter', 'adhan:preview', 'adhan:method', 'adhan:location',
      ]) {
        assert.ok(sent.includes(want), `${want} kommt nicht an. Angekommen: ${sent.join(', ')}`);
      }
    });
  });

  test('ungueltige Koordinaten werden abgelehnt', async () => {
    await withPage(async (page) => {
      const count = await page.evaluate(([t, m]) => {
        window.TMSBridge.setPrayer(t, m);
        window.show('settings');
        window.__posted.length = 0;
        document.querySelector('#adhanLocationRow').click();
        document.querySelector('#locLat').value = '999';
        document.querySelector('#locLon').value = '0';
        document.querySelector('#locSave').click();
        return window.__posted.filter((p) => p.type === 'adhan:location').length;
      }, [TIMES, META]);
      assert.equal(count, 0, '999 Breitengrad wurde uebernommen');
    });
  });

  test('die Vorschau ist auf dem gesperrten Bildschirm sichtbar, die Anzeige nicht', async () => {
    await withPage(async (page) => {
      const r = await page.evaluate(([t, m]) => {
        window.TMSBridge.setPrayer(t, m);
        const o = document.querySelector('#adhanOverlay');
        window.openAdhanOverlay('Fajr', { preview: true });
        document.body.classList.add('is-locked');
        const previewLocked = getComputedStyle(o).display;
        o.classList.remove('is-preview');
        const anzeigeLocked = getComputedStyle(o).display;
        o.classList.add('is-preview');
        document.body.classList.remove('is-locked');
        return {
          previewLocked, anzeigeLocked,
          laut: getComputedStyle(document.querySelector('#adhanLoud')).display,
          schliessen: getComputedStyle(document.querySelector('#adhanStop')).display,
          zeit: document.querySelector('#adhanTime').textContent,
          unterzeile: document.querySelector('#adhanSub').textContent,
        };
      }, [TIMES, META]);
      assert.notEqual(r.previewLocked, 'none', 'eine ausdrücklich angeforderte Vorschau muss auch bei Lock zu sehen sein');
      assert.equal(r.anzeigeLocked, 'none', 'der PIN-Lock muss die reine Anzeige weiterhin verstecken');
      assert.notEqual(r.laut, 'none', 'in der Vorschau gibt es Stumm/Laut');
      assert.notEqual(r.schliessen, 'none', 'und einen Schließen-Knopf');
      assert.equal(r.zeit, '05:12');
      assert.equal(r.unterzeile, 'Vorschau');
    });
  });

  test('Gebetszeiten-Screen zeigt alles, was die App schickt', async () => {
    for (const [w, h] of [[380, 915], [412, 915]]) {
      const url = loadPage();
      const bridge = readFileSync(join(WEB, 'bridge.js'), 'utf8');
      const prayer = readFileSync(join(WEB, 'prayerBridge.js'), 'utf8');
      const browser = await chromium.launch();
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      await page.goto(url);
      await page.waitForTimeout(400);
      await page.evaluate(([b, p]) => {
        window.ReactNativeWebView = { postMessage: () => {} };
        eval(p.replace(/^export /gm, '') + '\nwindow.__tmsNormalizePrayer=normalizePrayerPayload;');
        eval(b);
      }, [bridge, prayer]);
      await page.waitForTimeout(200);

      const r = await page.evaluate(([t, m]) => {
        window.TMSBridge.setPrayer(t, m);
        window.show('prayer');
        const names = Array.from(document.querySelectorAll('.prayer-row__name')).map((e) => e.textContent.trim());
        const clipped = [];
        document.querySelectorAll('.prayer-row__name, .prayer-row__time, #prayerMeta').forEach((el) => {
          if (el.scrollWidth > el.clientWidth + 1) clipped.push(el.textContent.trim().slice(0, 30));
        });
        return { names, meta: document.querySelector('#prayerMeta').textContent.trim(), clipped };
      }, [TIMES, META]);

      assert.equal(r.names.length, 6, `${w}px: Sunrise fehlt in der Liste (${r.names.join(', ')})`);
      assert.ok(r.names.includes('Sunrise'), `${w}px: Sunrise fehlt`);
      assert.ok(r.meta.includes('München'), `${w}px: Ort fehlt — "${r.meta}"`);
      assert.ok(r.meta.includes('Rabi al-Awwal'), `${w}px: Hijri fehlt`);
      assert.deepEqual(r.clipped, [], `${w}px: Text abgeschnitten: ${r.clipped.join(' | ')}`);

      await ctx.close();
      await browser.close();
    }
  });

  test('die Einstellungen-Gruppe passt bei 380 und 412 und ist erreichbar', async () => {
    for (const [w, h] of [[380, 915], [412, 915]]) {
      const url = loadPage();
      const bridge = readFileSync(join(WEB, 'bridge.js'), 'utf8');
      const prayer = readFileSync(join(WEB, 'prayerBridge.js'), 'utf8');
      const browser = await chromium.launch();
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      await page.goto(url);
      await page.waitForTimeout(400);
      await page.evaluate(([b, p]) => {
        window.ReactNativeWebView = { postMessage: () => {} };
        eval(p.replace(/^export /gm, '') + '\nwindow.__tmsNormalizePrayer=normalizePrayerPayload;');
        eval(b);
      }, [bridge, prayer]);
      await page.waitForTimeout(200);

      const r = await page.evaluate(([t, m]) => {
        window.TMSBridge.setPrayer(t, m);
        window.show('settings');
        const g = document.querySelector('#adhanSettingsGroup');
        // Der Screen, nicht .screen-col, ist der Scrollbereich.
        const sc = document.querySelector('[data-screen="settings"]');
        const kannScrollen = sc.scrollHeight > sc.clientHeight + 4;
        sc.scrollTop = g.offsetTop - 60;
        const rect = g.getBoundingClientRect();
        const clipped = [];
        g.querySelectorAll('.settings-row__label, .settings-row__value').forEach((el) => {
          if (el.scrollWidth > el.clientWidth + 1) clipped.push(el.textContent.trim().slice(0, 30));
        });
        return {
          rows: [...g.querySelectorAll('.settings-row__label')].map((e) => e.childNodes[0].textContent.trim()),
          kannScrollen,
          imBild: rect.top >= 0 && rect.bottom <= window.innerHeight,
          clipped,
        };
      }, [TIMES, META]);

      assert.ok(r.kannScrollen, `${w}px: der Einstellungs-Screen scrollt nicht — die Gruppe waere unerreichbar`);
      assert.ok(r.imBild, `${w}px: die Gruppe laesst sich nicht in den Sichtbereich scrollen`);
      assert.deepEqual(r.rows, [
        'Azān-Benachrichtigung', 'Fajr-Wecker', 'Rezitateur', 'Ort', 'Berechnung', 'Genauigkeit', 'Testen',
      ], `${w}px: andere Zeilen als erwartet`);
      assert.deepEqual(r.clipped, [], `${w}px: Text abgeschnitten: ${r.clipped.join(' | ')}`);

      await ctx.close();
      await browser.close();
    }
  });
}