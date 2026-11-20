// Screenshots-Galerie: the wording and limits around uploading photos and
// videos. Pure on purpose (no React Native imports) — node runs the tests
// against this file directly.

/** Same limit as the computer's /upload/media. */
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_VIDEO_MB = MAX_VIDEO_BYTES / 1024 / 1024;

export interface UploadCounts {
  images: number;
  videos: number;
  /** Tried, but the computer or the connection said no. */
  failed: number;
  /** Videos over the limit — never sent. */
  tooBig: number;
  /** First failure, for the case that nothing got through. */
  firstError?: string;
}

/** The one line shown once the batch is through. */
export function uploadSummary(c: UploadCounts): string {
  const ok = c.images + c.videos;
  const big = c.tooBig === 1
    ? `1 Video zu groß (max. ${MAX_VIDEO_MB} MB)`
    : c.tooBig > 1 ? `${c.tooBig} Videos zu groß (max. ${MAX_VIDEO_MB} MB)` : '';
  if (!ok) {
    if (c.failed) return `Upload fehlgeschlagen: ${c.firstError || 'unbekannter Fehler'}`;
    return big || 'Nichts hochgeladen';
  }
  const noun = c.videos === 0 ? ['Bild', 'Bilder']
    : c.images === 0 ? ['Video', 'Videos']
    : ['Datei', 'Dateien'];
  const head = ok === 1 ? `${noun[0]} hochgeladen und eingefügt` : `${ok} ${noun[1]} hochgeladen und eingefügt`;
  const rest = [c.failed ? `${c.failed} fehlgeschlagen` : '', big].filter(Boolean);
  return rest.length ? `${head} · ${rest.join(' · ')}` : head;
}

/**
 * What to tell the user when the computer refuses a video.
 *
 * "No file received" on a video that was sent is the signature of a computer
 * still running the old receiver (it answered before the file was written).
 */
export function uploadErrorText(status: number, serverError?: string): string {
  if (status === 400 && serverError === 'No file received') {
    return 'Rechner-Software zu alt für Videos — dort „tms-terminal update“ ausführen';
  }
  if (status === 413) return `Zu groß (max. ${MAX_VIDEO_MB} MB)`;
  if (status === 401) return 'Nicht angemeldet';
  return serverError || (status ? `HTTP ${status}` : 'Verbindung abgebrochen');
}

/** Bar width for "file 2 of 5, 40 % through": 0..100. */
export function overallPercent(done: number, total: number, frac = 0): number {
  if (total <= 0) return 0;
  const f = Math.max(0, Math.min(1, frac || 0));
  return Math.max(0, Math.min(100, Math.round(((done + f) / total) * 100)));
}
