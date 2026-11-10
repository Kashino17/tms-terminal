/**
 * Content-Disposition with a filename that survives any characters.
 * Node rejects header values outside Latin-1 ("Invalid character in header
 * content") — macOS names are often NFD (o + U+0308) and Turkish ı is not
 * Latin-1, so the raw name made /files/download answer 400.
 * RFC 6266: ASCII fallback in filename=, the real name in filename*=UTF-8''.
 */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const nfc = name.normalize('NFC');
  const ascii = nfc.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const star = encodeURIComponent(nfc).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`;
}
