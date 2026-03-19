import React, { useEffect, useRef, useMemo } from 'react';
import { Animated, Keyboard, Platform, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { WebSocketService } from '../services/websocket.service';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

export const TOOLBAR_HEIGHT = 48;

const BUTTONS: { label: string; seq: string; icon?: string }[] = [
  { label: 'Up',    seq: '\x1b[A', icon: 'chevron-up' },
  { label: 'Down',  seq: '\x1b[B', icon: 'chevron-down' },
  { label: 'Left',  seq: '\x1b[D', icon: 'chevron-left' },
  { label: 'Right', seq: '\x1b[C', icon: 'chevron-right' },
  { label: 'Esc',   seq: '\x1b' },
  { label: 'Enter', seq: '\r' },
  { label: '^C',    seq: '\x03' },
  { label: 'CLR',   seq: 'clear\r', icon: 'trash' },
  { label: 'Clear', seq: '\x15', icon: 'delete' },
];

interface Props {
  sessionId: string | undefined;
  wsService: WebSocketService;
  rangeActive?: boolean;
  onRangeToggle?: () => void;
}

export function TerminalToolbar({ sessionId, wsService, rangeActive = false, onRangeToggle }: Props) {
  const { rf, rs, ri, isExpanded } = useResponsive();
  const bottomAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // On Android with adjustResize, the window already shrinks for the keyboard —
    // bottom: 0 automatically sits above the keyboard. Only iOS needs manual offset.
    if (Platform.OS !== 'ios') return;

    const showListener = Keyboard.addListener('keyboardWillShow', (e) => {
      Animated.timing(bottomAnim, {
        toValue: e.endCoordinates.height,
        duration: e.duration > 0 ? e.duration : 220,
        useNativeDriver: false,
      }).start();
    });

    const hideListener = Keyboard.addListener('keyboardWillHide', (e) => {
      Animated.timing(bottomAnim, {
        toValue: 0,
        duration: e.duration > 0 ? e.duration : 220,
        useNativeDriver: false,
      }).start();
    });

    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, []);

  const sendKey = (seq: string) => {
    if (!sessionId) return;
    wsService.send({ type: 'terminal:input', sessionId, payload: { data: seq } });
  };

  const btnHeight = isExpanded ? rs(44) : rs(40);

  return (
    <Animated.View style={[styles.toolbar, { bottom: bottomAnim, right: 0, height: rs(TOOLBAR_HEIGHT), paddingHorizontal: rs(6), gap: rs(4) }]} accessibilityRole={'toolbar' as any}>
      {BUTTONS.map((btn) => (
        <TouchableOpacity
          key={btn.label}
          style={[styles.btn, { height: btnHeight }]}
          onPress={() => sendKey(btn.seq)}
          activeOpacity={0.65}
          accessibilityLabel={btn.label}
          accessibilityRole="button"
        >
          {btn.icon ? <Feather name={btn.icon as any} size={ri(16)} color={colors.text} /> : <Text style={[styles.btnText, { fontSize: rf(13) }]}>{btn.label}</Text>}
        </TouchableOpacity>
      ))}
      <TouchableOpacity
        style={[styles.btn, { height: btnHeight }, rangeActive && styles.btnActive]}
        onPress={onRangeToggle}
        activeOpacity={0.65}
        accessibilityLabel="Range select"
        accessibilityRole="button"
      >
        <Feather name="scissors" size={ri(14)} color={rangeActive ? colors.accent : colors.text} />
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: TOOLBAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: 6,
    gap: 4,
    zIndex: 50,
  },
  btn: {
    flex: 1,
    height: 40,
    backgroundColor: colors.border,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  btnActive: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(34,197,94,0.1)',
  },
  btnText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: fonts.mono,
  },
});
