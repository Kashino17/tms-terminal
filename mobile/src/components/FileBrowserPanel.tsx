import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, ScrollView,
  StyleSheet, ActivityIndicator, Share, Animated,
  TouchableHighlight, Platform, Alert, Image,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { colors, spacing } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import { useFavPathsStore } from '../store/favPathsStore';
import { ActionSheet, ActionSheetOption } from './ActionSheet';
import { WebSocketService } from '../services/websocket.service';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);

// ── File type color + icon system ────────────────────────────────────────────

const TYPE_MAP: Record<string, { color: string; icon: keyof typeof Feather.glyphMap }> = {
  // TypeScript / JavaScript
  ts: { color: '#3B82F6', icon: 'code' }, tsx: { color: '#3B82F6', icon: 'code' },
  js: { color: '#F59E0B', icon: 'code' }, jsx: { color: '#F59E0B', icon: 'code' },
  mjs: { color: '#F59E0B', icon: 'code' }, cjs: { color: '#F59E0B', icon: 'code' },
  // Systems
  rs: { color: '#EF4444', icon: 'code' }, go: { color: '#06B6D4', icon: 'code' },
  c:  { color: '#94A3B8', icon: 'code' }, cpp: { color: '#94A3B8', icon: 'code' },
  h:  { color: '#94A3B8', icon: 'code' },
  // Scripting
  py: { color: '#22C55E', icon: 'code' }, rb: { color: '#EF4444', icon: 'code' },
  php: { color: '#8B5CF6', icon: 'code' }, lua: { color: '#3B82F6', icon: 'code' },
  // JVM / Mobile
  java: { color: '#F97316', icon: 'code' }, kt: { color: '#A855F7', icon: 'code' },
  swift: { color: '#F97316', icon: 'code' }, dart: { color: '#06B6D4', icon: 'code' },
  // Web
  html: { color: '#F97316', icon: 'code' }, css: { color: '#3B82F6', icon: 'code' },
  scss: { color: '#EC4899', icon: 'code' }, vue: { color: '#22C55E', icon: 'code' },
  svelte: { color: '#F97316', icon: 'code' },
  // Data
  json: { color: '#F59E0B', icon: 'settings' }, yaml: { color: '#F59E0B', icon: 'settings' },
  yml: { color: '#F59E0B', icon: 'settings' }, toml: { color: '#F59E0B', icon: 'settings' },
  xml: { color: '#94A3B8', icon: 'settings' }, csv: { color: '#22C55E', icon: 'bar-chart-2' },
  // Docs
  md: { color: '#8B5CF6', icon: 'file-text' }, mdx: { color: '#8B5CF6', icon: 'file-text' },
  txt: { color: '#94A3B8', icon: 'file-text' }, pdf: { color: '#EF4444', icon: 'file-text' },
  // Images
  png: { color: '#EC4899', icon: 'image' }, jpg: { color: '#EC4899', icon: 'image' },
  jpeg: { color: '#EC4899', icon: 'image' }, gif: { color: '#EC4899', icon: 'image' },
  svg: { color: '#F97316', icon: 'image' }, webp: { color: '#EC4899', icon: 'image' },
  ico: { color: '#F97316', icon: 'image' },
  // Shell / Config
  sh: { color: '#22C55E', icon: 'terminal' }, bash: { color: '#22C55E', icon: 'terminal' },
  zsh: { color: '#22C55E', icon: 'terminal' }, fish: { color: '#06B6D4', icon: 'terminal' },
  env: { color: '#F59E0B', icon: 'lock' },
  // Archives
  zip: { color: '#F59E0B', icon: 'archive' }, tar: { color: '#F59E0B', icon: 'archive' },
  gz: { color: '#F59E0B', icon: 'archive' }, dmg: { color: '#94A3B8', icon: 'package' },
};

