import React, { useRef, useState, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fonts } from '../theme';
import { useSplitViewStore, TriMainPane } from '../store/splitViewStore';
import { useResponsive } from '../hooks/useResponsive';

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

// ── Browser Pane ─────────────────────────────────────────────────────────────
function BrowserPane({ url }: { url: string }) {
  return (
    <WebView
      source={{ uri: url }}
      style={sl.browser}
      allowsInlineMediaPlayback
      mixedContentMode="always"
    />
  );
}

// ── Main Component ───────────────────────────────────────────────────────────
interface Props {
  serverHost: string;
  terminalContent: React.ReactNode;
}

export function SplitLayout({ serverHost, terminalContent }: Props) {
  const { layout, mainPane, browserPort, browserPort2, setMainPane, cycleMain, deactivate } = useSplitViewStore();
  const [swapped, setSwapped] = useState(false);

  // Browser panes point to local dev servers running on the remote host.
  // HTTPS is used to match the TMS server's TLS setup. If the target dev server
  // only serves HTTP, configure a reverse proxy or change the protocol here.
  const url1 = `http://${serverHost}:${browserPort}`;
  const url2 = `http://${serverHost}:${browserPort2}`;

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
      { id: 'browser1', label: `:${browserPort}`, icon: 'globe', content: <BrowserPane url={url1} /> },
      { id: 'browser2', label: `:${browserPort2}`, icon: 'globe', content: <BrowserPane url={url2} /> },
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
      <BrowserPane url={url1} />
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
