// File contents between phone and computer, routed through React Native.
//
// Why: the Season-2 page runs at https://tms.local, and Chromium's Local
// Network Access checks block that page from loading anything from the
// tailnet (100.x counts as "local"): <img>/<video>/<iframe> stay empty and
// XHR uploads fail. Native requests (OkHttp) are not affected, so previews
// and uploads go through here instead.
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';

/** Images up to this size are shown inline (as data: URL); bigger ones open natively. */
export const INLINE_IMAGE_MAX = 15 * 1024 * 1024;

/** Last path segment — Windows paths use backslashes. */
export const baseName = (p: string): string => String(p).split(/[\\/]/).filter(Boolean).pop() ?? 'datei';

/** File name that is safe inside the app cache. */
export const cacheSafe = (name: string): string => name.replace(/[^\w.\- ()]+/g, '_').slice(-120) || 'datei';

/** Previews the system viewer may still be reading — removed on the next preview. */
let openedPreviews: string[] = [];

type Reply = (data: Record<string, unknown>) => void;

/**
 * Download one file natively. Images small enough come back as data: URL for
 * the in-page preview; everything else (video, PDF, big images) opens in the
 * Android viewer.
 */
export async function fetchPreview(
  url: string, path: string, kind: string, mime: string, reply: Reply,
): Promise<void> {
  for (const old of openedPreviews.splice(0)) FileSystem.deleteAsync(old, { idempotent: true }).catch(() => {});
  const tmp = `${FileSystem.cacheDirectory}pv-${Date.now()}-${cacheSafe(baseName(path))}`;
  let lastPct = -1;
  const task = FileSystem.createDownloadResumable(url, tmp, {}, (p) => {
    if (p.totalBytesExpectedToWrite <= 0) return;
    const pct = Math.floor((p.totalBytesWritten / p.totalBytesExpectedToWrite) * 100);
    if (pct >= lastPct + 5) { lastPct = pct; reply({ progress: true, pct }); }
  });
  try {
    const res = await task.downloadAsync();
    if (!res) throw new Error('Abgebrochen');
    if (res.status >= 400) throw new Error(res.status === 404 ? 'Datei nicht gefunden' : `HTTP ${res.status}`);
    const info = await FileSystem.getInfoAsync(res.uri);
    const size = info.exists && 'size' in info ? info.size ?? 0 : 0;
    if (kind === 'img' && size <= INLINE_IMAGE_MAX) {
      const b64 = await FileSystem.readAsStringAsync(res.uri, { encoding: FileSystem.EncodingType.Base64 });
      FileSystem.deleteAsync(res.uri, { idempotent: true }).catch(() => {});
      reply({ src: `data:${mime};base64,${b64}` });
      return;
    }
    openedPreviews.push(res.uri);
    const contentUri = await FileSystem.getContentUriAsync(res.uri);
    reply({ opened: true });
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: mime,
      flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    });
  } catch (e: any) {
    FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
    const msg = String(e?.message ?? e ?? '');
    reply({ error: /No Activity found|ActivityNotFound/i.test(msg) ? 'Keine App zum Öffnen — „Teilen“ nutzen' : msg || 'Laden fehlgeschlagen' });
  }
}

export interface UploadPart {
  base: string; token: string; dir: string; name: string;
  up: string; part: number; final: boolean; reveal: boolean; b64: string;
}

/** Forward one base64 piece of a phone file to POST /files/upload (part mode). */
export async function uploadPart(p: UploadPart, reply: Reply): Promise<void> {
  const q = new URLSearchParams({
    dir: p.dir, name: p.name, up: p.up, part: String(p.part), enc: 'b64', token: p.token,
  });
  if (p.final) q.set('final', '1');
  if (p.final && p.reveal) q.set('reveal', '1');
  try {
    if (p.part === 0) {
      // An old server (no part mode) would store the base64 text as the file.
      const probe = await fetch(`${p.base}/files/upload?caps=1&token=${encodeURIComponent(p.token)}`).catch(() => null);
      const caps = probe && probe.ok ? await probe.json().catch(() => ({})) : {};
      if (!caps.parts) {
        reply({ error: 'Server zu alt — am Rechner „tms-terminal update“ ausführen', status: probe?.status ?? 0 });
        return;
      }
    }
    const r = await fetch(`${p.base}/files/upload?${q.toString()}`, { method: 'POST', body: p.b64 });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { reply({ error: d.error ?? `HTTP ${r.status}`, status: r.status }); return; }
    reply({ ok: true, result: d });
  } catch (e: any) {
    reply({ error: e?.message ? `Verbindung: ${e.message}` : 'Verbindung abgebrochen' });
  }
}
