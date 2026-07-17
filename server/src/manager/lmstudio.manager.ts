/**
 * LM-Studio-Steuerung für die lokalen Manager-Modelle.
 *
 * Zwei Wege, bewusst getrennt:
 *  - LESEN (welche Modelle gibt es, wie groß ist ihr Context-Maximum, ist eines
 *    geladen?) läuft über die native REST-API `GET /api/v0/models`. Ein Aufruf
 *    liefert für jedes Modell max_context_length, loaded_context_length, state.
 *  - LADEN mit einer bestimmten Context-Länge kann die REST-API NICHT — dafür
 *    gibt es nur die `lms`-CLI: `lms load <key> --context-length N --gpu max -y`.
 *    Vor dem Laden werfen wir die anderen lokalen Modelle raus (`lms unload --all`),
 *    sonst kollidieren zwei 30-GB-Modelle im VRAM.
 *
 * Alles hier ist rein additiv: schlägt LM Studio fehl (nicht gestartet, CLI nicht
 * installiert), bleibt der bisherige Inferenz-Pfad unberührt — nur das komfortable
 * Vorab-Laden entfällt und der Fehler wird sauber gemeldet.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../utils/logger';
import { getPlatform } from '../utils/platform';

export interface LmModelInfo {
  /** Der Modell-Schlüssel wie in LM Studio, z. B. "qwen/qwen3.6-27b". */
  key: string;
  /** Lesbar aufbereiteter Anzeigename (Vendor-Präfix gestrippt). */
  displayName: string;
  /** Modelltyp aus LM Studio: 'llm' | 'vlm' | 'embeddings' | … */
  type: string;
  /** Trainiertes Context-Maximum (Obergrenze des Reglers). */
  maxContext: number;
  /** Aktuell geladene Context-Länge, falls das Modell geladen ist. */
  loadedContext: number | null;
  /** 'loaded' | 'not-loaded' | … wie von LM Studio gemeldet. */
  state: string;
}

/** Native-API-Basis (…/api/v0) aus der OpenAI-kompatiblen Basis (…/v1) ableiten. */
function nativeApiBase(v1Url: string): string {
  return v1Url.replace(/\/v1\/?$/, '') + '/api/v0';
}

/** Aus dem Modell-Schlüssel einen lesbaren Namen ableiten: Vendor-Präfix weg,
 *  Trenner zu Leerzeichen, Wortanfänge groß. Kosmetisch — Eindeutigkeit liefert der key. */
export function deriveDisplayName(key: string): string {
  const afterVendor = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key;
  const spaced = afterVendor.replace(/[-_]+/g, ' ').trim();
  return spaced.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

/** Reine Umwandlung der /api/v0/models-Antwort in die Info-Map. Kein Filtern —
 *  die Info bleibt vollständige Quelle; das Filtern (Embeddings) macht die Registry. */
export function parseModelsResponse(json: unknown): Map<string, LmModelInfo> {
  const out = new Map<string, LmModelInfo>();
  const data = (json as { data?: Array<Record<string, any>> })?.data ?? [];
  for (const m of data) {
    const key = String(m.id ?? '');
    if (!key) continue;
    out.set(key, {
      key,
      displayName: deriveDisplayName(key),
      type: String(m.type ?? 'llm'),
      maxContext: Number(m.max_context_length) || 0,
      loadedContext: m.loaded_context_length != null ? Number(m.loaded_context_length) : null,
      state: String(m.state ?? 'not-loaded'),
    });
  }
  return out;
}

/** Alle in LM Studio bekannten Modelle mit Context-Maximum, Typ + Ladezustand. */
export async function getModelsInfo(v1Url: string): Promise<Map<string, LmModelInfo>> {
  try {
    const res = await fetch(`${nativeApiBase(v1Url)}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return new Map();
    return parseModelsResponse(await res.json());
  } catch (err) {
    logger.warn(`LM Studio: Modell-Info nicht lesbar (${err instanceof Error ? err.message : String(err)})`);
    return new Map();
  }
}

/** Pfad zur `lms`-CLI: erst PATH, dann die Standard-Installation im Home. */
function resolveLmsPath(): string {
  const win = getPlatform() === 'win32';
  const bin = win ? 'lms.exe' : 'lms';
  // Standard-Installationsort von LM Studio.
  const home = join(homedir(), '.lmstudio', 'bin', bin);
  if (existsSync(home)) return home;
  // Sonst auf den PATH vertrauen (lms via `lms bootstrap` global verlinkt).
  return bin;
}

function runLms(args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(resolveLmsPath(), args, { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* schon tot */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err || e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out, err }); });
  });
}

/**
 * Ein lokales Modell mit fester Context-Länge laden. Vorher werden alle anderen
 * lokalen Modelle entladen (VRAM). Wirft mit klarer Meldung, wenn `lms` fehlt
 * oder das Laden scheitert — der Aufrufer meldet das an die App.
 */
export async function loadLocalModel(modelKey: string, contextLength: number): Promise<void> {
  // Erst Platz schaffen. Fehler hier ist unkritisch (evtl. war nichts geladen).
  // Großzügiges Timeout: allein der CLI-Start dauert empirisch ~15 s, das
  // Entladen großer Modelle nochmal etwas — 20 s schnitten das gelegentlich ab.
  await runLms(['unload', '--all'], 45_000);

  const args = ['load', modelKey, '--gpu', 'max', '-y'];
  if (contextLength && contextLength > 0) args.push('--context-length', String(Math.round(contextLength)));

  // Große Modelle brauchen realistisch bis zu ~2 Minuten.
  const { code, err, out } = await runLms(args, 180_000);
  if (code !== 0) {
    const detail = (err || out || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
    if (code === -1 && /ENOENT|not found/i.test(err)) {
      throw new Error('LM Studio CLI (lms) nicht gefunden — in LM Studio einmal „lms bootstrap" ausführen.');
    }
    throw new Error(`Laden von ${modelKey} fehlgeschlagen: ${detail || 'unbekannter Fehler'}`);
  }
  logger.info(`LM Studio: ${modelKey} mit Context ${contextLength} geladen`);
}