function getType(name: string, isDir: boolean) {
  if (isDir) return { color: '#F59E0B', icon: 'folder' as keyof typeof Feather.glyphMap };
  if (name.startsWith('.') && !name.includes('.', 1)) {
    return { color: '#64748B', icon: 'settings' as keyof typeof Feather.glyphMap };
  }
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return TYPE_MAP[ext] ?? { color: '#64748B', icon: 'file' as keyof typeof Feather.glyphMap };
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  }
  return d.getFullYear().toString();
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
  isSymlink: boolean;
}

interface Viewer {
  name: string;
  path: string;
  content: string;
  lines: number;
}

interface Props {
  serverHost: string;
  serverPort: number;
  serverToken: string;
  sessionId?: string;
  wsService?: WebSocketService;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FileBrowserPanel({ serverHost, serverPort, serverToken, sessionId, wsService }: Props) {
  const responsive = useResponsive();
  const { rf, rs, ri } = responsive;
  const [currentPath, setCurrentPath] = useState('~/Desktop');
  const [resolvedPath, setResolvedPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const viewerAnim = useRef(new Animated.Value(0)).current;
  const [actionSheet, setActionSheet] = useState<{
    title?: string; subtitle?: string; options: ActionSheetOption[];
  } | null>(null);
  const favPaths = useFavPathsStore((s) => s.paths);
  const addFav = useFavPathsStore((s) => s.add);
  const removeFav = useFavPathsStore((s) => s.remove);
  const isFav = useFavPathsStore((s) => s.isFav);
  const currentIsFav = isFav(resolvedPath);

  const cdToPath = useCallback((dirPath: string) => {
    if (!sessionId || !wsService) return;
    // Detect Windows paths (C:\, D:\, \\, etc.)
    const isWindows = /^[A-Z]:[\\\/]/i.test(dirPath) || dirPath.startsWith('\\\\');
    let cmd: string;
    if (isWindows) {
      // Windows: use double quotes (works in both cmd.exe and PowerShell)
      const escaped = dirPath.replace(/"/g, '');
      cmd = `cd "${escaped}"\r`;
    } else {
      // Unix: use single quotes, escape embedded single quotes
      const escaped = dirPath.replace(/'/g, "'\\''");
      cmd = `cd '${escaped}'\r`;
    }
    wsService.send({
      type: 'terminal:input',
      sessionId,
      payload: { data: cmd },
    });
  }, [sessionId, wsService]);

  const BASE = `http://${serverHost}:${serverPort}`;

  const loadDir = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${BASE}/files/list?path=${encodeURIComponent(dirPath)}`, {
        headers: { Authorization: `Bearer ${serverToken}` },
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      const data = await r.json();
      setEntries(data.entries);
      setResolvedPath(data.path);
      setCurrentPath(dirPath);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load directory');
    } finally {
      setLoading(false);
    }
  }, [BASE, serverToken]);

  useEffect(() => { loadDir('~/Desktop'); }, [loadDir]);

  // Viewer slide animation
  const openViewer = (v: Viewer) => {
    setViewer(v);
    viewerAnim.setValue(0);
    Animated.spring(viewerAnim, { toValue: 1, useNativeDriver: true, tension: 100, friction: 12 }).start();
  };
  const closeViewer = () => {
    Animated.timing(viewerAnim, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => setViewer(null));
  };

  const navigate = (entry: FileEntry) => {
    if (!entry.isDir) return;
    Haptics.selectionAsync();
    setHistory((h) => [...h, currentPath]);
    loadDir(entry.path);
  };

  const goBack = () => {
    Haptics.selectionAsync();
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    loadDir(prev);
  };

  const goUp = () => {
    Haptics.selectionAsync();
    // Navigate to parent directory
    const parent = resolvedPath.replace(/\/[^/]+\/?$/, '') || '/';
    setHistory((h) => [...h, currentPath]);
    loadDir(parent);
  };

  const isImage = (name: string) => IMAGE_EXTS.has(name.split('.').pop()?.toLowerCase() ?? '');

  const openFile = async (entry: FileEntry) => {
    Haptics.selectionAsync();

    // Image preview — token in URL is required because RN Image source.uri
    // does not support custom Authorization headers. HTTPS protects the token in transit.
    if (isImage(entry.name)) {
      const imageUrl = `${BASE}/files/download?path=${encodeURIComponent(entry.path)}&token=${serverToken}`;
      openViewer({ name: entry.name, path: entry.path, content: imageUrl, lines: 0 });
      return;
    }

    setViewerLoading(true);
    try {
      const r = await fetch(`${BASE}/files/read?path=${encodeURIComponent(entry.path)}`, {
        headers: { Authorization: `Bearer ${serverToken}` },
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error ?? `HTTP ${r.status}`);
      openViewer({ name: entry.name, path: entry.path, content: data.content, lines: data.lines });
    } catch (e: unknown) {
      Alert.alert('Cannot Preview', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setViewerLoading(false);
    }
  };

  const downloadFile = async (entry: FileEntry) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      // Token in URL is required because expo-file-system downloadAsync
      // does not support custom Authorization headers. HTTPS protects the token in transit.
      const url = `${BASE}/files/download?path=${encodeURIComponent(entry.path)}&token=${serverToken}`;
      const localUri = FileSystem.cacheDirectory + entry.name;
      const { uri } = await FileSystem.downloadAsync(url, localUri);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri);
      } else {
        Alert.alert('Downloaded', `Saved to: ${uri}`);
      }
    } catch (e: unknown) {
      Alert.alert('Download Failed', e instanceof Error ? e.message : 'Unknown error');
    }
  };

  const handleLongPress = (entry: FileEntry) => {
    const options: ActionSheetOption[] = [
      { label: 'Pfad kopieren', icon: 'copy', onPress: () => Clipboard.setStringAsync(entry.path) },
    ];
    if (entry.isDir && sessionId) {
      options.push({ label: 'Im Terminal öffnen (cd)', icon: 'terminal', onPress: () => cdToPath(entry.path) });
    }
    if (!entry.isDir) {
      options.push(
        { label: 'Vorschau', icon: 'eye', onPress: () => openFile(entry) },
        { label: 'Download', icon: 'download', onPress: () => downloadFile(entry) },
      );
    }
    if (!isFav(entry.path) && entry.isDir) {
      options.push({ label: 'Zu Favoriten', icon: 'star', color: '#F59E0B', onPress: () => addFav(entry.path) });
    }
    setActionSheet({ title: entry.name, subtitle: entry.path, options });
  };

  const shareContent = async () => {
    if (!viewer) return;
    Haptics.selectionAsync();
    try {
      await Share.share({ message: viewer.content, title: viewer.name });
    } catch {}
  };

  // Breadcrumb segments from resolvedPath
  const breadcrumbs = useMemo(() => {
    if (!resolvedPath) return [];
    // Consider paths starting with /Users/ or /home/ as home directories
    const homePrefix = resolvedPath.match(/^(\/(?:Users|home)\/[^/]+)/)?.[1] ?? null;
    const home = homePrefix ? '~' : null;
    const parts = resolvedPath.replace(/^\//, '').split('/');
    // Condense: show ~ + last 2 segments
    if (home && parts.length > 3) {
      return ['~', '…', parts[parts.length - 2], parts[parts.length - 1]].filter(Boolean);
    }
    return [home ?? '', ...parts.slice(home ? parts.findIndex(p => resolvedPath.includes(p)) : 0)].filter(Boolean);
  }, [resolvedPath]);

  // ── Render helpers ──────────────────────────────────────────────────────────

  const scaledRowH = rs(ROW_HEIGHT);

  const renderEntry = useCallback(({ item }: { item: FileEntry }) => {
    const { color, icon } = getType(item.name, item.isDir);
    return (
      <TouchableHighlight
        onPress={() => item.isDir ? navigate(item) : openFile(item)}
        onLongPress={() => handleLongPress(item)}
        underlayColor={colors.surface}
        style={{ height: scaledRowH, justifyContent: 'center' }}
        delayLongPress={400}
        delayPressIn={100}
        accessibilityLabel={`${item.isDir ? 'Folder' : 'File'}: ${item.name}`}
        accessibilityRole="button"
      >
        <View style={[styles.rowInner, { height: scaledRowH }]}>
          <View style={[styles.typeBar, { backgroundColor: color, height: scaledRowH }]} />
          <Feather name={icon} size={ri(13)} color={color} style={styles.rowIcon} />
          <Text style={[styles.rowName, { fontSize: rf(12) }]} numberOfLines={1} ellipsizeMode="middle">
            {item.name}
          </Text>
          <Text style={[styles.rowMeta, { fontSize: rf(10) }]}>
            {item.isDir ? '' : fmtSize(item.size)}
          </Text>
          {item.isDir && <Feather name="chevron-right" size={ri(11)} color={colors.textDim} />}
        </View>
      </TouchableHighlight>
    );
  }, [navigate, openFile, handleLongPress, rf, rs, ri, scaledRowH]);

  const viewerTranslateY = viewerAnim.interpolate({
    inputRange: [0, 1], outputRange: [400, 0],
  });

  // ── Main render ─────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      {/* ── Header ── */}
      <View style={[styles.header, { height: rs(44) }]}>
        <TouchableOpacity
          onPress={goBack}
          disabled={history.length === 0}
          style={[styles.headerBtn, history.length === 0 && styles.headerBtnDisabled]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Feather name="arrow-left" size={ri(15)} color={history.length > 0 ? colors.text : colors.textDim} />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { fontSize: rf(12) }]} numberOfLines={1}>
            {resolvedPath.split('/').pop() || '~'}
          </Text>
        </View>

        <TouchableOpacity
          onPress={goUp}
          style={styles.headerBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="Go to parent directory"
        >
          <Feather name="corner-left-up" size={ri(14)} color={colors.textDim} />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => { setHistory([]); loadDir('~/Desktop'); }}
          style={styles.headerBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="Go to Desktop"
        >
          <Feather name="home" size={ri(14)} color={colors.textDim} />
        </TouchableOpacity>

        {sessionId && (
          <TouchableOpacity
            onPress={() => cdToPath(resolvedPath)}
            style={styles.headerBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="cd to this directory"
          >
            <Feather name="terminal" size={ri(14)} color={colors.primary} />
          </TouchableOpacity>
        )}

        <TouchableOpacity
          onPress={() => {
            if (currentIsFav) removeFav(resolvedPath);
            else addFav(resolvedPath);
          }}
          style={styles.headerBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel={currentIsFav ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Feather name="star" size={ri(14)} color={currentIsFav ? '#F59E0B' : colors.textDim} />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => loadDir(currentPath)}
          style={styles.headerBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="Refresh"
        >
          <Feather name="refresh-cw" size={ri(13)} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      {/* ── Favorites ── */}
      {favPaths.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.favBar}
          contentContainerStyle={[styles.favBarContent, { height: rs(30), gap: rs(6) }]}
        >
          {favPaths.map((fav) => (
            <TouchableOpacity
              key={fav.path}
              style={[
                styles.favChip,
                { paddingHorizontal: rs(8), paddingVertical: rs(4) },
                resolvedPath === fav.path && styles.favChipActive,
              ]}
              onPress={() => {
                Haptics.selectionAsync();
                setHistory((h) => [...h, currentPath]);
                loadDir(fav.path);
              }}
              onLongPress={() => {
                setActionSheet({
                  title: fav.label,
                  subtitle: fav.path,
                  options: [
                    { label: 'Pfad kopieren', icon: 'copy', onPress: () => Clipboard.setStringAsync(fav.path) },
                    { label: 'Favorit entfernen', icon: 'star', destructive: true, onPress: () => removeFav(fav.path) },
                  ],
                });
              }}
              delayLongPress={400}
            >
              <Feather name="star" size={ri(10)} color="#F59E0B" />
              <Text style={[styles.favLabel, { fontSize: rf(10) }]} numberOfLines={1}>{fav.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* ── Breadcrumb ── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.breadcrumb}
        contentContainerStyle={[styles.breadcrumbContent, { height: rs(28) }]}
      >
        {breadcrumbs.map((seg, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Text style={[styles.breadcrumbSep, { fontSize: rf(10) }]}>›</Text>}
            <Text
              style={[styles.breadcrumbSeg, { fontSize: rf(10) }, i === breadcrumbs.length - 1 && styles.breadcrumbActive]}
              numberOfLines={1}
            >
              {seg}
            </Text>
          </React.Fragment>
        ))}
      </ScrollView>

      <View style={styles.divider} />

      {/* ── File list ── */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Feather name="alert-circle" size={20} color={colors.destructive} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => loadDir(currentPath)} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : entries.length === 0 ? (
        <View style={styles.center}>
          <Feather name="folder" size={24} color={colors.textDim} />
          <Text style={styles.emptyText}>Empty directory</Text>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.path}
          renderItem={renderEntry}
          style={styles.list}
          showsVerticalScrollIndicator={false}
          initialNumToRender={30}
          getItemLayout={(_, index) => ({ length: scaledRowH, offset: scaledRowH * index, index })}
        />
      )}

      {/* ── Text Viewer overlay ── */}
      {viewer && (
        <Animated.View style={[styles.viewer, { transform: [{ translateY: viewerTranslateY }] }]}>
          {/* Viewer header */}
          <View style={[styles.viewerHeader, { height: rs(44) }]}>
            <View style={styles.viewerHandle} />
            <Text style={[styles.viewerName, { fontSize: rf(12) }]} numberOfLines={1}>{viewer.name}</Text>
            <View style={styles.viewerActions}>
              <TouchableOpacity onPress={shareContent} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Feather name="share" size={ri(14)} color={colors.primary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={closeViewer} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ marginLeft: rs(12) }}>
                <Feather name="x" size={ri(15)} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          </View>

          {viewer.lines === 0 && isImage(viewer.name) ? (
            <>
              {/* Image preview */}
              <View style={styles.viewerDivider} />
              <ScrollView
                style={styles.viewerContent}
                contentContainerStyle={styles.imageContainer}
                showsVerticalScrollIndicator={false}
              >
                <Image
                  source={{ uri: viewer.content }}
                  style={styles.imagePreview}
                  resizeMode="contain"
                />
                <TouchableOpacity
                  style={styles.downloadBtn}
                  onPress={() => downloadFile({ name: viewer.name, path: viewer.path, isDir: false, size: 0, modified: 0, isSymlink: false })}
                  activeOpacity={0.8}
                >
                  <Feather name="download" size={14} color={colors.bg} />
                  <Text style={styles.downloadBtnText}>Download</Text>
                </TouchableOpacity>
              </ScrollView>
            </>
          ) : (
            <>
              {/* Text preview */}
              <View style={styles.viewerMeta}>
                <Text style={styles.viewerMetaText}>{viewer.lines} lines · {fmtSize(viewer.content.length)}</Text>
              </View>
              <View style={styles.viewerDivider} />
              <ScrollView style={styles.viewerContent} showsVerticalScrollIndicator={false}>
                <Text style={styles.viewerText} selectable>{viewer.content}</Text>
              </ScrollView>
            </>
          )}
        </Animated.View>
      )}

      {/* Viewer loading indicator */}
      {viewerLoading && (
        <View style={styles.viewerLoadingOverlay}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      )}

      {/* Action Sheet */}
      <ActionSheet
        visible={!!actionSheet}
        title={actionSheet?.title}
        subtitle={actionSheet?.subtitle}
        options={actionSheet?.options ?? []}
        onClose={() => setActionSheet(null)}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const ROW_HEIGHT = 36;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    position: 'relative',
  },

  // ── Header
  header: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 2,
  },
  headerBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  headerBtnDisabled: { opacity: 0.3 },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  // ── Breadcrumb
  breadcrumb: { maxHeight: 28, backgroundColor: colors.surface },
  breadcrumbContent: {
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    height: 28,
    gap: 2,
  },
  breadcrumbSep: { fontSize: 10, color: colors.textDim, marginHorizontal: 1 },
  breadcrumbSeg: {
    fontSize: 10,
    color: colors.textDim,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  breadcrumbActive: { color: colors.primary, fontWeight: '600' },

  // ── Favorites
  favBar: { maxHeight: 30, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  favBarContent: { paddingHorizontal: spacing.sm, alignItems: 'center' },
  favChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  favChipActive: { borderColor: '#F59E0B', backgroundColor: 'rgba(245,158,11,0.1)' },
  favLabel: {
    color: colors.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    maxWidth: 100,
  },

  divider: { height: 1, backgroundColor: colors.border },

  // ── List
  list: { flex: 1 },

  row: { height: ROW_HEIGHT, justifyContent: 'center' },
  rowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROW_HEIGHT,
    paddingRight: spacing.sm,
  },
  typeBar: { width: 3, height: ROW_HEIGHT, marginRight: 7 },
  rowIcon: { marginRight: 6, width: 14 },
  rowName: {
    flex: 1,
    fontSize: 12,
    color: colors.text,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  rowMeta: {
    fontSize: 10,
    color: colors.textDim,
    marginLeft: 4,
    minWidth: 28,
    textAlign: 'right',
  },

  // ── Center states
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: spacing.lg },
  errorText: { fontSize: 11, color: colors.textMuted, textAlign: 'center', lineHeight: 16 },
  retryBtn: {
    marginTop: 4, paddingHorizontal: spacing.md, paddingVertical: spacing.xs,
    borderRadius: 6, borderWidth: 1, borderColor: colors.border,
  },
  retryText: { fontSize: 12, color: colors.primary },
  emptyText: { fontSize: 12, color: colors.textDim, marginTop: 4 },

  // ── Viewer
  viewer: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.borderStrong,
  },
  viewerHeader: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 6,
  },
  viewerHandle: {
    width: 3, height: 16, borderRadius: 2,
    backgroundColor: colors.border, marginRight: 4,
  },
  viewerName: {
    flex: 1, fontSize: 12, color: colors.text, fontWeight: '500',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  viewerActions: { flexDirection: 'row', alignItems: 'center' },
  viewerMeta: {
    paddingHorizontal: spacing.sm, paddingVertical: 4,
    backgroundColor: colors.surface,
  },
  viewerMetaText: { fontSize: 10, color: colors.textDim },
  viewerDivider: { height: 1, backgroundColor: colors.border },
  viewerContent: { flex: 1 },
  viewerText: {
    fontSize: 10.5,
    color: colors.text,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 17,
    padding: spacing.sm,
  },

  // Image preview
  imageContainer: { alignItems: 'center', padding: spacing.md, gap: 12 },
  imagePreview: { width: '100%', height: 200, borderRadius: 8, backgroundColor: colors.surface },
  downloadBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.primary, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 20,
  },
  downloadBtnText: { color: colors.bg, fontSize: 13, fontWeight: '700' },

  // Viewer loading
  viewerLoadingOverlay: {
    position: 'absolute', bottom: 16, alignSelf: 'center',
    backgroundColor: colors.surface,
    borderRadius: 12, padding: 10,
    borderWidth: 1, borderColor: colors.border,
  },
});
