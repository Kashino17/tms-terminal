/* ════════════════════════════════════════════════════════════════════
   Antwort lesen.
   Ein Tipp auf das Buch am Terminal öffnet die letzte Antwort der
   KI-Sitzung als sauber gesetzte Seite: Überschriften, echte Tabellen,
   Code zum Kopieren, Sprungmarken, Schriftgröße, ältere Antworten.

   Die Antworten kommen aus dem Verlauf, den Claude auf dem Rechner selbst
   führt (Server: reader/), nicht vom Terminal-Bild — darum stimmen Tabellen
   und Absätze auch bei 45 Spalten Breite.

   Datenweg: window.__readerRequest(cardId, cb) — in der App überschreibt
   die Bridge diese Funktion (reader:get → reader:answers). Im Browser ohne
   App liefert sie eine Beispiel-Antwort, damit die Seite prüfbar bleibt.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const say = (m) => { if (typeof toast === 'function') toast(m); };
  const I = {
    down: '<path d="m6 9 6 6 6-6"/>',
    left: '<path d="m15 6-6 6 6 6"/>', right: '<path d="m9 6 6 6-6 6"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    aa: '<path d="M3 18 8 6l5 12M5 14h6"/><path d="M15 18l3-7 3 7M16 16h4"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    play: '<path d="M8 5.5v13l11-6.5z"/>', pause: '<path d="M8 5v14M16 5v14"/>',
    reply: '<path d="M20 5v7a3 3 0 0 1-3 3H5"/><path d="m9 11-4 4 4 4"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
  };
  const ic = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;

  // ── Markdown → HTML (was Claude tatsächlich schreibt) ───────────────
  function inline(t) {
    const codes = [];
    let s = esc(t).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a class="rd-link" data-url="$2">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[Number(i)] + '</code>');
  }
  const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const BLOCK_START = /^(\s*```|#{1,4}\s|\||\s*([-*+]|\d+[.)])\s|>\s?|(-{3,}|\*{3,})\s*$)/;

  function renderList(lines, start) {
    // Verschachtelung über die Einrückung; Folgezeilen gehören zum Punkt davor.
    let i = start; let html = ''; const stack = [];
    const close = (to) => { while (stack.length > to) html += '</li></' + stack.pop().tag + '>'; };
    while (i < lines.length) {
      const m = lines[i].match(LIST);
      if (!m) {
        if (lines[i].trim() && /^\s+\S/.test(lines[i]) && stack.length) { html += '<br>' + inline(lines[i].trim()); i++; continue; }
        break;
      }
      const indent = m[1].length; const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
      while (stack.length && indent < stack[stack.length - 1].indent) close(stack.length - 1);
      if (!stack.length || indent > stack[stack.length - 1].indent) { stack.push({ indent, tag }); html += '<' + tag + '><li>'; }
      else html += '</li><li>';
      html += inline(m[3]);
      i++;
    }
    close(0);
    return { html, next: i };
  }

  function render(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n'); const out = []; let i = 0; let n = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*```/.test(l)) {
        const buf = []; i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<div class="rd-code"><pre>${esc(buf.join('\n'))}</pre><button data-rd="copycode">Kopieren</button></div>`);
        continue;
      }
      const h = l.match(/^(#{1,4})\s+(.*)$/);
      if (h) { const lv = Math.min(3, Math.max(2, h[1].length)); out.push(`<h${lv} id="rdh${n++}">${inline(h[2].replace(/\s+#+\s*$/, ''))}</h${lv}>`); i++; continue; }
      if (/^\|/.test(l) && /^\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
        const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(l); i += 2; const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<div class="rd-table" data-cols="${head.length}"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
          rows.map((r) => `<tr>${head.map((hd, k) => `<td data-label="${esc(hd)}">${inline(r[k] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      if (LIST.test(l)) { const r = renderList(lines, i); out.push(r.html); i = r.next; continue; }
      if (/^(-{3,}|\*{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (/^>\s?/.test(l)) {
        const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`); continue;
      }
      if (!l.trim()) { i++; continue; }
      const p = [l]; i++;
      while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) p.push(lines[i++]);
      out.push(`<p>${p.map((x) => inline(x.trim())).join('<br>')}</p>`);
    }
    return out.join('');
  }

  function ago(at) {
    if (!at) return '';
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 90) return 'gerade eben';
    if (s < 3600) return 'vor ' + Math.round(s / 60) + ' Min.';
    if (s < 86400) return 'vor ' + Math.round(s / 3600) + ' Std.';
    const d = new Date(at);
    return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  const WHY = {
    'no-claude': ['Hier läuft kein Claude', 'In diesem Terminal läuft gerade keine Claude-Sitzung, deren Antworten sich lesen ließen.'],
    'no-transcript': ['Diese Sitzung führt keinen Verlauf', 'Claude wurde hier in einem Terminal gestartet, das noch aus der Zeit vor dem Server-Update stammt. Öffne ein neues Terminal und starte Claude dort — dann lassen sich die Antworten lesen.'],
    empty: ['Noch keine Antwort', 'In dieser Sitzung gibt es noch keine fertige Antwort.'],
    error: ['Nicht geladen', 'Die Antworten konnten nicht geladen werden.'],
    timeout: ['Keine Rückmeldung vom Rechner', 'Der Server hat nicht geantwortet. Ist er älter als diese App, hilft am Rechner „tms-terminal update".'],
  };

  // ── Datenweg (die Bridge überschreibt das in der App) ───────────────
  if (typeof window.__readerRequest !== 'function') {
    window.__readerRequest = function (cardId, cb) {
      setTimeout(() => cb({ open: false, answers: [{
        prompt: 'Zeig mir, wie der Lesemodus aussieht.', at: Date.now() - 120000,
        md: 'Das ist eine **Beispiel-Antwort** — in der App steht hier die letzte Antwort aus dem Terminal.\n\n## Tabelle\n\n| Messwert | vorher | jetzt |\n|---|---|---|\n| Bildzeit | 21–26 ms | **12 ms** |\n\n## Code\n\n```\ntms-terminal update\n```\n\n- erster Punkt\n- zweiter Punkt mit `code`',
      }] }), 120);
    };
  }

  // ── Aufbau ─────────────────────────────────────────────────────────
  const el = document.createElement('div');
  el.id = 'reader'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Antwort lesen');
  el.innerHTML = `
    <div class="rd-top">
      <button class="rd-ic" data-rd="close" aria-label="Zurück zum Terminal">${ic('down')}</button>
      <div class="rd-title"><strong><i></i><span></span></strong><small></small></div>
      <button class="rd-ic" data-rd="toc" aria-label="Inhalt">${ic('list')}</button>
      <button class="rd-ic" data-rd="size" aria-label="Schriftgröße">${ic('aa')}</button>
      <button class="rd-ic" data-rd="copy" aria-label="Antwort kopieren">${ic('copy')}</button>
    </div>
    <div class="rd-pop" data-pop="toc" hidden></div>
    <div class="rd-pop" data-pop="size" hidden><h4>Schriftgröße</h4><div class="rd-sizes">
      <button data-fs="15">Klein</button><button data-fs="16.5">Mittel</button><button data-fs="18.5">Groß</button></div></div>
    <div class="rd-scroll"><div class="rd-col">
      <div class="rd-note" hidden><i></i><span></span></div>
      <details class="rd-prompt"><summary>Du<span></span>${ic('chev')}</summary><p></p></details>
      <article class="rd-body"></article>
    </div></div>
    <div class="rd-bar">
      <button class="rd-nav" data-rd="older" aria-label="Ältere Antwort">${ic('left')}</button>
      <span class="rd-count"></span>
      <button class="rd-nav" data-rd="newer" aria-label="Neuere Antwort">${ic('right')}</button>
      <button class="rd-main" data-rd="speak" hidden>${ic('play')}<span>Vorlesen</span></button>
      <button class="rd-main rd-main--go" data-rd="reply">${ic('reply')}<span>Antworten</span></button>
    </div>`;
  document.body.appendChild(el);
  const $ = (s) => el.querySelector(s);
  const body = $('.rd-body'), scroller = $('.rd-scroll');

  /** id = Karte; list = Antworten (neueste zuletzt); req zählt Anfragen (späte Antworten verwerfen). */
  let cur = { id: null, idx: 0, list: [], open: false, req: 0 };
  let speaking = false;
  let fs = 16.5;
  try { fs = Number(localStorage.getItem('tms-reader-fs')) || 16.5; } catch (_) {}
  const applyFs = () => { el.style.setProperty('--rd-fs', fs + 'px'); el.querySelectorAll('[data-fs]').forEach((b) => b.classList.toggle('is-on', Number(b.dataset.fs) === fs)); };
  applyFs();

  const sessionOf = (id) => ((window.TMS_DATA && window.TMS_DATA.sessions) || []).find((s) => s.id === id);
  function closePops() { el.querySelectorAll('.rd-pop').forEach((p) => { p.hidden = true; }); el.querySelectorAll('.rd-ic').forEach((b) => b.classList.remove('is-on')); }
  const speech = () => (window.__readerSpeech && typeof window.__readerSpeech.speak === 'function' ? window.__readerSpeech : null);
  function stopSpeak() {
    if (speaking && speech()) speech().stop();
    speaking = false;
    body.querySelectorAll('.is-speaking').forEach((x) => x.classList.remove('is-speaking'));
    const b = $('[data-rd="speak"]'); b.classList.remove('is-on'); b.innerHTML = ic('play') + '<span>Vorlesen</span>';
  }
  /**
   * Was vorgelesen wird, Stück für Stück (Überschrift, Absatz, Listenpunkt,
   * Tabellenzelle) — so kann die Seite markieren, wo die Stimme gerade ist.
   * Code-Blöcke werden übersprungen: Befehle vorgelesen helfen niemandem.
   */
  function spokenParts() {
    const els = []; const texts = [];
    body.querySelectorAll('h2, h3, p, li, blockquote, td').forEach((n) => {
      if (n.closest('.rd-code')) return;
      let t;
      if (n.tagName === 'LI' && n.querySelector('li')) t = [...n.childNodes].filter((c) => c.nodeType === 3 || !/^(UL|OL)$/.test(c.tagName)).map((c) => c.textContent).join(' ');
      else t = n.textContent;
      t = (t || '').replace(/\s+/g, ' ').trim();
      if (!t) return;
      if (n.tagName === 'TD' && n.dataset.label && n !== n.parentElement.firstElementChild) t = n.dataset.label + ': ' + t;
      els.push(n); texts.push(t);
    });
    return { els, texts };
  }

  function head(sub) {
    const s = sessionOf(cur.id);
    $('.rd-title strong i').style.background = (s && s.colorTag) || 'var(--accent)';
    $('.rd-title strong span').textContent = (s && s.name) || 'Terminal';
    $('.rd-title small').textContent = sub;
  }
  function showState(title, text) {
    stopSpeak(); closePops();
    $('.rd-note').hidden = true; $('.rd-prompt').hidden = true;
    body.innerHTML = `<div class="rd-state"><strong>${esc(title)}</strong>${esc(text)}</div>`;
    el.classList.add('is-bare');
    $('.rd-count').textContent = '';
    $('[data-rd="older"]').hidden = true; $('[data-rd="newer"]').hidden = true;
    ['toc', 'size', 'copy'].forEach((k) => { $(`[data-rd="${k}"]`).style.visibility = 'hidden'; });
    $('[data-rd="speak"]').hidden = true;
  }

  function paint() {
    const s = sessionOf(cur.id); const list = cur.list;
    const a = list[cur.idx]; if (!a) return;
    stopSpeak(); closePops();
    el.classList.remove('is-bare');
    ['size', 'copy'].forEach((k) => { $(`[data-rd="${k}"]`).style.visibility = ''; });
    $('[data-rd="speak"]').hidden = !speech();
    const latest = cur.idx === list.length - 1;
    head([latest ? 'Letzte Antwort' : 'Ältere Antwort', ago(a.at)].filter(Boolean).join(' · '));
    // Hinweis, wenn die Sitzung gerade etwas anderes tut als das, was hier steht
    const note = $('.rd-note');
    const waiting = !!s && (s.status === 'waiting' || s.taskState === 'waiting');
    const working = cur.open || (!!s && s.taskState === 'working');
    note.hidden = !(latest && (waiting || working));
    if (!note.hidden) {
      note.dataset.state = waiting ? 'waiting' : 'working';
      note.querySelector('span').textContent = waiting
        ? 'Claude wartet auf deine Antwort.'
        : 'Claude arbeitet gerade weiter' + (s && s.task ? ': ' + s.task : '') + '. Das hier ist die letzte fertige Antwort.';
    }
    const pr = $('.rd-prompt'); pr.open = false; pr.hidden = !a.prompt;
    pr.querySelector('summary span').textContent = a.prompt;
    pr.querySelector('p').textContent = a.prompt;
    body.innerHTML = render(a.md);
    // Breite Tabellen auf schmalem Schirm: jede Zeile als Karte statt seitlich scrollen
    const narrow = el.getBoundingClientRect().width < 560;
    body.querySelectorAll('.rd-table').forEach((t) => {
      const wide = Number(t.dataset.cols) > 3 || t.querySelector('table').scrollWidth > t.clientWidth + 2 || t.textContent.length > 260;
      t.classList.toggle('is-cards', narrow && wide);
    });
    // Sprungmarken
    const heads = [...body.querySelectorAll('h2, h3')];
    $('[data-rd="toc"]').style.visibility = heads.length > 1 ? '' : 'hidden';
    $('[data-pop="toc"]').innerHTML = '<h4>Inhalt</h4>' + heads.map((h) => `<button data-jump="${h.id}" data-level="${h.tagName[1]}">${esc(h.textContent)}</button>`).join('');
    $('.rd-count').textContent = list.length > 1 ? (cur.idx + 1) + ' / ' + list.length : '';
    $('[data-rd="older"]').disabled = cur.idx === 0;
    $('[data-rd="newer"]').disabled = latest;
    $('[data-rd="older"]').hidden = $('[data-rd="newer"]').hidden = list.length < 2; // eine Antwort: nichts zu blättern
    scroller.scrollTop = 0;
  }

  function placeForDesk() {
    const side = document.getElementById('deskSide');
    const left = document.body.classList.contains('desk') && side ? Math.round(side.getBoundingClientRect().right) : 0;
    el.style.setProperty('--rd-left', left + 'px');
  }

  function load(keepIndex) {
    const req = ++cur.req; const id = cur.id;
    const timer = setTimeout(() => { if (cur.req === req && !cur.list.length) showState(WHY.timeout[0], WHY.timeout[1]); }, 8000);
    window.__readerRequest(id, (res) => {
      if (cur.req !== req || cur.id !== id || el.hidden) return;
      clearTimeout(timer);
      const list = (res && Array.isArray(res.answers) ? res.answers : []).filter((a) => a && typeof a.md === 'string' && a.md.trim());
      cur.open = !!(res && res.open);
      if (!list.length) {
        const why = WHY[(res && res.reason) || 'empty'] || WHY.error;
        cur.list = [];
        showState(cur.open ? 'Claude arbeitet noch' : why[0], cur.open ? 'Die erste Antwort dieser Sitzung ist noch nicht fertig.' : why[1]);
        return;
      }
      const atEnd = cur.idx >= cur.list.length - 1;
      cur.list = list;
      cur.idx = keepIndex && !atEnd ? Math.min(cur.idx, list.length - 1) : list.length - 1;
      paint();
    });
  }

  function open(id) {
    if (!id) return;
    cur = { id, idx: 0, list: [], open: false, req: cur.req };
    placeForDesk();
    el.hidden = false;
    document.body.classList.add('reader-open');
    head('');
    showState('Antwort wird geladen', '');
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
    // gelesen: die Markierung „neu" verschwindet
    const s = sessionOf(id);
    if (s && s.answerNew) { s.answerNew = false; if (window.__taskSync) window.__taskSync(id); }
    load(false);
  }
  function close() {
    stopSpeak(); closePops();
    cur.req++;
    el.classList.remove('is-open');
    document.body.classList.remove('reader-open');
    setTimeout(() => { if (!el.classList.contains('is-open')) el.hidden = true; }, 300);
  }
  /** Die Sitzung ist fertig geworden, während der Lesemodus offen ist: neu laden. */
  function refresh(id) {
    if (el.hidden || cur.id !== id) return;
    const s = sessionOf(id); if (s) s.answerNew = false;
    load(true);
  }
  window.TMSReader = { open, close, refresh, isOpen: () => !el.hidden, render };

  // ── Bedienung ──────────────────────────────────────────────────────
  // Der Knopf sitzt auf der Karte: Stapel und Liste dürfen den Tipp nicht als Wisch-Anfang nehmen.
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.read-btn');
    if (!b) return;
    e.stopPropagation(); e.preventDefault();
    const card = b.closest('.term-card');
    if (card) open(card.dataset.id);
  }, true);

  el.addEventListener('click', (e) => {
    const link = e.target.closest('.rd-link');
    if (link) { if (window.TMSBridge && typeof window.TMSBridge.openBrowser === 'function') window.TMSBridge.openBrowser(link.dataset.url); else if (typeof copyText === 'function') { copyText(link.dataset.url); say('Link kopiert'); } return; }
    const jump = e.target.closest('[data-jump]');
    if (jump) { closePops(); const h = document.getElementById(jump.dataset.jump); if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const size = e.target.closest('[data-fs]');
    if (size) { fs = Number(size.dataset.fs); try { localStorage.setItem('tms-reader-fs', String(fs)); } catch (_) {} applyFs(); return; }
    const b = e.target.closest('[data-rd]');
    if (!b) { if (!e.target.closest('.rd-pop')) closePops(); return; }
    const act = b.dataset.rd;
    if (act === 'close') return close();
    if (act === 'older' && cur.idx > 0) { cur.idx--; return paint(); }
    if (act === 'newer' && cur.idx < cur.list.length - 1) { cur.idx++; return paint(); }
    if (act === 'toc' || act === 'size') {
      const pop = $(`[data-pop="${act}"]`); const was = !pop.hidden; closePops();
      if (!was) { pop.hidden = false; b.classList.add('is-on'); }
      return;
    }
    if (act === 'copy') { const a = cur.list[cur.idx]; if (a && typeof copyText === 'function') { copyText(a.md); say('Antwort kopiert'); } return; }
    if (act === 'copycode') { const pre = b.parentElement.querySelector('pre'); if (pre && typeof copyText === 'function') { copyText(pre.textContent); say('Kopiert'); } return; }
    if (act === 'reply') {
      close();
      const input = document.getElementById('dockInput');
      setTimeout(() => { if (input) input.focus(); }, 320);
      return;
    }
    if (act === 'speak') {
      if (speaking) return stopSpeak();
      const sp = speech(); const parts = spokenParts();
      if (!sp || !parts.texts.length) return;
      speaking = true;
      b.classList.add('is-on'); b.innerHTML = ic('pause') + '<span>Anhalten</span>';
      const german = /[äöüß]|\b(der|die|das|und|ist|nicht|ich|mit|für)\b/i.test(parts.texts.join(' '));
      sp.speak(parts.texts, german, (ev) => {
        if (!speaking) return;
        if (ev && typeof ev.index === 'number') {
          body.querySelectorAll('.is-speaking').forEach((x) => x.classList.remove('is-speaking'));
          const n = parts.els[ev.index];
          if (n && n.isConnected) { n.classList.add('is-speaking'); n.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
          return;
        }
        if (ev && ev.error) say(String(ev.error));
        speaking = false; stopSpeak();
      });
    }
  });
  window.addEventListener('resize', () => { if (!el.hidden) { placeForDesk(); if (cur.list.length) { const top = scroller.scrollTop; paint(); scroller.scrollTop = top; } } });
})();
