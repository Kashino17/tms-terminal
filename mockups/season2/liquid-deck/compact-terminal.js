/* Compact layout controller for the existing Liquid Deck. Both the demo and
   native build use this file. Session/input ownership stays in the old bridge. */
(function () {
  'use strict';
  const root = document.documentElement;
  const body = document.body;
  const dock = document.getElementById('dock');
  const input = document.getElementById('dockInput');
  const keys = document.getElementById('globalKeys');
  let reading = false;
  let frame = 0;
  let signature = '';
  let fontSize = 15;
  try { fontSize = Math.max(13, Math.min(20, Number(localStorage.getItem('tms-compact-font')) || 15)); } catch (_) {}
  root.style.setProperty('--compact-terminal-font', fontSize + 'px');

  const header = document.createElement('header');
  header.id = 'compactTerminalHeader';
  header.setAttribute('aria-label', 'Aktive Terminal-Sitzung');
  header.innerHTML = `<button id="compactSessionPicker" aria-haspopup="dialog" aria-controls="compactSessions" aria-label="Sitzung wechseln">
    <span class="compact-session-tag"></span><span class="compact-session-label"><strong></strong><small></small></span>${icon('chevron', 16)}</button>
    <button id="compactReading" aria-label="Lesefokus einschalten" aria-pressed="false">${icon('eye', 20)}</button>
    <button id="compactMenu" aria-label="Terminal-Menü öffnen" aria-haspopup="dialog" aria-controls="compactSettings">${icon('dotsV', 20)}</button>`;
  body.appendChild(header);
  const resume = document.createElement('button');
  resume.id = 'compactResumeInput';
  resume.innerHTML = icon('keyboard', 18) + '<span>Schreiben</span>';
  header.insertBefore(resume, header.querySelector('#compactMenu'));

  function dialog(id, title, content) {
    const el = document.createElement('dialog');
    el.id = id; el.className = 'compact-dialog';
    el.setAttribute('aria-labelledby', id + 'Title');
    el.innerHTML = `<div class="compact-dialog__header"><strong id="${id}Title">${title}</strong><button class="compact-dialog__close" aria-label="Schließen">${icon('x', 20)}</button></div>${content}`;
    el.querySelector('.compact-dialog__close').addEventListener('click', () => el.close());
    el.addEventListener('click', e => {
      const r = el.getBoundingClientRect();
      if (e.target === el && (e.clientY < r.top || e.clientX < r.left || e.clientX > r.right)) el.close();
    });
    body.appendChild(el);
    return el;
  }
  const sessions = dialog('compactSessions', 'Deine Sitzungen', '<div class="compact-dialog__sessions"></div><button class="compact-dialog__add">' + icon('plus', 18) + 'Neues Terminal</button>');
  const settings = dialog('compactSettings', 'Dein Terminal', `<form class="compact-name-form"><input id="compactName" aria-label="Sitzungsname" maxlength="120" autocomplete="off"><button type="submit">Speichern</button></form>
    <div class="compact-font-row"><span>Schriftgröße</span><div><button data-font="-1" aria-label="Schrift verkleinern">A−</button><output>${fontSize}</output><button data-font="1" aria-label="Schrift vergrößern">A+</button></div></div>
    <button class="compact-dialog__action" id="compactSessionMenu">${icon('dotsV', 18)}Sitzungsmenü</button>
    <div class="compact-dialog__nav"></div>`);
  [['terminals', 'Terminals'], ['tools', 'Werkzeuge'], ['manager', 'Manager'], ['browser', 'Browser'], ['servers', 'Server'], ['cloud', 'Cloud'], ['settings', 'Einstellungen'], ['prayer', 'Gebetszeiten']].forEach(([screen, label]) => {
    const button = document.createElement('button'); button.textContent = label;
    button.addEventListener('click', () => { settings.close(); show(screen); });
    settings.querySelector('.compact-dialog__nav').appendChild(button);
  });
  function target() { return typeof dockTargetId === 'function' ? dockTargetId() : null; }
  function sessionList() {
    const list = sessions.querySelector('.compact-dialog__sessions');
    list.replaceChildren();
    TMS_DATA.sessions.forEach(session => {
      const button = document.createElement('button');
      button.className = 'compact-dialog__session';
      button.setAttribute('aria-current', String(session.id === target()));
      const tag = document.createElement('span'); tag.className = 'compact-session-tag'; tag.style.background = session.colorTag;
      const text = document.createElement('span');
      const name = document.createElement('strong'); name.textContent = session.name;
      const status = document.createElement('small'); status.textContent = [folderLabel(session.cwd || ''), STATUS_LABELS[session.status] || session.status].filter(Boolean).join(' · ');
      text.append(name, status); button.append(tag, text);
      button.addEventListener('click', () => {
        const index = state.order.indexOf(session.id);
        if (index < 0) return;
        setActive(index);
        sessions.close();
        schedule();
      });
      list.appendChild(button);
    });
  }
  function open(el) {
    input.blur();
    if (el === sessions) sessionList();
    if (el === settings) {
      const session = TMS_DATA.sessions.find(item => item.id === target());
      settings.dataset.cardId = session?.id || '';
      settings.querySelector('#compactName').value = session?.name || '';
      settings.querySelector('#compactName').disabled = !session;
      settings.querySelector('[type="submit"]').disabled = !session;
    }
    if (!el.open) el.showModal();
  }
  settings.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    const name = settings.querySelector('#compactName').value.trim();
    const card = Array.from(document.querySelectorAll('.term-card')).find(el => el.dataset.id === settings.dataset.cardId);
    const field = card?.querySelector('.card-name');
    if (!field || !name) return;
    // Use the existing editor's commit event, including its native rename hook.
    field.readOnly = false;
    field.value = name;
    field.dispatchEvent(new Event('blur'));
    settings.close();
    syncDockTerminal();
    schedule();
  });
  header.querySelector('#compactSessionPicker').addEventListener('click', () => open(sessions));
  header.querySelector('#compactMenu').addEventListener('click', () => open(settings));
  function setReading(value) {
    reading = value;
    if (reading) { input.blur(); closeKeysPanel(); }
    header.querySelector('#compactReading').setAttribute('aria-pressed', String(reading));
    header.querySelector('#compactReading').setAttribute('aria-label', reading ? 'Lesefokus ausschalten' : 'Lesefokus einschalten');
    schedule();
  }
  header.querySelector('#compactReading').addEventListener('click', () => setReading(!reading));
  resume.addEventListener('click', () => { setReading(false); body.classList.remove('compact-reading'); setDockPage('term'); input.focus({ preventScroll: true }); });
  sessions.querySelector('.compact-dialog__add').addEventListener('click', () => { sessions.close(); addTerminal(); schedule(); });
  settings.querySelector('#compactSessionMenu').addEventListener('click', () => {
    settings.close();
    const card = Array.from(document.querySelectorAll('.term-card')).find(el => el.dataset.id === target());
    card?.querySelector('.card-menu-btn')?.click();
  });
  settings.querySelectorAll('[data-font]').forEach(button => button.addEventListener('click', () => {
    fontSize = Math.max(13, Math.min(20, fontSize + Number(button.dataset.font)));
    root.style.setProperty('--compact-terminal-font', fontSize + 'px');
    settings.querySelector('output').textContent = fontSize;
    try { localStorage.setItem('tms-compact-font', String(fontSize)); } catch (_) {}
    window.dispatchEvent(new Event('tms:terminal-layout'));
  }));

  function sync() {
    frame = 0;
    const vp = window.visualViewport;
    // Pinch zoom magnifies the existing layout; it is not a window-size change.
    const zoomed = vp && Math.abs(vp.scale - 1) > .05;
    const height = Math.round(vp && !zoomed ? vp.height : window.innerHeight);
    const top = vp && !zoomed ? vp.offsetTop : 0;
    const enabled = currentScreen === 'terminals' && height <= 480 && !body.classList.contains('is-locked');
    const changed = body.classList.contains('compact-terminal') !== enabled;
    const tight = enabled && height <= 280;
    const tightChanged = body.classList.contains('compact-tight') !== tight;
    root.style.setProperty('--compact-vp-h', height + 'px');
    root.style.setProperty('--compact-vp-top', top + 'px');
    body.classList.toggle('compact-terminal', enabled);
    body.classList.toggle('compact-tight', tight);
    body.classList.toggle('compact-reading', enabled && reading && !state.dockRecording);
    if (changed || tightChanged) autoGrowInput(input);
    if (!enabled) {
      if (sessions.open) sessions.close();
      if (settings.open) settings.close();
      if (changed) window.dispatchEvent(new Event('tms:terminal-layout'));
      return;
    }
    if (changed) {
      if (state.islandOpen) closeIsland();
      if (state.overviewOpen) toggleOverview(false);
      closeAllListRails();
      // Reuse the existing input and keep recordings on their recording page.
      if (!state.dockRecording && state.dockPage !== 'term') setDockPage('term');
    }
    const dockHeight = reading && !state.dockRecording ? 0 : dock.offsetHeight;
    const keysHeight = !reading && state.keysPanelOpen && !keys.hidden ? keys.offsetHeight : 0;
    root.style.setProperty('--compact-dock-h', dockHeight + 'px');
    root.style.setProperty('--compact-keys-h', keysHeight + 'px');
    const session = TMS_DATA.sessions.find(item => item.id === target());
    header.querySelector('strong').textContent = session?.name || 'Keine Sitzung';
    header.querySelector('small').textContent = session ? [folderLabel(session.cwd || ''), STATUS_LABELS[session.status] || session.status].filter(Boolean).join(' · ') : 'Sitzung hinzufügen';
    header.querySelector('.compact-session-tag').style.background = session?.colorTag || 'var(--text-dim)';
    const next = [height, window.innerWidth, dockHeight, keysHeight, reading, target(), fontSize].join(':');
    if (changed || signature !== next) {
      signature = next;
      window.dispatchEvent(new Event('tms:terminal-layout'));
    }
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(sync); }
  window.TMSCompact = {
    sync: schedule,
    rename() { syncDockTerminal(); open(settings); settings.querySelector('#compactName').focus(); },
    closeOverlay() {
      for (const el of [sessions, settings]) if (el.open) { el.close(); return true; }
      return false;
    },
  };
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(schedule);
    observer.observe(dock); observer.observe(keys);
  }
  schedule();
})();
