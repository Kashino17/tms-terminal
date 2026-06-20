import React, { useMemo, useRef, useImperativeHandle, forwardRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Pressable,
  Animated,
  Easing,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, fonts } from '../../theme';
import { TerminalView, type TerminalViewRef } from '../TerminalView';
import { WebSocketService } from '../../services/websocket.service';
import { colorForSession, lighten } from '../../utils/terminalColors';

export type SpotlightMode = 1 | 2 | 4;
export type PaneStatus = 'run' | 'idle' | 'wait' | 'err' | 'done';

export interface MultiSpotlightRef {
  /** Inject text into the active pane's terminal (Direct-Mode "send-keys"). */
  injectIntoActive: (text: string) => void;
  /** Inject text into a specific pane by index. */
  injectIntoPane: (index: number, text: string) => void;
  /** Open the soft keyboard targeting the pane at `index`. */
  focusPaneKeyboard: (index: number) => void;
  /** Close the soft keyboard for the pane at `index`. */
  blurPaneKeyboard: (index: number) => void;
  /** Scroll the pane at `index` (or the active pane if omitted) to the bottom. */
  scrollToBottom: (index?: number) => void;
}

interface Props {
  mode: SpotlightMode;
  /** sessionIds in slot order; null = empty slot. Length should equal `mode`. */
  panes: (string | null)[];
  activePaneIndex: number;
  onActivePaneChange: (index: number) => void;
  /** User tapped the "make 1-up" icon on a pane. */
  onPromote: (index: number) => void;
  /** User tapped an empty slot — open picker / accept next spine click. */
  onSelectEmptyPane?: (index: number) => void;
  wsService: WebSocketService;
  /** Map sessionId → display name (defaults to sessionId itself). */
  labelFor?: (sessionId: string) => string;
  /** Map sessionId → status (controls badge color). */
  statusFor?: (sessionId: string) => PaneStatus;
  /**
   * Fires when a pane receives two stationary taps within ~280 ms — the parent
   * uses this to enter "pane focus mode" (fullscreen single pane + keyboard).
   * Single taps still drive `onActivePaneChange` as usual.
   */
  onPaneDoubleTap?: (index: number) => void;
  /**
   * Fires when the user long-presses a pane header (~500 ms hold). Parent uses
   * this to open a per-pane settings sheet (e.g. rename). Empty pane slots
   * never fire this — the head only renders for occupied panes.
   */
  onPaneLongPress?: (index: number) => void;
  /**
   * Returns whether the AI CLI in this pane is currently "thinking". When
   * true, the pane wrapper pulses with a soft glow + gentle border-color
   * modulation. Cheap when false (no animator running).
   */
  thinkingFor?: (sessionId: string) => boolean;
  /**
   * Bubble-up channel for thinking-state changes. Wired to each TerminalView's
   * `onThinkingChange`; parent uses it to maintain `thinkingFor`'s source.
   */
  onPaneThinkingChange?: (sessionId: string, thinking: boolean) => void;
  /** When set, only the pane at this index renders (others hidden). */
  focusedPaneIndex?: number | null;
  /**
   * If true, the *active* pane gets `disableKeyboardOffset={false}` so its
   * TerminalView animates a 60-px bottom reserve on keyboard show — matching
   * V1's smooth single-pane behaviour. Other panes stay disabled (no fit()
   * cascade across all WebViews). Used by Manager-Chat V2 to leave room for
   * the orb dock above the keyboard without resizing every pane.
   */
  activePaneKeyboardOffset?: boolean;
}

const STATUS_LABEL: Record<PaneStatus, string> = {
  run: 'Run', idle: 'Idle', wait: 'Wait', err: 'Err', done: 'Done',
};

/**
 * Manager-Chat MultiSpotlight: 1, 2, or 4 equal-sized terminal panes in a grid.
 *
 * Each pane wraps a TerminalView (xterm.js WebView). Tapping a pane sets it as
 * the active pane (used by tools and direct-mode for routing). The header shows
 * a color dot (from terminalColors), the session name, a status badge, and a
 * promote-to-1-up icon.
 *
 * Empty slots show a dashed-border placeholder; tapping them fires
 * `onSelectEmptyPane` so the parent can hand off to the next spine selection.
 */
