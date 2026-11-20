/* ==========================================================
   Fold-Ansichten
   Eine Optik für alle Formen: die Zugeklappt-Ansicht (Karte + Punkte +
   schwebende Eingabe) gilt überall — es gibt keine Seitenleiste mehr.

     closed        zugeklappt / aufgeklappt nebeneinander  → unverändert
     open          aufgeklappt, ganzer Bildschirm           → zwei Karten,
                                                              eine hat den Fokus
     split-open    aufgeklappt, untereinander geteilt       → eine breite Karte,
                                                              Tastatur gesperrt
     split-closed  zugeklappt, untereinander geteilt        → Zugeklappt-Ansicht,
                                                              gestrafft

   Läuft nach index.html + compact-terminal.js. Hängt sich über globale
   Funktionen ein (layoutStack, setActive, __tmsCardVisible) und den Haken
   window.__compactWanted in compact-terminal.js.
   ========================================================== */
(function () {
  'use strict';
  const body = document.body;
  const root = document.documentElement;
  const input = document.getElementById('dockInput');
  const MODES = ['closed', 'open', 'split-open', 'split-closed'];

  function load(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }

  const fv = {
    force: MODES.includes(load('tms-fold-force')) ? load('tms-fold-force') : '',  // nur Mockup
    mode: '',
    slots: [null, null],   // aufgeklappt: welche Sitzung links / rechts liegt
    focus: 0,              // aufgeklappt: welche Karte die Eingabe bekommt
    kbOn: false,           // Split aufgeklappt: Tastatur gerade freigegeben
  };
  window.__fold = fv;

  // ── Form erkennen ─────────────────────────────────────────────────────
  // Solange ein Eingabefeld den Fokus hat, kann die Tastatur die Höhe
  // kürzen — dann gilt die zuletzt gemessene Höhe ohne Tastatur. Bewusst
  // KEIN „größte Höhe je Breite merken": aufgeklappt und untereinander
  // geteilt haben dieselbe Breite, das hielt den Split für den Vollbildschirm.
  let stableH = window.innerHeight;
  function editing() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable);
  }
  function detect() {
    if (fv.force) return fv.force;
    if (!editing()) stableH = window.innerHeight;
    const w = window.innerWidth;
    const sw = screen.width, sh = screen.height;
    // Meldet die WebView den Bildschirm nur so groß wie das Fenster, hilft er
    // nicht weiter — dann entscheidet die Fenstergröße allein.
    if (Math.abs(sw - w) < 4 && Math.abs(sh - stableH) < 4) {
      if (w >= 600) return stableH < 560 ? 'split-open' : 'open';
      return stableH < 560 ? 'split-closed' : 'closed';
    }
    const unfolded = Math.min(sw, sh) >= 600;          // Innenbildschirm (~750 dp)
    const fullW = w >= sw * 0.85;                       // nicht nebeneinander
    const short = stableH < sh * 0.72;                  // untereinander geteilt
    if (unfolded && fullW) return short ? 'split-open' : 'open';
    if (!unfolded && fullW && short) return 'split-closed';
    return 'closed';                                    // inkl. nebeneinander
  }
  function keyboardUp() {
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    return editing() && vh < stableH - 100;
  }

  // Kompakte Ansicht (flache Einzelkarte) nur noch zugeklappt beim Tippen.
  window.__compactWanted = function (w, h) {
    return detect() === 'closed' && h <= 480;
  };

  function apply() {
    const m = detect();
    const changed = m !== fv.mode;
    fv.mode = m;
    body.classList.toggle('fv-open', m === 'open');
    body.classList.toggle('fv-split', m === 'split-open' || m === 'split-closed');
    body.classList.toggle('fv-split-open', m === 'split-open');
    body.classList.toggle('fv-split-closed', m === 'split-closed');
    body.classList.toggle('fv-kb', m !== 'closed' && keyboardUp());
    applyKeyboardLock();
    if (window.TMSCompact) window.TMSCompact.sync();
    if (changed) relayout(); else placeDock();
  }

  function relayout() {
    if (typeof layoutStack !== 'function' || !document.getElementById('stack')) return;
    if (fv.mode === 'open') initSlots();
    layoutStack(state.activeIndex);
    if (typeof renderTermSwitcher === 'function') renderTermSwitcher();
    fitNames();
  }

  // ── Stapel-Anordnung je Form ──────────────────────────────────────────
  const origLayout = layoutStack;
  layoutStack = function (floatIndex, opts) {
    if (fv.mode !== 'open' && fv.mode !== 'split-open') return origLayout(floatIndex, opts);
    opts = opts || {};
    const stackEl = document.getElementById('stack');
    if (!stackEl) return;
    if (opts.instant) stackEl.classList.add('is-dragging');
    if (fv.mode === 'open') layoutTwo(stackEl);
    else layoutWide(stackEl, floatIndex);
    if (opts.instant) requestAnimationFrame(() => stackEl.classList.remove('is-dragging'));
    if (typeof flushHiddenCards === 'function') flushHiddenCards();
    placeDock();
  };

  // Split: Name und Aufgabe stehen in einer Zeile — das Namensfeld (ein
  // input) ist nur so breit wie sein Text, sonst schneidet es früh ab.
  const measureCtx = document.createElement('canvas').getContext('2d');
  function fitNames() {
    if (!body.classList.contains('fv-split')) return;
    document.querySelectorAll('.stack-card .card-name').forEach(n => {
      measureCtx.font = getComputedStyle(n).font;
      n.style.setProperty('--fv-name-w', Math.ceil(measureCtx.measureText(n.value || '').width + 4) + 'px');
    });
  }

  // Split aufgeklappt: eine breite Karte, Wischen blättert sauber weiter.
  function layoutWide(stackEl, f) {
    state.order.forEach((id, i) => {
      const card = stackEl.querySelector(`.stack-card[data-id="${id}"]`);
      if (!card) return;
      const off = i - f;
      const ao = Math.min(Math.abs(off), 3);
      card.style.transform = `translate3d(calc(${(off * 100).toFixed(2)}% + ${(off * 24).toFixed(1)}px), 0, 0) scale(${(1 - Math.min(ao, 1) * 0.04).toFixed(3)})`;
      card.style.opacity = (ao < 1 ? 1 - ao * 0.5 : 0).toFixed(3);
      card.style.zIndex = 100 - Math.round(ao * 10);
      card.classList.toggle('is-active', ao < 0.05);
      card.classList.remove('fv-focus', 'fv-side');
      card.style.pointerEvents = ao < 1.5 ? 'auto' : 'none';
      const b = card.querySelector('.card-body');
      if (b) b.style.pointerEvents = ao < 0.05 ? 'auto' : 'none';
    });
  }

  // Aufgeklappt: zwei Karten nebeneinander, eine hat den Fokus.
  function initSlots() {
    const ids = state.order;
    if (!ids.length) { fv.slots = [null, null]; return; }
    const act = ids[state.activeIndex] || ids[0];
    if (!fv.slots.every(id => id && ids.includes(id)) || !fv.slots.includes(act)) {
      const other = ids[state.activeIndex + 1] || ids[state.activeIndex - 1] || null;
      fv.slots = [act, other];
      fv.focus = 0;
    } else fv.focus = fv.slots.indexOf(act);
  }
  // Geschlossene Terminals fallen aus den Plätzen; ein leerer Platz holt sich
  // das nächste Terminal, das noch nicht zu sehen ist.
  function fillSlots() {
    const ids = state.order;
    fv.slots = fv.slots.map(x => (x && ids.includes(x) ? x : null));
    for (let k = 0; k < 2; k++) if (!fv.slots[k]) fv.slots[k] = ids.find(x => !fv.slots.includes(x)) || null;
    if (!fv.slots[fv.focus]) fv.focus = fv.slots[0] ? 0 : 1;
  }
  function placeInSlots(id) {
    fillSlots();
    if (fv.slots[0] === id) fv.focus = 0;
    else if (fv.slots[1] === id) fv.focus = 1;
    else {
      // Die fokussierte Karte wechselt ihr Terminal; ist der andere Platz leer,
      // rückt das bisherige dorthin, statt zu verschwinden.
      const displaced = fv.slots[fv.focus];
      fv.slots[fv.focus] = id;
      const other = 1 - fv.focus;
      if (!fv.slots[other] && displaced && displaced !== id) fv.slots[other] = displaced;
    }
  }
  function layoutTwo(stackEl) {
    // Was vorne ist, bestimmt der Stapel (auch nach Schließen/Neuanlegen).
    const act = state.order[state.activeIndex];
    if (act) placeInSlots(act); else fillSlots();
    const single = state.order.length < 2;
    stackEl.classList.toggle('fv-single', single);
    state.order.forEach(id => {
      const card = stackEl.querySelector(`.stack-card[data-id="${id}"]`);
      if (!card) return;
      const slot = fv.slots.indexOf(id);
      const focused = slot !== -1 && slot === fv.focus;
      if (slot === -1) {
        card.style.transform = 'translate3d(0, 18px, 0) scale(.96)';
        card.style.opacity = '0';
        card.style.zIndex = '1';
        card.style.pointerEvents = 'none';
      } else {
        card.style.transform = slot === 0 || single ? 'translate3d(0,0,0)' : 'translate3d(calc(100% + 12px),0,0)';
        card.style.opacity = focused ? '1' : '.6';
        card.style.zIndex = focused ? '100' : '90';
        card.style.pointerEvents = 'auto';
      }
      card.classList.toggle('is-active', focused);
      card.classList.toggle('fv-focus', focused);
      card.classList.toggle('fv-side', slot !== -1 && !focused);
      const b = card.querySelector('.card-body');
      if (b) b.style.pointerEvents = slot !== -1 ? 'auto' : 'none';
    });
  }
  // Die Eingabe liegt ruhig über beiden Karten (volle Breite) und trägt die
  // Farbe der Karte mit Fokus — man sieht sofort, wohin man schreibt.
  let lastTag = '';
  function placeDock() {
    if (fv.mode !== 'open') { root.style.removeProperty('--fv-dock-w'); root.style.removeProperty('--fv-tag'); lastTag = ''; return; }
    const pane = document.querySelector('.stack-pane');
    if (pane) root.style.setProperty('--fv-dock-w', Math.round(pane.getBoundingClientRect().width) + 'px');
    const s = TMS_DATA.sessions.find(x => x.id === fv.slots[fv.focus]);
    const tag = (s && s.colorTag) || '';
    if (tag === lastTag) return;
    const first = !lastTag;
    lastTag = tag;
    if (tag) root.style.setProperty('--fv-tag', tag); else root.style.removeProperty('--fv-tag');
    const dock = document.getElementById('dock');
    if (dock && !first) { dock.classList.remove('fv-pulse'); void dock.offsetWidth; dock.classList.add('fv-pulse'); }
  }
  document.getElementById('dock') && document.getElementById('dock').addEventListener('animationend', e => {
    if (e.animationName === 'fvDockPulse') e.currentTarget.classList.remove('fv-pulse');
  });

  const origSetActive = setActive;
  setActive = function (index) {
    if (fv.mode === 'open' && state.order.length) {
      const i = Math.max(0, Math.min(index, state.order.length - 1));
      placeInSlots(state.order[i]);
    }
    return origSetActive.apply(this, arguments);
  };

  // Aufgeklappt malen beide Karten — die zweite ist ja sichtbar.
  const origVisible = window.__tmsCardVisible;
  if (origVisible) window.__tmsCardVisible = function (id) {
    if (fv.mode === 'open' && fv.slots.includes(id) && !window.__tmsAppInactive) return true;
    return origVisible(id);
  };

  // Aufgeklappt wird nicht gewischt: Antippen der zweiten Karte holt den Fokus.
  document.addEventListener('pointerdown', e => {
    if (fv.mode !== 'open' || !e.target.closest('#stack')) return;
    e.stopPropagation();
  }, true);
  document.addEventListener('click', e => {
    if (fv.mode !== 'open') return;
    const card = e.target.closest('#stack .stack-card');
    if (!card || card.classList.contains('fv-focus')) return;
    const idx = state.order.indexOf(card.dataset.id);
    if (idx >= 0) setActive(idx);
  }, true);

  // ── Split aufgeklappt: Tastatur gesperrt, nur auf Knopfdruck ──────────
  // inputmode="none": das Feld bekommt Fokus + Cursor (Diktat landet dort,
  // Text lässt sich setzen und korrigieren), Android blendet aber keine
  // Tastatur ein. Der Knopf gibt sie frei, bis sie wieder zugeht.
  const kbBtn = document.createElement('button');
  kbBtn.id = 'fvKbBtn';
  kbBtn.className = 'term-input-btn';
  kbBtn.setAttribute('aria-label', 'Tastatur einblenden');
  kbBtn.setAttribute('aria-pressed', 'false');
  kbBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="8" width="19" height="12" rx="2.2"/><path d="M6.5 12h.01M10 12h.01M13.5 12h.01M17 12h.01M9.5 16h5"/><path d="m9 4.5 3-2.5 3 2.5" class="fvkb-arrow"/></svg><span>Tastatur</span>`;
  const mic = document.getElementById('dockMicBtn');
  if (mic && mic.parentNode) mic.parentNode.insertBefore(kbBtn, mic);

  function locked() { return fv.mode === 'split-open' && !fv.kbOn; }
  function applyKeyboardLock() {
    if (!input) return;
    if (locked()) input.setAttribute('inputmode', 'none');
    else input.removeAttribute('inputmode');
    kbBtn.setAttribute('aria-pressed', String(fv.kbOn));
    kbBtn.setAttribute('aria-label', fv.kbOn ? 'Tastatur ausblenden' : 'Tastatur einblenden');
    const ph = input.dataset.phFull || '';
    const next = locked() ? ph.replace(/^Befehl an /, 'Sprich mit ') : ph.replace(/^Sprich mit /, 'Befehl an ');
    if (next !== ph) {
      input.dataset.phFull = next;
      if (typeof fitDockPlaceholder === 'function') fitDockPlaceholder(input);
    }
  }
  // Der Platzhalter folgt jedem Terminalwechsel — danach wieder anpassen.
  if (typeof syncDockTerminal === 'function') {
    const origSync = syncDockTerminal;
    syncDockTerminal = function () { const r = origSync.apply(this, arguments); applyKeyboardLock(); return r; };
  }
  kbBtn.addEventListener('pointerdown', e => e.preventDefault()); // Fokus nicht klauen
  kbBtn.addEventListener('click', () => {
    if (fv.kbOn) { fv.kbOn = false; applyKeyboardLock(); input.blur(); return; }
    fv.kbOn = true;
    applyKeyboardLock();
    // Erst neu fokussieren, dann fragt Android die Tastatur mit dem neuen inputmode an.
    input.blur();
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  });
  input && input.addEventListener('blur', () => {
    if (!fv.kbOn) return;
    // Tastatur zu (Zurück-Taste, Tipp daneben) = wieder sperren.
    setTimeout(() => { if (document.activeElement !== input) { fv.kbOn = false; applyKeyboardLock(); } }, 120);
  });
  let hinted = false;
  input && input.addEventListener('pointerdown', () => {
    if (!locked() || hinted) return;
    hinted = true;
    if (typeof toast === 'function') toast('Tastatur gesperrt – 🎤 sprechen oder „Tastatur“ tippen');
  });

  // ── Anstoßen ───────────────────────────────────────────────────────────
  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; apply(); }); }
  window.addEventListener('resize', schedule);
  window.visualViewport && window.visualViewport.addEventListener('resize', schedule);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', () => setTimeout(schedule, 150));
  window.addEventListener('tms:terminal-layout', () => { placeDock(); fitNames(); });
  document.addEventListener('blur', e => { if (e.target.classList && e.target.classList.contains('card-name')) setTimeout(fitNames, 0); }, true);
  new MutationObserver(schedule).observe(body, { attributes: true, attributeFilter: ['class'] });

  window.TMSFold = {
    setForce(m) { fv.force = MODES.includes(m) ? m : ''; try { localStorage.setItem('tms-fold-force', fv.force); } catch (_) {} fv.mode = ''; apply(); },
    detect, apply,
  };
  apply();
})();
