import React, { useEffect, useRef, useCallback, useState } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Animated,
  StyleSheet, Pressable, Dimensions, PanResponder,
  type GestureResponderEvent, type PanResponderGestureState,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors } from '../theme';

interface ToolPanelSheetProps {
  visible: boolean;
  toolId: string | null;
  onClose: () => void;
  children?: React.ReactNode;
}

interface ToolHeaderConfig {
  title: string;
  subtitle: string;
  icon: keyof typeof Feather.glyphMap;
  color: string;
}

const HEADER_CONFIG: Record<string, ToolHeaderConfig> = {
  autoApprove: { title: 'Auto Approve', subtitle: 'Automatische Bestätigung', icon: 'check-circle', color: '#22C55E' },
  snippets: { title: 'Snippets', subtitle: 'Schnelle Textbausteine', icon: 'zap', color: '#F59E0B' },
  files: { title: 'Dateien', subtitle: 'Datei-Browser', icon: 'folder', color: '#F59E0B' },
  screenshots: { title: 'Screenshots', subtitle: 'Terminal-Aufnahmen', icon: 'camera', color: '#06B6D4' },
  sql: { title: 'SQL', subtitle: 'Datenbank-Abfragen', icon: 'database', color: '#3B82F6' },
  ports: { title: 'Ports', subtitle: 'Port Forwarding', icon: 'share-2', color: '#10B981' },
  autopilot: { title: 'Autopilot', subtitle: 'Automatische Ausführung', icon: 'play-circle', color: '#A78BFA' },
  watchers: { title: 'Watchers', subtitle: 'Datei-Überwachung', icon: 'bell', color: '#F59E0B' },
  render: { title: 'Render', subtitle: 'Render Dashboard', icon: 'box', color: '#6366F1' },
  vercel: { title: 'Vercel', subtitle: 'Vercel Dashboard', icon: 'triangle', color: '#F8FAFC' },
  supabase: { title: 'Supabase', subtitle: 'Supabase Dashboard', icon: 'layers', color: '#3ECF8E' },
};

const SCREEN_HEIGHT = Dimensions.get('window').height;
const MIN_HEIGHT = SCREEN_HEIGHT * 0.4;
const MAX_HEIGHT = SCREEN_HEIGHT * 0.75;
const DEFAULT_HEIGHT = SCREEN_HEIGHT * 0.5;
const DISMISS_THRESHOLD = 80;

export function ToolPanelSheet({ visible, toolId, onClose, children }: ToolPanelSheetProps) {
  // ALL animations use useNativeDriver: false because we animate `height`
  // which is a layout property not supported by the native animated module.
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const [sheetHeight, setSheetHeight] = useState(DEFAULT_HEIGHT);
  const currentHeight = useRef(DEFAULT_HEIGHT);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (visible) {
      currentHeight.current = DEFAULT_HEIGHT;
      setSheetHeight(DEFAULT_HEIGHT);
      translateY.setValue(SCREEN_HEIGHT);
      backdropOpacity.setValue(0);
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, tension: 120, friction: 16, useNativeDriver: false }),
        Animated.timing(backdropOpacity, { toValue: 1, duration: 200, useNativeDriver: false }),
      ]).start();
    }
  }, [visible]);

  const dismiss = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: SCREEN_HEIGHT, duration: 200, useNativeDriver: false }),
      Animated.timing(backdropOpacity, { toValue: 0, duration: 200, useNativeDriver: false }),
    ]).start(() => onCloseRef.current());
  }, []);

  // Drag handle to resize
  const dragStartHeight = useRef(DEFAULT_HEIGHT);
  const handlePR = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e: GestureResponderEvent, gs: PanResponderGestureState) =>
        Math.abs(gs.dy) > 4,

      onPanResponderGrant: () => {
        dragStartHeight.current = currentHeight.current;
      },

      onPanResponderMove: (_e: GestureResponderEvent, gs: PanResponderGestureState) => {
        const newH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, dragStartHeight.current - gs.dy));
        currentHeight.current = newH;
        setSheetHeight(newH);
      },

      onPanResponderRelease: (_e: GestureResponderEvent, gs: PanResponderGestureState) => {
        if (gs.dy > DISMISS_THRESHOLD && gs.vy > 0.3) {
          dismiss();
          return;
        }
        // Snap
        const h = currentHeight.current;
        let target = DEFAULT_HEIGHT;
        if (h > (DEFAULT_HEIGHT + MAX_HEIGHT) / 2) target = MAX_HEIGHT;
        else if (h < (MIN_HEIGHT + DEFAULT_HEIGHT) / 2) target = MIN_HEIGHT;
        currentHeight.current = target;
        setSheetHeight(target);
      },
    }),
  ).current;

  if (!visible || !toolId) return null;

  const config = HEADER_CONFIG[toolId];
  const title = config?.title ?? toolId;
  const subtitle = config?.subtitle ?? '';
  const iconName = config?.icon ?? ('tool' as keyof typeof Feather.glyphMap);
  const iconColor = config?.color ?? colors.primary;

  return (
    <Modal transparent visible animationType="none" onRequestClose={dismiss}>
      <Pressable style={StyleSheet.absoluteFill} onPress={dismiss}>
        <Animated.View style={[st.backdrop, { opacity: backdropOpacity }]} />
      </Pressable>

      <Animated.View
        style={[
          st.sheet,
          {
            height: sheetHeight,
            transform: [{ translateY }],
          },
        ]}
      >
        {/* Drag handle */}
        <View {...handlePR.panHandlers} style={st.handleZone}>
          <View style={st.handle} />
        </View>

        {/* Header */}
        <View style={st.header}>
          <View style={[st.iconBadge, { backgroundColor: iconColor + '18' }]}>
            <Feather name={iconName} size={18} color={iconColor} />
          </View>
          <View style={st.headerText}>
            <Text style={st.headerTitle}>{title}</Text>
            {subtitle !== '' && <Text style={st.headerSub}>{subtitle}</Text>}
          </View>
          <TouchableOpacity style={st.closeBtn} onPress={dismiss} hitSlop={8}>
            <Feather name="x" size={18} color={colors.textDim} />
          </TouchableOpacity>
        </View>

        {/* Body */}
        <View style={st.body}>
          {children}
        </View>
      </Animated.View>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#0F172A',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderBottomWidth: 0,
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    overflow: 'hidden',
  },
  handleZone: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 6,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    gap: 10,
  },
  iconBadge: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
  },
  headerSub: {
    fontSize: 10,
    color: '#64748B',
    marginTop: 1,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  body: {
    flex: 1,
  },
});
