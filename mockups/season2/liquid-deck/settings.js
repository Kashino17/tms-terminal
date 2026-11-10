/* ════════════════════════════════════════════════════════════════════
   Einstellungen — eine Seite für alles (statt Season-2-Seite + klassische
   Einstellungen). Startseite: Suche, Diktat-Bubble als Schnellzugriff,
   Kategorien mit Symbol + Zustand in einer Zeile. Tipp → Unterseite.
   Breiter Bildschirm (aufgeklappter Fold): zwei Spalten.

   Nur Einstellungen, die in Season 2 wirklich wirken. Daten:
   - TMS_DATA.settings   ← App (TMSBridge.setSettings / bubbleStatus)
   - TMS_DATA.prayerMeta ← Gebetsruf (setPrayer / setAdhanSettings)
   - TMS_DATA.cloudAccounts ← Cloud-Konten (setCloudAccounts)
   - TMS_DATA.dictionary ← Wörterbuch + Tempo vom Diktat-Rechner (setDictionary)
   Änderungen gehen als Nachricht an die App; im Mockup bleiben sie lokal.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const LIVE = () => !!window.ReactNativeWebView;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const say = (m) => (typeof window.toast === 'function' ? window.toast(m) : console.log(m));
  const post = (type, payload) => {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type, payload: payload || {} }));
  };

  // ── Symbole (Linien, 24er Raster) ──────────────────────────────────
  const P = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    term: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    link: '<rect x="3" y="5" width="11" height="8" rx="2"/><rect x="10" y="11" width="11" height="8" rx="2"/>',
    cloud: '<path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19.5 11 3.5 3.5 0 0 1 18 18z"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    back: '<path d="m15 6-6 6 6 6"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
    bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>',
    trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    play: '<path d="M8 5.5v13l11-6.5z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
  };
  // ── Arbeitsfläche: matt (Standard) oder Glas ────────────────────────
  // Nur Darstellung dieses Geräts — darum im Speicher der Seite, nicht in der App.
  // Matt ist Standard: am Fold gemessen braucht ein Bild mit Glas 21–26 ms
  // (ruckelt), matt 12–15 ms. „Glas nur vorne" gibt es nicht mehr; wer das
  // gespeichert hatte, bekommt den Standard.
  const CARD_LOOKS = [['matte', 'Matt — flüssig und sparsam'], ['glass', 'Glas']];
  const CARD_LOOK_KEY = 'tms-card-look';
  function cardLook() {
    let v = null;
    try { v = localStorage.getItem(CARD_LOOK_KEY); } catch (_) {}
    return CARD_LOOKS.some(([k]) => k === v) ? v : 'matte';
  }
  function applyCardLook(v) {
    document.body.classList.toggle('cards-matte', v !== 'glass');
  }
  function setCardLook(v) {
    try { localStorage.setItem(CARD_LOOK_KEY, v); } catch (_) {}
    applyCardLook(v);
  }
  applyCardLook(cardLook());

  const ic = (n, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ''}</svg>`;

  // ── Zustand ────────────────────────────────────────────────────────
  // In der App: neutral, bis die App ihre Werte schickt (passiert beim Start).
  const BLANK = { bubble: null, browserBridge: false, persistent: false, appLock: false, lockGrace: 0, version: '', prevVersion: null };
  // Nur Mockup: Beispielwerte, damit man alle Zustände sieht.
  const DEMO = {
    bubble: { serviceOn: true, bound: true, enabled: true, snoozedUntil: 0, keepAlive: true, notifications: true,
      lastCheck: 'sichtbar — Tastatur offen in WhatsApp', lastCheckAt: Date.now() - 4 * 60_000,
      lastExit: 'vom System beendet (Speicher)', lastExitAt: Date.now() - 26 * 3600_000 },
    browserBridge: true, persistent: true, appLock: true, lockGrace: 300,
    version: '1.140.0', prevVersion: { version: '1.139.0', size: '31 MB' },
    adhan: { enabled: true, wecker: true, reciter: 'mishary', location: 'Kuala Lumpur, Malaysia',
      method: { name: 'JAKIM (Malaysia)', auto: true, country: 'MY' },
      perms: { notifications: true, exactAlarms: true, overlay: false, fullscreen: true, battery: false, location: true, backgroundLocation: false },
      next: { name: 'Asr', at: Date.now() + 2 * 3600_000 + 17 * 60_000, exact: true }, exact: true },
    cloud: { render: { connected: true, maskedKey: 'rnd_8f2k…' }, vercel: { connected: false } },
  };
  function S() {
    const d = (window.TMS_DATA = window.TMS_DATA || {});
    if (!d.settings) d.settings = JSON.parse(JSON.stringify(LIVE() ? BLANK : DEMO));
    return d.settings;
  }
  /** Gebetsruf aus den Gebetsdaten der App (im Mockup: Beispielwerte). */
  function A() {
    const m = window.TMS_DATA && window.TMS_DATA.prayerMeta;
    if (m) {
      const perms = m.perms || {};
      return { has: true, enabled: !!(m.adhan && m.adhan.enabled), wecker: !!(m.adhan && m.adhan.wecker),
        reciter: (m.adhan && m.adhan.selected) || 'mishary', location: (m.location && m.location.label) || '',
        method: m.method || null, perms, next: m.next || null, exact: perms.exactAlarms !== false };
    }
    if (LIVE()) return { has: false, enabled: false, wecker: false, reciter: 'mishary', location: '', method: null, perms: {}, next: null, exact: true };
    return Object.assign({ has: true }, S().adhan || DEMO.adhan);
  }
  /** Erlaubnisse, ohne die der Gebetsruf nicht zuverlässig wie ein Anruf kommt. */
  const ADHAN_PERMS = [
    ['overlay', 'Über anderen Apps einblenden', 'Erscheint entsperrt über jeder App — wie ein Anruf', true],
    ['fullscreen', 'Vollbild auf dem Sperrbildschirm', 'Ohne das nur als Benachrichtigung', true],
    ['exact', 'Auf die Minute genau', 'Sonst darf Android ein paar Minuten schieben', true],
    ['battery', 'Akku: nicht einschränken', 'Damit Samsung TMS nicht schlafen legt', true],
    ['notifications', 'Benachrichtigungen', 'Für den Gebetsruf über dem Sperrbildschirm', true],
    ['backgroundLocation', 'Standort: immer erlauben', 'Folgt dir beim Reisen, auch wenn TMS nicht offen ist', false],
  ];
  const permOk = (perms, k) => (k === 'exact' ? perms.exactAlarms : perms[k]);
  function adhanMissing(a) {
    if (!a.enabled) return [];
    return ADHAN_PERMS.filter(([k, , , req]) => req && typeof permOk(a.perms || {}, k) === 'boolean' && !permOk(a.perms || {}, k));
  }
  /** Cloud-Konto: { connected, maskedKey, invalid }. */
  function C(k) {
    const acc = window.TMS_DATA && window.TMS_DATA.cloudAccounts;
    if (acc) return acc[k] || { connected: false };
    if (LIVE()) return { connected: false };
    return (S().cloud || DEMO.cloud)[k] || { connected: false };
  }

  const IDLE_NAMES = { render: 'Render', vercel: 'Vercel' };
  const GRACE = [[0, 'Immer sperren'], [300, '5 Min.'], [600, '10 Min.'], [3600, '1 Std.'], [7200, '2 Std.']];
  const RECITERS = [['mishary', 'Mishary Rashid Alafasy'], ['nafees', 'Ahmad al-Nafees'], ['mansour', 'Mansour Al-Zahrani']];
  const METHODS = [[3, 'Muslim World League'], [2, 'ISNA (Nordamerika)'], [5, 'Ägypten'], [4, 'Umm al-Qura (Mekka)'], [1, 'Karachi']];
  const isLight = () => document.documentElement.getAttribute('data-theme') === 'light';
  const label = (list, v) => (list.find((o) => o[0] === v) || [, '—'])[1];
  const hhmm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'gerade eben' : m < 60 ? `vor ${m} Min.` : m < 1440 ? `vor ${Math.round(m / 60)} Std.` : `vor ${Math.round(m / 1440)} Tagen`; };

  // Bubble-Zustand in einem Wort (+ Ton) — gleiche Regeln wie die bisherige Gruppe.
  function bubbleState() {
    const b = S().bubble;
    if (!b) return { key: 'wait', word: 'Wird geprüft', tone: 'dim', line: 'Einen Moment …' };
    if (!b.serviceOn) return { key: 'off', word: 'Aus', tone: 'dim', line: 'Mikrofon in allen Apps ist ausgeschaltet' };
    if (b.bound === false) return { key: 'stopped', word: 'Gestoppt', tone: 'warn', line: 'Android hat die Bubble gestoppt — einmal aus- und einschalten' };
    if (b.snoozedUntil > Date.now()) return { key: 'sleep', word: 'Pause', tone: 'dim', line: `Pausiert bis ${hhmm(b.snoozedUntil)}` };
    if (!b.enabled) return { key: 'hidden', word: 'Versteckt', tone: 'dim', line: 'Dienst läuft, die Bubble ist ausgeblendet' };
    if (b.keepAlive && b.notifications === false) return { key: 'nonotif', word: 'Aktiv', tone: 'warn', line: 'Aktiv — aber die Benachrichtigung ist blockiert' };
    return { key: 'on', word: 'Aktiv', tone: 'ok', line: 'Erscheint mit der Tastatur, in jeder App' };
  }
  function nextPrayerLine() {
    const list = (window.TMS_DATA && window.TMS_DATA.prayerTimes) || [];
    const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
    const real = list.filter((p) => p.name !== 'Sunrise' && /^\d{1,2}:\d{2}$/.test(p.time || ''));
    const nx = real.find((p) => { const [h, m] = p.time.split(':').map(Number); return h * 60 + m > mins; }) || real[0];
    return nx ? `${nx.name} ${nx.time}` : '';
  }
  function updateInfo() {
    const u = (window.TMS_DATA && window.TMS_DATA.update) || {};
    const st = window.__bundUpdateStateSeen;
    const latest = String(u.latest || '').replace(/^v/, '');
    const has = st ? st !== 'none' : (latest && latest !== String(u.current || '').replace(/^v/, ''));
    return { has: !!has, latest };
  }
  const version = () => S().version || String(((window.TMS_DATA && window.TMS_DATA.update) || {}).current || '').replace(/^v/, '');

  // ── Kategorien: Zustand in einer Zeile, Hinweis-Punkt wenn etwas zu tun ist ──
  const CATS = [
    { id: 'diktat', group: 'Arbeiten', name: 'Diktat & Sprache', icon: 'mic', hue: '#a78bfa',
      desc: 'Wörterbuch, Tempo, Bubble in allen Apps',
      sum: () => { const d = Dict(); return `Bubble ${bubbleState().word.toLowerCase()}` + (d && d.entries ? ` · ${d.entries.length} Begriffe` + (d.speed && d.speed.count ? ` · Ø ${secs(d.speed.medianMs)}` : '') : ''); },
      alert: () => bubbleState().tone === 'warn' },
    { id: 'terminal', group: 'Arbeiten', name: 'Terminal', icon: 'term', hue: '#34d399',
      desc: 'Login-Links, Schrift',
      sum: () => `Login-Links ${S().browserBridge ? 'aufs Handy' : 'am Rechner'}` },
    { id: 'geraete', group: 'Arbeiten', name: 'Geräte & Verbindung', icon: 'link', hue: '#60a5fa',
      desc: 'Bund, Verbindung im Hintergrund',
      sum: () => { const sv = (window.TMS_DATA && window.TMS_DATA.servers) || []; const on = sv.filter((s) => s.status === 'online').length; return `${on} von ${sv.length} Geräten online · Hintergrund ${S().persistent ? 'an' : 'aus'}`; } },
    { id: 'cloud', group: 'Arbeiten', name: 'Cloud-Konten', icon: 'cloud', hue: '#818cf8',
      desc: 'Render und Vercel',
      sum: () => { const n = ['render', 'vercel'].filter((k) => C(k).connected); return n.length ? n.map((k) => IDLE_NAMES[k]).join(' + ') + ' verbunden' : 'Nichts verbunden'; },
      alert: () => ['render', 'vercel'].some((k) => C(k).invalid) },
    { id: 'gebet', group: 'App & Alltag', name: 'Gebetsruf', icon: 'moon', hue: '#fbbf24',
      desc: 'Azān, Fajr-Wecker, Ort',
      sum: () => {
        const a = A(); if (!a.has) return 'Gebetszeiten werden geladen …';
        if (!a.enabled) return 'Azān aus';
        const miss = adhanMissing(a).length;
        if (miss) return `Azān an · ${miss === 1 ? '1 Erlaubnis fehlt' : miss + ' Erlaubnisse fehlen'}`;
        const nx = a.next ? `${a.next.name} ${hhmm(a.next.at)}` : nextPrayerLine();
        return `Azān an${nx ? ' · nächster ' + nx : ''}`;
      },
      alert: () => adhanMissing(A()).length > 0 },
    { id: 'sicherheit', group: 'App & Alltag', name: 'Sicherheit', icon: 'lock', hue: '#f59e0b',
      desc: 'App-Sperre, PIN',
      sum: () => (S().appLock ? `App-Sperre an · ${S().lockGrace ? 'entsperrt ' + label(GRACE, S().lockGrace) : 'immer sperren'}` : 'App-Sperre aus') },
    { id: 'darstellung', group: 'App & Alltag', name: 'Darstellung', icon: 'sun', hue: '#f472b6',
      desc: 'Hell / Dunkel, Arbeitsfläche, Oberfläche',
      sum: () => `${isLight() ? 'Hell' : 'Dunkel'} · Arbeitsfläche ${cardLook() === 'glass' ? 'Glas' : 'matt'}` },
    { id: 'app', group: 'App & Alltag', name: 'App & Updates', icon: 'info', hue: '#94a3b8',
      desc: 'Version, Updates, Daten',
      sum: () => { const u = updateInfo(); return u.has ? `Update ${u.latest} bereit` : `Version ${version() || '—'} · aktuell`; },
      badge: () => updateInfo().has },
  ];
  const cat = (id) => CATS.find((c) => c.id === id);

  // ── Bausteine ─────────────────────────────────────────────────────
  const tile = (c, big) => `<span class="st-tile${big ? ' st-tile--big' : ''}" style="--hue:${c.hue}">${ic(c.icon, 2)}</span>`;
  const sw = (key, on) => `<label class="switch st-switch"><input type="checkbox" data-st-switch="${key}" ${on ? 'checked' : ''}><span class="switch__track"><span class="switch__thumb"></span></span></label>`;
  /** Zeile: Titel + Erklärung links, Steuerung rechts. `id` = Sprungziel der Suche. */
  function row(id, title, desc, right, opts = {}) {
    const tap = opts.tap ? ` data-st-tap="${opts.tap}" role="button" tabindex="0"` : '';
    return `<div class="st-row${opts.tap ? ' is-tap' : ''}${opts.tone ? ' st-row--' + opts.tone : ''}" data-st-row="${id}"${tap}>
      <div class="st-row__text"><div class="st-row__title">${title}</div>${desc ? `<div class="st-row__desc">${desc}</div>` : ''}</div>
      ${right ? `<div class="st-row__right">${right}</div>` : ''}${opts.tap && !opts.noChev ? `<span class="st-chev${opts.chevDown ? ' st-chev--down' : ''}">${ic('chev', 2)}</span>` : ''}
    </div>`;
  }
  const val = (t, tone) => `<span class="st-val${tone ? ' st-val--' + tone : ''}">${t}</span>`;
  const pill = (txt, act, tone) => `<button type="button" class="st-btn${tone ? ' st-btn--' + tone : ''}" data-st-act="${act}">${txt}</button>`;
  /** Auswahl als Liste (lange Namen) — klappt unter der Zeile auf. */
  function choice(id, title, desc, key, list, cur, extra) {
    const open = openChoice === id;
    return `<div class="st-choice${open ? ' is-open' : ''}">
      ${row(id, title, desc, val(esc(label(list, cur))), { tap: 'choice:' + id, chevDown: true })}
      <div class="st-choice__list">${list.map(([v, l]) => `<button type="button" class="st-opt${v === cur ? ' is-on' : ''}" data-st-pick="${key}" data-v="${v}">
        <span>${esc(l)}</span>${extra ? extra(v) : ''}<span class="st-opt__check">${v === cur ? ic('check', 2.4) : ''}</span></button>`).join('')}</div>
    </div>`;
  }
  const section = (title, body, note) => `<div class="st-sec">${title ? `<h3 class="st-sec__title">${title}</h3>` : ''}<div class="st-card glass">${body}</div>${note ? `<p class="st-sec__note">${note}</p>` : ''}</div>`;

  // ── Diktat & Sprache: Wörterbuch · Diktat · Bubble ─────────────────
  // Das Wörterbuch liegt auf dem Rechner, der transkribiert. Die Seite zeigt,
  // was er meldet (TMS_DATA.dictionary), und schickt jede Änderung als
  // Nachricht (dict:*) — er antwortet mit dem neuen Stand.
  const DW = { tab: 'words', open: null, filter: 'all' };
  const DEMO_DICT = {
    entries: [
      { id: 'd1', term: 'Wispr Flow', heard: ['Vispa Flow', 'Whisperflow'], source: 'manual', uses: 14, createdAt: 9 },
      { id: 'd2', term: 'Liquid Deck', heard: [], source: 'manual', uses: 0, createdAt: 8 },
      { id: 'd3', term: 'Claude Code', heard: ['Cloud Code'], source: 'seed', uses: 212, createdAt: 7 },
      { id: 'd4', term: 'Tailscale', heard: ['Tail Scale'], source: 'seed', uses: 31, createdAt: 6 },
      { id: 'd5', term: 'WebView', heard: ['Web View'], source: 'seed', uses: 58, createdAt: 5 },
      { id: 'd6', term: 'ptyd', heard: ['P T Y D'], source: 'seed', uses: 9, createdAt: 4 },
      { id: 'd7', term: 'Fernzugriff', heard: [], source: 'seed', uses: 0, createdAt: 3 },
    ],
    speed: { count: 24, medianMs: 460, under700: 0.92, waits: [420, 550, 380, 610, 470, 520, 830, 440, 390, 580, 490, 410, 630, 360, 510, 460, 570, 430, 790, 480, 400, 530, 450, 590] },
  };
  /** { entries, speed } vom Diktat-Rechner · { offline } · { unsupported } · null = noch keine Antwort. */
  function Dict() {
    const d = window.TMS_DATA = window.TMS_DATA || {};
    if (d.dictionary) return d.dictionary;
    if (LIVE()) return null;
    return (d.dictionary = JSON.parse(JSON.stringify(DEMO_DICT)));
  }
  const secs = (ms) => (ms / 1000).toFixed(2).replace('.', ',') + ' s';
  const SOURCES = { manual: 'Von dir angelegt', seed: 'Mitgeliefert', learned: 'Automatisch gelernt' };
  const dwCard = (title, body, extra) => `<div class="dw-sec">${title ? `<div class="dw-sec__head"><h3>${title}</h3>${extra || ''}</div>` : ''}<div class="dw-card">${body}</div></div>`;
  const dwNote = (title, text) => `<div class="dw-card dw-state"><b>${title}</b><span>${text}</span></div>`;
  /**
   * Eine Änderung: sofort im gezeigten Stand nachziehen, dann an den Rechner.
   * Sofort, weil die nächste Änderung auf dem gezeigten Stand aufbaut — zwei
   * schnelle Tipps hintereinander würden sonst die erste Änderung zurückdrehen.
   * Der Rechner antwortet mit seinem Stand; der gilt. (Im Mockup ohne App
   * bleibt es beim lokalen Stand, damit man alles ausprobieren kann.)
   */
  function dictSend(type, payload) {
    const d = Dict(), e = d && d.entries ? d.entries.find((x) => x.id === payload.id) : null;
    if (d && d.entries) {
      if (type === 'dict:add' && !LIVE()) d.entries.unshift({ id: 'n' + Date.now(), term: payload.term, heard: [], source: 'manual', uses: 0, createdAt: Date.now() });
      if (type === 'dict:update' && e) e.heard = payload.heard;
      if (type === 'dict:remove') d.entries = d.entries.filter((x) => x.id !== payload.id);
    }
    post(type, payload);
    render(true);
  }

  function dwWords() {
    const d = Dict();
    if (!d) return dwNote('Wörterbuch wird geladen …', 'Es liegt auf dem Rechner, über den du diktierst.');
    if (d.offline) return dwNote('Der Diktat-Rechner ist nicht erreichbar', 'Das Wörterbuch liegt auf dem Rechner, über den du diktierst. Sobald er wieder online ist, erscheint es hier.');
    if (d.unsupported || !d.entries) return dwNote('Der Diktat-Rechner braucht ein Update', 'Das Wörterbuch kommt mit der neuen Server-Version: am Rechner „tms-terminal update“ ausführen.');
    const count = (v) => (v === 'all' ? d.entries.length : d.entries.filter((e) => e.source === v).length);
    const shown = d.entries.filter((e) => DW.filter === 'all' || e.source === DW.filter);
    const items = shown.map((e) => {
      const open = DW.open === e.id;
      return `<div class="dw-item${open ? ' is-open' : ''}" data-dw-term="${esc((e.term + ' ' + e.heard.join(' ')).toLowerCase())}">
        <button type="button" class="dw-item__row" data-st-act="dw:open:${esc(e.id)}"><span class="dw-item__text"><b>${esc(e.term)}</b><small>${e.heard.length ? 'gehört als ' + e.heard.map(esc).join(', ') : e.inPrompt === false ? 'passt nicht mehr in die Hörliste' : 'wird beim Zuhören bevorzugt'}</small></span>
          ${e.uses ? `<span class="dw-item__n">${e.uses}×</span>` : ''}<span class="st-chev st-chev--down">${ic('chev', 2)}</span></button>
        ${open ? `<div class="dw-item__more"><div class="dw-lab">Wird so gehört</div>
          <div class="dw-chips">${e.heard.map((h, i) => `<span class="dw-chip">${esc(h)}<button type="button" data-st-act="dw:unheard:${esc(e.id)}:${i}" aria-label="${esc(h)} entfernen">${ic('x', 2.4)}</button></span>`).join('') || '<span class="dw-none">Noch kein Hörfehler bekannt</span>'}</div>
          <div class="dw-line"><input id="dwHeard" type="text" class="dw-input" placeholder="Hörfehler ergänzen" autocomplete="off" autocapitalize="off" enterkeyhint="done" data-dw-id="${esc(e.id)}">
            <button type="button" class="st-btn" data-st-act="dw:heard:${esc(e.id)}">Merken</button></div>
          <div class="dw-item__btns"><span class="dw-src">${SOURCES[e.source] || ''}${e.uses ? ` · ${e.uses}× ersetzt` : ''}</span><button type="button" class="st-btn st-btn--danger" data-st-act="dw:del:${esc(e.id)}">${ic('trash', 2)}Löschen</button></div></div>` : ''}</div>`;
    }).join('');
    return dwCard('', `<div class="dw-add"><span class="dw-add__ic">${ic('plus', 2.2)}</span><input id="dwAdd" type="text" class="dw-input dw-input--bare" placeholder="Suchen oder neu" autocomplete="off" autocapitalize="off" enterkeyhint="done">
        <button type="button" class="st-btn st-btn--accent" data-st-act="dw:add">Hinzufügen</button></div>
      <div class="dw-filter">${[['all', 'Alle'], ['manual', 'Von dir'], ['seed', 'Mitgeliefert']].map(([v, l]) => `<button type="button" class="${DW.filter === v ? 'is-on' : ''}" data-st-act="dw:filter:${v}">${l} <i>${count(v)}</i></button>`).join('')}</div>
      <div id="dwList">${items || '<p class="dw-none dw-none--pad">Hier ist noch nichts.</p>'}</div>`)
      + `<p class="st-sec__note">Begriffe werden beim Zuhören bevorzugt${d.entries.some((e) => e.inPrompt === false) ? ' — die Spracherkennung kann sich nur eine begrenzte Liste merken, deine eigenen kommen zuerst' : ''}. Trägst du zu einem Begriff ein, wie er falsch gehört wird, ersetzt das Diktat es von selbst — nur ganze Wörter, nie mitten im Wort.</p>`;
  }
  function dwDictation() {
    const d = Dict(), sp = d && d.speed;
    let tempo;
    if (!sp || !sp.count) {
      tempo = `<div class="dw-tempo"><div class="dw-tempo__num"><b class="is-empty">—</b><span>${!d ? 'Wird geladen …' : d.offline ? 'Der Diktat-Rechner ist nicht erreichbar' : d.unsupported ? 'Der Diktat-Rechner braucht ein Update' : 'Noch keine Diktate gemessen'}</span></div></div>`;
    } else {
      const top = Math.max(1400, ...sp.waits), ok = sp.medianMs <= 700;
      tempo = `<div class="dw-tempo"><div class="dw-tempo__num"><b class="${ok ? '' : 'is-slow'}">${secs(sp.medianMs)}</b><span>Stopp bis Text · ${sp.count === 1 ? 'letztes Diktat' : 'letzte ' + sp.count + ' Diktate'}</span></div>
        <div class="dw-tempo__bars" aria-hidden="true">${sp.waits.map((w) => `<i class="${w > 700 ? 'is-slow' : ''}" style="height:${Math.max(3, Math.round(w / top * 48))}px"></i>`).join('')}<em style="bottom:${Math.round(700 / top * 48)}px"></em></div>
        <div class="dw-tempo__foot"><span><i class="st-dot st-dot--${sp.under700 >= 0.9 ? 'ok' : 'warn'}"></i>${Math.round(sp.under700 * 100)} % unter 0,7 s</span><span>Linie = 0,7 s</span></div></div>`;
    }
    return dwCard('Tempo', tempo)
      + '<p class="st-sec__note">Diktiert wird über das MacBook, nichts verlässt deine Geräte. Ist es offline, fehlt der Mikrofon-Knopf.</p>';
  }

  // ── Unterseiten ───────────────────────────────────────────────────
  const PAGES = {
    diktat() {
      const s = S(), b = s.bubble || {}, st = bubbleState();
      const on = b.serviceOn && b.bound !== false;
      let bub = row('bubble-service', 'Mikrofon in allen Apps', st.key === 'stopped' ? 'Von Android gestoppt — antippen, dann den Schalter einmal aus- und wieder einschalten' : 'Android-Bedienungshilfe „TMS Diktat-Bubble“',
        val(st.key === 'wait' ? '…' : st.key === 'off' ? 'Aus' : st.key === 'stopped' ? 'Gestoppt' : 'An', st.key === 'stopped' ? 'warn' : (st.key === 'off' || st.key === 'wait') ? '' : 'ok'), { tap: 'bubble:open', tone: st.key === 'stopped' ? 'warn' : '' });
      if (on) {
        bub += row('bubble-show', 'Bubble anzeigen', 'Gedrückt halten = 15 Min. Pause', sw('bubble.enabled', b.enabled));
        if (b.snoozedUntil > Date.now()) bub += row('bubble-wake', `Pausiert bis ${hhmm(b.snoozedUntil)}`, 'Jetzt wieder einblenden', pill('Aufwecken', 'bubble:wake'));
        else if (b.enabled) bub += row('bubble-snooze', '15 Minuten pausieren', 'Blendet die Bubble kurz aus', pill('Pause', 'bubble:snooze'));
        if (b.enabled && typeof b.keepAlive === 'boolean') bub += row('bubble-keep', 'Hintergrund-Schutz', !b.keepAlive ? 'Nicht aktiv — antippen zum Starten' : b.notifications === false ? 'Benachrichtigung blockiert — antippen zum Erlauben' : 'Die Bubble bleibt im Hintergrund wach',
          val(!b.keepAlive ? 'Aus' : b.notifications === false ? 'Prüfen' : 'An', !b.keepAlive || b.notifications === false ? 'warn' : 'ok'), (!b.keepAlive || b.notifications === false) ? { tap: 'bubble:keep' } : {});
      }
      const diag = st.key === 'wait' ? '' : `<details class="st-more"${openMore ? ' open' : ''}><summary>${ic('chev', 2)}<span>Fehlersuche</span><small>Letzte Prüfung ${b.lastCheckAt ? ago(b.lastCheckAt) : '—'}</small></summary>
        ${b.lastCheckAt ? row('bubble-check', 'Letzte Prüfung', `${hhmm(b.lastCheckAt)} — ${esc(b.lastCheck)}`) : ''}
        ${b.lastExitAt ? row('bubble-exit', 'Letzter Abbruch', `${new Date(b.lastExitAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${hhmm(b.lastExitAt)} — ${esc(b.lastExit)}`) : ''}
        ${on ? row('bubble-trace', 'Protokoll kopieren', 'Für die Fehlersuche — danach im Chat einfügen', pill('Kopieren', 'bubble:trace')) : ''}
      </details>`;
      const tabs = [['words', 'Wörterbuch', 'book'], ['dictation', 'Diktat', 'bolt'], ['bubble', 'Bubble', 'mic']];
      const body = DW.tab === 'words' ? dwWords() : DW.tab === 'dictation' ? dwDictation() : dwCard('', bub + diag);
      return `<div class="dw"><div class="dw-tabs" role="tablist">${tabs.map(([k, l, i]) => `<button type="button" role="tab" aria-selected="${DW.tab === k}" class="${DW.tab === k ? 'is-on' : ''}" data-st-act="dw:tab:${k}">${ic(i, 2)}<span>${l}</span>${k === 'bubble' && st.tone === 'warn' ? '<i class="st-dot st-dot--warn"></i>' : ''}</button>`).join('')}</div>${body}</div>`;
    },
    terminal() {
      const s = S();
      return section('Browser', row('browser-bridge', 'Login-Links aufs Handy', 'Öffnet Login-Seiten aus dem Terminal (z. B. render login) im App-Browser', sw('browserBridge', s.browserBridge)))
        + section('Schrift', row('font-size', 'Schriftgröße', 'Passt sich der Breite an — immer 50 Zeichen pro Zeile', val('Automatisch')));
    },
    geraete() {
      const s = S(), sv = (window.TMS_DATA && window.TMS_DATA.servers) || [];
      const devs = sv.map((d) => row('dev-' + d.id, esc(d.name), `${esc(d.host)}:${esc(d.port)}`, val(d.status === 'online' ? (d.latency != null ? d.latency + ' ms' : 'online') : 'offline', d.status === 'online' ? 'ok' : ''))).join('');
      return section('Bund', devs + row('bund-open', 'Geräte verwalten', 'Hinzufügen, umbenennen, entfernen', '', { tap: 'go:servers' }))
        + section('Verbindung', row('persistent', 'Verbindung im Hintergrund', 'Terminals bleiben verbunden, wenn die App zu ist (Dauer-Benachrichtigung)', sw('persistent', s.persistent)),
          'Kein Hauptserver: jedes Gerät ist direkt verbunden, alles folgt dem Terminal vorne.');
    },
    cloud() {
      const acc = (k) => {
        const a = C(k), name = IDLE_NAMES[k];
        if (!a.connected) return row('cloud-' + k, name, 'Nicht verbunden', pill('Verbinden', 'cloud:connect', 'accent'));
        return row('cloud-' + k, name, a.invalid ? 'Schlüssel ungültig — trennen und neu verbinden' : `${esc(a.maskedKey || '••••')} · verbunden`, pill('Trennen', 'cloud:disconnect:' + k), a.invalid ? { tone: 'warn' } : {});
      };
      return section('Konten', acc('render') + acc('vercel'), 'Die Schlüssel liegen verschlüsselt auf dem Handy.');
    },
    gebet() {
      const a = A();
      if (!a.has) return section('', row('adhan-wait', 'Gebetszeiten werden geladen …', 'Braucht einmal den Standort', pill('Ort wählen', 'adhan:location')));
      let body = row('adhan', 'Azān', 'Klingelt zur Gebetszeit wie ein Anruf — auch bei gesperrtem Bildschirm', sw('adhan.enabled', a.enabled));
      if (a.enabled) {
        if (a.next) body += row('adhan-next', `Nächster Azān: ${esc(a.next.name)} · ${hhmm(a.next.at)}`,
          a.next.exact ? 'Fest gestellt — klingelt auch, wenn TMS geschlossen ist' : 'Gestellt, kann sich aber um ein paar Minuten verschieben',
          val(a.next.exact ? 'Pünktlich' : 'Ungenau', a.next.exact ? 'ok' : 'warn'));
        body += row('adhan-wecker', 'Fajr-Wecker', 'Morgengebet spielt sofort laut, ohne Antippen', sw('adhan.wecker', a.wecker));
        body += choice('adhan-reciter', 'Rezitator', 'Wer den Azān ruft', 'adhan.reciter', RECITERS, a.reciter,
          (v) => `<span class="st-opt__play" data-st-act="adhan:listen:${v}" role="button" aria-label="Anhören">${ic('play', 2)}</span>`);
        body += row('adhan-test', 'Testen', 'Klingelt in 10 Sekunden — genau wie echt (gern mit gesperrtem Handy)', pill('Test', 'adhan:test'));
      }
      let out = section('Azān', body);
      const perms = a.perms || {};
      const rows = ADHAN_PERMS.filter(([k]) => typeof permOk(perms, k) === 'boolean');
      if (a.enabled && rows.length) {
        out += section('Damit es zuverlässig klingelt', rows.map(([k, title, desc, req]) => {
          const ok = permOk(perms, k);
          return row('perm-' + k, title, desc, ok ? val('Erlaubt', 'ok') : pill('Erlauben', 'adhan:perm:' + k, req ? 'warn' : ''), ok || !req ? {} : { tone: 'warn' });
        }).join(''), 'Einmal einrichten — danach kommt der Gebetsruf wie ein Anruf: über allem, nur mit „Stumm“, „Laut“, Sperr- oder Lautstärketaste zu beenden.');
      }
      const method = a.method && a.method.name ? a.method.name : 'Muslim World League';
      const nx = nextPrayerLine();
      const where = row('adhan-loc', 'Ort', esc(a.location || 'Aktueller Standort'), val('Automatisch'), { tap: 'adhan:location' })
        + row('adhan-method', 'Berechnung', 'Automatisch die offizielle Methode des Landes, in dem du gerade bist', val(esc(method)))
        + row('prayer-times', 'Heutige Gebetszeiten', nx ? `Nächstes: ${esc(nx)}` : '', '', { tap: 'go:prayer' });
      return out + section('Zeiten', where);
    },
    sicherheit() {
      const s = S();
      let body = row('app-lock', 'App-Sperre', 'Fingerabdruck oder PIN beim Öffnen', sw('appLock', s.appLock));
      if (s.appLock) {
        body += row('pin', 'PIN ändern', '', '', { tap: 'lock:pin' });
        body += choice('grace', 'Entsperrt bleiben', 'Keine erneute Abfrage innerhalb dieser Zeit', 'lockGrace', GRACE, s.lockGrace);
        body += row('lock-now', 'Jetzt sperren', '', pill('Sperren', 'lock:now'));
      }
      return section('', body);
    },
    darstellung() {
      const light = isLight();
      const card = (v, name, on) => `<button type="button" class="st-look${on ? ' is-on' : ''}" data-st-look="${v}" role="radio" aria-checked="${on}">
        <span class="st-look__prev st-look__prev--${v}"><i></i><i></i><i></i></span><span class="st-look__name">${name}</span></button>`;
      return section('Erscheinungsbild', `<div class="st-looks" role="radiogroup">${card('dark', 'Dunkel', !light)}${card('light', 'Hell', light)}</div>`, 'Hell ist für direktes Sonnenlicht gemacht.')
        + section('Arbeitsfläche', choice('card-look', 'Terminal, Tasten und Eingabezeile', 'Wirkt sofort', 'cardLook', CARD_LOOKS, cardLook()),
          'Matt zeichnet am Fold doppelt so schnell wie Glas und schont den Akku.')
        + section('Oberfläche', row('classic', 'Klassische Oberfläche', 'Season 2 verlassen — jederzeit wieder umschaltbar', pill('Wechseln', 'nav:classic')));
    },
    app() {
      const s = S(), u = updateInfo();
      let body = row('version', 'Installiert', '', val(version() ? 'v' + esc(version()) : '—'));
      body += u.has ? '<div class="st-upd" id="stUpdHost"></div>' : row('update-check', 'Nach Updates suchen', 'Sucht auch von selbst alle 15 Minuten', pill('Suchen', 'update:check'));
      if (s.prevVersion) body += row('prev-version', 'Vorherige Version', `${esc(s.prevVersion.version)} · ${esc(s.prevVersion.size)} — falls die neue Probleme macht`, pill('Zurück', 'app:prev'));
      const danger = confirmWipe
        ? `<div class="st-confirm"><b>Wirklich alle Daten löschen?</b><small>Geräte, Einstellungen, Notizen und Zwischenablage auf diesem Handy sind danach weg.</small>
            <div class="st-confirm__btns">${pill('Abbrechen', 'wipe:no')}${pill('Alles löschen', 'wipe:yes', 'danger')}</div></div>`
        : row('wipe', 'Alle Daten löschen', 'Setzt die App auf diesem Handy komplett zurück', pill('Löschen', 'wipe:ask', 'danger'));
      return section('Version', body) + section('Zurücksetzen', danger);
    },
  };

  // ── Suche: jede Zeile jeder Unterseite, mit Pfad ────────────────────
  const EXTRA_WORDS = {
    'browser-bridge': 'browser login vercel render link',
    persistent: 'hintergrund verbindung akku dienst', 'app-lock': 'sperre pin fingerabdruck biometrie',
    classic: 'season klassisch alt', 'update-check': 'update version', wipe: 'reset zurücksetzen löschen',
    'adhan-reciter': 'rezitator muezzin stimme', 'bubble-service': 'bubble mikrofon bedienungshilfe',
    'adhan-loc': 'ort standort gps stadt reisen', 'adhan-method': 'berechnung methode jakim mwl land', 'perm-overlay': 'überlagerung anruf vollbild', 'perm-battery': 'akku energiesparen samsung', 'font-size': 'schrift größe zoom', 'card-look': 'flackern flimmern glas matt karten stapel unschärfe akku',
  };
  const DIAG = new Set(['bubble-check', 'bubble-exit']); // Diagnose-Text ist kein Suchbegriff
  function searchIndex() {
    const out = [];
    const tmp = document.createElement('div');
    const keep = [openChoice, openMore, confirmWipe];
    openMore = true; // Fehlersuche-Zeilen auch finden
    CATS.forEach((c) => {
      tmp.innerHTML = PAGES[c.id]();
      tmp.querySelectorAll('[data-st-row]').forEach((r) => {
        const t = r.querySelector('.st-row__title'), d = r.querySelector('.st-row__desc');
        if (!t) return;
        const id = r.dataset.stRow;
        out.push({ cat: c, row: id, title: t.textContent.trim(), desc: d ? d.textContent.trim() : '', words: EXTRA_WORDS[id] || '' });
      });
    });
    [openChoice, openMore, confirmWipe] = keep;
    return out;
  }
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // ── Darstellung der Seite ──────────────────────────────────────────
  let cur = null;           // offene Kategorie (null = Startseite)
  let query = '';
  let openChoice = null;    // aufgeklappte Auswahl
  let openMore = false;     // Fehlersuche aufgeklappt
  let confirmWipe = false;
  let lastHtml = '';
  const wide = () => window.matchMedia('(min-width: 700px)').matches;
  const hostEl = () => document.querySelector('[data-screen="settings"]');

  function quickCard() {
    const st = bubbleState(), b = S().bubble || {};
    const live = b.serviceOn && b.bound !== false;
    const act = st.key === 'stopped' ? pill('Beheben', 'bubble:open', 'warn')
      : st.key === 'off' ? pill('Einschalten', 'bubble:open', 'accent')
      : st.key === 'sleep' ? pill('Aufwecken', 'bubble:wake')
      : (live && b.enabled) ? pill(`${ic('pause', 2.2)} 15 Min.`, 'bubble:snooze') : '';
    return `<div class="st-quick glass st-quick--${st.tone}" data-st-tap="cat:diktat" role="button" tabindex="0">
      <span class="st-tile st-tile--big" style="--hue:#a78bfa">${ic('mic', 2)}</span>
      <div class="st-quick__text"><div class="st-quick__title">Diktat-Bubble</div>
        <div class="st-quick__line"><span class="st-dot st-dot--${st.tone}"></span><b class="st-quick__state">${esc(st.word)}</b> · ${esc(st.line)}</div></div>
      <div class="st-quick__ctl">${live ? sw('bubble.enabled', b.enabled) : ''}${act}</div>
    </div>`;
  }

  function hubHtml() {
    const q = norm(query.trim());
    let list;
    if (q) {
      const hits = searchIndex().filter((h) => norm(`${h.title} ${DIAG.has(h.row) ? '' : h.desc} ${h.cat.name} ${h.words}`).includes(q));
      list = hits.length
        ? `<div class="st-card glass st-results">${hits.slice(0, 30).map((h) => `<button type="button" class="st-hit" data-st-go="${h.cat.id}" data-st-focus="${h.row}">
            ${tile(h.cat)}<span class="st-hit__text"><span class="st-hit__title">${esc(h.title)}</span><span class="st-hit__path">${esc(h.cat.name)}${h.desc && !DIAG.has(h.row) ? ' · ' + esc(h.desc) : ''}</span></span><span class="st-chev">${ic('chev', 2)}</span></button>`).join('')}</div>`
        : `<p class="st-empty">Nichts gefunden für „${esc(query.trim())}“</p>`;
    } else {
      const groups = [...new Set(CATS.map((c) => c.group))];
      list = quickCard() + groups.map((g) => `<div class="st-sec"><h3 class="st-sec__title">${g}</h3><div class="st-card glass">${CATS.filter((c) => c.group === g).map((c) => `
        <button type="button" class="st-cat${cur === c.id ? ' is-cur' : ''}" data-st-go="${c.id}">
          ${tile(c)}<span class="st-cat__text"><span class="st-cat__name">${c.name}${c.badge && c.badge() ? '<span class="st-badge">1</span>' : ''}</span>
          <span class="st-cat__sum">${c.alert && c.alert() ? '<span class="st-dot st-dot--warn"></span>' : ''}${esc(c.sum())}</span></span>
          <span class="st-chev">${ic('chev', 2)}</span></button>`).join('')}</div></div>`).join('');
    }
    return `<div class="st-search glass">${ic('search', 2)}<input id="stSearch" type="search" placeholder="Einstellung suchen …" autocomplete="off" enterkeyhint="search" value="${esc(query)}">${query ? `<button type="button" class="st-search__x" data-st-act="search:clear" aria-label="Suche leeren">${ic('x', 2.2)}</button>` : ''}</div>${list}`;
  }

  function detailHtml(id) {
    const c = cat(id);
    if (!c) return '';
    return `<div class="st-head">
        <button type="button" class="st-back" data-st-act="back">${ic('back', 2.2)}<span>Einstellungen</span></button>
        <div class="st-head__main">${tile(c, true)}<div><h2 class="st-head__name">${c.name}</h2><div class="st-head__desc">${esc(c.desc)}</div></div></div>
      </div>${PAGES[id]()}`;
  }

  /** Zeichnet neu — aber nur, wenn sich etwas geändert hat und die Seite zu
   *  sehen ist (Gebetszeiten/Server kommen alle paar Sekunden). */
  function render(force) {
    const host = hostEl();
    if (!host) return;
    if (host.hidden && !force) { lastHtml = ''; return; } // beim Zeigen neu
    if (wide() && !cur) cur = 'diktat';
    const html = `<div class="st-root${cur ? ' has-detail' : ''}" id="settingsBody">
      <div class="st-hub"><h1 class="screen-title">Einstellungen</h1>${hubHtml()}</div>
      <div class="st-detail">${cur ? detailHtml(cur) : ''}</div>
    </div>`;
    if (!force && html === lastHtml && host.querySelector('.st-root')) return; // force: Schalter-Stellung zurücksetzen
    lastHtml = html;
    const focused = document.activeElement && document.activeElement.id === 'stSearch';
    const caret = focused ? document.activeElement.selectionStart : null;
    // Wörterbuch-Felder: Getipptes überlebt das Neuzeichnen (neuer Stand vom Rechner).
    const typed = ['dwAdd', 'dwHeard'].map((id) => { const el = document.getElementById(id); return el ? { id, v: el.value, on: document.activeElement === el, key: el.dataset.dwId || '' } : null; }).filter(Boolean);
    host.innerHTML = html;
    typed.forEach((t) => { const el = document.getElementById(t.id); if (!el || (el.dataset.dwId || '') !== t.key) return; el.value = t.v; if (t.on) { el.focus(); try { el.setSelectionRange(t.v.length, t.v.length); } catch (e) {} } });
    dwFilterList();
    const up = document.getElementById('stUpdHost');
    if (up && window.__bundUpdateCard) window.__bundUpdateCard(up);
    if (focused) { const i = document.getElementById('stSearch'); i.focus(); try { i.setSelectionRange(caret, caret); } catch (e) {} }
  }

  /** Tippen im Feld filtert die Liste — ohne neu zu zeichnen, der Fokus bleibt. */
  function dwFilterList() {
    const inp = document.getElementById('dwAdd');
    const q = inp ? inp.value.trim().toLowerCase() : '';
    document.querySelectorAll('#dwList .dw-item').forEach((el) => { el.hidden = !!q && !el.dataset.dwTerm.includes(q); });
  }
  function openCat(id, focusRow) {
    cur = id; openChoice = null; confirmWipe = false; openMore = !!(focusRow && DIAG.has(focusRow));
    render(true);
    const host = hostEl();
    const root = host && host.querySelector('.st-root');
    if (root && !wide()) { root.classList.add('is-entering'); requestAnimationFrame(() => root.classList.remove('is-entering')); host.scrollTop = 0; }
    if (id === 'diktat') { post('bubble:status'); post('dict:get'); }
    if (focusRow && host) {
      const el = host.querySelector(`[data-st-row="${focusRow}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('is-flash'); setTimeout(() => el.classList.remove('is-flash'), 1600); }
    }
  }
  function back() {
    if (wide()) return;
    const host = hostEl();
    const keep = cur; cur = null; openChoice = null; confirmWipe = false;
    render(true);
    const el = host && host.querySelector(`.st-cat[data-st-go="${keep}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
  }
  /** Zurück-Geste: erst Unterseite → Startseite. true = erledigt. */
  window.__settingsBack = () => {
    const host = hostEl();
    if (!host || host.hidden) return false;
    if (query && !cur) { query = ''; render(true); return true; }
    if (cur && !wide()) { back(); return true; }
    return false;
  };

  // ── Ändern ─────────────────────────────────────────────────────────
  function setPath(obj, path, v) {
    const parts = path.split('.'); let o = obj;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] = o[parts[i]] || {};
    o[parts[parts.length - 1]] = v;
  }
  /** Gebetsruf: die App hat eigene Nachrichten; vorab die Anzeige mitziehen. */
  function setAdhan(k, v) {
    const m = window.TMS_DATA && window.TMS_DATA.prayerMeta;
    if (m) {
      if (k === 'method') m.method = Object.assign({}, m.method, { id: v, name: label(METHODS, v) });
      else { m.adhan = m.adhan || {}; m.adhan[k === 'reciter' ? 'selected' : k] = v; }
    } else if (!LIVE()) setPath(S(), 'adhan.' + k, v);
    if (k === 'enabled') post('adhan:toggle', { enabled: v });
    else if (k === 'wecker') post('adhan:wecker', { enabled: v });
    else if (k === 'reciter') post('adhan:reciter', { id: v });
    else if (k === 'method') post('adhan:method', { method: v });
  }
  function set(path, v, msg) {
    if (path === 'cardLook') { setCardLook(v); say(label(CARD_LOOKS, v)); render(true); return; }
    if (path.startsWith('adhan.')) setAdhan(path.slice(6), v);
    else if (path === 'bubble.enabled') { if (S().bubble) S().bubble.enabled = v; post('bubble:toggle', { enabled: v }); }
    else if (path === 'appLock' && LIVE()) { post('settings:set', { key: path, value: v }); render(true); return; } // App fragt PIN ab und meldet zurück
    else { setPath(S(), path, v); post('settings:set', { key: path, value: v }); }
    if (msg) say(msg);
    render(true);
  }
  const MSG = {
    'bubble.enabled': (v) => (v ? 'Bubble wird angezeigt' : 'Bubble ausgeblendet'),
    browserBridge: (v) => (v ? 'Login-Links öffnen auf dem Handy' : 'Login-Links bleiben am Rechner'),
    persistent: (v) => (v ? 'Verbindung bleibt im Hintergrund' : 'Verbindung endet mit der App'),
    'adhan.wecker': (v) => (v ? 'Fajr-Wecker an' : 'Fajr-Wecker aus'),
  };

  function action(a) {
    const s = S();
    if (a === 'back') return back();
    if (a.startsWith('dw:')) {
      const p = a.split(':'), cmd = p[1], id = p[2];
      const d = Dict(), e = d && d.entries ? d.entries.find((x) => x.id === id) : null;
      if (cmd === 'tab') { DW.tab = id; DW.open = null; render(true); const h = hostEl(); if (h) h.scrollTop = 0; if (id !== 'bubble') post('dict:get'); else post('bubble:status'); return; }
      if (cmd === 'filter') { DW.filter = id; return render(true); }
      if (cmd === 'open') { DW.open = DW.open === id ? null : id; return render(true); }
      if (cmd === 'add') {
        const inp = document.getElementById('dwAdd'), v = inp ? inp.value.replace(/\s+/g, ' ').trim() : '';
        if (!v) { if (inp) inp.focus(); return; }
        if (d && d.entries && d.entries.some((x) => x.term.toLowerCase() === v.toLowerCase())) { say('Gibt es schon'); return; }
        inp.value = ''; dwFilterList(); say(`${v} hinzugefügt`);
        return dictSend('dict:add', { term: v });
      }
      if (!e) return;
      if (cmd === 'heard') {
        const inp = document.getElementById('dwHeard'), v = inp ? inp.value.replace(/\s+/g, ' ').trim() : '';
        if (!v) { if (inp) inp.focus(); return; }
        if (e.heard.some((h) => h.toLowerCase() === v.toLowerCase())) { say('Steht schon da'); return; }
        if (d.entries.some((x) => x.term.toLowerCase() === v.toLowerCase())) { say('Das ist selbst ein Begriff im Wörterbuch'); return; }
        inp.value = ''; say(`„${v}“ wird künftig zu ${e.term}`);
        return dictSend('dict:update', { id: e.id, heard: e.heard.concat([v]) });
      }
      if (cmd === 'unheard') return dictSend('dict:update', { id: e.id, heard: e.heard.filter((_, i) => i !== Number(p[3])) });
      if (cmd === 'del') { DW.open = null; say(`${e.term} gelöscht`); return dictSend('dict:remove', { id: e.id }); }
      return;
    }
    if (a === 'search:clear') { query = ''; render(true); const i = document.getElementById('stSearch'); if (i) i.focus(); return; }
    if (a.startsWith('cat:')) return openCat(a.slice(4));
    if (a.startsWith('choice:')) { const id = a.slice(7); openChoice = openChoice === id ? null : id; render(); return; }
    if (a.startsWith('go:')) { if (typeof window.show === 'function') window.show(a.slice(3)); return; }
    if (a === 'bubble:snooze') { if (s.bubble) s.bubble.snoozedUntil = Date.now() + 15 * 60_000; post('bubble:snooze'); say('Bubble pausiert 15 Minuten'); return render(); }
    if (a === 'bubble:wake') { if (s.bubble) s.bubble.snoozedUntil = 0; post('bubble:wake'); say('Bubble wieder da'); return render(); }
    if (a === 'bubble:open') { post('bubble:open'); if (!LIVE()) say('Öffnet Android › Bedienungshilfen › TMS Diktat-Bubble'); return; }
    if (a === 'bubble:keep') { post(s.bubble && s.bubble.keepAlive ? 'bubble:notify' : 'bubble:keepalive'); return; }
    if (a === 'bubble:trace') { post('bubble:copytrace'); if (!LIVE()) say('Protokoll kopiert'); return; }
    if (a === 'cloud:connect') {
      const wrap = document.getElementById('cloudAccountsSheetWrap');
      if (typeof window.renderCloudAccountsSheet === 'function') window.renderCloudAccountsSheet();
      if (wrap && typeof window.openSheet === 'function') window.openSheet(wrap);
      return;
    }
    if (a.startsWith('cloud:disconnect:')) {
      const k = a.split(':')[2];
      if (LIVE() && typeof window.requestCloudDisconnect === 'function') window.requestCloudDisconnect(k);
      else { (s.cloud = s.cloud || JSON.parse(JSON.stringify(DEMO.cloud)))[k] = { connected: false }; render(); }
      say(IDLE_NAMES[k] + ' getrennt');
      return;
    }
    if (a.startsWith('adhan:listen:')) { const id = a.split(':')[2]; post('adhan:preview', { id }); say('Spielt ' + label(RECITERS, id) + ' …'); return; }
    if (a === 'adhan:exact') a = 'adhan:perm:exact';
    if (a.startsWith('adhan:perm:')) {
      const which = a.slice(11);
      post('adhan:perms', { which });
      if (!LIVE()) { const p = (s.adhan.perms = s.adhan.perms || {}); p[which === 'exact' ? 'exactAlarms' : which] = true; render(true); }
      return;
    }
    if (a === 'adhan:test') { post('adhan:test'); if (!LIVE()) say('Azān klingelt in 10 Sekunden'); return; }
    if (a === 'adhan:location') { if (typeof window.openLocationPicker === 'function') window.openLocationPicker(); return; }
    if (a === 'lock:pin') { post('lock:pin'); if (!LIVE()) say('Öffnet „PIN ändern“'); return; }
    if (a === 'lock:now') { post('lock:now'); if (!LIVE()) say('Gesperrt'); return; }
    if (a === 'nav:classic') { post('nav:classic', { screen: 'classic' }); if (!LIVE()) say('Wechselt zur klassischen Oberfläche'); return; }
    if (a === 'update:check') { post('update:check'); if (!LIVE()) say('Suche nach Updates …'); return; }
    if (a === 'app:prev') { post('update:previous'); if (!LIVE()) say(`Lädt ${s.prevVersion.version} …`); return; }
    if (a === 'wipe:ask') { confirmWipe = true; return render(); }
    if (a === 'wipe:no') { confirmWipe = false; return render(); }
    if (a === 'wipe:yes') { confirmWipe = false; post('app:wipe'); if (!LIVE()) say('Alle Daten gelöscht — App neu starten'); return render(); }
  }

  // ── Ereignisse (einmal, an der Seite — überleben jedes Neuzeichnen) ──
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t.closest || !t.closest('[data-screen="settings"]')) return;
    const play = t.closest('.st-opt__play');
    if (play) { e.stopPropagation(); action(play.dataset.stAct); return; }
    const go = t.closest('[data-st-go]');
    if (go) { openCat(go.dataset.stGo, go.dataset.stFocus); return; }
    const look = t.closest('[data-st-look]');
    if (look) { if (typeof window.applyTheme === 'function' && (isLight() ? 'light' : 'dark') !== look.dataset.stLook) window.applyTheme(look.dataset.stLook); render(); return; }
    const pk = t.closest('[data-st-pick]');
    if (pk) {
      const key = pk.dataset.stPick, raw = pk.dataset.v;
      const v = (key === 'lockGrace' || key === 'adhan.method') ? Number(raw) : raw;
      openChoice = null;
      set(key, v, key === 'adhan.reciter' ? 'Rezitator gespeichert' : key === 'adhan.method' ? null : 'Gespeichert');
      return;
    }
    const btn = t.closest('[data-st-act]');
    if (btn) { e.stopPropagation(); action(btn.dataset.stAct); return; }
    if (t.closest('.switch')) return; // Schalter: change-Ereignis unten
    const sum = t.closest('.st-more > summary');
    if (sum) { e.preventDefault(); openMore = !openMore; render(); return; }
    const tap = t.closest('[data-st-tap]');
    if (tap) action(tap.dataset.stTap);
  }, true);
  document.addEventListener('change', (e) => {
    const inp = e.target.closest && e.target.closest('[data-screen="settings"] [data-st-switch]');
    if (!inp) return;
    const k = inp.dataset.stSwitch;
    set(k, inp.checked, MSG[k] ? MSG[k](inp.checked) : null);
  });
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'stSearch') { query = e.target.value; render(); }
    if (e.target && e.target.id === 'dwAdd') dwFilterList();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target) return;
    if (e.target.id === 'dwAdd') action('dw:add');
    else if (e.target.id === 'dwHeard') action('dw:heard:' + (e.target.dataset.dwId || ''));
  });
  try { window.matchMedia('(min-width: 700px)').addEventListener('change', () => render()); } catch (e) { /* alt */ }

  // ── An die Seite hängen ────────────────────────────────────────────
  window.renderSettings = render;
  // Gebetsdaten kommen alle paar Sekunden — render() zeichnet nur bei Änderung.
  window.renderAdhanSettings = () => render();
  window.__settingsOpen = openCat;
  // Beim Zeigen frisch zeichnen (versteckt wird nicht gezeichnet).
  if (typeof SCREEN_HOOKS === 'object' && SCREEN_HOOKS) {
    const prev = SCREEN_HOOKS.settings;
    // Beim Zeigen auch das Wörterbuch holen: aufgeklappt ist „Diktat & Sprache“ schon
    // vorausgewählt, und die Zeile der Übersicht nennt Begriffe und Tempo.
    SCREEN_HOOKS.settings = function () { if (prev) prev.apply(this, arguments); lastHtml = ''; render(true); post('dict:get'); };
  }
  // Update-Stand ändert Abzeichen/Karte.
  const prevUpd = window.__bundUpdateState;
  if (typeof prevUpd === 'function') window.__bundUpdateState = function (st) { prevUpd(st); render(); };
  render(true);
})();
