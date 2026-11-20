/* Nur fürs Mockup (fold.html): direkt ins Terminal, Update-Hinweis aus und
   ein kleiner Umschalter für Variante A/B/C und die Ansicht. Geht nicht live. */
(function () {
  'use strict';
  try { unlockApp(); goToTerminals(); setDockPage('term'); } catch (_) {}
  const st = document.createElement('style');
  st.textContent = `
  .upd--bar { display: none !important; }
  #fvDemo { position: fixed; z-index: 400; left: 0; top: 42%; display: flex; flex-direction: row-reverse; align-items: center; gap: 6px; font: 600 12px var(--font-ui); }
  body.fv-split #fvDemo { top: 30%; }
  #fvDemo > button { width: 16px; height: 44px; border-radius: 0 10px 10px 0; opacity: .75; font-size: 9px !important; background: rgba(var(--accent-rgb), .9); color: #0b1220; font: 800 11px var(--font-ui); box-shadow: 0 6px 20px rgba(0,0,0,.4); }
  #fvDemoPanel { display: none; order: -1; margin-left: 6px; padding: 10px; border-radius: 16px; background: #1b1e24; border: 1px solid rgba(255,255,255,.12); box-shadow: 0 16px 40px rgba(0,0,0,.5); width: 236px; color: #e9ecf1; }
  #fvDemo.is-open #fvDemoPanel { display: block; }
  #fvDemoPanel h5 { margin: 4px 2px 6px; font: 800 10.5px var(--font-ui); letter-spacing: .08em; text-transform: uppercase; color: #8b93a1; }
  #fvDemoPanel .row { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }
  #fvDemoPanel .row button { flex: 1 1 auto; padding: 8px 9px; border-radius: 10px; background: rgba(255,255,255,.06); color: #e9ecf1; font: 600 12px var(--font-ui); text-align: center; }
  #fvDemoPanel .row button.on { background: rgba(var(--accent-rgb), .25); color: var(--accent); }
  #fvDemoPanel small { display: block; color: #8b93a1; font-weight: 500; line-height: 1.4; margin: -4px 2px 2px; }`;
  document.head.appendChild(st);

  const box = document.createElement('div');
  box.id = 'fvDemo';
  box.innerHTML = `<div id="fvDemoPanel">
      <h5>Ansicht</h5>
      <div class="row" data-g="m"><button data-m="">Automatisch</button><button data-m="open">Aufgeklappt</button><button data-m="split-open">Split auf</button><button data-m="split-closed">Split zu</button><button data-m="closed">Zugeklappt</button></div>
      <small id="fvDemoNow"></small>
    </div><button aria-label="Mockup-Einstellungen">M</button>`;
  document.body.appendChild(box);
  const now = box.querySelector('#fvDemoNow');
  const names = { open: 'Aufgeklappt', 'split-open': 'Split aufgeklappt', 'split-closed': 'Split zugeklappt', closed: 'Zugeklappt / nebeneinander' };
  function paint() {
    const fv = window.__fold;
    box.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === fv.force));
    now.textContent = 'Jetzt: ' + names[fv.mode] + ' · ' + innerWidth + '×' + innerHeight + ' (Bildschirm ' + screen.width + '×' + screen.height + ')';
  }
  box.lastElementChild.addEventListener('click', () => { box.classList.toggle('is-open'); paint(); });
  box.addEventListener('click', e => {
    const m = e.target.closest('[data-m]'); if (m) { TMSFold.setForce(m.dataset.m); paint(); }
  });
  window.addEventListener('resize', paint);
  paint();
})();
