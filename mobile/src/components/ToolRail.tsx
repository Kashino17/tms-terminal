import React, { useState, useRef, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Animated, Easing, View, TouchableOpacity, Text, StyleSheet, LayoutAnimation, Platform, UIManager } from 'react-native';
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
import { RenderPanel } from './RenderPanel';
import { VercelPanel } from './VercelPanel';
import { WebSocketService } from '../services/websocket.service';
import { useSQLStore } from '../store/sqlStore';
import { TOOLBAR_HEIGHT } from './TerminalToolbar';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export const TOOL_RAIL_WIDTH = 48;
const PANEL_WIDTH = 214;
const COLLAPSE_WIDTH = 14;

type ToolItem = { id: string; icon: any; color: string; label: string };

// Standalone items — always visible, grouped by separator
const STANDALONE_GROUPS: ToolItem[][] = [
  // AI / Workflow
  [
    { id: 'autoApprove', icon: 'check-circle', color: colors.accent,  label: 'Auto Approve' },
    { id: 'snippets',    icon: 'zap',          color: colors.warning, label: 'Snippets' },
  ],
  // Files & Media
  [
    { id: 'files',       icon: 'folder', color: '#F59E0B',   label: 'Files' },
    { id: 'screenshots', icon: 'film',   color: colors.info, label: 'Medien' },
  ],
];

// Collapsible groups — parent icon toggles children visibility
const COLLAPSIBLE_GROUPS: {
  groupId: string;
  icon: any;
  color: string;
  label: string;
  items: ToolItem[];
}[] = [
  {
    groupId: 'monitoring',
    icon: 'activity',
    color: '#A78BFA',
    label: 'Monitoring',
    items: [
      { id: 'autopilot', icon: 'play-circle', color: '#A78BFA',      label: 'Autopilot' },
      { id: 'watchers',  icon: 'bell',        color: colors.warning, label: 'Notifications' },
      { id: 'ports',     icon: 'share-2',     color: '#10B981',      label: 'Ports' },
    ],
  },
  {
    groupId: 'cloud',
    icon: 'cloud',
    color: colors.primary,
    label: 'Cloud & Daten',
    items: [
      { id: 'sql',    icon: 'database', color: colors.primary, label: 'SQL' },
      { id: 'render', icon: 'box',      color: '#4353FF',      label: 'Render' },
      { id: 'vercel', icon: 'triangle', color: '#FFFFFF',      label: 'Vercel' },
    ],
  },
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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
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

  // ── Collapsible group toggle ─────────────────────────────────────────────
  const expandedGroupsRef = useRef(expandedGroups);
  expandedGroupsRef.current = expandedGroups;

  const toggleGroup = useCallback((groupId: string) => {
    const group = COLLAPSIBLE_GROUPS.find(g => g.groupId === groupId);
    const isCollapsing = expandedGroupsRef.current.has(groupId);

    // Close panel if active tool belongs to this group and we're collapsing
    if (group && isCollapsing && activeRef.current) {
      if (group.items.some(item => item.id === activeRef.current)) closePanel();
    }

    LayoutAnimation.configureNext({
      duration: 200,
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });

    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, [closePanel]);

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
    <View style={[styles.wrapper, { bottom: rs(TOOLBAR_HEIGHT) }]} pointerEvents="box-none">
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
          {active === 'render' && <RenderPanel />}
          {active === 'vercel' && <VercelPanel />}
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
          {/* ── Standalone groups ── */}
          {STANDALONE_GROUPS.map((group, gi) => (
            <React.Fragment key={`s${gi}`}>
              {gi > 0 && <View style={styles.separator} />}
              {group.map((tool) => (
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
                </TouchableOpacity>
              ))}
            </React.Fragment>
          ))}

          {/* ── Collapsible groups ── */}
          {COLLAPSIBLE_GROUPS.map((group) => {
            const isExpanded = expandedGroups.has(group.groupId);
            const hasActiveChild = group.items.some(item => item.id === active);
            const showParentBadge = group.groupId === 'cloud' && !isExpanded && sqlCount > 0 && active !== 'sql';

            return (
              <React.Fragment key={group.groupId}>
                <View style={styles.separator} />
                {/* Parent toggle icon */}
                <TouchableOpacity
                  style={styles.toolBtn}
                  onPress={() => toggleGroup(group.groupId)}
                  activeOpacity={0.7}
                  accessibilityLabel={`${group.label} ${isExpanded ? 'zuklappen' : 'aufklappen'}`}
                  accessibilityRole="button"
                >
                  {(isExpanded || hasActiveChild) && (
                    <View style={[styles.activeGlow, { backgroundColor: group.color + '18' }]} />
                  )}
                  <Feather
                    name={group.icon}
                    size={ri(18)}
                    color={isExpanded || hasActiveChild ? group.color : colors.textDim}
                  />
                  <View style={styles.chevronIndicator}>
                    <Feather
                      name={isExpanded ? 'chevron-down' : 'chevron-right'}
                      size={8}
                      color={isExpanded || hasActiveChild ? group.color : colors.textDim}
                    />
                  </View>
                  {showParentBadge && (
                    <View style={[styles.badge, { minWidth: rs(16), height: rs(16), borderRadius: rs(8) }]}>
                      <Text style={[styles.badgeText, { fontSize: rf(10) }]}>{sqlCount > 9 ? '9+' : String(sqlCount)}</Text>
                    </View>
                  )}
                </TouchableOpacity>

                {/* Child items — visible when expanded */}
                {isExpanded && group.items.map((tool) => {
                  const isSqlBadge = tool.id === 'sql' && sqlCount > 0 && active !== 'sql';
                  return (
                    <TouchableOpacity
                      key={tool.id}
                      style={styles.childToolBtn}
                      onPress={() => toggle(tool.id)}
                      activeOpacity={0.7}
                      accessibilityLabel={tool.label}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active === tool.id }}
                    >
                      {active === tool.id && (
                        <View style={[styles.childActiveGlow, { backgroundColor: tool.color + '22' }]} />
                      )}
                      <Feather name={tool.icon} size={ri(15)} color={active === tool.id ? tool.color : colors.textDim} />
                      {active === tool.id && (
                        <View style={[styles.activeDot, { backgroundColor: tool.color }]} />
                      )}
                      {isSqlBadge && (
                        <View style={[styles.badge, { minWidth: rs(14), height: rs(14), borderRadius: rs(7) }]}>
                          <Text style={[styles.badgeText, { fontSize: rf(9) }]}>{sqlCount > 9 ? '9+' : String(sqlCount)}</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </React.Fragment>
            );
          })}
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
    // bottom set dynamically via rs(TOOLBAR_HEIGHT) to match responsive toolbar height
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
  childToolBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  childActiveGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 10,
  },
  chevronIndicator: {
    position: 'absolute',
    bottom: 2,
    right: 4,
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
