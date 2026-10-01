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
// Serverseitige Notizen (klassischer Store) und die Notizen des HTML-Sheets je
// Karte (eigener Store) sind zwei verschiedene Sachen. Vorher hiessen beide
// `useNotesStore` — der Import musste Alias nehmen, und wer die Zeile las, sah
// nicht, dass zwei Notizspeicher gemeint waren.
import { useNotesStore } from '../../store/notesStore';
import { useSQLStore } from '../../store/sqlStore';
import { useS2NotesStore } from '../store/s2NotesStore';
import { Linking } from 'react-native';
import { useFavPathsStore } from '../../store/favPathsStore';
import { fetchPrayerTimes, getCurrentLocation, PRAYER_NAMES } from '../../services/prayer.service';
import { usePrayerStore, prayerMethodName } from '../../store/prayerStore';
import { readAdhanSettings, canScheduleExactAdhan } from '../../services/adhan.service';

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
  // Mitlesen, damit ein Methoden- oder Ortswechsel die Zeiten neu laedt.
  const method = usePrayerStore((s) => s.method);
  const chosenLocation = usePrayerStore((s) => s.location);
  /** Directory the Dateien sheet is currently showing. */
  const cwd = useRef('~');
  /** Which sheet is open — so an async reply knows whether it is still wanted. */
  const openSheet = useRef<string | null>(null);
  /** Screenshots uploaded this session: server path + a thumbnail URL. */
  const [shots, setShots] = useState<Array<{ path: string; url: string; isVideo?: boolean }>>([]);

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
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.All, // Fotos UND Videos
            quality: 1,
            base64: true,
            allowsMultipleSelection: true,
            selectionLimit: 20, // bis zu 20 auf einmal
          });
      if (result.canceled) return;

      const uploaded: Array<{ path: string; url: string; isVideo?: boolean }> = [];
      const total = result.assets.length;
      call('uploadProgress', 0, total);
      for (const asset of result.assets) {
        const isVideo = asset.type === 'video';
        if (isVideo && (asset.fileSize ?? 0) > 500 * 1024 * 1024) {
          call('toast', 'Video übersprungen: größer als 500 MB');
          continue;
        }
        let json: any;
        if (isVideo) {
          // Multipart wie im klassischen Panel — 500 MB als Base64 wären das
          // Ende der JS-Brücke. Der Server (/upload/media) kann genau 500 MB.
          const form = new FormData();
          form.append('file', {
            uri: asset.uri,
            name: asset.fileName ?? `video-${Date.now()}.mp4`,
            type: asset.mimeType ?? 'video/mp4',
          } as unknown as Blob);
          const r = await fetch(`http://${server.host}:${server.port}/upload/media`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: form,
          });
          json = await r.json();
          if (!r.ok || !json.path) throw new Error(json.error ?? `HTTP ${r.status}`);
        } else {
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
          json = await r.json();
          if (!r.ok || !json.path) throw new Error(json.error ?? `HTTP ${r.status}`);
        }
        uploaded.push({ path: json.path, url: isVideo ? '' : downloadUrl(json.path), isVideo });
        call('uploadProgress', uploaded.length, total); // 3 von 12 …
      }
      const next = [...uploaded.reverse(), ...shots];
      setShots(next);
      // Ein Bild hochzuladen hat nur einen Zweck: die KI soll es ansehen. Also
      // landet der Serverpfad sofort im Terminal — still (null), die Meldung
      // kommt gleich gebündelt.
      call('insertIntoTerminal', next.slice(0, uploaded.length).map((s) => s.path).join(' '), null);
      // Und KEIN setTool: die Galerie soll sich hinterher nicht wieder
      // aufklappen. Liste still nachführen, Sheet zu, kurz bestätigen.
      const n = uploaded.length;
      call('uploadFinished', next,
        n > 1 ? `${n} Bilder hochgeladen und eingefügt` : 'Bild hochgeladen und eingefügt');
    } catch (e: any) {
      call('uploadProgress', 1, 1); // Fortschritt wieder ausblenden
      call('toast', `Screenshot: ${e?.message ?? 'Upload fehlgeschlagen'}`);
    }
  }, [server, token, shots, downloadUrl, call]);

  const pushSnippets = useCallback(async () => {
    const raw = await AsyncStorage.getItem(SNIPPETS_KEY);
    const list: Array<{ id: string; text: string }> = raw ? JSON.parse(raw) : [];
    call('setTool', 'snippets', list.map((sn) => ({
      id: sn.id,
      label: sn.text.split('\n')[0].slice(0, 40),
      cmd: sn.text,
    })));
  }, [call]);

  const openTool = useCallback(async (tool: string) => {
    openSheet.current = tool;
    switch (tool) {
      case 'files':
        call('setFavs', useFavPathsStore.getState().paths.map((f) => f.path));
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

      case 'snippets':
        await pushSnippets();
        break;

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
  }, [listFiles, wsService, server, call, activeSessionId, shots, pushSnippets]);

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

  /**
   * Gebetszeiten fuer die Insel, den Gebetszeiten-Screen und die Einstellungen.
   *
   * Laeuft bei jedem Wechsel der Berechnungsmethode und des Ortes mit, nicht nur
   * einmal beim Start — sonst blieb nach dem Umschalten die alte Methode stehen.
   *
   * `meta` ist zusaetzlich zur Liste: Ort, Datum, Hijri, Methode, Adhan-Schalter
   * und Berechtigungen. Ohne meta zeigt die Seite weiter nur Liste und Countdown.
   */
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      // Von Hand gewaehlter Ort vor GPS: der Nutzer soll auch ohne Standort
      // Gebetszeiten sehen (und den Adhan einstellen) koennen.
      const chosen = usePrayerStore.getState().location;
      const gps = chosen ? null : await getCurrentLocation().catch(() => null);
      const loc = chosen ?? gps;
      if (!loc || cancelled) return;
      // Von Hand gewaehlter Ort traegt sein eigenes Label, GPS den Ort aus der
      // Rueckwaerts-Geokodierung.
      const label = chosen
        ? chosen.label
        : [gps?.city, gps?.country].filter(Boolean).join(', ') || 'GPS';

      const data = await fetchPrayerTimes(loc.latitude, loc.longitude, method).catch(() => null);
      if (!data || cancelled) return;

      const keys = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'] as const;
      const times = keys
        .filter((k) => data.timings[k])
        .map((k) => ({
          name: PRAYER_NAMES[k].de,
          de: PRAYER_NAMES[k].de,
          ar: PRAYER_NAMES[k].ar,
          emoji: PRAYER_NAMES[k].emoji,
          time: data.timings[k],
        }));

      const adhan = await readAdhanSettings();
      if (cancelled) return;
      call('setPrayer', times, {
        location: { label, lat: loc.latitude, lon: loc.longitude },
        date: {
          readable: data.date.readable,
          hijri: `${data.date.hijri.day}. ${data.date.hijri.month.en} ${data.date.hijri.year}`,
        },
        method: { id: method, name: prayerMethodName(method) },
        adhan: { enabled: adhan.enabled, wecker: adhan.wecker, selected: adhan.selected },
        perms: { notifications: true, exactAlarms: adhan.exactAlarms },
      });
    })();
    return () => { cancelled = true; };
  }, [ready, call, method, chosenLocation]);

  /** Everything the sheets post back. Returns true when it handled the message. */
  const handle = useCallback((type: string, payload: any): boolean => {
    switch (type) {
      case 'tool:open':
        openTool(payload.tool);
        return true;

      case 'files:preview': {
        if (!server || !token) return true;
        (async () => {
          try {
            const r = await fetch(`http://${server.host}:${server.port}/files/read?path=${encodeURIComponent(payload.path)}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            const d = await r.json();
            if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
            call('filePreview', payload.path.split('/').pop(), d.content ?? '');
          } catch (e: any) { call('toast', `Vorschau: ${e?.message ?? 'fehlgeschlagen'}`); }
        })();
        return true;
      }

      case 'files:download':
        // Der System-Browser lädt die Datei herunter (Token in der URL, wie im
        // klassischen Explorer — Tailscale verschlüsselt den Transport).
        Linking.openURL(downloadUrl(payload.path)).catch(() => call('toast', 'Download fehlgeschlagen'));
        return true;

      case 'files:fav': {
        const fav = useFavPathsStore.getState();
        if (fav.isFav(payload.path)) fav.remove(payload.path);
        else fav.add(payload.path);
        call('setFavs', useFavPathsStore.getState().paths.map((f) => f.path));
        listFiles(cwd.current); // Sheet neu zeichnen mit aktualisierten Sternen
        return true;
      }

      case 'files:goto':
        listFiles(String(payload.path ?? '~'));
        return true;

      case 'files:mkdir': {
        if (!server || !token) return true;
        (async () => {
          try {
            const r = await fetch(`http://${server.host}:${server.port}/files/mkdir`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ path: `${cwd.current.replace(/\/$/, '')}/${payload.name}` }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            call('toast', 'Ordner angelegt');
            listFiles(cwd.current);
          } catch (e: any) { call('toast', `Ordner: ${e?.message ?? 'fehlgeschlagen'}`); }
        })();
        return true;
      }

      case 'files:trash': {
        if (!server || !token) return true;
        (async () => {
          try {
            const r = await fetch(`http://${server.host}:${server.port}/files/trash`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ paths: [payload.path] }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            call('toast', 'In den Papierkorb gelegt');
            listFiles(cwd.current);
          } catch (e: any) { call('toast', `Löschen: ${e?.message ?? 'fehlgeschlagen'}`); }
        })();
        return true;
      }

      case 'snippet:add': {
        (async () => {
          const raw = await AsyncStorage.getItem(SNIPPETS_KEY);
          const list: Array<{ id: string; text: string }> = raw ? JSON.parse(raw) : [];
          list.unshift({ id: `s-${Date.now()}`, text: String(payload.text) });
          await AsyncStorage.setItem(SNIPPETS_KEY, JSON.stringify(list));
          pushSnippets();
        })();
        return true;
      }

      case 'snippet:delete': {
        (async () => {
          const raw = await AsyncStorage.getItem(SNIPPETS_KEY);
          const list: Array<{ id: string; text: string }> = raw ? JSON.parse(raw) : [];
          await AsyncStorage.setItem(SNIPPETS_KEY, JSON.stringify(list.filter((sn) => sn.id !== payload.id)));
          pushSnippets();
        })();
        return true;
      }

      case 'watcher:delete':
        wsService?.send({ type: 'watcher:delete', payload: { id: payload.id } });
        setTimeout(() => wsService?.send({ type: 'watcher:list' }), 300);
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

      case 'shot:delete': {
        const paths: string[] = payload.paths ?? [];
        if (!server || !token || !paths.length) return true;
        (async () => {
          try {
            const r = await fetch(`http://${server.host}:${server.port}/files/trash`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ paths }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            setShots((prev) => {
              const next = prev.filter((sh) => !paths.includes(sh.path));
              call('setTool', 'screenshots', next);
              return next;
            });
            call('toast', paths.length > 1 ? `${paths.length} Dateien gelöscht` : 'Gelöscht');
          } catch (e: any) {
            call('toast', `Löschen: ${e?.message ?? 'fehlgeschlagen'}`);
          }
        })();
        return true;
      }

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
  }, [openTool, listFiles, server, token, wsService, call, captureShot, pushSnippets]);

  /** Hand a card's stored notes/todos back to the page once it exists. */
  const pushNotes = useCallback((cardId: string) => {
    const entry = useS2NotesStore.getState().byTab[cardId];
    if (entry) call('setNotes', cardId, entry.notes, entry.todos);
  }, [call]);

  // A stable object: the callers keep it in effect dependency lists.
  return useMemo(() => ({ handle, pushNotes }), [handle, pushNotes]);
}
