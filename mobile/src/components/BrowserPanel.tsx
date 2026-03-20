import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, FlatList,
  PanResponder, LayoutAnimation, Platform,
  UIManager, Pressable, ScrollView, useWindowDimensions,
} from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { colors, fonts } from '../theme';
import { useBrowserTabsStore } from '../store/browserTabsStore';
import { useSplitViewStore, SplitLayout, TriMainPane } from '../store/splitViewStore';
import { usePortForwardingStore } from '../store/portForwardingStore';
import { useResponsive } from '../hooks/useResponsive';
import { CredentialOverlay } from './CredentialOverlay';
import { FORM_DETECT_JS } from '../store/credentialStore';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ── Types ─────────────────────────────────────────────────────────────────────
type PanelSection = 'browser' | 'ports' | 'layout';
type LogLevel = 'log' | 'info' | 'warn' | 'error';
type FilterMode = 'all' | 'error' | 'warn';

interface ConsoleEntry {
  id: number;
  level: LogLevel;
  message: string;
  timestamp: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const CONSOLE_COLLAPSED = 36;
const QUICK_PORTS = ['3000', '4200', '5173', '8080'];
const LAYOUT_QUICK_PORTS = ['3000', '5173', '8080'];

const LOG_CFG: Record<LogLevel, { color: string; icon: string }> = {
  log:   { color: colors.text,        icon: 'chevron-right' },
  info:  { color: colors.info,        icon: 'info' },
  warn:  { color: colors.warning,     icon: 'alert-triangle' },
  error: { color: colors.destructive, icon: 'alert-circle' },
};

// Colors for sections
const SECTION_ACCENT = {
  browser: colors.info,    // cyan
  ports:   '#F97316',      // orange
  layout:  '#F472B6',      // pink
} as const;

const SECTION_DEFS: { id: PanelSection; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { id: 'browser', label: 'Browser', icon: 'globe'   },
  { id: 'ports',   label: 'Ports',   icon: 'zap'     },
  { id: 'layout',  label: 'Layout',  icon: 'sidebar' },
];

const LAYOUTS: { id: SplitLayout; icon: keyof typeof Feather.glyphMap; label: string }[] = [
  { id: 'stack', icon: 'layers',  label: 'Stack' },
  { id: 'side',  icon: 'columns', label: 'Side'  },
  { id: 'tri',   icon: 'layout',  label: 'Tri'   },
];

const TRI_PANE_OPTIONS: { id: TriMainPane; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { id: 'terminal', label: 'Terminal',  icon: 'terminal' },
  { id: 'browser1', label: 'Browser 1', icon: 'globe'    },
  { id: 'browser2', label: 'Browser 2', icon: 'globe'    },
];

// ── Console intercept JS ──────────────────────────────────────────────────────
const CONSOLE_INTERCEPT_JS = `
(function() {
  var _send = function(level, args) {
    try {
      var parts = [];
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (a === null) { parts.push('null'); }
        else if (a === undefined) { parts.push('undefined'); }
        else if (typeof a === 'object') {
          try { parts.push(JSON.stringify(a, null, 2)); }
          catch(e) { parts.push(String(a)); }
        } else { parts.push(String(a)); }
      }
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: '__console__', level: level, message: parts.join(' ')
      }));
    } catch(e) {}
  };
  var _origLog = console.log, _origInfo = console.info,
      _origWarn = console.warn, _origError = console.error;
  console.log   = function() { _origLog.apply(console, arguments);   _send('log',   arguments); };
  console.info  = function() { _origInfo.apply(console, arguments);  _send('info',  arguments); };
  console.warn  = function() { _origWarn.apply(console, arguments);  _send('warn',  arguments); };
  console.error = function() { _origError.apply(console, arguments); _send('error', arguments); };
  window.onerror = function(msg, src, line, col) {
    _send('error', [msg + ' (' + (src||'') + ':' + (line||0) + ':' + (col||0) + ')']);
  };
  window.addEventListener('unhandledrejection', function(e) {
    _send('error', ['Unhandled Promise: ' + (e.reason ? (e.reason.message || e.reason) : 'unknown')]);
  });
  true;
})();
`;

// ── ConsoleRow ────────────────────────────────────────────────────────────────
const ConsoleRow = React.memo(function ConsoleRow({ entry }: { entry: ConsoleEntry }) {
  const cfg = LOG_CFG[entry.level];
  const t = new Date(entry.timestamp);
  const ts = `${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}:${t.getSeconds().toString().padStart(2,'0')}`;
  return (
    <View style={[cs.row, entry.level === 'error' && cs.rowError, entry.level === 'warn' && cs.rowWarn]}>
      <Feather name={cfg.icon as any} size={11} color={cfg.color} style={cs.rowIcon} />
      <Text style={cs.rowTime}>{ts}</Text>
      <Text style={[cs.rowMsg, { color: cfg.color }]} numberOfLines={6}>{entry.message}</Text>
    </View>
  );
});

// ── Layout Preview (mini diagrams) ────────────────────────────────────────────
function LayoutPreview({ id, active }: { id: SplitLayout; active: boolean }) {
  const c = active ? '#F472B6' : colors.textDim;
  const block = { backgroundColor: c, borderRadius: 1 };
  if (id === 'stack') return (
    <View style={lp.wrap}>
      <View style={[block, { width: 18, height: 7, marginBottom: 1.5 }]} />
      <View style={[block, { width: 18, height: 7 }]} />
    </View>
  );
  if (id === 'side') return (
    <View style={[lp.wrap, { flexDirection: 'row', gap: 1.5 }]}>
      <View style={[block, { width: 8, height: 16 }]} />
      <View style={[block, { width: 8, height: 16 }]} />
    </View>
  );
  return (
    <View style={[lp.wrap, { flexDirection: 'row', gap: 1.5 }]}>
      <View style={[block, { width: 8, height: 16 }]} />
      <View style={{ gap: 1.5 }}>
        <View style={[block, { width: 8, height: 7 }]} />
        <View style={[block, { width: 8, height: 7 }]} />
      </View>
    </View>
  );
}
const lp = StyleSheet.create({ wrap: { width: 18, height: 16, overflow: 'hidden' } });

// ── Configured Dot (neutral — only means the port is saved, not that it's live) ──
function ConfiguredDot() {
  return <View style={pd.dot} />;
}
const pd = StyleSheet.create({
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.borderStrong },
});

// ── Main Component ────────────────────────────────────────────────────────────
interface Props {
  serverHost: string;
  serverId: string;
  screenWidth?: number;
  /** When true: panel header is hidden (navigator header is used instead) */
  isFullScreen?: boolean;
  /** Called when the browser modal opens/closes */
  onBrowserOpenChange?: (isOpen: boolean) => void;
  /** Called when user wants to go back to terminal (fullscreen mode) */
  onBackToTerminal?: () => void;
  /** Open browser single view immediately on mount */
  openDirect?: boolean;
}

