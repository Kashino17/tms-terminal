import React, { useCallback, useRef, useMemo } from 'react';
import {
  View, Image, StyleSheet, TextInput, Text,
  GestureResponderEvent, LayoutChangeEvent,
} from 'react-native';
import { useChromeRemoteStore } from '../store/chromeRemoteStore';
import { useResponsive } from '../hooks/useResponsive';

interface Props {
  serverId: string;
  onInput: (action: string, payload: Record<string, any>) => void;
}

const DOUBLE_TAP_THRESHOLD = 300;
const LONG_PRESS_THRESHOLD = 500;

export function ChromeRemoteView({ serverId, onInput }: Props) {
  const { rf, isCompact } = useResponsive();
  const frame = useChromeRemoteStore(s => s.frame[serverId]);
  const status = useChromeRemoteStore(s => s.status[serverId]);
  const latency = useChromeRemoteStore(s => s.latency[serverId] ?? 0);

  const viewSize = useRef({ width: 0, height: 0 });
  const lastTap = useRef(0);
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const keyboardRef = useRef<TextInput>(null);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    viewSize.current = { width, height };
  }, []);

  const getRelativeCoords = useCallback((e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    return {
      x: locationX, y: locationY,
      viewWidth: viewSize.current.width, viewHeight: viewSize.current.height,
    };
  }, []);

  const handleTouchStart = useCallback((e: GestureResponderEvent) => {
    const coords = getRelativeCoords(e);
    longPressTimer.current = setTimeout(() => {
      onInput('rightclick', coords);
      longPressTimer.current = null;
    }, LONG_PRESS_THRESHOLD);
  }, [getRelativeCoords, onInput]);

  const handleTouchEnd = useCallback((e: GestureResponderEvent) => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    } else {
      return; // Long press already fired
    }

    const coords = getRelativeCoords(e);
    const now = Date.now();

    if (now - lastTap.current < DOUBLE_TAP_THRESHOLD) {
      onInput('dblclick', coords);
      lastTap.current = 0;
    } else {
      onInput('click', coords);
      lastTap.current = now;
    }
    keyboardRef.current?.focus();
  }, [getRelativeCoords, onInput]);

  const scrollStart = useRef({ x: 0, y: 0 });

  const handleMove = useCallback((e: GestureResponderEvent) => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    const { locationX, locationY } = e.nativeEvent;
    const deltaX = scrollStart.current.x - locationX;
    const deltaY = scrollStart.current.y - locationY;
    scrollStart.current = { x: locationX, y: locationY };

    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
      onInput('scroll', {
        x: locationX, y: locationY,
        deltaX: deltaX * 2, deltaY: deltaY * 2,
        viewWidth: viewSize.current.width, viewHeight: viewSize.current.height,
      });
    }
  }, [onInput]);

  const handleMoveStart = useCallback((e: GestureResponderEvent) => {
    scrollStart.current = { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY };
    return true;
  }, []);

  const handleKeyInput = useCallback((text: string) => {
    if (!text) return;
    for (const char of text) {
      onInput('key', { key: char, code: `Key${char.toUpperCase()}`, text: char });
    }
  }, [onInput]);

  const handleKeyPress = useCallback((e: any) => {
    const { key } = e.nativeEvent;
    if (key === 'Enter') onInput('key', { key: 'Enter', code: 'Enter' });
    else if (key === 'Backspace') onInput('key', { key: 'Backspace', code: 'Backspace' });
    else if (key === 'Tab') onInput('key', { key: 'Tab', code: 'Tab' });
  }, [onInput]);

  const frameUri = useMemo(() => {
    if (!frame?.data) return null;
    return `data:image/jpeg;base64,${frame.data}`;
  }, [frame?.data]);

  if (status !== 'connected' || !frameUri) {
    return (
      <View style={styles.loading}>
        <Text style={[styles.loadingText, { fontSize: rf(13) }]}>Warte auf Frame...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} onLayout={onLayout}>
      <Image source={{ uri: frameUri }} style={styles.frame} resizeMode="contain" />
      <View
        style={StyleSheet.absoluteFill}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={handleMoveStart as any}
        onResponderGrant={handleTouchStart}
        onResponderMove={handleMove}
        onResponderRelease={handleTouchEnd}
      />
      <TextInput
        ref={keyboardRef}
        style={styles.hiddenInput}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={handleKeyInput}
        onKeyPress={handleKeyPress}
        value=""
        blurOnSubmit={false}
      />
      <View style={[styles.badge, isCompact ? styles.badgeCompact : styles.badgeExpanded]}>
        <Text style={[styles.badgeText, { fontSize: rf(isCompact ? 9 : 11) }]}>
          {isCompact ? `${latency}ms` : `HD \u00b7 ${latency}ms`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  frame: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a1a2e' },
  loadingText: { color: '#778899' },
  hiddenInput: { position: 'absolute', top: -100, left: 0, width: 1, height: 1, opacity: 0 },
  badge: { position: 'absolute', top: 8, right: 8, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 4 },
  badgeCompact: { paddingHorizontal: 6, paddingVertical: 2 },
  badgeExpanded: { paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { color: '#4fc3f7' },
});
