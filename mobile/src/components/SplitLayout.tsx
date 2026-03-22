import React, { useRef, useState, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fonts } from '../theme';
import { useSplitViewStore, TriMainPane } from '../store/splitViewStore';
import { useResponsive } from '../hooks/useResponsive';
import { CredentialOverlay } from './CredentialOverlay';
import { FORM_DETECT_JS } from '../store/credentialStore';
import { useCookieIsolation } from '../hooks/useCookieIsolation';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const SPRING = LayoutAnimation.create(280, LayoutAnimation.Types.easeOut, LayoutAnimation.Properties.scaleXY);

// ── Pane Header ──────────────────────────────────────────────────────────────
interface PaneHeaderProps {
  label: string;
  icon: string;
  isMain: boolean;
  canPromote: boolean;
  onPromote: () => void;
  onClose: () => void;
}

function PaneHeader({ label, icon, isMain, canPromote, onPromote, onClose }: PaneHeaderProps) {
  const { rf, rs, ri } = useResponsive();
  const dynamicStyles = useMemo(() => ({
    bar: { height: rs(28), paddingHorizontal: rs(8), gap: rs(6) },
    label: { fontSize: rf(10) },
    mainDot: { width: rs(5), height: rs(5), borderRadius: rs(3) },
    btn: { width: rs(28), height: rs(28) },
  }), [rf, rs]);

  return (
    <View style={[ph.bar, dynamicStyles.bar]}>
      <Feather name={icon as any} size={ri(12)} color={isMain ? '#F472B6' : colors.textDim} />
      <Text style={[ph.label, dynamicStyles.label, isMain && ph.labelMain]} numberOfLines={1}>{label}</Text>
      {isMain && <View style={[ph.mainDot, dynamicStyles.mainDot]} />}
      <View style={{ flex: 1 }} />
      {canPromote && (
        <TouchableOpacity
          style={[ph.btn, dynamicStyles.btn]}
          onPress={() => {
            Haptics.selectionAsync();
            LayoutAnimation.configureNext(SPRING);
            onPromote();
          }}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="Make main pane"
        >
          <Feather name="maximize-2" size={ri(12)} color={colors.textMuted} />
        </TouchableOpacity>
      )}
      <TouchableOpacity
        style={[ph.btn, dynamicStyles.btn]}
        onPress={onClose}
        activeOpacity={0.7}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityLabel="Exit split view"
      >
        <Feather name="x" size={ri(14)} color={colors.textDim} />
      </TouchableOpacity>
    </View>
  );
}

const ph = StyleSheet.create({
  bar: {
    height: 28, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 6,
    backgroundColor: colors.surfaceAlt, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  label: { color: colors.textDim, fontSize: 10, fontWeight: '700', fontFamily: fonts.mono, letterSpacing: 0.5, textTransform: 'uppercase', maxWidth: 120 },
  labelMain: { color: '#F472B6' },
  mainDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#F472B6' },
  btn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
});

// ── Divider with swap ────────────────────────────────────────────────────────
function SplitDivider({ horizontal, onSwap }: { horizontal: boolean; onSwap: () => void }) {
  const { rs, ri } = useResponsive();
  const dynamicStyles = useMemo(() => ({
    h: { height: rs(6) },
    v: { width: rs(6) },
    handle: { width: rs(24), height: rs(24), borderRadius: rs(12) },
  }), [rs]);

  return (
    <View style={[dv.base, horizontal ? [dv.h, dynamicStyles.h] : [dv.v, dynamicStyles.v]]}>
      <TouchableOpacity
        style={[dv.handle, dynamicStyles.handle]}
        onPress={() => { Haptics.selectionAsync(); LayoutAnimation.configureNext(SPRING); onSwap(); }}
        activeOpacity={0.7}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityLabel="Swap panes"
      >
        <Feather name="repeat" size={ri(10)} color={colors.textDim} />
      </TouchableOpacity>
    </View>
  );
}

const dv = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  h: { height: 6, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  v: { width: 6, borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  handle: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: colors.surfaceAlt,
    borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center',
    position: 'absolute', zIndex: 10,
  },
});

// ── Console intercept JS (injected into browser WebViews) ────────────────────
const SPLIT_CONSOLE_JS = `
(function(){
  var _post = window.ReactNativeWebView && window.ReactNativeWebView.postMessage.bind(window.ReactNativeWebView);
  if (!_post) return;
  ['log','warn','error','info','debug'].forEach(function(level){
    var orig = console[level];
    console[level] = function(){
      try {
        var args = Array.prototype.slice.call(arguments);
        var msg = args.map(function(a){ return typeof a === 'object' ? JSON.stringify(a) : String(a); }).join(' ');
        _post(JSON.stringify({ type: '__console__', level: level === 'debug' ? 'log' : level, message: msg }));
      } catch(e){}
      orig.apply(console, arguments);
    };
  });
  window.onerror = function(m){ _post(JSON.stringify({ type: '__console__', level: 'error', message: String(m) })); };
})(); true;`;

