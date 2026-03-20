import React, { useState, useEffect, useRef } from 'react';
import { Animated, Keyboard, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { WebSocketService } from '../services/websocket.service';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

export const TOOLBAR_HEIGHT = 44;

interface Props {
  sessionId: string | undefined;
  wsService: WebSocketService;
  rangeActive?: boolean;
  onRangeToggle?: () => void;
  onScrollToBottom?: () => void;
}

export function TerminalToolbar({ sessionId, wsService, rangeActive = false, onRangeToggle, onScrollToBottom }: Props) {
  const { rf, rs, ri } = useResponsive();
  const bottomAnim = useRef(new Animated.Value(0)).current;
  const [arrowsOpen, setArrowsOpen] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const showSub = Keyboard.addListener('keyboardWillShow', (e) => {
      Animated.timing(bottomAnim, { toValue: e.endCoordinates.height, duration: e.duration > 0 ? e.duration : 220, useNativeDriver: false }).start();
    });
    const hideSub = Keyboard.addListener('keyboardWillHide', (e) => {
      Animated.timing(bottomAnim, { toValue: 0, duration: e.duration > 0 ? e.duration : 220, useNativeDriver: false }).start();
    });
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  const send = (seq: string, action?: string) => {
    if (!sessionId) return;
    if (action === 'clear') { wsService.send({ type: 'terminal:clear', sessionId }); return; }
    wsService.send({ type: 'terminal:input', sessionId, payload: { data: seq } });
  };

  const h = rs(36);
  const iconSz = ri(14);
  const fontSz = rf(11);

  // Compact arrow button
  const Arrow = ({ icon, seq }: { icon: string; seq: string }) => (
    <TouchableOpacity style={[s.arrowBtn, { width: h, height: h }]} onPress={() => send(seq)} activeOpacity={0.6}>
      <Feather name={icon as any} size={iconSz} color={colors.textMuted} />
    </TouchableOpacity>
  );

  // Standard key button
  const Key = ({ label, seq, icon, action, accent }: { label: string; seq: string; icon?: string; action?: string; accent?: string }) => (
    <TouchableOpacity
      style={[s.key, { height: h }]}
      onPress={() => send(seq, action)}
      activeOpacity={0.6}
      accessibilityLabel={label}
    >
      {icon
        ? <Feather name={icon as any} size={iconSz} color={accent || colors.text} />
        : <Text style={[s.keyText, { fontSize: fontSz }, accent ? { color: accent } : null]}>{label}</Text>
      }
    </TouchableOpacity>
  );

  return (
    <Animated.View style={[s.bar, { bottom: bottomAnim, height: rs(TOOLBAR_HEIGHT) }]} accessibilityRole={'toolbar' as any}>
      {/* ── D-Pad toggle ─────────────────────────────── */}
      <TouchableOpacity
        style={[s.dpadToggle, { height: h, width: h }, arrowsOpen && s.dpadToggleActive]}
        onPress={() => setArrowsOpen((v) => !v)}
        activeOpacity={0.6}
      >
        <Feather name="navigation" size={iconSz} color={arrowsOpen ? colors.primary : colors.textDim} />
      </TouchableOpacity>

      {/* ── Arrow keys (collapsible) ─────────────────── */}
      {arrowsOpen && (
        <View style={s.arrowGroup}>
          <Arrow icon="chevron-up" seq={'\x1b[A'} />
          <Arrow icon="chevron-down" seq={'\x1b[B'} />
          <Arrow icon="chevron-left" seq={'\x1b[D'} />
          <Arrow icon="chevron-right" seq={'\x1b[C'} />
        </View>
      )}

      {/* ── Separator ────────────────────────────────── */}
      <View style={s.sep} />

      {/* ── Action keys ──────────────────────────────── */}
      <Key label="Esc" seq={'\x1b'} />
      <Key label="↵" seq={'\r'} />
      <Key label="^C" seq={'\x03'} accent={colors.destructive} />
      <Key label="" seq="" icon="trash" action="clear" />
      <Key label="" seq={'\x15'} icon="delete" />

      {/* ── Separator ────────────────────────────────── */}
      <View style={s.sep} />

      {/* ── Utilities ────────────────────────────────── */}
      <TouchableOpacity style={[s.utilBtn, { height: h }]} onPress={onScrollToBottom} activeOpacity={0.6} accessibilityLabel="Scroll to bottom">
        <Feather name="chevrons-down" size={iconSz} color={colors.info} />
      </TouchableOpacity>

      <TouchableOpacity
        style={[s.utilBtn, { height: h }, rangeActive && s.utilActive]}
        onPress={onRangeToggle}
        activeOpacity={0.6}
        accessibilityLabel="Range select"
      >
        <Feather name="scissors" size={ri(13)} color={rangeActive ? colors.accent : colors.textDim} />
      </TouchableOpacity>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: TOOLBAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 5,
    gap: 3,
    zIndex: 50,
  },

  // ── D-Pad ──────────────────────────────────────────
  dpadToggle: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  dpadToggleActive: {
    backgroundColor: 'rgba(59,130,246,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
  },
  arrowGroup: {
    flexDirection: 'row',
    gap: 2,
  },
  arrowBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.surface,
  },

  // ── Keys ───────────────────────────────────────────
  key: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.surface,
    minWidth: 32,
  },
  keyText: {
    color: colors.text,
    fontWeight: '700',
    fontFamily: fonts.mono,
    letterSpacing: 0.3,
  },

  // ── Utilities ──────────────────────────────────────
  utilBtn: {
    width: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  utilActive: {
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
  },

  // ── Separator ──────────────────────────────────────
  sep: {
    width: StyleSheet.hairlineWidth,
    height: 20,
    backgroundColor: colors.border,
    marginHorizontal: 2,
  },
});
