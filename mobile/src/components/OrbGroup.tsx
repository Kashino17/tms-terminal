import React, { useRef, useEffect, useCallback } from 'react';
import {
  Animated,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../theme';

export interface MiniOrbDef {
  id: string;
  icon: React.ReactNode;
  color?: string;
  label: string;
}

interface OrbGroupProps {
  groupId: string;
  label: string;
  vertical: boolean;
  orbs: MiniOrbDef[];
  position: { x: number; y: number };
  editMode: boolean;
  isDropTarget?: boolean;
  onOrbPress: (orbId: string) => void;
  onLongPress: () => void;
  onGroupDragEnd: (x: number, y: number) => void;
  onRotate: () => void;
  onRemoveOrb: (orbId: string) => void;
  onReorderOrb: (fromIdx: number, toIdx: number) => void;
  onDragOrbOut: (orbId: string, absX: number, absY: number) => void;
}

const MINI_SIZE = 40;
const GAP = 4;
const PAD = 5;
const MINI_DRAG_THRESHOLD = 6;
const GROUP_DRAG_THRESHOLD = 16; // higher threshold so group doesn't move accidentally
const LONG_PRESS_MS = 600;
/** Perpendicular distance from bar axis before orb ejects */
const EJECT_PERP_DISTANCE = 50;

export { MINI_SIZE, GAP, PAD };

// ── Draggable Mini Orb (edit mode only) ────────────────────────────────────
// Gets its own PanResponder — NOT a child of the group's PanResponder view.
// Rendered in an absolute overlay so there's no parent responder conflict.
function DraggableMiniOrb({
  orb,
  idx,
  totalOrbs,
  vertical,
  groupPosition,
  onReorder,
  onEject,
}: {
  orb: MiniOrbDef;
  idx: number;
  totalOrbs: number;
  vertical: boolean;
  groupPosition: { x: number; y: number };
  onReorder: (fromIdx: number, toIdx: number) => void;
  onEject: (orbId: string, absX: number, absY: number) => void;
}) {
  const idxRef = useRef(idx);
  const groupPosRef = useRef(groupPosition);
  const onReorderRef = useRef(onReorder);
  const onEjectRef = useRef(onEject);

  idxRef.current = idx;
  groupPosRef.current = groupPosition;
  onReorderRef.current = onReorder;
  onEjectRef.current = onEject;

  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const isDragging = useRef(false);

  const pr = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > MINI_DRAG_THRESHOLD || Math.abs(gs.dy) > MINI_DRAG_THRESHOLD,

      onPanResponderGrant: () => {
        isDragging.current = false;
        Animated.spring(scale, { toValue: 1.15, tension: 250, friction: 12, useNativeDriver: true }).start();
      },

      onPanResponderMove: (_, gs) => {
        if (!isDragging.current && (Math.abs(gs.dx) > MINI_DRAG_THRESHOLD || Math.abs(gs.dy) > MINI_DRAG_THRESHOLD)) {
          isDragging.current = true;
        }
        if (isDragging.current) {
          tx.setValue(gs.dx);
          ty.setValue(gs.dy);
        }
      },

      onPanResponderRelease: (_, gs) => {
        const resetAnims = () => {
          Animated.spring(scale, { toValue: 1, tension: 200, friction: 14, useNativeDriver: true }).start();
          Animated.spring(tx, { toValue: 0, tension: 200, friction: 14, useNativeDriver: true }).start();
          Animated.spring(ty, { toValue: 0, tension: 200, friction: 14, useNativeDriver: true }).start();
        };

        if (!isDragging.current) {
          resetAnims();
          return;
        }

        isDragging.current = false;

        // Key insight: use PERPENDICULAR distance to decide eject vs reorder.
        // For horizontal bar: perpendicular = abs(dy), parallel = dx
        // For vertical bar: perpendicular = abs(dx), parallel = dy
        const isVert = vertical;
        const perpDist = Math.abs(isVert ? gs.dx : gs.dy);
        const paraDist = isVert ? gs.dy : gs.dx;

        if (perpDist > EJECT_PERP_DISTANCE) {
          // Dragged perpendicular to bar axis → eject from group
          const slotX = isVert ? 0 : idxRef.current * (MINI_SIZE + GAP);
          const slotY = isVert ? idxRef.current * (MINI_SIZE + GAP) : 0;
          const absX = groupPosRef.current.x + PAD + slotX + gs.dx;
          const absY = groupPosRef.current.y + PAD + slotY + gs.dy;
          onEjectRef.current(orb.id, absX, absY);
          resetAnims();
        } else {
          // Dragged along bar axis → reorder
          const slotSize = MINI_SIZE + GAP;
          const slotDelta = Math.round(paraDist / slotSize);
          if (slotDelta !== 0) {
            const targetIdx = Math.max(0, Math.min(totalOrbs - 1, idxRef.current + slotDelta));
            if (targetIdx !== idxRef.current) {
              onReorderRef.current(idxRef.current, targetIdx);
            }
          }
          resetAnims();
        }
      },

      onPanResponderTerminate: () => {
        isDragging.current = false;
        Animated.spring(scale, { toValue: 1, tension: 200, friction: 14, useNativeDriver: true }).start();
        Animated.spring(tx, { toValue: 0, tension: 200, friction: 14, useNativeDriver: true }).start();
        Animated.spring(ty, { toValue: 0, tension: 200, friction: 14, useNativeDriver: true }).start();
      },
    }),
  ).current;

  // Position this mini orb at its slot offset from group origin
  const slotX = vertical ? PAD : PAD + idx * (MINI_SIZE + GAP);
  const slotY = vertical ? PAD + idx * (MINI_SIZE + GAP) : PAD;

  return (
    <Animated.View
      {...pr.panHandlers}
      style={{
        position: 'absolute',
        left: slotX,
        top: slotY,
        width: MINI_SIZE,
        height: MINI_SIZE,
        zIndex: 30,
        transform: [{ translateX: tx }, { translateY: ty }, { scale }],
      }}
    >
      <View style={ms.mini}>{orb.icon}</View>
    </Animated.View>
  );
}