export function BrowserPanel({ serverHost, serverId, screenWidth = 375, isFullScreen = false, onBrowserOpenChange, onBackToTerminal, openDirect = false }: Props) {
  const { rf, rs, ri } = useResponsive();
  const { height: windowHeight } = useWindowDimensions();
  const CONSOLE_PEEK = useMemo(() => Math.round(windowHeight * 0.20), [windowHeight]); // 1/5 of screen
  const CONSOLE_HALF = useMemo(() => Math.round(windowHeight * 0.35), [windowHeight]);
  const CONSOLE_FULL = useMemo(() => Math.round(windowHeight * 0.7), [windowHeight]);

  // Refs for PanResponder to avoid stale closure over computed values
  const consolePeekRef = useRef(CONSOLE_PEEK);
  consolePeekRef.current = CONSOLE_PEEK;
  const consoleHalfRef = useRef(CONSOLE_HALF);
  consoleHalfRef.current = CONSOLE_HALF;
  const consoleFullRef = useRef(CONSOLE_FULL);
  consoleFullRef.current = CONSOLE_FULL;

  // ── Store hooks ──
  const { load, getTabs, getActive, addTab, removeTab, setActive, updateTab } = useBrowserTabsStore();
  const tabs = useBrowserTabsStore((s) => s.getTabs(serverId));
  const activeTab = useBrowserTabsStore((s) => s.getActive(serverId));

  const splitStore = useSplitViewStore();

  const pfStore = usePortForwardingStore();
  const pfEntries = usePortForwardingStore((s) => s.getEntries(serverId));

  // ── Panel state ──
  const [section, setSection] = useState<PanelSection>('browser');

  // ── Tab edit state (long-press in browser single view) ──
  const [editingTab, setEditingTab] = useState<{ id: string; port: string; path: string } | null>(null);

  // ── Modal (WebView) state ──
  const [open, setOpen] = useState(openDirect);
  const [loading, setLoading] = useState(false);
  const webviewRef = useRef<WebView>(null);
  const [reloadMenuOpen, setReloadMenuOpen] = useState(false);
  const [webviewKey, setWebviewKey] = useState(0);
  const [formDetected, setFormDetected] = useState(false);

  // ── Console state ──
  const [logs, setLogs] = useState<ConsoleEntry[]>([]);
  const [consoleHeight, setConsoleHeight] = useState(CONSOLE_COLLAPSED);
  const [filter, setFilter] = useState<FilterMode>('all');
  const logIdRef  = useRef(0);
  const listRef   = useRef<FlatList>(null);
  const heightRef = useRef(CONSOLE_COLLAPSED);

  const errorCount = useMemo(() => logs.filter((l) => l.level === 'error').length, [logs]);
  const warnCount  = useMemo(() => logs.filter((l) => l.level === 'warn').length, [logs]);
  const filteredLogs = useMemo(() =>
    filter === 'all' ? logs
    : filter === 'error' ? logs.filter((l) => l.level === 'error')
    : logs.filter((l) => l.level === 'warn'),
  [logs, filter]);
  const isConsoleOpen = consoleHeight > CONSOLE_COLLAPSED;

  // ── Load stores ──
  useEffect(() => { load(serverId); }, [serverId]);
  useEffect(() => { pfStore.load(serverId); }, [serverId]);

  const activePath = activeTab?.path ?? '';
  const pathSuffix = activePath ? (activePath.startsWith('/') ? activePath : '/' + activePath) : '';
  const configuredUrl = activeTab ? `http://${serverHost}:${activeTab.port}${pathSuffix}` : '';
  // Use persisted URL if available (resumes where user left off), otherwise configured URL
  const activeUrl = (activeTab?.lastUrl) || configuredUrl;

  // Notify parent when browser modal opens/closes
  useEffect(() => { onBrowserOpenChange?.(open); }, [open, onBrowserOpenChange]);

  // Reset console on tab switch (but DON'T force WebView remount — key changes naturally via activeTab.id)
  const prevTabRef = useRef(activeTab?.id);
  useEffect(() => {
    if (activeTab && activeTab.id !== prevTabRef.current) {
      prevTabRef.current = activeTab.id;
      if (open) { setLogs([]); logIdRef.current = 0; setFormDetected(false); }
    }
  }, [activeTab?.id, open]);

  // Reset console UI when modal closes (but keep tab URLs and sessions intact)
  useEffect(() => {
    if (!open) {
      setLogs([]);
      setConsoleHeight(CONSOLE_COLLAPSED);
      heightRef.current = CONSOLE_COLLAPSED;
      setFilter('all');
      logIdRef.current = 0;
      setFormDetected(false);
    }
  }, [open]);

  // ── Tab actions ──
  const handleAddTab = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.create(200, LayoutAnimation.Types.easeOut, LayoutAnimation.Properties.opacity));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    addTab(serverId);
  }, [serverId, addTab]);

  const handleRemoveTab = useCallback((tabId: string) => {
    if (tabs.length <= 1) return;
    LayoutAnimation.configureNext(LayoutAnimation.create(180, LayoutAnimation.Types.easeIn, LayoutAnimation.Properties.opacity));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    removeTab(serverId, tabId);
  }, [serverId, tabs.length, removeTab]);

  const handleSelectTab = useCallback((tabId: string) => {
    if (tabId === activeTab?.id) return;
    Haptics.selectionAsync();
    setActive(serverId, tabId);
  }, [serverId, activeTab?.id, setActive]);

  const handlePortChange = useCallback((port: string) => {
    if (!activeTab) return;
    // Clear lastUrl so the new port/path config takes effect on next open
    updateTab(serverId, activeTab.id, { port, lastUrl: undefined });
  }, [serverId, activeTab, updateTab]);

  // Open a specific port — finds/creates a tab and opens the modal
  const openInBrowser = useCallback((port: string, path?: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const existing = tabs.find((t) => t.port === port);
    if (existing) {
      setActive(serverId, existing.id);
      if (path !== undefined) updateTab(serverId, existing.id, { path, lastUrl: undefined });
    } else {
      addTab(serverId, port);
      // Set path on the newly created tab after a tick (tab needs to exist first)
      if (path) setTimeout(() => {
        const newTabs = useBrowserTabsStore.getState().getTabs(serverId);
        const last = newTabs[newTabs.length - 1];
        if (last) updateTab(serverId, last.id, { path });
      }, 0);
    }
    setSection('browser');
    setOpen(true);
  }, [tabs, serverId, setActive, addTab, updateTab]);

  // ── Console snap ──
  const snapTo = useCallback((target: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.create(200, LayoutAnimation.Types.easeOut, LayoutAnimation.Properties.scaleY));
    setConsoleHeight(target);
    heightRef.current = target;
  }, []);

  const toggleConsole = useCallback(() => {
    Haptics.selectionAsync();
    snapTo(isConsoleOpen ? CONSOLE_COLLAPSED : CONSOLE_HALF);
  }, [isConsoleOpen, snapTo]);

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
    onPanResponderMove: (_, g) => {
      setConsoleHeight(Math.max(CONSOLE_COLLAPSED, Math.min(consoleFullRef.current, heightRef.current - g.dy)));
    },
    onPanResponderRelease: (_, g) => {
      const raw = heightRef.current - g.dy;
      const v = g.vy;
      const peek = consolePeekRef.current;
      const half = consoleHalfRef.current;
      const full = consoleFullRef.current;
      if (v < -0.5) snapTo(raw < peek ? peek : raw < half ? half : full);
      else if (v > 0.5) snapTo(raw > half ? half : raw > peek ? peek : CONSOLE_COLLAPSED);
      else {
        const snaps = [CONSOLE_COLLAPSED, peek, half, full];
        snapTo(snaps.reduce((p, c) => Math.abs(c - raw) < Math.abs(p - raw) ? c : p));
      }
      Haptics.selectionAsync();
    },
  })).current;

  // ── WebView message ──
  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === '__console__') {
        setLogs((prev) => {
          const next = [...prev, { id: ++logIdRef.current, level: data.level as LogLevel, message: data.message, timestamp: Date.now() }];
          return next.length > 500 ? next.slice(-500) : next;
        });
        setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
      }
      if (data.type === '__form_detected__') {
        setFormDetected(true);
      }
    } catch {}
  }, []);

  const clearLogs = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setLogs([]);
  }, []);

  const copyAllLogs = useCallback(async () => {
    if (!logs.length) return;
    const text = logs.map((l) => {
      const t = new Date(l.timestamp);
      return `[${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}:${t.getSeconds().toString().padStart(2,'0')}] [${l.level.toUpperCase()}] ${l.message}`;
    }).join('\n');
    await Clipboard.setStringAsync(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [logs]);

  // ── Reload actions ──
  const handleNormalReload = useCallback(() => { setReloadMenuOpen(false); webviewRef.current?.reload(); }, []);
  const handleHardReload = useCallback(() => {
    setReloadMenuOpen(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    webviewRef.current?.clearCache?.(true);
    webviewRef.current?.reload();
  }, []);
  const handleEmptyCacheReload = useCallback(() => {
    setReloadMenuOpen(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    webviewRef.current?.injectJavaScript(`
      (function(){try{localStorage.clear()}catch(e){}try{sessionStorage.clear()}catch(e){}
      try{document.cookie.split(';').forEach(function(c){document.cookie=c.trim().split('=')[0]+'=;expires=Thu,01 Jan 1970 00:00:00 GMT;path=/'})}catch(e){}
      try{caches.keys().then(function(n){n.forEach(function(k){caches.delete(k)})})}catch(e){}true})();
    `);
    webviewRef.current?.clearCache?.(true);
    setLogs([]); logIdRef.current = 0;
    // Clear saved URL + force full remount so it starts fresh from configured URL
    if (activeTab) updateTab(serverId, activeTab.id, { lastUrl: undefined });
    setWebviewKey((k) => k + 1);
  }, [activeTab, serverId, updateTab]);

  // ── Port Forwarding actions ──
  const handleAddPortForward = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    pfStore.addEntry(serverId);
  }, [serverId]);

  const handleRemovePortForward = useCallback((id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    pfStore.removeEntry(serverId, id);
  }, [serverId]);

  // ══════════════════════════════════════════════════════════════════════════════
  // ── RENDER ──────────────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════════

  const accentColor = SECTION_ACCENT[section];

  return (
    <View style={s.container}>
      {/* ── Panel Header (hidden on full-screen — Navigator provides the header) ── */}
      {!isFullScreen && (
        <View style={[s.header, { paddingHorizontal: rs(12), paddingVertical: rs(9), gap: rs(8) }]}>
          <View style={[s.headerIcon, { backgroundColor: accentColor + '20' }]}>
            <Feather name={SECTION_DEFS.find(d => d.id === section)?.icon ?? 'globe'} size={ri(13)} color={accentColor} />
          </View>
          <Text style={[s.title, { fontSize: rf(13) }]}>Dev Browser</Text>
          <View style={{ flex: 1 }} />
          {section === 'browser' && (
            <View style={s.headerBadge}>
              <Text style={s.headerBadgeText}>{tabs.length}</Text>
            </View>
          )}
          {section === 'ports' && (
            <View style={[s.headerBadge, { backgroundColor: '#F9731620' }]}>
              <Text style={[s.headerBadgeText, { color: '#F97316' }]}>{pfEntries.length}</Text>
            </View>
          )}
          {section === 'layout' && splitStore.active && (
            <View style={[s.headerBadge, { backgroundColor: '#F472B620' }]}>
              <Text style={[s.headerBadgeText, { color: '#F472B6' }]}>ON</Text>
            </View>
          )}
        </View>
      )}

      {/* ── Section Tab Bar ── */}
      <View style={s.sectionBar}>
        {SECTION_DEFS.map((def) => {
          const isActive = section === def.id;
          const accent = SECTION_ACCENT[def.id];
          return (
            <TouchableOpacity
              key={def.id}
              style={[s.sectionTab, isActive && { backgroundColor: accent + '18', borderColor: accent }]}
              onPress={() => { Haptics.selectionAsync(); setSection(def.id); }}
              activeOpacity={0.7}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
            >
              <Feather name={def.icon} size={11} color={isActive ? accent : colors.textDim} />
              <Text style={[s.sectionTabText, isActive && { color: accent }]}>{def.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── BROWSER SECTION ── */}
      {section === 'browser' && (
        <ScrollView style={s.sectionContent} contentContainerStyle={s.sectionPad} showsVerticalScrollIndicator={false}>

          {/* Redesigned Tab Bar */}
          <View style={tb.bar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={tb.scroll}>
              {tabs.map((tab) => {
                const isActive = tab.id === activeTab?.id;
                return (
                  <TouchableOpacity
                    key={tab.id}
                    style={[tb.tab, isActive && tb.tabActive]}
                    onPress={() => handleSelectTab(tab.id)}
                    activeOpacity={0.75}
                    accessibilityRole={'tab' as any}
                    accessibilityState={{ selected: isActive }}
                  >
                    <View style={[tb.favicon, isActive && tb.faviconActive]} />
                    <Text style={[tb.port, isActive && tb.portActive]} numberOfLines={1}>:{tab.port}</Text>
                    {tabs.length > 1 && (
                      <TouchableOpacity
                        onPress={() => handleRemoveTab(tab.id)}
                        hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
                        activeOpacity={0.5}
                        accessibilityLabel="Close tab"
                        style={tb.closeBtn}
                      >
                        <Feather name="x" size={10} color={isActive ? colors.info : colors.textDim} />
                      </TouchableOpacity>
                    )}
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={tb.addBtn}
                onPress={handleAddTab}
                activeOpacity={0.7}
                accessibilityLabel="New tab"
              >
                <Feather name="plus" size={14} color={colors.info} />
              </TouchableOpacity>
            </ScrollView>
          </View>

          {/* Active tab config */}
          {activeTab && (
            <>
              {/* Quick ports */}
              <View style={s.chipRow}>
                {QUICK_PORTS.map((p) => (
                  <TouchableOpacity
                    key={p}
                    style={[s.chip, activeTab.port === p && s.chipActive]}
                    onPress={() => handlePortChange(p)}
                    activeOpacity={0.7}
                  >
                    <Text style={[s.chipText, activeTab.port === p && s.chipTextActive]}>{p}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Custom port input */}
              <View style={s.inputRow}>
                <Text style={s.inputLabel}>Port</Text>
                <TextInput
                  style={s.input}
                  value={activeTab.port}
                  onChangeText={(v) => handlePortChange(v.replace(/\D/g, ''))}
                  keyboardType="number-pad"
                  placeholder="3000"
                  placeholderTextColor={colors.textDim}
                  maxLength={5}
                  selectTextOnFocus
                />
              </View>

              {/* Path input with clear button */}
              <View style={s.inputRow}>
                <Text style={s.inputLabel}>Pfad</Text>
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
                  <TextInput
                    style={[s.input, { flex: 1 }]}
                    value={activeTab.path ?? ''}
                    onChangeText={(v) => updateTab(serverId, activeTab.id, { path: v })}
                    placeholder="/login (optional)"
                    placeholderTextColor={colors.textDim}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  {!!(activeTab.path) && (
                    <TouchableOpacity
                      onPress={() => updateTab(serverId, activeTab.id, { path: '' })}
                      style={{ paddingHorizontal: 8 }}
                      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                    >
                      <Feather name="x-circle" size={16} color={colors.textDim} />
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              {/* URL preview */}
              <Text style={s.urlPreview} numberOfLines={1}>
                {activeTab?.lastUrl ? `↩ ${activeTab.lastUrl}` : configuredUrl}
              </Text>

              {/* Open button */}
              <TouchableOpacity
                style={s.openBtn}
                onPress={() => { setOpen(true); }}
                activeOpacity={0.85}
                accessibilityLabel="Open in browser"
                accessibilityRole="button"
              >
                <Feather name="globe" size={14} color={colors.bg} />
                <Text style={s.openBtnText}>Open in Browser</Text>
                <Feather name="external-link" size={13} color={colors.bg} />
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      )}

      {/* ── PORTS SECTION ── */}
      {section === 'ports' && (
        <ScrollView style={s.sectionContent} contentContainerStyle={s.sectionPad} showsVerticalScrollIndicator={false}>
          <Text style={pf.sectionTitle}>Forwarded Ports</Text>
          <Text style={pf.sectionHint}>One tap to open in browser</Text>

          {pfEntries.length === 0 && (
            <View style={pf.empty}>
              <Feather name="zap-off" size={28} color={colors.border} />
              <Text style={pf.emptyText}>No ports configured</Text>
            </View>
          )}

          {pfEntries.map((entry) => (
            <View key={entry.id} style={pf.card}>
              {/* Delete button */}
              <TouchableOpacity
                style={pf.deleteBtn}
                onPress={() => handleRemovePortForward(entry.id)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel="Delete port"
              >
                <Feather name="x" size={11} color={colors.textDim} />
              </TouchableOpacity>

              {/* Row 1: dot + label */}
              <View style={pf.cardRow}>
                <ConfiguredDot />
                <TextInput
                  style={pf.labelInput}
                  value={entry.label}
                  onChangeText={(v) => pfStore.updateEntry(serverId, entry.id, { label: v })}
                  placeholder="Label"
                  placeholderTextColor={colors.textDim}
                  selectTextOnFocus
                  returnKeyType="done"
                />
              </View>

              {/* Row 2: port + path input */}
              <View style={pf.cardFooter}>
                <View style={pf.portBadge}>
                  <Text style={pf.portColon}>:</Text>
                  <TextInput
                    style={pf.portInput}
                    value={entry.port}
                    onChangeText={(v) => pfStore.updateEntry(serverId, entry.id, { port: v.replace(/\D/g, '') })}
                    keyboardType="number-pad"
                    maxLength={5}
                    selectTextOnFocus
                  />
                </View>
                <TextInput
                  style={pf.pathInput}
                  value={entry.path ?? ''}
                  onChangeText={(v) => pfStore.updateEntry(serverId, entry.id, { path: v })}
                  placeholder="/pfad"
                  placeholderTextColor={colors.textDim}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity
                  style={pf.openBtn}
                  onPress={() => openInBrowser(entry.port, entry.path)}
                  activeOpacity={0.8}
                  accessibilityLabel={`Open port ${entry.port}${entry.path ? entry.path : ''}`}
                >
                  <Feather name="external-link" size={13} color={colors.bg} />
                  <Text style={pf.openBtnText}>Open</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}

          <TouchableOpacity style={pf.addBtn} onPress={handleAddPortForward} activeOpacity={0.75}>
            <Feather name="plus" size={14} color="#F97316" />
            <Text style={pf.addBtnText}>Add Port</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* ── LAYOUT SECTION ── */}
      {section === 'layout' && (
        <ScrollView style={s.sectionContent} contentContainerStyle={s.sectionPad} showsVerticalScrollIndicator={false}>
          {/* Status */}
          <View style={ly.statusRow}>
            <View style={[ly.statusDot, splitStore.active && ly.statusDotActive]} />
            <Text style={ly.statusText}>{splitStore.active ? 'Split View Active' : 'Split View Inactive'}</Text>
          </View>

          {/* Layout selector */}
          <Text style={ly.label}>Layout</Text>
          <View style={ly.layoutRow}>
            {LAYOUTS.filter((l) => l.id !== 'tri' || screenWidth >= 600).map((l) => {
              const isActive = splitStore.layout === l.id;
              return (
                <TouchableOpacity
                  key={l.id}
                  style={[ly.layoutBtn, isActive && ly.layoutBtnActive]}
                  onPress={() => { Haptics.selectionAsync(); splitStore.setLayout(l.id); }}
                  activeOpacity={0.75}
                  accessibilityLabel={l.label}
                  accessibilityState={{ selected: isActive }}
                >
                  <LayoutPreview id={l.id} active={isActive} />
                  <Text style={[ly.layoutBtnText, isActive && ly.layoutBtnTextActive]}>{l.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Browser 1 port */}
          <Text style={ly.label}>{splitStore.layout === 'tri' ? 'Browser 1 Port' : 'Browser Port'}</Text>
          <View style={ly.portChips}>
            {LAYOUT_QUICK_PORTS.map((p) => (
              <TouchableOpacity
                key={p}
                style={[ly.portChip, splitStore.browserPort === p && ly.portChipActive]}
                onPress={() => splitStore.setBrowserPort(p)}
                activeOpacity={0.7}
              >
                <Text style={[ly.portChipText, splitStore.browserPort === p && ly.portChipTextActive]}>{p}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput
            style={ly.portInput}
            value={splitStore.browserPort}
            onChangeText={(v) => splitStore.setBrowserPort(v.replace(/\D/g, ''))}
            keyboardType="number-pad"
            placeholder="Custom port"
            placeholderTextColor={colors.textDim}
            maxLength={5}
          />
          <TextInput
            style={ly.portInput}
            value={splitStore.browserPath}
            onChangeText={(v) => splitStore.setBrowserPath(v)}
            placeholder="/pfad (optional)"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
          />

          {/* Browser 2 port (tri only) */}
          {splitStore.layout === 'tri' && (
            <>
              <Text style={[ly.label, { marginTop: 12 }]}>Browser 2 Port</Text>
              <View style={ly.portChips}>
                {LAYOUT_QUICK_PORTS.map((p) => (
                  <TouchableOpacity
                    key={p}
                    style={[ly.portChip, splitStore.browserPort2 === p && ly.portChipActive]}
                    onPress={() => splitStore.setBrowserPort2(p)}
                    activeOpacity={0.7}
                  >
                    <Text style={[ly.portChipText, splitStore.browserPort2 === p && ly.portChipTextActive]}>{p}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TextInput
                style={ly.portInput}
                value={splitStore.browserPort2}
                onChangeText={(v) => splitStore.setBrowserPort2(v.replace(/\D/g, ''))}
                keyboardType="number-pad"
                placeholder="Custom port 2"
                placeholderTextColor={colors.textDim}
                maxLength={5}
              />
              <TextInput
                style={ly.portInput}
                value={splitStore.browserPath2}
                onChangeText={(v) => splitStore.setBrowserPath2(v)}
                placeholder="/pfad (optional)"
                placeholderTextColor={colors.textDim}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </>
          )}

          {/* Main Pane (tri only) */}
          {splitStore.layout === 'tri' && (
            <>
              <Text style={[ly.label, { marginTop: 12 }]}>Main Pane</Text>
              {TRI_PANE_OPTIONS.map((opt) => {
                const isActive = splitStore.mainPane === opt.id;
                return (
                  <TouchableOpacity
                    key={opt.id}
                    style={[ly.paneBtn, isActive && ly.paneBtnActive]}
                    onPress={() => { Haptics.selectionAsync(); splitStore.setMainPane(opt.id); }}
                    activeOpacity={0.75}
                  >
                    <Feather name={opt.icon} size={13} color={isActive ? '#F472B6' : colors.textDim} />
                    <Text style={[ly.paneBtnText, isActive && ly.paneBtnTextActive]}>{opt.label}</Text>
                    {isActive && <View style={ly.paneDot} />}
                  </TouchableOpacity>
                );
              })}
            </>
          )}

          {/* URL previews */}
          <View style={ly.urlPreviewWrap}>
            <Text style={ly.urlPreview}>{`http://${serverHost}:${splitStore.browserPort}${splitStore.browserPath ? (splitStore.browserPath.startsWith('/') ? splitStore.browserPath : '/' + splitStore.browserPath) : ''}`}</Text>
            {splitStore.layout === 'tri' && (
              <Text style={ly.urlPreview}>{`http://${serverHost}:${splitStore.browserPort2}${splitStore.browserPath2 ? (splitStore.browserPath2.startsWith('/') ? splitStore.browserPath2 : '/' + splitStore.browserPath2) : ''}`}</Text>
            )}
          </View>

          {/* Activate/Deactivate */}
          <TouchableOpacity
            style={[ly.activateBtn, splitStore.active && ly.activateBtnOff]}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              splitStore.active ? splitStore.deactivate() : splitStore.activate(splitStore.browserPort);
            }}
            activeOpacity={0.85}
          >
            <Feather
              name={splitStore.active ? 'minimize-2' : 'maximize-2'}
              size={15}
              color={splitStore.active ? colors.destructive : colors.bg}
            />
            <Text style={[ly.activateBtnText, splitStore.active && ly.activateBtnTextOff]}>
              {splitStore.active ? 'Exit Split View' : 'Activate Split View'}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* ══ WebView Modal ══════════════════════════════════════════════════════ */}
      <Modal visible={open} animationType={isFullScreen ? 'none' : 'slide'} statusBarTranslucent onRequestClose={() => {
        if (isFullScreen && onBackToTerminal) onBackToTerminal();
        else setOpen(false);
      }}>
        <SafeAreaView style={m.modal} edges={['top']}>

          {/* Nav bar */}
          <View style={m.navBar}>
            <TouchableOpacity style={m.navBtn} onPress={() => {
              if (isFullScreen && onBackToTerminal) {
                onBackToTerminal();
              } else {
                setOpen(false);
              }
            }} activeOpacity={0.7}>
              <Feather name="terminal" size={17} color={colors.primary} />
            </TouchableOpacity>

            {/* Tab strip */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={m.tabStrip}
              contentContainerStyle={m.tabStripContent}
            >
              {tabs.map((tab) => {
                const isActive = tab.id === activeTab?.id;
                return (
                  <TouchableOpacity
                    key={tab.id}
                    style={[m.tab, isActive && m.tabActive]}
                    onPress={() => handleSelectTab(tab.id)}
                    onLongPress={() => setEditingTab({ id: tab.id, port: tab.port, path: tab.path ?? '' })}
                    delayLongPress={400}
                    activeOpacity={0.75}
                  >
                    <View style={[m.tabFavicon, isActive && m.tabFaviconActive]} />
                    <Text style={[m.tabPort, isActive && m.tabPortActive]} numberOfLines={1}>
                      :{tab.port}{tab.path ? tab.path : ''}
                    </Text>
                    {tabs.length > 1 && (
                      <TouchableOpacity
                        onPress={() => handleRemoveTab(tab.id)}
                        hitSlop={{ top: 6, bottom: 6, left: 4, right: 6 }}
                        activeOpacity={0.5}
                      >
                        <Feather name="x" size={10} color={isActive ? colors.info : colors.textDim} />
                      </TouchableOpacity>
                    )}
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity style={m.tabAddBtn} onPress={handleAddTab} activeOpacity={0.7}>
                <Feather name="plus" size={13} color={colors.textMuted} />
              </TouchableOpacity>
            </ScrollView>

            {loading
              ? <ActivityIndicator size="small" color={colors.info} style={m.navBtn} />
              : (
                <TouchableOpacity
                  style={m.navBtn}
                  onPress={() => webviewRef.current?.reload()}
                  onLongPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); setReloadMenuOpen(true); }}
                  delayLongPress={350}
                  activeOpacity={0.7}
                >
                  <Feather name="refresh-cw" size={16} color={colors.text} />
                </TouchableOpacity>
              )
            }

            <CredentialOverlay
              serverId={serverId}
              currentUrl={activeUrl}
              webviewRef={webviewRef}
              variant="header"
              formDetected={formDetected}
            />

            <TouchableOpacity style={m.navBtn} onPress={toggleConsole} activeOpacity={0.7}>
              <Feather name="terminal" size={16} color={isConsoleOpen ? colors.info : colors.textMuted} />
              {errorCount > 0 && !isConsoleOpen && (
                <View style={cs.badge}><Text style={cs.badgeText}>{errorCount > 9 ? '9+' : errorCount}</Text></View>
              )}
            </TouchableOpacity>
          </View>

          {/* WebView + Console */}
          <View style={{ flex: 1 }}>
              <WebView
                key={`${activeTab?.id}-${webviewKey}`}
                ref={webviewRef}
                source={{ uri: activeUrl }}
                style={[m.webview, { flex: 1 }]}
                onLoadStart={() => setLoading(true)}
                onLoadEnd={() => setLoading(false)}
                onMessage={handleMessage}
                onNavigationStateChange={(navState) => {
                  // Persist the current URL so the tab resumes here on next open
                  if (!navState.loading && activeTab && navState.url && !navState.url.startsWith('about:')) {
                    updateTab(serverId, activeTab.id, { lastUrl: navState.url });
                  }
                }}
                injectedJavaScript={CONSOLE_INTERCEPT_JS + '\n' + FORM_DETECT_JS}
                allowsInlineMediaPlayback
                mediaPlaybackRequiresUserAction={false}
                mixedContentMode="always"
                sharedCookiesEnabled
                thirdPartyCookiesEnabled
              />

            {/* Console panel */}
            <View style={[cs.panel, { height: consoleHeight }]}>
              <View {...panResponder.panHandlers} style={cs.dragZone}>
                <View style={cs.dragHandle} />
              </View>
              <View style={cs.headerRow}>
                <TouchableOpacity style={cs.headerToggle} onPress={toggleConsole} activeOpacity={0.7} hitSlop={{ top: 8, bottom: 8 }}>
                  <Feather name="terminal" size={12} color={colors.info} />
                  <Text style={cs.headerTitle}>Console</Text>
                  {logs.length > 0 && <Text style={cs.headerCount}>{logs.length}</Text>}
                </TouchableOpacity>
                {isConsoleOpen && (
                  <View style={cs.filters}>
                    <TouchableOpacity style={[cs.filterTab, filter === 'all' && cs.filterTabActive]} onPress={() => setFilter('all')} activeOpacity={0.7}>
                      <Text style={[cs.filterText, filter === 'all' && cs.filterTextActive]}>All</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[cs.filterTab, filter === 'error' && cs.filterTabError]} onPress={() => setFilter('error')} activeOpacity={0.7}>
                      <Feather name="alert-circle" size={10} color={filter === 'error' ? colors.destructive : colors.textDim} />
                      {errorCount > 0 && <Text style={[cs.filterText, filter === 'error' && { color: colors.destructive }]}>{errorCount}</Text>}
                    </TouchableOpacity>
                    <TouchableOpacity style={[cs.filterTab, filter === 'warn' && cs.filterTabWarn]} onPress={() => setFilter('warn')} activeOpacity={0.7}>
                      <Feather name="alert-triangle" size={10} color={filter === 'warn' ? colors.warning : colors.textDim} />
                      {warnCount > 0 && <Text style={[cs.filterText, filter === 'warn' && { color: colors.warning }]}>{warnCount}</Text>}
                    </TouchableOpacity>
                  </View>
                )}
                {isConsoleOpen && logs.length > 0 && (
                  <View style={cs.actions}>
                    <TouchableOpacity style={cs.actionBtn} onPress={copyAllLogs} activeOpacity={0.7} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
                      <Feather name="copy" size={13} color={colors.textDim} />
                    </TouchableOpacity>
                    <TouchableOpacity style={cs.actionBtn} onPress={clearLogs} activeOpacity={0.7} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
                      <Feather name="trash-2" size={13} color={colors.textDim} />
                    </TouchableOpacity>
                  </View>
                )}
              </View>
              {isConsoleOpen && (
                <FlatList
                  ref={listRef}
                  data={filteredLogs}
                  keyExtractor={(i) => String(i.id)}
                  style={cs.list}
                  contentContainerStyle={cs.listContent}
                  renderItem={({ item }) => <ConsoleRow entry={item} />}
                  keyboardShouldPersistTaps="handled"
                  ListEmptyComponent={
                    <View style={cs.empty}>
                      <Feather name="terminal" size={24} color={colors.border} />
                      <Text style={cs.emptyText}>No console output</Text>
                    </View>
                  }
                />
              )}
            </View>
          </View>

          {/* Reload Menu */}
          <Modal visible={reloadMenuOpen} transparent animationType="fade" onRequestClose={() => setReloadMenuOpen(false)}>
            <Pressable style={rm.overlay} onPress={() => setReloadMenuOpen(false)}>
              <View style={rm.sheet}>
                <Text style={rm.title}>Reload Options</Text>
                <TouchableOpacity style={rm.option} onPress={handleNormalReload} activeOpacity={0.7}>
                  <Feather name="refresh-cw" size={18} color={colors.text} />
                  <View style={rm.optionText}><Text style={rm.optionLabel}>Normal Reload</Text><Text style={rm.optionHint}>Reload the page</Text></View>
                </TouchableOpacity>
                <View style={rm.divider} />
                <TouchableOpacity style={rm.option} onPress={handleHardReload} activeOpacity={0.7}>
                  <Feather name="zap" size={18} color={colors.warning} />
                  <View style={rm.optionText}><Text style={rm.optionLabel}>Hard Reload</Text><Text style={rm.optionHint}>Clear HTTP cache, then reload</Text></View>
                </TouchableOpacity>
                <View style={rm.divider} />
                <TouchableOpacity style={rm.option} onPress={handleEmptyCacheReload} activeOpacity={0.7}>
                  <Feather name="trash" size={18} color={colors.destructive} />
                  <View style={rm.optionText}><Text style={[rm.optionLabel, { color: colors.destructive }]}>Empty Cache & Reload</Text><Text style={rm.optionHint}>Clear cache, cookies, localStorage</Text></View>
                </TouchableOpacity>
                <View style={rm.divider} />
                <TouchableOpacity style={rm.cancel} onPress={() => setReloadMenuOpen(false)} activeOpacity={0.7}>
                  <Text style={rm.cancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Modal>
        </SafeAreaView>
      </Modal>

      {/* ══ Tab Edit Modal ═══════════════════════════════════════════════════ */}
      <Modal visible={!!editingTab} transparent animationType="fade" onRequestClose={() => setEditingTab(null)}>
        <Pressable style={te.overlay} onPress={() => setEditingTab(null)}>
          <View style={te.card} onStartShouldSetResponder={() => true}>
            <Text style={te.title}>Tab bearbeiten</Text>

            <Text style={te.label}>Port</Text>
            <TextInput
              style={te.input}
              value={editingTab?.port ?? ''}
              onChangeText={(v) => setEditingTab((prev) => prev ? { ...prev, port: v.replace(/\D/g, '') } : null)}
              keyboardType="number-pad"
              maxLength={5}
              selectTextOnFocus
              placeholder="3000"
              placeholderTextColor={colors.textDim}
            />

            <Text style={te.label}>URL-Pfad</Text>
            <TextInput
              style={te.input}
              value={editingTab?.path ?? ''}
              onChangeText={(v) => setEditingTab((prev) => prev ? { ...prev, path: v } : null)}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="/login (optional)"
              placeholderTextColor={colors.textDim}
            />

            <View style={te.buttons}>
              <TouchableOpacity style={te.cancelBtn} onPress={() => setEditingTab(null)} activeOpacity={0.7}>
                <Text style={te.cancelText}>Abbrechen</Text>
              </TouchableOpacity>
              <TouchableOpacity style={te.saveBtn} onPress={() => {
                if (editingTab) {
                  updateTab(serverId, editingTab.id, { port: editingTab.port, path: editingTab.path, lastUrl: undefined });
                  setWebviewKey((k) => k + 1); // force reload with new URL
                }
                setEditingTab(null);
              }} activeOpacity={0.7}>
                <Text style={te.saveText}>Speichern</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Styles ───────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// Tab edit modal styles
const te = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 320, backgroundColor: colors.surface, borderRadius: 14, padding: 20, borderWidth: 1, borderColor: colors.border },
  title: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 16, textAlign: 'center' },
  label: { color: colors.textMuted, fontSize: 12, fontWeight: '500', marginBottom: 6, marginTop: 10 },
  input: { backgroundColor: colors.bg, borderRadius: 8, padding: 12, color: colors.text, fontSize: 14, fontFamily: fonts.mono, borderWidth: 1, borderColor: colors.border },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 20 },
  cancelBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center', backgroundColor: colors.border },
  cancelText: { color: colors.textDim, fontSize: 14, fontWeight: '500' },
  saveBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center', backgroundColor: colors.primary },
  saveText: { color: colors.text, fontSize: 14, fontWeight: '600' },
});

// Panel styles
const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
    paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: 'rgba(51,65,85,0.7)', gap: 8,
  },
  headerIcon: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontSize: 13, fontWeight: '700', letterSpacing: 0.3 },
  headerBadge: {
    backgroundColor: 'rgba(6,182,212,0.15)', borderRadius: 10,
    paddingHorizontal: 7, paddingVertical: 2, minWidth: 24, alignItems: 'center',
  },
  headerBadgeText: { color: colors.info, fontSize: 10, fontWeight: '700', fontFamily: fonts.mono },

  // Section tab bar
  sectionBar: {
    flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border,
    paddingHorizontal: 8, paddingVertical: 6, gap: 4,
  },
  sectionTab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingVertical: 6, borderRadius: 8,
    borderWidth: 1, borderColor: 'transparent',
  },
  sectionTabText: { color: colors.textDim, fontSize: 11, fontWeight: '600', letterSpacing: 0.2 },

  // Section content
  sectionContent: { flex: 1 },
  sectionPad: { padding: 10, paddingBottom: 24 },

  // Quick ports
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: 8 },
  chip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 7,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  chipActive: { backgroundColor: 'rgba(6,182,212,0.15)', borderColor: colors.info },
  chipText: { color: colors.textDim, fontSize: 11, fontFamily: fonts.mono, fontWeight: '600' },
  chipTextActive: { color: colors.info },

  // Port input row
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  inputLabel: { color: colors.textDim, fontSize: 11, fontWeight: '600', width: 28 },
  input: {
    flex: 1, height: 34, backgroundColor: colors.surface, borderWidth: 1,
    borderColor: colors.borderStrong, borderRadius: 8, color: colors.text,
    fontSize: 13, fontFamily: fonts.mono, paddingHorizontal: 10,
  },

  // URL preview
  urlPreview: { color: colors.textDim, fontSize: 10, fontFamily: fonts.mono, marginBottom: 10, opacity: 0.7 },

  // Open button
  openBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, backgroundColor: colors.info, borderRadius: 10,
    paddingVertical: 10, marginTop: 2,
    shadowColor: colors.info, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 6,
    elevation: 4,
  },
  openBtnText: { color: colors.bg, fontWeight: '700', fontSize: 13, letterSpacing: 0.2 },
});

// Tab bar styles
const tb = StyleSheet.create({
  bar: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 10,
    backgroundColor: colors.surface, overflow: 'hidden', marginBottom: 10,
  },
  scroll: { paddingHorizontal: 6, paddingVertical: 6, gap: 4, alignItems: 'center' },

  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 9, paddingVertical: 6, borderRadius: 7,
    borderWidth: 1, borderColor: 'transparent',
    // Fixed width prevents tabs stretching to fill the scroll container
    width: 92,
  },
  tabActive: {
    backgroundColor: 'rgba(6,182,212,0.12)',
    borderColor: colors.info,
  },
  favicon: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.textDim, flexShrink: 0 },
  faviconActive: { backgroundColor: colors.info },
  // No flex:1 — let the tab have fixed width
  port: { color: colors.textMuted, fontSize: 11, fontFamily: fonts.mono, fontWeight: '600', flexShrink: 1 },
  portActive: { color: colors.info },
  closeBtn: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },

  addBtn: {
    width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(6,182,212,0.08)',
  },
});

// Port forwarding styles
const pf = StyleSheet.create({
  sectionTitle: { color: colors.text, fontSize: 12, fontWeight: '700', letterSpacing: 0.3, marginBottom: 2 },
  sectionHint: { color: colors.textDim, fontSize: 10, marginBottom: 10 },

  empty: { alignItems: 'center', paddingVertical: 28, gap: 8 },
  emptyText: { color: colors.textDim, fontSize: 11 },

  card: {
    backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1,
    borderColor: colors.border, padding: 10, marginBottom: 8, position: 'relative',
  },
  deleteBtn: {
    position: 'absolute', top: 6, right: 6, width: 22, height: 22,
    alignItems: 'center', justifyContent: 'center', zIndex: 1,
    backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 6,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, paddingRight: 28 },
  labelInput: {
    flex: 1, color: colors.text, fontSize: 12, fontWeight: '600',
    paddingVertical: 2, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  portBadge: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(6,182,212,0.1)', borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: 'rgba(6,182,212,0.25)',
  },
  portColon: { color: colors.info, fontSize: 12, fontFamily: fonts.mono, fontWeight: '700' },
  portInput: { color: colors.info, fontSize: 12, fontFamily: fonts.mono, fontWeight: '700', minWidth: 36, maxWidth: 52 },
  pathInput: { flex: 1, color: colors.textMuted, fontSize: 11, fontFamily: fonts.mono, marginLeft: 6, paddingVertical: 2 },
  openBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#F97316', borderRadius: 7,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  openBtnText: { color: colors.bg, fontSize: 11, fontWeight: '700' },

  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: 4, paddingVertical: 10, borderRadius: 9,
    borderWidth: 1, borderColor: '#F9731640', borderStyle: 'dashed',
  },
  addBtnText: { color: '#F97316', fontSize: 12, fontWeight: '600' },
});

// Layout section styles
const ly = StyleSheet.create({
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textDim },
  statusDotActive: { backgroundColor: '#22C55E' },
  statusText: { color: colors.textMuted, fontSize: 12, fontWeight: '500' },

  label: { color: colors.textDim, fontSize: 10, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 },

  layoutRow: { flexDirection: 'row', gap: 6, marginBottom: 14 },
  layoutBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 9,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 6,
  },
  layoutBtnActive: { backgroundColor: 'rgba(244,114,182,0.08)', borderColor: '#F472B6' },
  layoutBtnText: { color: colors.textDim, fontSize: 10, fontWeight: '600' },
  layoutBtnTextActive: { color: '#F472B6' },

  portChips: { flexDirection: 'row', gap: 5, marginBottom: 6 },
  portChip: {
    flex: 1, paddingVertical: 6, borderRadius: 7, alignItems: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  portChipActive: { backgroundColor: 'rgba(244,114,182,0.12)', borderColor: '#F472B6' },
  portChipText: { color: colors.textDim, fontSize: 11, fontFamily: fonts.mono, fontWeight: '600' },
  portChipTextActive: { color: '#F472B6' },
  portInput: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: 8, color: colors.text, fontSize: 12, fontFamily: fonts.mono,
    paddingHorizontal: 10, paddingVertical: 7, marginBottom: 4,
  },

  paneBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 8, paddingHorizontal: 10, borderRadius: 7, marginBottom: 4,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  paneBtnActive: { backgroundColor: 'rgba(244,114,182,0.08)', borderColor: '#F472B6' },
  paneBtnText: { color: colors.textMuted, fontSize: 12, fontWeight: '500', flex: 1 },
  paneBtnTextActive: { color: '#F472B6' },
  paneDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#F472B6' },

  urlPreviewWrap: { gap: 2, marginTop: 10, marginBottom: 14 },
  urlPreview: { color: colors.textDim, fontSize: 9.5, fontFamily: fonts.mono },

  activateBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 11, borderRadius: 10, backgroundColor: '#F472B6',
    shadowColor: '#F472B6', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 5,
    elevation: 3,
  },
  activateBtnOff: {
    backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.destructive,
    shadowOpacity: 0, elevation: 0,
  },
  activateBtnText: { color: colors.bg, fontWeight: '700', fontSize: 13 },
  activateBtnTextOff: { color: colors.destructive },
});

// Console styles
const cs = StyleSheet.create({
  panel: { backgroundColor: colors.bg, borderTopWidth: 1, borderTopColor: colors.border, overflow: 'hidden' },
  dragZone: { height: 16, alignItems: 'center', justifyContent: 'center' },
  dragHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong },
  headerRow: { flexDirection: 'row', alignItems: 'center', height: 20, paddingHorizontal: 8, gap: 6 },
  headerToggle: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 2 },
  headerTitle: { color: colors.textMuted, fontSize: 11, fontWeight: '700', fontFamily: fonts.mono, letterSpacing: 0.3 },
  headerCount: { color: colors.textDim, fontSize: 10, fontFamily: fonts.mono, marginLeft: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  actionBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  filters: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: 8 },
  filterTab: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  filterTabActive: { backgroundColor: 'rgba(59,130,246,0.12)' },
  filterTabError: { backgroundColor: 'rgba(239,68,68,0.12)' },
  filterTabWarn: { backgroundColor: 'rgba(245,158,11,0.12)' },
  filterText: { color: colors.textDim, fontSize: 10, fontWeight: '600', fontFamily: fonts.mono },
  filterTextActive: { color: colors.primary },
  list: { flex: 1 },
  listContent: { paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 8, paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(51,65,85,0.3)', gap: 6 },
  rowError: { backgroundColor: 'rgba(239,68,68,0.06)' },
  rowWarn: { backgroundColor: 'rgba(245,158,11,0.04)' },
  rowIcon: { marginTop: 2 },
  rowTime: { color: colors.textDim, fontSize: 9, fontFamily: fonts.mono, marginTop: 1, minWidth: 48 },
  rowMsg: { flex: 1, fontSize: 10.5, fontFamily: fonts.mono, lineHeight: 15 },
  badge: { position: 'absolute', top: 4, right: 4, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: colors.destructive, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  badgeText: { color: '#fff', fontSize: 9, fontWeight: '800', fontFamily: fonts.mono },
  empty: { alignItems: 'center', paddingTop: 24, gap: 8 },
  emptyText: { color: colors.textDim, fontSize: 11, fontFamily: fonts.mono },
});

// Modal styles
const m = StyleSheet.create({
  modal: { flex: 1, backgroundColor: colors.bg },
  navBar: {
    flexDirection: 'row', alignItems: 'center', height: 46,
    backgroundColor: colors.surfaceAlt, borderBottomWidth: 1,
    borderBottomColor: colors.border, paddingHorizontal: 2,
  },
  navBtn: { width: 38, height: 44, alignItems: 'center', justifyContent: 'center' },
  tabStrip: { flex: 1 },
  tabStripContent: { alignItems: 'center', gap: 3, paddingHorizontal: 3 },

  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 9, paddingVertical: 5, borderRadius: 7,
    borderWidth: 1, borderColor: 'transparent',
    width: 88, // fixed width — prevents single tab stretching to fill bar
  },
  tabActive: { backgroundColor: 'rgba(6,182,212,0.12)', borderColor: 'rgba(6,182,212,0.4)' },
  tabFavicon: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.textDim, flexShrink: 0 },
  tabFaviconActive: { backgroundColor: colors.info },
  tabPort: { color: colors.textDim, fontSize: 11, fontFamily: fonts.mono, fontWeight: '600', flexShrink: 1 },
  tabPortActive: { color: colors.info },
  tabAddBtn: {
    width: 28, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface,
  },

  webview: { flex: 1, backgroundColor: '#ffffff' },
});

// Reload menu styles
const rm = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18,
    paddingTop: 16, paddingBottom: Platform.OS === 'ios' ? 34 : 16, paddingHorizontal: 16,
  },
  title: { color: colors.textMuted, fontSize: 11, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 12, paddingHorizontal: 4 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 4 },
  optionText: { flex: 1, gap: 2 },
  optionLabel: { color: colors.text, fontSize: 15, fontWeight: '500' },
  optionHint: { color: colors.textDim, fontSize: 12 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  cancel: { marginTop: 8, paddingVertical: 14, alignItems: 'center', backgroundColor: colors.surfaceAlt, borderRadius: 10 },
  cancelText: { color: colors.textMuted, fontSize: 15, fontWeight: '600' },
});
