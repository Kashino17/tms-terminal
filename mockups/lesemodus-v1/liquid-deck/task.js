/* „Woran wird gerade gearbeitet" — die kleine Zeile neben dem Ordnernamen.
   Ersetzt die Marke LÄUFT / BEREIT. In der App kommt der Text aus dem Titel,
   den Claude der Sitzung selbst gibt; hier aus den Demo-Daten (session.task). */
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  window.__taskHtml = function (s) {
    if (!s || !s.task) return '';
    var st = s.taskState || 'working';
    return '<span class="card-task" data-state="' + st + '"><span class="card-task__sep">·</span><i class="card-task__dot"></i>'
      + (st === 'waiting' ? '<b>Wartet auf dich</b><span class="card-task__sep">·</span>' : '')
      + '<span class="card-task__text">' + esc(s.task) + '</span></span>';
  };
  /** Zustand der Sitzung hat sich geändert (Demo: die mitlaufende Sitzung). */
  window.__taskSync = function (id) {
    var s = (window.TMS_DATA.sessions || []).find(function (x) { return x.id === id; });
    if (!s || !s.task) return;
    s.taskState = s.status === 'running' ? 'working' : s.status === 'waiting' ? 'waiting' : 'done';
    document.querySelectorAll('.term-card[data-id="' + id + '"] .card-task').forEach(function (el) { el.outerHTML = window.__taskHtml(s); });
    if (window.TMSCompact) window.TMSCompact.sync();
    if (window.__deskRender) window.__deskRender();
  };
})();
