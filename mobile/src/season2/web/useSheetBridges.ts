/**
 * The Werkzeug sheets of the Liquid Deck, on real data.
 *
 * Each sheet in the mockup renders straight out of TMS_DATA[key], so wiring one
 * up means two things: fetch the real thing when the sheet opens, and make its
 * taps do real work. Nothing here rebuilds a sheet — they already exist.
 *
 *   Dateien    HTTP /files/list on the server (walkable)
 *   Prozesse   WebSocket system:snapshot
 *   Watcher    WebSocket watcher:list / watcher:update
 *   Ports      the saved port forwards; a tap opens one in the in-app browser
 *   Snippets   the same AsyncStorage snippets the classic panel uses
 *   SQL        the statements detected in terminal output (sqlStore)
 *   Notizen    notesStore (global) + per-terminal notes/todos (season2 store)
 *   Screens.   camera / gallery -> upload to the server -> the path goes into
 *              the terminal, which is the only reason to take one
 *   Gebete     real prayer times for the current location
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import type { WebSocketService } from '../../services/websocket.service';
import { usePortForwardingStore } from '../../store/portForwardingStore';
import { useNotesStore } from '../../store/notesStore';
import { useSQLStore } from '../../store/sqlStore';
import { useNotesStore as useS2NotesStore } from '../store/notesStore';
import { fetchPrayerTimes, getCurrentLocation } from '../../services/prayer.service';

type Call = (fn: string, ...args: unknown[]) => void;

const SNIPPETS_KEY = 'tms:snippets';

interface Args {
  ready: boolean;
  call: Call;
  wsService: WebSocketService | null;
  server: { id: string; host: string; port: number } | null;
  token: string | null;
  /** sessionId of the terminal the sheets act on. */
  activeSessionId?: string;
}

function humanSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function useSheetBridges({ ready, call, wsService, server, token, activeSessionId }: Args) {
  /** Directory the Dateien sheet is currently showing. */
  const cwd = useRef('~');
  /** Which sheet is open — so an async reply knows whether it is still wanted. */
  const openSheet = useRef<string | null>(null);
  /** Screenshots uploaded this session: server path + a thumbnail URL. */
  const [shots, setShots] = useState<Array<{ path: string; url: string }>>([]);

  const listFiles = useCallback(async (path: string) => {
    if (!server || !token) return;
    try {
      const r = await fetch(
        `http://${server.host}:${server.port}/files/list?path=${encodeURIComponent(path)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      cwd.current = data.path;
      call('setTool', 'files',
        (data.entries ?? []).map((e: any) => ({
          name: e.isDir ? `${e.name}/` : e.name,
          type: e.isDir ? 'dir' : 'file',
          size: e.isDir ? '' : humanSize(e.size),
          path: e.path, // damit ein Tipp den Pfad ins Terminal schreiben kann
        })),
        data.path,
      );
    } catch (e: any) {
      call('toast', `Dateien: ${e?.message ?? 'Laden fehlgeschlagen'}`);
    }
  }, [server, token, call]);

  /** Server path → a URL the page can put in an <img>. */
  const downloadUrl = useCallback((path: string) => (
    server && token
      ? `http://${server.host}:${server.port}/files/download?path=${encodeURIComponent(path)}&token=${token}`
      : ''
  ), [server, token]);

  /** Pick an image, upload it, and remember where it landed. */
  const captureShot = useCallback(async (source: 'camera' | 'library') => {
    if (!server || !token) return;
    try {
      const perm = source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        call('toast', source === 'camera' ? 'Kamera-Berechtigung fehlt' : 'Galerie-Berechtigung fehlt');
        return;
      }
      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1, base64: true })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1, base64: true, allowsMultipleSelection: true });
      if (result.canceled) return;

      const uploaded: Array<{ path: string; url: string }> = [];
      for (const asset of result.assets) {
        const data = asset.base64
          ?? (await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 }));
        const r = await fetch(`http://${server.host}:${server.port}/upload/screenshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            filename: asset.fileName ?? `screenshot-${uploaded.length}.jpg`,
            data,
            mimeType: asset.mimeType ?? 'image/jpeg',
          }),
        });
        const json = await r.json();
        if (!r.ok || !json.path) throw new Error(json.error ?? `HTTP ${r.status}`);
        uploaded.push({ path: json.path, url: downloadUrl(json.path) });
      }
      const next = [...uploaded.reverse(), ...shots];
      setShots(next);
      call('setTool', 'screenshots', next);
      // Ein Bild hochzuladen hat nur einen Zweck: die KI soll es ansehen. Also
      // landet der Serverpfad sofort im Terminal.
      call('insertIntoTerminal', next.slice(0, uploaded.length).map((s) => s.path).join(' '),
        uploaded.length > 1 ? `${uploaded.length} Bilder eingefügt` : 'Bild eingefügt');
    } catch (e: any) {
      call('toast', `Screenshot: ${e?.message ?? 'Upload fehlgeschlagen'}`);
    }
  }, [server, token, shots, downloadUrl, call]);

  const openTool = useCallback(async (tool: string) => {
    openSheet.current = tool;
    switch (tool) {
      case 'files':
        await listFiles(cwd.current);
        break;

      case 'processes':
        wsService?.send({ type: 'system:snapshot' });
        break;

      case 'watchers':
        wsService?.send({ type: 'watcher:list' });
        break;

      case 'ports': {
        if (!server) break;
        await usePortForwardingStore.getState().load(server.id);
        const entries = usePortForwardingStore.getState().getEntries(server.id);
        call('setTool', 'ports', entries.map((p) => ({
          port: p.port, service: p.label, forwarded: true,
        })));
        break;
      }

      case 'snippets': {
        const raw = await AsyncStorage.getItem(SNIPPETS_KEY);
        const list: Array<{ id: string; text: string }> = raw ? JSON.parse(raw) : [];
        call('setTool', 'snippets', list.map((s) => ({
          id: s.id,
          label: s.text.split('\n')[0].slice(0, 40),
          cmd: s.text,
        })));
        break;
      }

      case 'sql': {
        const entries = activeSessionId ? useSQLStore.getState().entries[activeSessionId] ?? [] : [];
        call('setTool', 'sql', {
          statements: entries.map((e) => ({
            sql: e.sql,
            time: new Date(e.detectedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
          })),
        });
        break;
      }

      case 'screenshots':
        call('setTool', 'screenshots', shots);
        break;

      case 'notes': {
        if (!server) break;
        await useNotesStore.getState().load();
        const items = useNotesStore.getState().getItems(server.id);
        call('setTool', 'notes', items.map((n) => ({
          title: '',
          body: n.text,
          time: new Date(n.createdAt).toLocaleDateString('de-DE'),
        })));
        break;
      }
    }
  }, [listFiles, wsService, server, call, activeSessionId, shots]);

  // Async server replies for the two WebSocket-backed sheets.
  useEffect(() => {
    if (!wsService || !ready) return;
    return wsService.addMessageListener((m: any) => {
      if (m?.type === 'system:snapshot' && openSheet.current === 'processes') {
        call('setTool', 'processes', (m.payload?.processes ?? []).map((p: any) => ({
          pid: p.pid, name: p.name, cpu: p.cpu, mem: Math.round(p.mem),
        })));
      } else if (m?.type === 'watcher:list' && openSheet.current === 'watchers') {
        call('setTool', 'watchers', (m.payload?.watchers ?? []).map((w: any) => ({
          id: w.id,
          pattern: w.config?.pattern ?? w.label,
          session: w.type,
          hits: w.hits ?? 0,
          active: !!w.enabled,
        })));
      }
    });
  }, [wsService, ready, call]);

  /** Real prayer times, once — the island and the Gebete screen both read them. */
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const loc = await getCurrentLocation().catch(() => null);
      if (!loc || cancelled) return;
      const data = await fetchPrayerTimes(loc.latitude, loc.longitude).catch(() => null);
      if (!data || cancelled) return;
      const t = data.timings;
      call('setPrayer', [
        { name: 'Fajr', time: t.Fajr }, { name: 'Dhuhr', time: t.Dhuhr }, { name: 'Asr', time: t.Asr },
        { name: 'Maghrib', time: t.Maghrib }, { name: 'Isha', time: t.Isha },
      ].map((p) => ({ ...p, time: p.time.slice(0, 5) })));
    })();
    return () => { cancelled = true; };
  }, [ready, call]);

  /** Everything the sheets post back. Returns true when it handled the message. */
  const handle = useCallback((type: string, payload: any): boolean => {
    switch (type) {
      case 'tool:open':
        openTool(payload.tool);
        return true;

      case 'files:cd': {
        const name = String(payload.name ?? '');
        const base = cwd.current;
        const next = name === '..'
          ? base.replace(/\/[^/]+\/?$/, '') || '/'
          : `${base.replace(/\/$/, '')}/${name.replace(/\/$/, '')}`;
        listFiles(next);
        return true;
      }

      case 'ports:open':
        call('openBrowser', String(payload.port));
        return true;

      case 'shot:capture':
        captureShot(payload.source === 'camera' ? 'camera' : 'library');
        return true;

      case 'watcher:toggle':
        wsService?.send({ type: 'watcher:update', payload: { id: payload.id, enabled: !!payload.on } });
        return true;

      case 'notes:sync':
        useS2NotesStore.setState((s) => ({
          byTab: {
            ...s.byTab,
            [payload.cardId]: { notes: payload.notes ?? [], todos: payload.todos ?? [] },
          },
        }));
        return true;
    }
    return false;
  }, [openTool, listFiles, server, wsService, call, captureShot]);

  /** Hand a card's stored notes/todos back to the page once it exists. */
  const pushNotes = useCallback((cardId: string) => {
    const entry = useS2NotesStore.getState().byTab[cardId];
    if (entry) call('setNotes', cardId, entry.notes, entry.todos);
  }, [call]);

  // A stable object: the callers keep it in effect dependency lists.
  return useMemo(() => ({ handle, pushNotes }), [handle, pushNotes]);
}
