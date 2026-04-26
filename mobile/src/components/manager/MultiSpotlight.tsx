import React, { useMemo, useRef, useImperativeHandle, forwardRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Pressable,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, fonts } from '../../theme';
import { TerminalView, type TerminalViewRef } from '../TerminalView';
import { WebSocketService } from '../../services/websocket.service';
import { colorForSession } from '../../utils/terminalColors';

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
  /** When set, only the pane at this index renders (others hidden). */
  focusedPaneIndex?: number | null;
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
    focusedPaneIndex,
  },
  ref,
) {
  // One TerminalViewRef per pane index, kept stable across re-renders.
  const terminalRefs = useRef<Array<TerminalViewRef | null>>([]);

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
    // In focus mode, only the focused pane is visible. Non-focused panes stay
    // mounted (preserving WebView/xterm state) but render as 0×0 with display:
    // 'none' so they don't take grid space — the focused pane expands to fill.
    const hidden = focusedPaneIndex != null && i !== focusedPaneIndex;
    if (!sid) {
      return (
        <Pressable
          key={`empty-${i}`}
          style={[s.empty, hidden && s.hiddenPane]}
          onPress={() => onSelectEmptyPane?.(i)}
        >
          <Feather name="plus" size={16} color={colors.textDim} />
          <Text style={s.emptyText}>Pane {i + 1} leer</Text>
        </Pressable>
      );
    }
    const tcolor = colorForSession(sid);
    const status: PaneStatus = statusFor?.(sid) ?? 'idle';
    const label = labelFor?.(sid) ?? sid;
    // Per-mode font size: smaller panes need smaller text so a useful amount
    // of terminal context fits. Clamped client-side to xterm's MIN_FONT/MAX_FONT.
    const fontSize = mode === 4 ? 11 : mode === 2 ? 12 : 13;
    return (
      <View
        key={`${sid}-${i}`}
        style={[
          s.pane,
          { borderLeftColor: tcolor },
          isActive && { ...s.paneActive, shadowColor: tcolor, borderColor: tcolor },
          hidden && s.hiddenPane,
        ]}
      >
        {/* Header taps activate the pane (no double-tap needed here). */}
        <Pressable style={s.head} onPress={() => onActivePaneChange(i)}>
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
            <Feather name="maximize-2" size={9} color={colors.textDim} />
          </TouchableOpacity>
        </Pressable>
        <View style={s.outWrap}>
          <TerminalView
            ref={(r) => { terminalRefs.current[i] = r; }}
            sessionId={sid}
            wsService={wsService}
            visible={true}
            fontSize={fontSize}
            disableKeyboardOffset
            tapFocusDisabled
            onTap={() => handlePaneTap(i)}
          />
        </View>
      </View>
    );
  }

  // Note: focus mode is handled inside renderPane (hides non-focused panes via
  // display:none so the focused one expands to fill its row). We keep the same
  // layout tree so the WebViews don't unmount/remount, which would lose xterm
  // state and cancel the soft keyboard mid-input.

  // Mode-4 needs a 2x2 grid → use 2 rows, each holding 2 panes.
  // Doing this with flexWrap on RN is fragile; explicit rows are simpler.
  if (mode === 4) {
    // Focus mode: hide whichever row doesn't contain the focused pane so the
    // focused pane's row gets all the vertical space.
    const row1Hidden = focusedPaneIndex != null && focusedPaneIndex !== 0 && focusedPaneIndex !== 1;
    const row2Hidden = focusedPaneIndex != null && focusedPaneIndex !== 2 && focusedPaneIndex !== 3;
    return (
      <View style={s.grid}>
        <View style={[s.row, row1Hidden && s.hiddenPane]}>
          {renderPane(slots[0], 0)}
          {renderPane(slots[1], 1)}
        </View>
        <View style={[s.row, row2Hidden && s.hiddenPane]}>
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
  emptyText: {
    fontSize: 9,
    color: colors.textDim,
  },
  // Hide a pane (or row) without unmounting it. `display: 'none'` removes it
  // from the flex layout entirely so siblings expand to take its space, while
  // React keeps the View + child WebView mounted (xterm state preserved).
  hiddenPane: {
    display: 'none',
  },
});