type MiniLogEntry = { id: number; level: string; message: string };

// ── Browser Pane with mini console ───────────────────────────────────────────
function BrowserPane({ url, serverId, browserKey }: { url: string; serverId: string; browserKey: string }) {
  useCookieIsolation(browserKey, true);
  const [logs, setLogs] = useState<MiniLogEntry[]>([]);
  const [showConsole, setShowConsole] = useState(false);
  const [formDetected, setFormDetected] = useState(false);
  const logId = useRef(0);
  const listRef = useRef<FlatList>(null);
  const webviewRef = useRef<WebView>(null);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === '__console__') {
        setLogs((prev) => {
          const next = [...prev, { id: ++logId.current, level: data.level, message: data.message }];
          return next.length > 200 ? next.slice(-200) : next;
        });
        setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 30);
      }
      if (data.type === '__form_detected__') {
        setFormDetected(true);
      }
    } catch {}
  }, []);

  const errorCount = useMemo(() => logs.filter((l) => l.level === 'error').length, [logs]);
  const warnCount = useMemo(() => logs.filter((l) => l.level === 'warn').length, [logs]);
  const hasIssues = errorCount > 0 || warnCount > 0;

  return (
    <View style={sl.browser}>
        <WebView
          ref={webviewRef}
          source={{ uri: url }}
          style={{ flex: 1 }}
          allowsInlineMediaPlayback
          mixedContentMode="always"
          onMessage={handleMessage}
          injectedJavaScript={SPLIT_CONSOLE_JS + '\n' + FORM_DETECT_JS}
        />

      {/* Credential Overlay */}
      <CredentialOverlay serverId={serverId} currentUrl={url} webviewRef={webviewRef} formDetected={formDetected} />

      {/* Mini console toggle pill */}
      <TouchableOpacity
        style={[mc.pill, hasIssues && mc.pillAlert]}
        onPress={() => setShowConsole((v) => !v)}
        activeOpacity={0.7}
      >
        <Feather name="terminal" size={10} color={showConsole ? colors.info : colors.textDim} />
        {errorCount > 0 && <Text style={mc.errBadge}>{errorCount}</Text>}
        {warnCount > 0 && <Text style={mc.warnBadge}>{warnCount}</Text>}
        <Text style={mc.logCount}>{logs.length}</Text>
        <Feather name={showConsole ? 'chevron-down' : 'chevron-up'} size={9} color={colors.textDim} />
      </TouchableOpacity>

      {/* Mini console log list */}
      {showConsole && (
        <View style={mc.panel}>
          <FlatList
            ref={listRef}
            data={logs}
            keyExtractor={(item) => String(item.id)}
            renderItem={({ item }) => (
              <Text
                style={[mc.line, item.level === 'error' ? mc.lineErr : item.level === 'warn' ? mc.lineWarn : null]}
                numberOfLines={2}
              >
                {item.message}
              </Text>
            )}
            showsVerticalScrollIndicator={false}
          />
          <TouchableOpacity style={mc.clearBtn} onPress={() => setLogs([])} activeOpacity={0.7}>
            <Feather name="trash-2" size={10} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ── Mini console styles ──────────────────────────────────────────────────────
const mc = StyleSheet.create({
  pill: {
    position: 'absolute', bottom: 4, right: 4, flexDirection: 'row', alignItems: 'center',
    gap: 4, backgroundColor: colors.surface + 'E0', borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 3, borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  pillAlert: { borderColor: colors.destructive + '60' },
  errBadge: { fontSize: 9, fontWeight: '700', color: colors.destructive },
  warnBadge: { fontSize: 9, fontWeight: '700', color: colors.warning },
  logCount: { fontSize: 9, color: colors.textDim, fontFamily: fonts.mono },
  panel: {
    position: 'absolute', bottom: 24, left: 0, right: 0, height: '35%',
    backgroundColor: colors.bg + 'F0', borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  line: { fontSize: 9, color: colors.textMuted, fontFamily: fonts.mono, paddingHorizontal: 6, paddingVertical: 1 },
  lineErr: { color: colors.destructive },
  lineWarn: { color: colors.warning },
  clearBtn: {
    position: 'absolute', top: 4, right: 4, padding: 4, borderRadius: 6,
    backgroundColor: colors.surface,
  },
});

// ── Main Component ───────────────────────────────────────────────────────────
interface Props {
  serverHost: string;
  serverId: string;
  terminalTabId: string;
  terminalContent: React.ReactNode;
}

export function SplitLayout({ serverHost, serverId, terminalTabId, terminalContent }: Props) {
  const { layout, mainPane, browserPort, browserPort2, browserPath, browserPath2, setMainPane, cycleMain, deactivate } = useSplitViewStore();
  const [swapped, setSwapped] = useState(false);

  // Browser panes point to local dev servers running on the remote host.
  const pathSuffix1 = browserPath ? (browserPath.startsWith('/') ? browserPath : '/' + browserPath) : '';
  const pathSuffix2 = browserPath2 ? (browserPath2.startsWith('/') ? browserPath2 : '/' + browserPath2) : '';
  const url1 = `http://${serverHost}:${browserPort}${pathSuffix1}`;
  const url2 = `http://${serverHost}:${browserPort2}${pathSuffix2}`;

  // Cookie isolation keys — one per split browser pane, shared across terminals
  const browserKey1 = `${serverId}:split1`;
  const browserKey2 = `${serverId}:split2`;

  const handleClose = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    LayoutAnimation.configureNext(LayoutAnimation.create(200, LayoutAnimation.Types.easeIn, LayoutAnimation.Properties.opacity));
    deactivate();
  }, [deactivate]);

  // ── Tri-Split: Terminal + Browser1 + Browser2 ──
  if (layout === 'tri') {
    // Build the 3 panes
    const panes: { id: TriMainPane; label: string; icon: string; content: React.ReactNode }[] = [
      { id: 'terminal', label: 'Terminal', icon: 'terminal', content: <View style={sl.paneContent}>{terminalContent}</View> },
      { id: 'browser1', label: `:${browserPort}`, icon: 'globe', content: <BrowserPane url={url1} serverId={serverId} browserKey={browserKey1} /> },
      { id: 'browser2', label: `:${browserPort2}`, icon: 'globe', content: <BrowserPane url={url2} serverId={serverId} browserKey={browserKey2} /> },
    ];

    const mainPaneData = panes.find((p) => p.id === mainPane) ?? panes[0];
    const secondaryPanes = panes.filter((p) => p.id !== mainPane);

    return (
      <View style={[sl.container, { flexDirection: 'row' }]}>
        {/* Left pane — full height, 50% width */}
        <View style={sl.pane}>
          <PaneHeader
            label={mainPaneData.label}
            icon={mainPaneData.icon}
            isMain
            canPromote={false}
            onPromote={() => {}}
            onClose={handleClose}
          />
          {mainPaneData.content}
        </View>

        <SplitDivider horizontal={false} onSwap={cycleMain} />

        {/* Right column — two panes stacked vertically, 50% width */}
        <View style={sl.pane}>
          {/* Top-right pane */}
          <View style={sl.pane}>
            <PaneHeader
              label={secondaryPanes[0].label}
              icon={secondaryPanes[0].icon}
              isMain={false}
              canPromote
              onPromote={() => { LayoutAnimation.configureNext(SPRING); setMainPane(secondaryPanes[0].id); }}
              onClose={handleClose}
            />
            {secondaryPanes[0].content}
          </View>

          <SplitDivider horizontal onSwap={() => { LayoutAnimation.configureNext(SPRING); setMainPane(secondaryPanes[1].id); }} />

          {/* Bottom-right pane */}
          <View style={sl.pane}>
            <PaneHeader
              label={secondaryPanes[1].label}
              icon={secondaryPanes[1].icon}
              isMain={false}
              canPromote
              onPromote={() => { LayoutAnimation.configureNext(SPRING); setMainPane(secondaryPanes[1].id); }}
              onClose={handleClose}
            />
            {secondaryPanes[1].content}
          </View>
        </View>
      </View>
    );
  }

  // ── Stack (vertical) or Side (horizontal): Terminal + Browser1 ──
  const isStack = layout === 'stack';

  const termPane = (
    <View style={sl.pane}>
      <PaneHeader label="Terminal" icon="terminal" isMain={false} canPromote={false} onPromote={() => {}} onClose={handleClose} />
      <View style={sl.paneContent}>{terminalContent}</View>
    </View>
  );

  const browserPaneEl = (
    <View style={sl.pane}>
      <PaneHeader label={`:${browserPort}`} icon="globe" isMain={false} canPromote={false} onPromote={() => {}} onClose={handleClose} />
      <BrowserPane url={url1} serverId={serverId} browserKey={browserKey1} />
    </View>
  );

  const first = swapped ? browserPaneEl : termPane;
  const second = swapped ? termPane : browserPaneEl;

  return (
    <View style={[sl.container, { flexDirection: isStack ? 'column' : 'row' }]}>
      {first}
      <SplitDivider
        horizontal={isStack}
        onSwap={() => {
          LayoutAnimation.configureNext(SPRING);
          setSwapped((v) => !v);
        }}
      />
      {second}
    </View>
  );
}

const sl = StyleSheet.create({
  container: { flex: 1 },
  pane: { flex: 1, overflow: 'hidden' },
  paneContent: { flex: 1, position: 'relative' },
  browser: { flex: 1, backgroundColor: '#ffffff' },
});
