import React, { useState, useRef, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Animated, Easing, View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, spacing } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import { SnippetsPanel } from './SnippetsPanel';
import { ScreenshotPanel } from './ScreenshotPanel';
import { SQLPanel } from './SQLPanel';
import { AutoApprovePanel } from './AutoApprovePanel';
import { AutopilotPanel } from './AutopilotPanel';
import { WatchersPanel } from './WatchersPanel';
import { FileBrowserPanel } from './FileBrowserPanel';
import { PortForwardingPanel } from './PortForwardingPanel';
import { WebSocketService } from '../services/websocket.service';
import { useSQLStore } from '../store/sqlStore';

export const TOOL_RAIL_WIDTH = 48;
const PANEL_WIDTH = 214;
const COLLAPSE_WIDTH = 14;

// Grouped tool definitions — each sub-array is a visual group separated by a hairline
const TOOL_GROUPS: { id: string; icon: any; color: string; label: string }[][] = [
  // AI / Workflow
  [
    { id: 'autoApprove', icon: 'check-circle', color: colors.accent,  label: 'Auto Approve' },
    { id: 'snippets',    icon: 'zap',          color: colors.warning, label: 'Snippets' },
  ],
  // Files & Data
  [
    { id: 'files', icon: 'folder',   color: '#F59E0B',      label: 'Files' },
    { id: 'sql',   icon: 'database', color: colors.primary, label: 'SQL' },
    { id: 'ports', icon: 'share-2',  color: '#10B981',      label: 'Ports' },
  ],
  // Capture, Notes & Alerts
  [
    { id: 'screenshots', icon: 'film',        color: colors.info,    label: 'Medien' },
    { id: 'autopilot',   icon: 'play-circle',  color: '#A78BFA',      label: 'Autopilot' },
    { id: 'watchers',    icon: 'bell',         color: colors.warning, label: 'Notifications' },
  ],
];

export interface ToolRailRef {
  closePanel: () => void;
  openFileBrowser: (path: string) => void;
}

interface Props {
  sessionId: string | undefined;
  wsService: WebSocketService;
  serverHost: string;
  serverPort: number;
  serverToken: string;
  serverId: string;
  onPanelChange?: (open: boolean) => void;
  railWidthAnim?: Animated.Value;
  onToolAction?: (toolId: string) => boolean;
}

