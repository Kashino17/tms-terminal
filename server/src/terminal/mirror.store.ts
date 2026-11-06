import * as fs from 'fs';
import * as path from 'path';
import type { MirrorState } from './emulator.mirror';

/**
 * Übergabe der Spiegel (Bildschirm + Historie jedes Terminals) vom alten an den
 * neuen Server. Ohne sie startet jeder Spiegel nach einem Neustart leer — und
 * das nächste Vollbild nähme der App den ganzen Verlauf.
 */
export const MIRROR_FILE = 'mirrors.json';
/** Älter → nicht mehr verlässlich: der Wächter puffert nur ein Endstück, die
 *  Lücke zwischen Sicherung und Puffer-Anfang würde das Bild zerreißen. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

interface MirrorFile { savedAt: number; states: Record<string, MirrorState> }

export function saveMirrorStates(dir: string, states: Record<string, MirrorState>, now = Date.now()): void {
  const file = path.join(dir, MIRROR_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ savedAt: now, states } satisfies MirrorFile), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Liest die Übergabe genau einmal (die Datei wird danach gelöscht). */
export function takeMirrorStates(dir: string, now = Date.now()): Record<string, MirrorState> {
  const file = path.join(dir, MIRROR_FILE);
  let parsed: MirrorFile | null = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as MirrorFile;
  } catch {
    return {};
  } finally {
    try { fs.unlinkSync(file); } catch { /* schon weg */ }
  }
  if (!parsed || typeof parsed.savedAt !== 'number' || now - parsed.savedAt > MAX_AGE_MS) return {};
  return parsed.states && typeof parsed.states === 'object' ? parsed.states : {};
}
