/**
 * Pfad-Rechnen für die Dateien-Ansichten — für Mac/Linux (`/Users/x`) UND
 * Windows (`C:\Users\x`). Der Server liefert immer den absoluten Pfad im Format
 * seines Betriebssystems; bisher kannte die App nur `/`, und „Aufwärts“ sprang
 * unter Windows ins Laufwerks-Root bzw. hängte `/Ordner` an `C:\…` an.
 * Gegenstück im Mockup: TMS-TEST-EXPORT-Block `fsPath` (gleiche Regeln).
 */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
}

function sepOf(p: string): string {
  return isWindowsPath(p) && !p.includes('/') ? '\\' : '/';
}

/** Übergeordneter Ordner; Wurzeln (`/`, `C:\`, `~`) bleiben stehen. */
export function parentDir(p: string): string {
  if (!p || p === '~' || p === '/') return p || '~';
  const sep = sepOf(p);
  const trimmed = p.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + sep;          // C:\ ist Wurzel
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (i < 0) return '~';                                            // "Ordner" ohne Pfad
  const parent = trimmed.slice(0, i);
  if (!parent) return '/';
  if (/^[A-Za-z]:$/.test(parent)) return parent + sep;
  return parent;
}

/** Unterordner `name` von `p`, im Trennzeichen von `p`. */
export function joinDir(p: string, name: string): string {
  const clean = name.replace(/[\\/]+$/, '');
  const sep = sepOf(p);
  return p.replace(/[\\/]+$/, '') + sep + clean;
}
