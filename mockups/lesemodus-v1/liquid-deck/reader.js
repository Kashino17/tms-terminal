/* ════════════════════════════════════════════════════════════════════
   Mockup: Antwort lesen.
   Ein Tipp auf „Lesen" am Terminal öffnet Claudes letzte Antwort als sauber
   gesetzte Seite: Überschriften, echte Tabellen, Code zum Kopieren,
   Sprungmarken, Schriftgröße, ältere Antworten, Vorlesen.
   Die Inhalte hier sind echte Antworten aus der Arbeit an TMS — in der App
   kämen sie aus Claudes eigenem Verlauf auf dem Rechner (nicht aus dem
   Terminal-Bild abgelesen), darum stimmen Tabellen und Absätze exakt.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const say = (m) => (typeof window.toast === 'function' ? window.toast(m) : console.log(m));
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

  // ── Beispiel-Antworten (neueste zuletzt) ───────────────────────────
  const ANSWERS = {
    t1: [
      { when: 'vor 41 Min.', prompt: 'Flackert immer noch. Hier ist die WLAN-Debugging-Adresse, dann mach das halt so.',
        md: `Ich bin mit deinem Fold verbunden, du kannst das Kopplungsfenster schließen.

Auf der Aufnahme von deinem Gerät sehe ich jetzt etwas Konkretes. Im Ruhezustand ist der Bereich stabil. Bei **jedem Terminalwechsel** passiert dagegen Folgendes:

- Die Tastenleiste wird für 4–5 Bilder komplett leer, nur das ✕ bleibt stehen.
- In denselben Bildern verschwindet die farbige Linie unter den Punkten.
- Danach baut sich alles wieder auf.

Die Ursache liegt im Code: Die Tastenleiste wird bei jedem Wechsel weggeworfen und neu gebaut.` },
      { when: 'vor 18 Min.', prompt: 'ich hab beide server selbst mit tms-terminal update neugestartet. du kannst also jetzt neu messen und bewerten',
        md: `Der Sparmodus greift auf deinem Fold. Der Hintergrund-Fall ist auf dem Gerät aber noch ungemessen.

## Gemessen auf dem Fold

| Messwert | vorher | jetzt |
|---|---|---|
| Ausgabe-Nachrichten bei zwei arbeitenden Sitzungen | 266 in 20 s | **37 in 20 s** |
| Bildzeit im Mittel | 21–26 ms | **12 ms** |
| Verspätete Bilder | 72–75 % | **0 %** |

Beide Server laufen mit dem neuen Stand. Zum Nachprüfen:

\`\`\`
tms-terminal version
\`\`\`

## Was noch offen ist

1. Die App im Hintergrund habe ich auf deinem Fold noch nicht sauber messen können.
2. Der echte Tagesverbrauch zeigt sich erst über Stunden.` },
      { when: 'vor 2 Min.', prompt: 'Okay, jetzt geh nochmal in die richtige Tiefenanalyse und finde weitere Lücken, wenn es welche gibt. Ziel ist es halt wirklich den Energieverbrauch und die Schnelligkeit, Effizienz so hoch wie möglich zu machen. Also es muss alles richtig, richtig flüssig laufen und es muss verdammt schnell sein.',
        md: `Die Tiefenanalyse hat fünf Lücken gefunden. Alle fünf sind behoben und getestet, aber zwei Dinge fehlen noch, bevor alles bei dir wirkt:

- **App v1.149.0** ist gebaut, aber noch nicht auf deinem Fold. Bitte in der App aktualisieren.
- **Beide Server** brauchen noch einmal \`tms-terminal update\`.

## Was ich gefunden und behoben habe

| Lücke | Messung vorher | Jetzt |
|---|---|---|
| Daten im Hintergrund | 118 KB in 31 s bei drei arbeitenden Sitzungen, etwa 14 MB pro Stunde | Im Hintergrund wird nichts gesendet. Der Stand ist 0,6 s nach der Rückkehr da |
| Pings im Vordergrund | Alle 3 s je Gerät, auch wenn nirgends ein Ping-Wert angezeigt wird | Alle 3 s nur, wenn ein Ping-Wert zu sehen ist. Sonst alle 12 s |
| Wartezeit vor dem Zeichnen | Tastendruck bis Anzeige: 85 ms, davon 60 ms feste Wartezeit | 47 ms im Mittel, bestenfalls 16 ms |
| Unsichtbare Hilfsterminals | 33 Bild-Anforderungen pro Sekunde für nichts | 0 |

## Was sich als unauffällig herausgestellt hat

- **App im Hintergrund:** Die Rechenzeit lag auf deinem Fold bei praktisch null.
- **App-Start:** 0,2 s bis das Fenster steht, 2,4 s bis Terminal-Inhalt da ist.
- **Bildschirm wachhalten:** Das passiert nur während eines Diktats.

## Was ich bewusst nicht angefasst habe

### Fernzugriff-Bild beim Zusehen

Dort gibt es zwei mögliche Stellschrauben. Ohne eine laufende Sitzung auf deinem Gerät kann ich aber nicht messen, ob sie helfen oder schaden.

### Zwei Kleinigkeiten

Eine Prüfung des „nach unten“-Knopfs läuft 18-mal pro Sekunde, und ein verdeckter Bildschirm wird alle 2 Sekunden neu aufgebaut. Beides kostet messbar fast nichts.

## Wie es weitergeht

Der echte Tagesverbrauch zeigt sich erst über Stunden. Mein Ausgangswert von gestern: 969 mAh nach 6 Stunden Akkubetrieb.` },
    ],
    t2: [
      { when: 'vor 9 Min.', prompt: 'Bau mir den Kampagnen-Bericht für Oktober.',
        md: `Ich fange mit den Rohdaten an und melde mich, sobald die Kennzahlen stehen.

## Was ich vorhabe

1. Kampagnendaten für Oktober einlesen.
2. Kosten, Klicks und Conversions je Kampagne zusammenrechnen.
3. Den Bericht als Tabelle und als kurze Zusammenfassung ausgeben.` },
    ],
    t3: [
      { when: 'gerade eben', prompt: 'Die Übungen aus Lektion 4 nochmal überarbeiten, die Sätze waren zu lang.',
        md: `Die neue Fassung der Übungen funktioniert im Emulator. Die Sätze sind jetzt höchstens acht Wörter lang.

| Übung | vorher | jetzt |
|---|---|---|
| Hören | 14 Wörter | 7 Wörter |
| Sprechen | 12 Wörter | 8 Wörter |
| Schreiben | 11 Wörter | 6 Wörter |

**Soll ich Lektion 4 jetzt freigeben?**` },
    ],
    t4: [
      { when: 'vor 6 Min.', prompt: 'Die Tests sind rot, bitte reparieren.',
        md: `Drei von 27 Tests schlagen fehl, alle in der Datumsberechnung. Ich sehe mir die Zeitzonen-Behandlung an.

\`\`\`
npm test
24 bestanden, 3 fehlgeschlagen
\`\`\`` },
    ],
  };
  window.LESE_ANSWERS = ANSWERS;

  // ── Kleine Markdown-Setzerei (Überschrift, Liste, Tabelle, Code) ────
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  function render(md) {
    const lines = md.split('\n'); const out = []; let i = 0; let n = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++;
        out.push(`<div class="rd-code"><pre>${esc(buf.join('\n'))}</pre><button data-rd="copycode">Kopieren</button></div>`); continue; }
      const h = l.match(/^(#{2,3})\s+(.*)$/);
      if (h) { out.push(`<h${h[1].length} id="rdh${n++}">${inline(h[2])}</h${h[1].length}>`); i++; continue; }
      if (/^\|/.test(l) && /^\|\s*-/.test(lines[i + 1] || '')) {
        const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(l); i += 2; const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<div class="rd-table" data-cols="${head.length}"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
          rows.map((r) => `<tr>${r.map((c, k) => `<td data-label="${esc(head[k] || '')}">${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      if (/^(-|\d+\.)\s+/.test(l)) { const ord = /^\d+\./.test(l); const items = [];
        while (i < lines.length && /^(-|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^(-|\d+\.)\s+/, ''));
        out.push(`<${ord ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ord ? 'ol' : 'ul'}>`); continue; }
      if (!l.trim()) { i++; continue; }
      const p = []; while (i < lines.length && lines[i].trim() && !/^(#{2,3}\s|```|\||-\s|\d+\.\s)/.test(lines[i])) p.push(lines[i++]);
      out.push(`<p>${inline(p.join(' '))}</p>`);
    }
    return out.join('');
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
      <button class="rd-main" data-rd="speak">${ic('play')}<span>Vorlesen</span></button>
      <button class="rd-main rd-main--go" data-rd="reply">${ic('reply')}<span>Antworten</span></button>
    </div>`;
  document.body.appendChild(el);
  const $ = (s) => el.querySelector(s);
  const body = $('.rd-body'), scroller = $('.rd-scroll');

  let cur = { id: null, idx: 0 };
  let speakT = 0;
  let fs = 16.5;
  try { fs = Number(localStorage.getItem('tms-reader-fs')) || 16.5; } catch (_) {}
  const applyFs = () => { el.style.setProperty('--rd-fs', fs + 'px'); el.querySelectorAll('[data-fs]').forEach((b) => b.classList.toggle('is-on', Number(b.dataset.fs) === fs)); };
  applyFs();

  const sessionOf = (id) => (window.TMS_DATA.sessions || []).find((s) => s.id === id);
  function closePops() { el.querySelectorAll('.rd-pop').forEach((p) => { p.hidden = true; }); el.querySelectorAll('.rd-ic').forEach((b) => b.classList.remove('is-on')); }
  function stopSpeak() {
    clearTimeout(speakT); speakT = 0;
    body.querySelectorAll('.is-speaking').forEach((x) => x.classList.remove('is-speaking'));
    const b = $('[data-rd="speak"]'); b.classList.remove('is-on'); b.innerHTML = ic('play') + '<span>Vorlesen</span>';
  }

  function paint() {
    const s = sessionOf(cur.id); const list = ANSWERS[cur.id] || [];
    const a = list[cur.idx]; if (!s || !a) return;
    stopSpeak(); closePops();
    $('.rd-title strong i').style.background = s.colorTag;
    $('.rd-title strong span').textContent = s.name;
    const latest = cur.idx === list.length - 1;
    $('.rd-title small').textContent = (latest ? 'Letzte Antwort' : 'Ältere Antwort') + ' · ' + a.when;
    // Hinweis, wenn die Sitzung gerade etwas anderes tut
    const note = $('.rd-note');
    const live = latest && (s.taskState === 'working' || s.taskState === 'waiting');
    note.hidden = !live;
    if (live) {
      note.dataset.state = s.taskState;
      note.querySelector('span').textContent = s.taskState === 'waiting'
        ? 'Claude wartet auf deine Antwort.'
        : 'Claude arbeitet gerade weiter: ' + s.task + '. Das hier ist die letzte fertige Antwort.';
    }
    const pr = $('.rd-prompt'); pr.open = false;
    pr.querySelector('summary span').textContent = a.prompt;
    pr.querySelector('p').textContent = a.prompt;
    body.innerHTML = render(a.md);
    // Breite Tabellen auf schmalem Schirm: jede Zeile als Karte statt seitlich scrollen
    const narrow = el.getBoundingClientRect().width < 560;
    body.querySelectorAll('.rd-table').forEach((t) => {
      const wide = Number(t.dataset.cols) > 3 || (narrow && t.querySelector('table').scrollWidth > t.clientWidth + 2) || (narrow && t.textContent.length > 260);
      t.classList.toggle('is-cards', narrow && wide);
    });
    // Sprungmarken
    const heads = [...body.querySelectorAll('h2, h3')];
    $('[data-rd="toc"]').style.visibility = heads.length > 1 ? '' : 'hidden';
    $('[data-pop="toc"]').innerHTML = '<h4>Inhalt</h4>' + heads.map((h) => `<button data-jump="${h.id}" data-level="${h.tagName[1]}">${esc(h.textContent)}</button>`).join('');
    $('.rd-count').textContent = (cur.idx + 1) + ' / ' + list.length;
    $('[data-rd="older"]').disabled = cur.idx === 0;
    $('[data-rd="newer"]').disabled = latest;
    scroller.scrollTop = 0;
  }

  function placeForDesk() {
    const side = document.getElementById('deskSide');
    const left = document.body.classList.contains('desk') && side ? Math.round(side.getBoundingClientRect().right) : 0;
    el.style.setProperty('--rd-left', left + 'px');
  }

  function open(id) {
    if (!ANSWERS[id] || !ANSWERS[id].length) { say('Hier gibt es noch keine Antwort zu lesen'); return; }
    cur = { id, idx: ANSWERS[id].length - 1 };
    placeForDesk();
    el.hidden = false;
    document.body.classList.add('reader-open');
    paint();
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
    // gelesen: die Markierung „neu" verschwindet
    const s = sessionOf(id); if (s) s.unread = false;
    markUnread();
  }
  function close() {
    stopSpeak(); closePops();
    el.classList.remove('is-open');
    document.body.classList.remove('reader-open');
    setTimeout(() => { if (!el.classList.contains('is-open')) el.hidden = true; }, 300);
  }
  window.TMSReader = { open, close };

  /** „Lesen"-Knöpfe: nur wo es etwas zu lesen gibt; Punkt bei ungelesener Antwort. */
  function markUnread() {
    document.querySelectorAll('.term-card[data-id]').forEach((card) => {
      const id = card.dataset.id; const b = card.querySelector('.read-btn'); if (!b) return;
      const s = sessionOf(id);
      b.hidden = !(ANSWERS[id] && ANSWERS[id].length);
      b.classList.toggle('has-new', !!(s && s.unread));
    });
    const cr = document.getElementById('compactRead');
    if (cr) {
      const id = typeof window.dockTargetId === 'function' ? window.dockTargetId() : null;
      const s = sessionOf(id);
      cr.style.display = ANSWERS[id] && ANSWERS[id].length ? '' : 'none';
      cr.classList.toggle('has-new', !!(s && s.unread));
    }
  }
  window.__readerMark = markUnread;
  const prevSync = window.multiSync;
  window.multiSync = function () { if (prevSync) prevSync.apply(this, arguments); markUnread(); };

  // ── Bedienung ──────────────────────────────────────────────────────
  // Der Knopf sitzt auf der Karte: der Stapel darf den Tipp nicht als Wisch-Anfang nehmen.
  document.addEventListener('pointerdown', (e) => { if (e.target.closest && e.target.closest('.read-btn')) e.stopPropagation(); }, true);
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.read-btn');
    if (!b) return;
    e.stopPropagation(); e.preventDefault();
    const card = b.closest('.term-card');
    if (card) open(card.dataset.id);
  }, true);

  el.addEventListener('click', (e) => {
    const jump = e.target.closest('[data-jump]');
    if (jump) { closePops(); const h = document.getElementById(jump.dataset.jump); if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const size = e.target.closest('[data-fs]');
    if (size) { fs = Number(size.dataset.fs); try { localStorage.setItem('tms-reader-fs', String(fs)); } catch (_) {} applyFs(); return; }
    const b = e.target.closest('[data-rd]');
    if (!b) { if (!e.target.closest('.rd-pop')) closePops(); return; }
    const act = b.dataset.rd;
    if (act === 'close') return close();
    if (act === 'older' && cur.idx > 0) { cur.idx--; return paint(); }
    if (act === 'newer' && cur.idx < (ANSWERS[cur.id] || []).length - 1) { cur.idx++; return paint(); }
    if (act === 'toc' || act === 'size') {
      const pop = $(`[data-pop="${act}"]`); const was = !pop.hidden; closePops();
      if (!was) { pop.hidden = false; b.classList.add('is-on'); }
      return;
    }
    if (act === 'copy') { say('Antwort kopiert'); return; }
    if (act === 'copycode') { say('Kopiert'); return; }
    if (act === 'reply') {
      close();
      const input = document.getElementById('dockInput');
      setTimeout(() => { if (input) input.focus(); }, 320);
      return;
    }
    if (act === 'speak') {
      if (speakT) return stopSpeak();
      const parts = [...body.querySelectorAll('p, li, h2, h3, td')];
      let k = 0;
      b.classList.add('is-on'); b.innerHTML = ic('pause') + '<span>Anhalten</span>';
      const step = () => {
        body.querySelectorAll('.is-speaking').forEach((x) => x.classList.remove('is-speaking'));
        if (k >= parts.length) return stopSpeak();
        const p = parts[k++]; p.classList.add('is-speaking');
        p.scrollIntoView({ behavior: 'smooth', block: 'center' });
        speakT = setTimeout(step, Math.min(4200, 900 + p.textContent.length * 38));
      };
      step();
    }
  });
  window.addEventListener('resize', () => { if (!el.hidden) { placeForDesk(); paint(); } });

  // ── Mockup-Start: ohne Sperrbildschirm direkt zu den Terminals ──────
  setTimeout(() => {
    try { if (typeof window.unlockApp === 'function') window.unlockApp(); } catch (_) {}
    try { document.body.classList.remove('is-locked'); if (typeof window.show === 'function') window.show('terminals'); } catch (_) {}
    try { if (typeof window.setActive === 'function') window.setActive(0); } catch (_) {}
    markUnread();
  }, 60);
})();