export const ToolRail = forwardRef<ToolRailRef, Props>(function ToolRail(
  { sessionId, wsService, serverHost, serverPort, serverToken, serverId, onPanelChange, railWidthAnim, onToolAction },
  ref,
) {
  const responsive = useResponsive();
  const { rs, ri, rf } = responsive;
  const PANEL_W = responsive.panelWidth;

  const [active, setActive]       = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [fileBrowserPath, setFileBrowserPath] = useState<string | null>(null);
  const panelAnim    = useRef(new Animated.Value(0)).current;
  const panelOpacity = useRef(new Animated.Value(0)).current;
  const panelSlide   = useRef(new Animated.Value(20)).current;
  const panelScale   = useRef(new Animated.Value(0.94)).current;
  const stripAnim    = useRef(new Animated.Value(TOOL_RAIL_WIDTH)).current;
  const iconsOpacity = useRef(new Animated.Value(1)).current;

  // SQL badge — reactive count for the current session
  const sqlCount = useSQLStore((state) =>
    sessionId ? state.getEntries(sessionId).length : 0,
  );

  // ── Panel helpers ────────────────────────────────────────────────────────
  // Use refs to avoid stale closures in the toggle callback
  const onPanelChangeRef = useRef(onPanelChange);
  onPanelChangeRef.current = onPanelChange;
  const activeRef = useRef(active);
  activeRef.current = active;

  // Apple HIG: spring-based enter, quick timing exit
  const openPanel = useCallback((toolId: string) => {
    setActive(toolId);
    onPanelChangeRef.current?.(true);
    panelAnim.setValue(PANEL_W); // instant — reserves layout space
    panelOpacity.setValue(0);
    panelSlide.setValue(20);
    panelScale.setValue(0.94);
    // Spring enter — snappy with minimal overshoot (Apple fluid animation)
    const springConfig = { stiffness: 320, damping: 24, mass: 0.8, useNativeDriver: true };
    Animated.parallel([
      Animated.spring(panelOpacity, { ...springConfig, toValue: 1 }),
      Animated.spring(panelSlide,   { ...springConfig, toValue: 0 }),
      Animated.spring(panelScale,   { ...springConfig, toValue: 1 }),
    ]).start();
  }, [panelAnim, panelOpacity, panelSlide, panelScale]);

  // Exit: quick and decisive — 60-70% of enter duration (Apple HIG)
  const closePanel = useCallback((cb?: () => void) => {
    Animated.parallel([
      Animated.timing(panelOpacity, { toValue: 0,    duration: 140, useNativeDriver: true, easing: Easing.in(Easing.cubic) }),
      Animated.timing(panelSlide,   { toValue: 12,   duration: 140, useNativeDriver: true, easing: Easing.in(Easing.cubic) }),
      Animated.timing(panelScale,   { toValue: 0.96, duration: 140, useNativeDriver: true, easing: Easing.in(Easing.cubic) }),
    ]).start(() => {
      panelAnim.setValue(0);
      setActive(null);
      if (!cb) onPanelChangeRef.current?.(false);
      cb?.();
    });
  }, [panelAnim, panelOpacity, panelSlide, panelScale]);

  const toggle = useCallback((toolId: string) => {
    if (collapsed) return; // strip is hidden — ignore taps

    // Non-panel tools — delegate to parent
    if (onToolAction?.(toolId)) {
      if (activeRef.current) closePanel();
      return;
    }
    if (activeRef.current === toolId) {
      closePanel();
    } else if (activeRef.current) {
      closePanel(() => openPanel(toolId));
    } else {
      openPanel(toolId);
    }
  }, [collapsed, onToolAction, openPanel, closePanel]);

  // ── Strip collapse / expand ──────────────────────────────────────────────
  const collapseStrip = useCallback(() => {

    // Close any open panel first, then shrink the strip
    const shrink = () => {
      setCollapsed(true);
      const anims: Animated.CompositeAnimation[] = [
        Animated.timing(stripAnim,    { toValue: COLLAPSE_WIDTH, duration: 200, useNativeDriver: false }),
        Animated.timing(iconsOpacity, { toValue: 0,              duration: 140, useNativeDriver: true  }),
      ];
      if (railWidthAnim) {
        anims.push(Animated.timing(railWidthAnim, { toValue: COLLAPSE_WIDTH, duration: 200, useNativeDriver: false }));
      }
      Animated.parallel(anims).start();
    };
    if (activeRef.current) {
      closePanel(shrink);
    } else {
      shrink();
    }
  }, [closePanel, stripAnim, iconsOpacity, railWidthAnim]);

  const expandStrip = useCallback(() => {

    setCollapsed(false);
    const anims: Animated.CompositeAnimation[] = [
      Animated.timing(stripAnim,    { toValue: TOOL_RAIL_WIDTH, duration: 200, useNativeDriver: false }),
      Animated.timing(iconsOpacity, { toValue: 1,               duration: 200, useNativeDriver: true  }),
    ];
    if (railWidthAnim) {
      anims.push(Animated.timing(railWidthAnim, { toValue: TOOL_RAIL_WIDTH, duration: 200, useNativeDriver: false }));
    }
    Animated.parallel(anims).start();
  }, [stripAnim, iconsOpacity, railWidthAnim]);

  useImperativeHandle(ref, () => ({
    closePanel: () => {
      if (activeRef.current) closePanel();
    },
    openFileBrowser: (path: string) => {
      setFileBrowserPath(path);
      if (activeRef.current !== 'files') {
        if (activeRef.current) {
          closePanel(() => openPanel('files'));
        } else {
          openPanel('files');
        }
      }
    },
  }), [closePanel, openPanel]);

  return (
    <View style={styles.wrapper} pointerEvents="box-none">
      {/* Sliding panel — grows leftward from the strip */}
      <Animated.View style={[styles.panel, { width: panelAnim }]}>
        <Animated.View style={[styles.panelInner, {
          width: PANEL_W,
          opacity: panelOpacity,
          transform: [
            { translateX: panelSlide },
            { scale: panelScale },
          ],
        }]}>
          {active === 'snippets' && (
            <SnippetsPanel sessionId={sessionId} wsService={wsService} />
          )}
          {active === 'screenshots' && (
            <ScreenshotPanel
              sessionId={sessionId}
              wsService={wsService}
              serverHost={serverHost}
              serverPort={serverPort}
              serverToken={serverToken}
            />
          )}
          {active === 'sql' && (
            <SQLPanel sessionId={sessionId} serverId={serverId} />
          )}
          {active === 'autoApprove' && (
            <AutoApprovePanel serverId={serverId} />
          )}
          {active === 'autopilot' && (
            <AutopilotPanel sessionId={sessionId} wsService={wsService} serverId={serverId} />
          )}
          {active === 'watchers' && (
            <WatchersPanel serverId={serverId} wsService={wsService} />
          )}
          {active === 'ports' && (
            <PortForwardingPanel serverId={serverId} />
          )}
          {active === 'files' && (
            <FileBrowserPanel
              serverHost={serverHost}
              serverPort={serverPort}
              serverToken={serverToken}
              sessionId={sessionId}
              wsService={wsService}
              initialPath={fileBrowserPath}
            />
          )}
        </Animated.View>
      </Animated.View>

      {/* Icon strip — animates width when collapsing/expanding */}
      <Animated.View style={[styles.strip, { width: stripAnim }]}>
        {/* Collapse / expand toggle — always visible */}
        <TouchableOpacity
          style={styles.collapseBtn}
          onPress={collapsed ? expandStrip : collapseStrip}
          activeOpacity={0.7}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          accessibilityLabel={collapsed ? 'Expand tool rail' : 'Collapse tool rail'}
          accessibilityRole="button"
        >
          <Feather name={collapsed ? 'chevron-left' : 'chevron-right'} size={ri(14)} color={colors.textDim} />
        </TouchableOpacity>

        {/* Tool icons — fade out when collapsed */}
        <Animated.View style={[styles.iconsContainer, { opacity: iconsOpacity }]} pointerEvents={collapsed ? 'none' : 'auto'}>
          {TOOL_GROUPS.map((group, gi) => (
            <React.Fragment key={gi}>
              {gi > 0 && <View style={styles.separator} />}
              {group.map((tool) => {
                const isSqlBadge = tool.id === 'sql' && sqlCount > 0 && active !== 'sql';
                return (
                  <TouchableOpacity
                    key={tool.id}
                    style={styles.toolBtn}
                    onPress={() => toggle(tool.id)}
                    activeOpacity={0.7}
                    accessibilityLabel={tool.label}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active === tool.id }}
                  >
                    {active === tool.id && (
                      <View style={[styles.activeGlow, { backgroundColor: tool.color + '22' }]} />
                    )}
                    <Feather name={tool.icon} size={ri(18)} color={active === tool.id ? tool.color : colors.textDim} />
                    {active === tool.id && (
                      <View style={[styles.activeDot, { backgroundColor: tool.color }]} />
                    )}
                    {isSqlBadge && (
                      <View style={[styles.badge, { minWidth: rs(16), height: rs(16), borderRadius: rs(8) }]}>
                        <Text style={[styles.badgeText, { fontSize: rf(10) }]}>{sqlCount > 9 ? '9+' : String(sqlCount)}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </React.Fragment>
          ))}
        </Animated.View>
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'stretch',
    zIndex: 5, // above TerminalView (zIndex:1), below TerminalToolbar (zIndex:10)
  },
  panel: {
    overflow: 'hidden',
  },
  panelInner: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
  },
  strip: {
    backgroundColor: colors.bg,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    alignItems: 'center',
    paddingVertical: 6,
    gap: 2,
    overflow: 'hidden',
  },
  collapseBtn: {
    width: 44,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconsContainer: {
    alignItems: 'center',
    gap: 4,
  },
  toolBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  activeGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 12,
  },
  activeDot: {
    position: 'absolute',
    bottom: 2,
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  badge: {
    position: 'absolute',
    top: 2,
    right: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  badgeText: {
    color: colors.bg,
    fontSize: 10,
    fontWeight: '800',
    lineHeight: 14,
  },
  separator: {
    width: 20,
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 3,
    alignSelf: 'center',
  },
});
