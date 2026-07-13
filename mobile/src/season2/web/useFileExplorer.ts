// The fullscreen Files screen: raw listings, previews, renames, bulk trash,
// shares, and real downloads (single file or server-zipped selection).
import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { saveToDownloads } from './downloads';

type Call = (fn: string, ...args: unknown[]) => void;

interface Args {
  ready: boolean;
  call: Call;
  server: { id: string; host: string; port: number } | null;
  token: string | null;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm',
  mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  zip: 'application/zip', md: 'text/markdown', txt: 'text/plain', json: 'application/json',
};
const mimeFor = (name: string) =>
  MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export function useFileExplorer({ ready, call, server, token }: Args) {
  const cwd = useRef('~');
  const base = server ? `http://${server.host}:${server.port}` : '';

  useEffect(() => {
    if (ready && server && token) call('setFilesBase', base, token);
  }, [ready, server, token, base, call]);

  const auth = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const listRaw = useCallback(async (path: string) => {
    if (!server || !token) return;
    try {
      const r = await fetch(`${base}/files/list?path=${encodeURIComponent(path)}`, { headers: auth });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      cwd.current = d.path;
      call('setFilesDir', d.path, (d.entries ?? []).map((e: any) => ({
        name: e.name, path: e.path, isDir: e.isDir, size: e.size, modified: e.modified,
      })));
    } catch (e: any) {
      call('toast', `Dateien: ${e?.message ?? 'Laden fehlgeschlagen'}`);
    }
  }, [server, token, base, auth, call]);

  const refresh = useCallback(() => listRaw(cwd.current), [listRaw]);

  const download = useCallback(async (paths: string[], zip: boolean) => {
    if (!server || !token || !paths.length) return;
    const id = `dl-${Date.now()}`;
    const filename = zip
      ? `tms-${paths.length === 1 ? (paths[0].split('/').pop() ?? 'ordner') : 'auswahl'}.zip`
      : (paths[0].split('/').pop() ?? 'datei');
    const url = zip
      ? `${base}/files/zip?paths=${encodeURIComponent(JSON.stringify(paths))}&token=${token}`
      : `${base}/files/download?path=${encodeURIComponent(paths[0])}&token=${token}`;
    const tmp = `${FileSystem.cacheDirectory}${id}-${filename}`;
    call('downloadProgress', id, filename, 0, 'running');
    try {
      const task = FileSystem.createDownloadResumable(url, tmp, {}, (p) => {
        const pct = p.totalBytesExpectedToWrite > 0
          ? p.totalBytesWritten / p.totalBytesExpectedToWrite : 0;
        call('downloadProgress', id, filename, pct, 'running');
      });
      const res = await task.downloadAsync();
      if (!res) throw new Error('Abgebrochen');
      if (res.status >= 400) throw new Error(res.status === 413 ? 'Zu groß (> 4 GB)' : `HTTP ${res.status}`);
      try {
        await saveToDownloads(res.uri, filename, zip ? 'application/zip' : mimeFor(filename));
        call('downloadProgress', id, filename, 1, 'done');
      } catch {
        // SAF denied or copy failed — offer the share sheet instead.
        call('downloadProgress', id, filename, 1, 'done');
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(res.uri);
      }
    } catch (e: any) {
      call('downloadProgress', id, filename, 0, 'error');
      call('toast', `Download: ${e?.message ?? 'fehlgeschlagen'}`);
    } finally {
      FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
    }
  }, [server, token, base, call]);

  /** Everything the files screen posts back. True when handled. */
  const handle = useCallback((type: string, payload: any): boolean => {
    switch (type) {
      case 'files:listRaw':
        listRaw(String(payload.path ?? '~'));
        return true;

      case 'files:readRaw': {
        if (!server || !token) return true;
        (async () => {
          try {
            const r = await fetch(`${base}/files/read?path=${encodeURIComponent(payload.path)}`, { headers: auth });
            const d = await r.json();
            if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
            call('fileContent', payload.path, d.content ?? '', null);
          } catch (e: any) {
            call('fileContent', payload.path, '', e?.message ?? 'Lesen fehlgeschlagen');
          }
        })();
        return true;
      }

      case 'files:downloadToFolder':
        download((payload.paths ?? []).map(String), !!payload.zip);
        return true;

      case 'files:share': {
        if (!server || !token) return true;
        (async () => {
          const name = String(payload.path).split('/').pop() ?? 'datei';
          const tmp = `${FileSystem.cacheDirectory}share-${name}`;
          try {
            const { uri, status } = await FileSystem.downloadAsync(
              `${base}/files/download?path=${encodeURIComponent(payload.path)}&token=${token}`, tmp);
            if (status >= 400) throw new Error(`HTTP ${status}`);
            if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
          } catch (e: any) {
            call('toast', `Teilen: ${e?.message ?? 'fehlgeschlagen'}`);
          }
        })();
        return true;
      }

      case 'files:rename': {
        if (!server || !token) return true;
        (async () => {
          try {
            const r = await fetch(`${base}/files/rename`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...auth },
              body: JSON.stringify({ path: payload.path, name: payload.name }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(r.status === 409 ? 'Name existiert schon' : d.error ?? `HTTP ${r.status}`);
            call('toast', 'Umbenannt');
            refresh();
          } catch (e: any) { call('toast', `Umbenennen: ${e?.message ?? 'fehlgeschlagen'}`); }
        })();
        return true;
      }

      case 'files:trashMany': {
        if (!server || !token) return true;
        const paths: string[] = (payload.paths ?? []).map(String);
        if (!paths.length) return true;
        (async () => {
          try {
            const r = await fetch(`${base}/files/trash`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...auth },
              body: JSON.stringify({ paths }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            call('toast', paths.length > 1 ? `${paths.length} in den Papierkorb gelegt` : 'In den Papierkorb gelegt');
            refresh();
          } catch (e: any) { call('toast', `Löschen: ${e?.message ?? 'fehlgeschlagen'}`); }
        })();
        return true;
      }

      case 'files:mkdirAbs': {
        if (!server || !token) return true;
        (async () => {
          try {
            const r = await fetch(`${base}/files/mkdir`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...auth },
              body: JSON.stringify({ path: payload.path }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            call('toast', 'Ordner angelegt');
            refresh();
          } catch (e: any) { call('toast', `Ordner: ${e?.message ?? 'fehlgeschlagen'}`); }
        })();
        return true;
      }
    }
    return false;
  }, [listRaw, refresh, download, server, token, base, auth, call]);

  return useMemo(() => ({ handle }), [handle]);
}