export const MultiSpotlight = forwardRef<MultiSpotlightRef, Props>(function MultiSpotlight(
  {
    mode,
    panes,
    activePaneIndex,
    onActivePaneChange,
    onPromote,
    onSelectEmptyPane,
    wsService,
    labelFor,
    statusFor,
    onPaneDoubleTap,
    onPaneLongPress,
    thinkingFor,
    onPaneThinkingChange,
    focusedPaneIndex,
    activePaneKeyboardOffset = false,
  },
  ref,
) {
  // One TerminalViewRef per pane index, kept stable across re-renders.
  const terminalRefs = useRef<Array<TerminalViewRef | null>>([]);

  // Per-pane pulse animator for the AI-thinking glow. Lazy-init: each pane
  // only allocates an Animated.Value the first time it renders. The loop is
  // only running while the pane's thinking flag is true — no idle CPU cost.
  const pulseRefs = useRef<Animated.Value[]>([]);
  const loopRefs = useRef<Array<Animated.CompositeAnimation | null>>([]);
  const getPulse = (i: number): Animated.Value => {
    if (!pulseRefs.current[i]) pulseRefs.current[i] = new Animated.Value(0);
    return pulseRefs.current[i];
  };

  // Drive each pane's pulse loop based on its thinking state. Effect re-runs
  // whenever panes change (mount/unmount/swap) or thinkingFor identity flips.
  useEffect(() => {
    panes.forEach((sid, i) => {
      const thinking = sid ? !!thinkingFor?.(sid) : false;
      const pulse = getPulse(i);
      const existing = loopRefs.current[i];
      if (thinking && !existing) {
        const loop = Animated.loop(
          Animated.sequence([
            Animated.timing(pulse, {
              toValue: 1,
              duration: 800,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: false,
            }),
            Animated.timing(pulse, {
              toValue: 0,
              duration: 800,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: false,
            }),
          ]),
        );
        loopRefs.current[i] = loop;
        loop.start();
      } else if (!thinking && existing) {
        existing.stop();
        loopRefs.current[i] = null;
        // Smooth fade-out so the glow doesn't snap-cut.
        Animated.timing(pulse, {
          toValue: 0,
          duration: 300,
          easing: Easing.out(Easing.quad),
          useNativeDriver: false,
        }).start();
      }
    });
  }, [panes, thinkingFor]);

  // Stop every loop on unmount so leftover animators don't keep ticking.
  useEffect(() => () => {
    loopRefs.current.forEach((l) => l?.stop());
    loopRefs.current = [];
  }, []);

  useImperativeHandle(ref, () => ({
    injectIntoActive: (text: string) => {
      terminalRefs.current[activePaneIndex]?.injectText(text);
    },
    injectIntoPane: (index: number, text: string) => {
      terminalRefs.current[index]?.injectText(text);
    },
    focusPaneKeyboard: (index: number) => {
      terminalRefs.current[index]?.focusKeyboard();
    },
    blurPaneKeyboard: (index: number) => {
      terminalRefs.current[index]?.blurKeyboard();
    },
    scrollToBottom: (index?: number) => {
      const i = index ?? activePaneIndex;
      terminalRefs.current[i]?.scrollToBottom();
    },
  }), [activePaneIndex]);

  // Tap counter — single tap activates, double tap (within 280ms) fires
  // onPaneDoubleTap. Stored per-pane so simultaneous taps on different panes
  // don't collide. The timer is cleared on unmount.
  const tapTimers = useRef<Array<ReturnType<typeof setTimeout> | null>>([]);
  useEffect(() => () => {
    tapTimers.current.forEach((t) => t && clearTimeout(t));
  }, []);

  const handlePaneTap = useCallback((paneIdx: number) => {
    const existing = tapTimers.current[paneIdx];
    if (existing) {
      // Double tap
      clearTimeout(existing);
      tapTimers.current[paneIdx] = null;
      onActivePaneChange(paneIdx);
      onPaneDoubleTap?.(paneIdx);
      return;
    }
    tapTimers.current[paneIdx] = setTimeout(() => {
      tapTimers.current[paneIdx] = null;
      onActivePaneChange(paneIdx);
    }, 280);
  }, [onActivePaneChange, onPaneDoubleTap]);

  const slots = useMemo(() => {
    const arr: (string | null)[] = [];
    for (let i = 0; i < mode; i++) arr.push(panes[i] ?? null);
    return arr;
  }, [mode, panes]);

  function renderPane(sid: string | null, i: number) {
    const isActive = i === activePaneIndex;
    // In focus mode the focused pane overlays the grid via absolute positioning.
    // Non-focused panes stay in their normal flex slot (covered visually by the
    // overlay). This keeps every WebView at its original React-tree position so
    // none get detached → no xterm reset, no keyboard cancel.
    const isFocusedOverlay = focusedPaneIndex != null && i === focusedPaneIndex;
    if (!sid) {
      return (
        <Pressable
          key={`empty-${i}`}
          style={[
            s.empty,
            isActive && s.emptyActive,
            focusedPaneIndex != null && i !== focusedPaneIndex && s.paneHiddenInFocus,
          ]}
          onPress={() => {
            // Tap on an empty pane both activates it (so the user sees the
            // selection highlight) and notifies the parent to start the
            // pick-a-terminal flow. Without the activate step, the user got
            // no feedback that their tap registered.
            onActivePaneChange(i);
            onSelectEmptyPane?.(i);
          }}
        >
          <Feather name="plus" size={16} color={colors.textDim} />
          <Text style={s.emptyText}>Pane {i + 1} leer</Text>
        </Pressable>
      );
    }
    const tcolor = colorForSession(sid);
    const status: PaneStatus = statusFor?.(sid) ?? 'idle';
    const label = labelFor?.(sid) ?? sid;
    // In focus mode the visible (focused) pane has lots of vertical space so
    // we can use the largest font even when the underlying mode is 2 or 4.
    const fontSize = isFocusedOverlay ? 13 : (mode === 4 ? 11 : mode === 2 ? 12 : 13);

    // Thinking glow: pulse the shadow + border color when the AI CLI is busy.
    // Values are pumped up vs. the original design — Android ignores most of
    // the iOS shadow* properties and only honors `elevation`, and the original
    // 12 % lighten + elev 2→6 was barely perceptible on Galaxy Fold-class
    // devices. The wider ranges make the glow obvious without being jarring.
    const pulse = getPulse(i);
    const tcolorLit = lighten(tcolor, 0.30);
    const glowShadowOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });
    const glowShadowRadius = pulse.interpolate({ inputRange: [0, 1], outputRange: [4, 18] });
    const glowElevation = pulse.interpolate({ inputRange: [0, 1], outputRange: [0, 14] });
    const glowBorderColor = pulse.interpolate({
      inputRange: [0, 1],
      outputRange: [tcolor, tcolorLit],
    });
    const thinking = !!thinkingFor?.(sid);

    return (
      <Animated.View
        key={`${sid}-${i}`}
        style={[
          s.pane,
          { borderLeftColor: tcolor },
          isActive && { ...s.paneActive, shadowColor: tcolor, borderColor: tcolor },
          // Thinking glow overrides static shadow during the pulse. Border
          // color animates between full saturation and a +12% tint (option B
          // from the design — pulse + light color modulation).
          thinking && {
            shadowColor: tcolor,
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: glowShadowOpacity,
            shadowRadius: glowShadowRadius,
            elevation: glowElevation as unknown as number,
            borderColor: glowBorderColor,
          },
          // Non-focused panes are visually hidden so the focused one expands
          // (flex:1) to fill whatever container is left. WebViews stay mounted
          // (display:none keeps the React tree intact), so xterm state survives.
          focusedPaneIndex != null && i !== focusedPaneIndex && s.paneHiddenInFocus,
        ]}
      >
        {/* Header taps activate the pane (no double-tap needed here). */}
        <Pressable
          style={s.head}
          onPress={() => onActivePaneChange(i)}
          onLongPress={() => onPaneLongPress?.(i)}
          delayLongPress={500}
        >
          <View style={[s.dot, { backgroundColor: tcolor, shadowColor: tcolor }]} />
          <Text style={s.name} numberOfLines={1}>{label}</Text>
          <View style={[s.statusBadge, statusBgColor(status)]}>
            <Text style={[s.statusText, statusTextColor(status)]}>
              {STATUS_LABEL[status]}
            </Text>
          </View>
          <TouchableOpacity
            style={s.promoteBtn}
            onPress={() => onPromote(i)}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            <Feather
              name={isFocusedOverlay ? 'minimize-2' : 'maximize-2'}
              size={9}
              color={isFocusedOverlay ? colors.primary : colors.textDim}
            />
          </TouchableOpacity>
        </Pressable>
        <View style={s.outWrap}>
          <TerminalView
            ref={(r) => { terminalRefs.current[i] = r; }}
            sessionId={sid}
            wsService={wsService}
            visible={true}
            fontSize={fontSize}
            // In focus mode the focused pane shrinks for the orb dock (V1).
            // In Manager-Chat V2 with `activePaneKeyboardOffset`, the *active*
            // pane gets the same per-pane animated 60-px bottom reserve so its
            // prompt stays visible above the dock — without resizing every
            // pane (which caused fit() cascade lag across all WebViews).
            disableKeyboardOffset={!isFocusedOverlay && !(activePaneKeyboardOffset && i === activePaneIndex)}
            // Focused pane lifts the tap suppression so xterm behaves normally
            // (cursor positioning, scrolling, keyboard stays). Non-focused panes
            // keep the suppression so the single-tap-vs-double-tap counter works.
            tapFocusDisabled={!isFocusedOverlay}
            onTap={() => handlePaneTap(i)}
            onThinkingChange={(t) => onPaneThinkingChange?.(sid, t)}
          />
        </View>
      </Animated.View>
    );
  }

  // Note: focus mode is handled inside renderPane (hides non-focused panes via
  // display:none so the focused one expands to fill its row). We keep the same
  // layout tree so the WebViews don't unmount/remount, which would lose xterm
  // state and cancel the soft keyboard mid-input.

  // Mode-4 needs a 2x2 grid → use 2 rows, each holding 2 panes.
  // When focused, the row that does NOT contain the focused pane is hidden
  // entirely so the remaining row gets the full grid height. Combined with
  // hiding the non-focused pane in the active row, the focused pane fills
  // the whole grid even though it's nested two layers deep.
  if (mode === 4) {
    const row0HasFocus = focusedPaneIndex === 0 || focusedPaneIndex === 1;
    const row1HasFocus = focusedPaneIndex === 2 || focusedPaneIndex === 3;
    const focusActive = focusedPaneIndex != null;
    return (
      <View style={s.grid}>
        <View style={[s.row, focusActive && !row0HasFocus && s.rowHiddenInFocus]}>
          {renderPane(slots[0], 0)}
          {renderPane(slots[1], 1)}
        </View>
        <View style={[s.row, focusActive && !row1HasFocus && s.rowHiddenInFocus]}>
          {renderPane(slots[2], 2)}
          {renderPane(slots[3], 3)}
        </View>
      </View>
    );
  }

  // Mode 1 / 2: simple column stack
  return (
    <View style={s.grid}>
      {slots.map((sid, i) => renderPane(sid, i))}
    </View>
  );
});