// ── OrbGroup ───────────────────────────────────────────────────────────────
export function OrbGroup({
  groupId,
  label,
  vertical,
  orbs,
  position,
  editMode,
  isDropTarget = false,
  onOrbPress,
  onLongPress,
  onGroupDragEnd,
  onRotate,
  onRemoveOrb,
  onReorderOrb,
  onDragOrbOut,
}: OrbGroupProps) {
  const editRef = useRef(editMode);
  const posRef = useRef(position);
  const onLongPressRef = useRef(onLongPress);
  const onDragEndRef = useRef(onGroupDragEnd);

  editRef.current = editMode;
  posRef.current = position;
  onLongPressRef.current = onLongPress;
  onDragEndRef.current = onGroupDragEnd;

  const pan = useRef(new Animated.ValueXY({ x: position.x, y: position.y })).current;
  const wobbleAnim = useRef(new Animated.Value(0)).current;
  const isDragging = useRef(false);
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isDragging.current) pan.setValue({ x: position.x, y: position.y });
  }, [position.x, position.y]);

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

  // Group-level PanResponder: ONLY for long-press detection (to enter edit mode)
  // and for group dragging (only when tapping the glass background, not a mini orb).
  // In edit mode, the DraggableMiniOrb overlay handles mini orb touches directly.
  const groupPR = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) =>
        editRef.current && (Math.abs(gs.dx) > GROUP_DRAG_THRESHOLD || Math.abs(gs.dy) > GROUP_DRAG_THRESHOLD),

      onPanResponderGrant: () => {
        isDragging.current = false;
        lpTimer.current = setTimeout(() => {
          if (!isDragging.current && !editRef.current) {
            onLongPressRef.current();
          }
        }, LONG_PRESS_MS);
      },

      onPanResponderMove: (_, gs) => {
        if (Math.abs(gs.dx) > 5 || Math.abs(gs.dy) > 5) {
          if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null; }
        }
        if (!editRef.current) return;
        if (!isDragging.current && (Math.abs(gs.dx) > GROUP_DRAG_THRESHOLD || Math.abs(gs.dy) > GROUP_DRAG_THRESHOLD)) {
          isDragging.current = true;
        }
        if (isDragging.current) {
          pan.setValue({ x: posRef.current.x + gs.dx, y: posRef.current.y + gs.dy });
        }
      },

      onPanResponderRelease: (_, gs) => {
        if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null; }
        if (isDragging.current) {
          onDragEndRef.current(posRef.current.x + gs.dx, posRef.current.y + gs.dy);
          isDragging.current = false;
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

  // Calculate group dimensions for the glass background
  const groupW = vertical
    ? MINI_SIZE + 2 * PAD
    : orbs.length * MINI_SIZE + (orbs.length - 1) * GAP + 2 * PAD;
  const groupH = vertical
    ? orbs.length * MINI_SIZE + (orbs.length - 1) * GAP + 2 * PAD
    : MINI_SIZE + 2 * PAD;

  return (
    <Animated.View
      style={[
        s.wrap,
        {
          width: groupW,
          height: groupH,
          transform: [
            { translateX: pan.x },
            { translateY: pan.y },
            { rotate },
          ],
        },
      ]}
    >
      {/* Glass background with group panHandlers — this handles long-press and group drag */}
      <View
        {...groupPR.panHandlers}
        style={[s.glass, { width: groupW, height: groupH }, isDropTarget && s.glassDrop]}
      >
        {/* Non-edit mode: render tappable mini orbs inline */}
        {!editMode && (
          <View style={{ flexDirection: vertical ? 'column' : 'row', gap: GAP }}>
            {orbs.map((orb) => (
              <TouchableOpacity
                key={orb.id}
                style={ms.mini}
                onPress={() => onOrbPress(orb.id)}
                onLongPress={onLongPress}
                delayLongPress={LONG_PRESS_MS}
                activeOpacity={0.6}
              >
                {orb.icon}
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      {/* Edit mode: draggable mini orbs as absolute overlay ABOVE the glass
          so they are NOT children of the group panHandlers view */}
      {editMode && orbs.map((orb, idx) => (
        <DraggableMiniOrb
          key={orb.id}
          orb={orb}
          idx={idx}
          totalOrbs={orbs.length}
          vertical={vertical}
          groupPosition={position}
          onReorder={onReorderOrb}
          onEject={onDragOrbOut}
        />
      ))}

      {/* Remove badges */}
      {editMode && orbs.map((orb, i) => {
        const ox = vertical ? MINI_SIZE + PAD - 2 : i * (MINI_SIZE + GAP) + PAD + MINI_SIZE - 4;
        const oy = vertical ? i * (MINI_SIZE + GAP) + PAD - 4 : -4;
        return (
          <TouchableOpacity
            key={`rm-${orb.id}`}
            style={[s.miniRemove, { left: ox, top: oy }]}
            onPress={() => onRemoveOrb(orb.id)}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            <Text style={s.removeText}>✕</Text>
          </TouchableOpacity>
        );
      })}

      {editMode && <Text style={[s.label, { bottom: -16 }]} numberOfLines={1}>{label}</Text>}

      {editMode && (
        <TouchableOpacity
          style={s.rotateBtn}
          onPress={onRotate}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Text style={s.rotateTxt}>↻</Text>
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

const ms = StyleSheet.create({
  mini: {
    width: MINI_SIZE,
    height: MINI_SIZE,
    borderRadius: MINI_SIZE / 2,
    backgroundColor: '#1B2336',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

const s = StyleSheet.create({
  wrap: {
    position: 'absolute',
    zIndex: 12,
  },
  glass: {
    backgroundColor: '#0F172A',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    padding: PAD,
  },
  glassDrop: {
    borderColor: colors.primary,
    borderWidth: 2,
    shadowColor: colors.primary,
    shadowOpacity: 0.4,
    shadowRadius: 14,
  },
  miniRemove: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.destructive,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#0F172A',
    zIndex: 40,
  },
  removeText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: '700',
  },
  label: {
    position: 'absolute',
    left: 0,
    right: 0,
    fontSize: 8,
    color: '#475569',
    textAlign: 'center',
  },
  rotateBtn: {
    position: 'absolute',
    top: -8,
    right: -8,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#0F172A',
    zIndex: 40,
  },
  rotateTxt: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
});
