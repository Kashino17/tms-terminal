/**
 * Katalog aller Werkzeuge im Terminal — die eine Quelle fuer Icon, Farbe und
 * Beschreibung.
 *
 * Vorher lag die Icon-Map fest in ToolMenu.tsx. Dadurch war `processes` zwar in
 * ToolRail definiert, aber nicht im Menue: das Icon fehlte, das Werkzeug war ueber
 * diesen Weg nicht erreichbar. Jetzt haengt beides an dieser Liste, und die
 * "Werkzeug hinzufuegen"-Auswahl (frueher: nur loeschbar, nie wieder hereinholbar)
 * liest dieselben Eintraege.
 */
export interface ToolDef {
  id: string;
  icon: string;
  color: string;
  label: string;
  /** Ein Satz fuer den Auswahlbogen. */
  hint: string;
}

export const TOOL_CATALOG: ToolDef[] = [
  { id: 'ports',        icon: 'share-2',      color: '#10B981', label: 'Ports',      hint: 'Port-Weiterleitungen anlegen' },
  { id: 'processes',    icon: 'activity',     color: '#06B6D4', label: 'Prozesse',   hint: 'CPU, RAM und einzelne Prozesse' },
  { id: 'sql',          icon: 'database',     color: '#3B82F6', label: 'SQL',        hint: 'Erkannte Queries und Supabase' },
  { id: 'render',       icon: 'box',          color: '#6366F1', label: 'Render',     hint: 'Projekte und Deploy-Logs' },
  { id: 'vercel',       icon: 'triangle',     color: '#F8FAFC', label: 'Vercel',     hint: 'Projekte und Deploy-Logs' },
  { id: 'autoApprove',  icon: 'check-circle', color: '#22C55E', label: 'Approve',    hint: 'Berechtigungen je Reiter' },
  { id: 'snippets',     icon: 'zap',          color: '#F59E0B', label: 'Snippets',   hint: 'Wiederkehrende Befehle' },
  { id: 'autopilot',    icon: 'play-circle',  color: '#A78BFA', label: 'Autopilot',  hint: 'Aufgaben nacheinander abarbeiten' },
  { id: 'watchers',     icon: 'bell',         color: '#F59E0B', label: 'Watchers',   hint: 'Auf Dateien, Prozesse und Logs achten' },
  { id: 'files',        icon: 'folder',       color: '#F59E0B', label: 'Dateien',    hint: 'Explorer mit Vorschau und Download' },
  { id: 'screenshots',  icon: 'camera',       color: '#06B6D4', label: 'Shots',      hint: 'Bilder und Videos ins Terminal laden' },
  { id: 'drawing',      icon: 'edit-2',       color: '#F59E0B', label: 'Zeichnen',   hint: 'Skizze zeichnen und Pfad einsetzen' },
  { id: 'browser',      icon: 'globe',        color: '#22C55E', label: 'Browser',    hint: 'WebView mit Reitern und DevTools' },
];

const BY_ID: Record<string, ToolDef> = Object.fromEntries(
  TOOL_CATALOG.map((t) => [t.id, t]),
);

/** Icon-Map fuer die Aufrufer, die nur icon/color/label brauchen. */
export const TOOL_ICON_MAP: Record<string, { icon: string; color: string; label: string }> =
  Object.fromEntries(TOOL_CATALOG.map((t) => [t.id, { icon: t.icon, color: t.color, label: t.label }]));

export function getToolDef(id: string): ToolDef | undefined {
  return BY_ID[id];
}

/** Anzeigename eines Werkzeugs, mit Rueckfall auf die ID. */
export function toolLabel(id: string): string {
  return BY_ID[id]?.label ?? id;
}