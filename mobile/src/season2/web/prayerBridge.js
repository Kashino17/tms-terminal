/**
 * Gebetszeiten von der App in die WebView — der reine Teil.
 *
 * Als eigene Datei, damit mobile/scripts/prayer-bridge.test.mjs den Vertrag
 * ohne Fenster pruefen kann. bridge.js ruft das auf, die Seite kennt davon nichts.
 *
 * Die Zusage nach unten: **ohne `meta` sieht die Seite genau wie vorher.** Ein
 * Aufruf aus einem alten Pfad darf den Screen nicht leeren. Deshalb ist meta
 * entweder vollstaendig da oder null — kein halbes Objekt, auf das die Seite
 * wartet.
 */

/**
 * @param {Array<{name:string, de?:string, ar?:string, time:string}>|null|undefined} times
 * @param {object|null} meta
 * @returns {{times: Array, meta: object|null}}
 */
export function normalizePrayerPayload(times, meta) {
  const clean = [];
  if (Array.isArray(times)) {
    for (const t of times) {
      if (!t || typeof t.name !== 'string' || typeof t.time !== 'string') continue;
      const time = String(t.time).replace(/\s*\([^)]*\)/, '').trim();
      if (!time) continue;
      const entry = { name: t.name, time: time };
      if (t.de) entry.de = t.de;
      if (t.ar) entry.ar = t.ar;
      if (t.emoji) entry.emoji = t.emoji;
      clean.push(entry);
    }
  }

  const hasMeta = !!(
    meta &&
    (meta.location || meta.date || meta.method || meta.adhan || meta.perms)
  );

  if (!hasMeta) return { times: clean, meta: null };

  return {
    times: clean,
    meta: {
      location: meta.location
        ? { label: String(meta.location.label ?? ''), lat: meta.location.lat, lon: meta.location.lon }
        : null,
      date: meta.date
        ? { readable: String(meta.date.readable ?? ''), hijri: String(meta.date.hijri ?? '') }
        : null,
      method: meta.method ? { id: meta.method.id, name: String(meta.method.name ?? '') } : null,
      adhan: meta.adhan
        ? {
            enabled: !!meta.adhan.enabled,
            wecker: !!meta.adhan.wecker,
            selected: String(meta.adhan.selected ?? 'mishary'),
          }
        : null,
      perms: meta.perms
        ? {
            notifications: !!meta.perms.notifications,
            exactAlarms: !!meta.perms.exactAlarms,
          }
        : null,
    },
  };
}