// ── Status badge color helpers ──────────────────────────────────────────────
function statusBgColor(s: PaneStatus) {
  switch (s) {
    case 'run':  return { backgroundColor: 'rgba(34,197,94,0.15)' };
    case 'idle': return { backgroundColor: 'rgba(100,116,139,0.15)' };
    case 'wait': return { backgroundColor: 'rgba(245,158,11,0.15)' };
    case 'err':  return { backgroundColor: 'rgba(239,68,68,0.15)' };
    case 'done': return { backgroundColor: 'rgba(6,182,212,0.15)' };
  }
}
function statusTextColor(s: PaneStatus) {
  switch (s) {
    case 'run':  return { color: colors.accent };
    case 'idle': return { color: colors.textDim };
    case 'wait': return { color: colors.warning };
    case 'err':  return { color: colors.destructive };
    case 'done': return { color: colors.info };
  }
}

const s = StyleSheet.create({
  grid: {
    flex: 1,
    padding: 4,
    gap: 4,
    // position:relative establishes the containing block for the focused pane's
    // absolute overlay in focus mode.
    position: 'relative',
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    gap: 4,
    minHeight: 0,
  },
  pane: {
    backgroundColor: colors.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderColor: colors.border,
    overflow: 'hidden',
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  // Mode-4 panes need explicit width otherwise flexWrap doesn't split them
  // 2-column grid on a phone — handled via parent grid; we set basis below.
  paneActive: {
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 8,
    elevation: 4,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 24,
    paddingHorizontal: 8,
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 2,
  },
  name: {
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: '700',
    color: colors.text,
  },
  statusBadge: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 7.5,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  promoteBtn: {
    width: 16,
    height: 16,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  outWrap: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  empty: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    padding: 8,
  },
  // Soft selection highlight for empty panes — solid 1.5px white-ish border
  // with a hairline inner glow so the user sees their tap registered, before
  // they pick a terminal to fill it. Stays subtle (no theme accent) since
  // an empty pane is a transient picking state, not a styled surface.
  emptyActive: {
    borderStyle: 'solid',
    borderColor: 'rgba(255,255,255,0.55)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  emptyText: {
    fontSize: 9,
    color: colors.textDim,
  },
  // Display:none for non-focused panes / row containers when expanding one
  // pane to fill the grid. Keeps the React tree (and WebViews) mounted —
  // toggling display:none doesn't unmount, so xterm state survives.
  paneHiddenInFocus: {
    display: 'none',
  },
  rowHiddenInFocus: {
    display: 'none',
  },
  // Promote the focused pane to a full-grid overlay. Stays in its React tree
  // position so the WebView is never detached/remounted — only its style flips.
  // The non-focused panes keep rendering in their flex slots underneath but
  // are visually covered.
  focusedOverlay: {
    position: 'absolute',
    top: 4, left: 4, right: 4, bottom: 4,
    zIndex: 99,
    elevation: 8,
  },
});
