import React, { useRef, useEffect } from 'react';
import {
  Animated,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../theme';

interface LiquidOrbProps {
  id: string;
  icon: React.ReactNode;
  label: string;
  color?: string;
  position: { x: number; y: number };
  editMode: boolean;
  isDropTarget?: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onDragStart: () => void;
  onDragMove: (x: number, y: number) => void;
  onDragEnd: (x: number, y: number) => void;
  onRemove: () => void;
  recording?: boolean;
}

const ORB_SIZE = 48;
const LONG_PRESS_MS = 600;
const DRAG_THRESHOLD = 6;

export { ORB_SIZE };

export function LiquidOrb({
  id,
  icon,
  label,
  color,
  position,
  editMode,
  isDropTarget = false,
  onPress,
  onLongPress,
  onDragStart,
  onDragMove,
  onDragEnd,
  onRemove,
  recording = false,
}: LiquidOrbProps) {
  // ── Refs to avoid stale closures in PanResponder ─────────────────────
  const editModeRef = useRef(editMode);
  const positionRef = useRef(position);
  const onPressRef = useRef(onPress);
  const onLongPressRef = useRef(onLongPress);
  const onDragStartRef = useRef(onDragStart);
  const onDragMoveRef = useRef(onDragMove);
  const onDragEndRef = useRef(onDragEnd);

  editModeRef.current = editMode;
  positionRef.current = position;
  onPressRef.current = onPress;
  onLongPressRef.current = onLongPress;
  onDragStartRef.current = onDragStart;
  onDragMoveRef.current = onDragMove;
  onDragEndRef.current = onDragEnd;

  // ── Animated values ──────────────────────────────────────────────────
  const pan = useRef(new Animated.ValueXY({ x: position.x, y: position.y })).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const wobbleAnim = useRef(new Animated.Value(0)).current;

  const isDragging = useRef(false);
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync position from props when NOT dragging
  useEffect(() => {
    if (!isDragging.current) {
      pan.setValue({ x: position.x, y: position.y });
    }
  }, [position.x, position.y]);

  // Wobble in edit mode
  useEffect(() => {
    if (editMode) {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(wobbleAnim, { toValue: -1, duration: 100, useNativeDriver: true }),
          Animated.timing(wobbleAnim, { toValue: 0, duration: 100, useNativeDriver: true }),
          Animated.timing(wobbleAnim, { toValue: 1, duration: 100, useNativeDriver: true }),
          Animated.timing(wobbleAnim, { toValue: 0, duration: 100, useNativeDriver: true }),
        ]),
      );
      anim.start();
      return () => { anim.stop(); wobbleAnim.setValue(0); };
    }
    wobbleAnim.setValue(0);
  }, [editMode]);

  // Drop target scale
  useEffect(() => {
    Animated.spring(scaleAnim, {
      toValue: isDropTarget ? 1.25 : 1,
      tension: 200,
      friction: 15,
      useNativeDriver: true,
    }).start();
  }, [isDropTarget]);

  // ── PanResponder ─────────────────────────────────────────────────────
  // FIX Bug 2: Don't unconditionally claim onStart.
  // Instead, always return false for onStart and use onMove to conditionally claim
  // when in edit mode with sufficient movement.
  // Long-press is handled via a timer started in onResponderGrant.
  // For taps: handle via onResponderRelease when dx/dy are small.
  const panResponder = useRef(
    PanResponder.create({
      // Always claim the touch — needed for tap detection + long-press timer
      onStartShouldSetPanResponder: () => true,
      // In edit mode, claim movement for drag if threshold exceeded
      onMoveShouldSetPanResponder: (_, gs) =>
        editModeRef.current && (Math.abs(gs.dx) > DRAG_THRESHOLD || Math.abs(gs.dy) > DRAG_THRESHOLD),

      onPanResponderGrant: () => {
        isDragging.current = false;
        // Start long-press timer
        // FIX Bug 3: Only fire long-press to ENTER edit mode, not to toggle it off
        lpTimer.current = setTimeout(() => {
          if (!isDragging.current && !editModeRef.current) {
            onLongPressRef.current();
          }
        }, LONG_PRESS_MS);
      },

      onPanResponderMove: (_, gs) => {
        // Cancel long-press on any significant movement
        if (Math.abs(gs.dx) > 3 || Math.abs(gs.dy) > 3) {
          if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null; }
        }

        // Only drag in edit mode
        if (!editModeRef.current) return;

        if (!isDragging.current && (Math.abs(gs.dx) > DRAG_THRESHOLD || Math.abs(gs.dy) > DRAG_THRESHOLD)) {
          isDragging.current = true;
          onDragStartRef.current();
        }

        if (isDragging.current) {
          const newX = positionRef.current.x + gs.dx;
          const newY = positionRef.current.y + gs.dy;
          pan.setValue({ x: newX, y: newY });
          onDragMoveRef.current(newX, newY);
        }
      },

      onPanResponderRelease: (_, gs) => {
        if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null; }

        if (isDragging.current) {
          const finalX = positionRef.current.x + gs.dx;
          const finalY = positionRef.current.y + gs.dy;
          // FIX Bug 1: Call onDragEnd BEFORE setting isDragging=false
          // so the useEffect position sync doesn't snap-back during the callback
          onDragEndRef.current(finalX, finalY);
          isDragging.current = false;
        } else {
          // It was a tap — only fire action if NOT in edit mode
          if (!editModeRef.current) {
            onPressRef.current();
          }
          // In edit mode, tap does nothing (prevents accidental action execution)
        }
      },

      onPanResponderTerminate: () => {
        if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null; }
        isDragging.current = false;
      },
    }),
  ).current;

  const rotate = wobbleAnim.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: ['-1.5deg', '0deg', '1.5deg'],
  });

  return (
    <Animated.View
      {...panResponder.panHandlers}
      style={[
        s.wrap,
        {
          transform: [
            { translateX: pan.x },
            { translateY: pan.y },
            { scale: scaleAnim },
            { rotate },
          ],
        },
      ]}
    >
      <View style={[s.orb, isDropTarget && s.orbDrop, recording && s.orbRec]}>
        {icon}
      </View>

      {editMode && <Text style={s.label} numberOfLines={1}>{label}</Text>}

      {editMode && (
        <TouchableOpacity
          style={s.remove}
          onPress={onRemove}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={s.removeText}>✕</Text>
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrap: {
    position: 'absolute',
    width: ORB_SIZE,
    height: ORB_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 12,
  },
  orb: {
    width: ORB_SIZE,
    height: ORB_SIZE,
    borderRadius: ORB_SIZE / 2,
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orbDrop: {
    borderColor: colors.primary,
    borderWidth: 2,
    shadowColor: colors.primary,
    shadowOpacity: 0.5,
    shadowRadius: 14,
  },
  orbRec: {
    borderColor: 'rgba(239,68,68,0.5)',
    borderWidth: 2,
    shadowColor: '#EF4444',
    shadowOpacity: 0.4,
    shadowRadius: 12,
  },
  label: {
    position: 'absolute',
    bottom: -14,
    fontSize: 8,
    color: '#475569',
    textAlign: 'center',
    maxWidth: 70,
  },
  remove: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.destructive,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#0F172A',
    zIndex: 2,
  },
  removeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
  },
});
