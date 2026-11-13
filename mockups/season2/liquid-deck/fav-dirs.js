/* Favoriten-Ordner des Datei-Explorers — reine Logik, ohne Seite testbar.
   Die Favoriten gehören zum Gerät: ein Mac-Pfad sagt dem Windows-PC nichts.
   Form: { [geraeteId]: [{ path, label }] } — Reihenfolge = Reihenfolge der Leiste.
   Jede Funktion gibt eine neue Karte zurück, die alte bleibt unverändert. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BundFavDirs = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var MAX_PER_DEVICE = 30;

  /** Pfad ohne Schrägstrich am Ende — außer er IST die Wurzel ("/", "C:\"). */
  function norm(p) {
    var s = String(p == null ? '' : p).trim();
    if (!s) return '';
    var t = s.replace(/[\\/]+$/, '');
    if (!t) return s.charAt(0);                    // "/" oder "\"
    if (/^[A-Za-z]:$/.test(t)) return t + '\\';    // "C:" → "C:\"
    return t;
  }

  /** Name für den Chip: der letzte Teil des Pfads. */
  function nameOf(p) {
    var n = norm(p);
    if (n === '~') return 'Home';
    var parts = n.split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : n;
  }

  function listFor(map, dev) {
    var l = map && dev ? map[dev] : null;
    return Array.isArray(l) ? l : [];
  }

  function indexOf(map, dev, path) {
    var n = norm(path), l = listFor(map, dev);
    for (var i = 0; i < l.length; i++) if (norm(l[i].path) === n) return i;
    return -1;
  }

  function isFav(map, dev, path) { return indexOf(map, dev, path) !== -1; }

  function withList(map, dev, list) {
    var out = {};
    Object.keys(map || {}).forEach(function (k) { out[k] = map[k]; });
    if (list.length) out[dev] = list; else delete out[dev];
    return out;
  }

  function add(map, dev, path, label) {
    var n = norm(path);
    if (!dev || !n || isFav(map, dev, n)) return map || {};
    var l = listFor(map, dev);
    if (l.length >= MAX_PER_DEVICE) return map || {};
    var name = String(label == null ? '' : label).trim() || nameOf(n);
    return withList(map, dev, l.concat([{ path: n, label: name }]));
  }

  function remove(map, dev, path) {
    var i = indexOf(map, dev, path);
    if (i === -1) return map || {};
    var l = listFor(map, dev).slice();
    l.splice(i, 1);
    return withList(map, dev, l);
  }

  function toggle(map, dev, path) {
    return isFav(map, dev, path) ? remove(map, dev, path) : add(map, dev, path);
  }

  /** Nur der Name auf dem Chip — der Ordner selbst heißt weiter wie er heißt. */
  function rename(map, dev, path, label) {
    var i = indexOf(map, dev, path), name = String(label == null ? '' : label).trim();
    if (i === -1 || !name) return map || {};
    var l = listFor(map, dev).slice();
    l[i] = { path: l[i].path, label: name };
    return withList(map, dev, l);
  }

  /** Um `delta` Plätze verschieben (−1 = nach links). Am Rand bleibt er stehen. */
  function move(map, dev, path, delta) {
    var i = indexOf(map, dev, path);
    if (i === -1) return map || {};
    var l = listFor(map, dev).slice();
    var j = Math.max(0, Math.min(l.length - 1, i + delta));
    if (j === i) return map || {};
    var item = l.splice(i, 1)[0];
    l.splice(j, 0, item);
    return withList(map, dev, l);
  }

  /** Was aus dem Speicher kommt, kann alles sein — nur Gültiges übernehmen. */
  function sanitize(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    Object.keys(raw).forEach(function (dev) {
      if (!Array.isArray(raw[dev])) return;
      var m = {};
      raw[dev].forEach(function (f) {
        if (f && typeof f.path === 'string') m = add(m, dev, f.path, typeof f.label === 'string' ? f.label : '');
      });
      if (m[dev]) out[dev] = m[dev];
    });
    return out;
  }

  /** Beide Stände zusammenführen: `a` zuerst, aus `b` nur was `a` nicht kennt. */
  function merge(a, b) {
    var out = sanitize(a), other = sanitize(b);
    Object.keys(other).forEach(function (dev) {
      other[dev].forEach(function (f) { out = add(out, dev, f.path, f.label); });
    });
    return out;
  }

  return {
    MAX_PER_DEVICE: MAX_PER_DEVICE,
    norm: norm, nameOf: nameOf, listFor: listFor, indexOf: indexOf, isFav: isFav,
    add: add, remove: remove, toggle: toggle, rename: rename, move: move,
    sanitize: sanitize, merge: merge,
  };
});
