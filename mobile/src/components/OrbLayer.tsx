import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  Animated,
  ActivityIndicator,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  FlatList,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { colors, spacing } from '../theme';
import { useOrbLayoutStore } from '../store/orbLayoutStore';
import { useSettingsStore } from '../store/settingsStore';
import { LiquidOrb, ORB_SIZE } from './LiquidOrb';
import { OrbGroup, MINI_SIZE, GAP, PAD } from './OrbGroup';

// ── Types ──────────────────────────────────────────────────────────────────────
interface OrbLayerProps {
  sessionId: string | undefined;
  wsService: any;
  onScrollToBottom: () => void;
  onOpenTools: (position: { x: number; y: number }) => void;
  onOpenSpotlight: () => void;
  onOpenManager: () => void;
  onRangeToggle: () => void;
  rangeActive: boolean;
  containerSize: { width: number; height: number };
  keyboardVisible: boolean;
  keyboardHeight: number;
  onTranscription?: (text: string) => void;
}

interface OrbDefinition {
  label: string;
  icon: (size: number, color: string) => React.ReactNode;
  color: string;
  action: string;
}

// ── Orb Definitions ────────────────────────────────────────────────────────────
// Icon sizes: free orbs get bigger icons, mini orbs in groups get slightly smaller
const FREE_ICON = 22;
const MINI_ICON = 18;
const FREE_TEXT = 18;
const MINI_TEXT = 16;

const ORB_DEFINITIONS: Record<string, OrbDefinition> = {
  ctrl_c: {
    label: 'Ctrl+C',
    color: '#EF4444',
    action: 'input:\x03',
    icon: (size, color) => (
      <Text style={{ fontSize: size > 44 ? FREE_TEXT : MINI_TEXT, fontWeight: '700', color, fontFamily: 'monospace' }}>^C</Text>
    ),
  },
  esc: {
    label: 'Escape',
    color: '#94A3B8',
    action: 'input:\x1b',
    icon: (size, color) => (
      <Text style={{ fontSize: size > 44 ? FREE_TEXT - 2 : MINI_TEXT - 2, fontWeight: '600', color, fontFamily: 'monospace' }}>Esc</Text>
    ),
  },
  clear: {
    label: 'Clear',
    color: '#94A3B8',
    action: 'clear',
    icon: (size, color) => <Feather name="trash-2" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  delete: {
    label: 'Delete',
    color: '#94A3B8',
    action: 'input:\x15',
    icon: (size, color) => (
      <Text style={{ fontSize: size > 44 ? FREE_TEXT : MINI_TEXT, color }}>⌫</Text>
    ),
  },
  scissors: {
    label: 'Ausschneiden',
    color: '#94A3B8',
    action: 'range',
    icon: (size, color) => <Feather name="scissors" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  scroll: {
    label: 'Scroll',
    color: '#06B6D4',
    action: 'scroll',
    icon: (size, color) => <Feather name="chevrons-down" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  enter: {
    label: 'Enter',
    color: '#94A3B8',
    action: 'input:\r',
    icon: (size, color) => <Feather name="corner-down-left" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  tools: {
    label: 'Tools',
    color: '#94A3B8',
    action: 'tools',
    icon: (size, color) => <Feather name="tool" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  spotlight: {
    label: 'Spotlight',
    color: '#94A3B8',
    action: 'spotlight',
    icon: (size, color) => <Feather name="search" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  dpad: {
    label: 'D-Pad',
    color: '#3B82F6',
    action: 'dpad',
    icon: (size, color) => <Feather name="move" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  mic: {
    label: 'Mikrofon',
    color: '#94A3B8',
    action: 'mic',
    icon: (size, color) => <Feather name="mic" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  manager: {
    label: 'Manager',
    color: '#A78BFA',
    action: 'manager',
    icon: (size, color) => <Feather name="cpu" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
};

const DOCK_ORB_SIZE = 42;
const DOCK_SLOT = DOCK_ORB_SIZE + 6; // orb + gap
const DROP_PROXIMITY_ORB = 60;
const DROP_PROXIMITY_GROUP = 40;

// ── Draggable Dock Orb (edit mode) ────────────────────────────────────────
function DraggableDockOrb({
  orbId,
  idx,
  totalOrbs,
  icon,
  onReorder,
  onRemove,
}: {
  orbId: string;
  idx: number;
  totalOrbs: number;
  icon: React.ReactNode;
  onReorder: (from: number, to: number) => void;
  onRemove: () => void;
}) {
  const idxRef = useRef(idx);
  const onReorderRef = useRef(onReorder);
  idxRef.current = idx;
  onReorderRef.current = onReorder;

  const tx = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const isDragging = useRef(false);

  const pr = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e: GestureResponderEvent, gs: PanResponderGestureState) => Math.abs(gs.dx) > 4,

      onPanResponderGrant: () => {
        isDragging.current = false;
        Animated.spring(scale, { toValue: 1.2, tension: 250, friction: 10, useNativeDriver: true }).start();
      },

      onPanResponderMove: (_e: GestureResponderEvent, gs: PanResponderGestureState) => {
        if (!isDragging.current && Math.abs(gs.dx) > 4) isDragging.current = true;
        if (isDragging.current) tx.setValue(gs.dx);
      },

      onPanResponderRelease: (_e: GestureResponderEvent, gs: PanResponderGestureState) => {
        Animated.spring(scale, { toValue: 1, tension: 200, friction: 14, useNativeDriver: true }).start();

        if (isDragging.current) {
          isDragging.current = false;
          const slotDelta = Math.round(gs.dx / DOCK_SLOT);
          if (slotDelta !== 0) {
            const target = Math.max(0, Math.min(totalOrbs - 1, idxRef.current + slotDelta));
            if (target !== idxRef.current) onReorderRef.current(idxRef.current, target);
          }
        }
        Animated.spring(tx, { toValue: 0, tension: 200, friction: 14, useNativeDriver: true }).start();
      },

      onPanResponderTerminate: () => {
        isDragging.current = false;
        Animated.spring(scale, { toValue: 1, tension: 200, friction: 14, useNativeDriver: true }).start();
        Animated.spring(tx, { toValue: 0, tension: 200, friction: 14, useNativeDriver: true }).start();
      },
    }),
  ).current;

  return (
    <Animated.View
      {...pr.panHandlers}
      style={{ transform: [{ translateX: tx }, { scale }], zIndex: 20, position: 'relative' }}
    >
      <View style={dockOrbStyle}>{icon}</View>
      <TouchableOpacity
        style={dockRemoveStyle}
        onPress={onRemove}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Text style={{ color: '#fff', fontSize: 8, fontWeight: '700' }}>✕</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const dockOrbStyle: any = {
  width: DOCK_ORB_SIZE,
  height: DOCK_ORB_SIZE,
  borderRadius: DOCK_ORB_SIZE / 2,
  backgroundColor: '#1B2336',
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.08)',
  alignItems: 'center',
  justifyContent: 'center',
};

const dockRemoveStyle: any = {
  position: 'absolute',
  top: -4,
  right: -4,
  width: 16,
  height: 16,
  borderRadius: 8,
  backgroundColor: '#EF4444',
  alignItems: 'center',
  justifyContent: 'center',
  borderWidth: 2,
  borderColor: '#0F172A',
  zIndex: 5,
};

// ── Component ──────────────────────────────────────────────────────────────────
export function OrbLayer({
  sessionId,
  wsService,
  onScrollToBottom,
  onOpenTools,
  onOpenSpotlight,
  onOpenManager,
  onRangeToggle,
  rangeActive,
  containerSize,
  keyboardVisible,
  keyboardHeight,
  onTranscription,
}: OrbLayerProps) {
  // ── Store ────────────────────────────────────────────────────────────────
  const freeOrbs = useOrbLayoutStore((s) => s.freeOrbs);
  const groups = useOrbLayoutStore((s) => s.groups);
  const removedOrbIds = useOrbLayoutStore((s) => s.removedOrbIds);
  const dockOrder = useOrbLayoutStore((s) => s.dockOrder);
  const setOrbPosition = useOrbLayoutStore((s) => s.setOrbPosition);
  const setGroupPosition = useOrbLayoutStore((s) => s.setGroupPosition);
  const toggleGroupOrientation = useOrbLayoutStore((s) => s.toggleGroupOrientation);
  const removeOrb = useOrbLayoutStore((s) => s.removeOrb);
  const restoreOrb = useOrbLayoutStore((s) => s.restoreOrb);
  const createGroup = useOrbLayoutStore((s) => s.createGroup);
  const addOrbToGroup = useOrbLayoutStore((s) => s.addOrbToGroup);
  const removeOrbFromGroup = useOrbLayoutStore((s) => s.removeOrbFromGroup);
  const reorderInGroup = useOrbLayoutStore((s) => s.reorderInGroup);
  const reorderDock = useOrbLayoutStore((s) => s.reorderDock);
  const addToDock = useOrbLayoutStore((s) => s.addToDock);
  const removeFromDock = useOrbLayoutStore((s) => s.removeFromDock);

  // ── Local state ──────────────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [dockEditMode, setDockEditMode] = useState(false);
  const [dockPickerVisible, setDockPickerVisible] = useState(false);
  const [dropTargetOrbId, setDropTargetOrbId] = useState<string | null>(null);
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
  const [dpadOpen, setDpadOpen] = useState(false);

  // ── Mic recording state (fully internal) ────────────────────────────────
  const [micState, setMicState] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [micDuration, setMicDuration] = useState(0);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const micTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioInputEnabled = useSettingsStore((s) => (s as any).audioInputEnabled ?? true);

  // Listen for transcription result from server
  useEffect(() => {
    if (!wsService) return;
    const handler = (msg: unknown) => {
      const m = msg as { type: string; sessionId?: string; payload?: any };
      if (m.sessionId !== sessionId) return;
      if (m.type === 'audio:transcription') {
        setMicState('idle');
        onTranscription?.(m.payload?.text ?? '');
      }
    };
    return wsService.addMessageListener(handler);
  }, [wsService, sessionId, onTranscription]);

  const handleMicPress = useCallback(async () => {
    if (micState === 'processing') return;

    if (micState === 'recording') {
      // Stop and send
      if (micTimerRef.current) { clearInterval(micTimerRef.current); micTimerRef.current = null; }
      setMicState('processing');
      try {
        const rec = recordingRef.current;
        if (!rec) { setMicState('idle'); return; }
        await rec.stopAndUnloadAsync();
        const uri = rec.getURI();
        recordingRef.current = null;
        if (!uri || !sessionId) { setMicState('idle'); return; }
        const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
        await FileSystem.deleteAsync(uri, { idempotent: true });
        wsService?.send({ type: 'audio:transcribe', sessionId, payload: { audio: base64, format: 'wav' } });
      } catch (err) {
        console.warn('[mic] stop error:', err);
        setMicState('idle');
      }
      return;
    }

    // Start recording
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) return;
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync({
        android: { extension: '.wav', outputFormat: 3, audioEncoder: 1, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000 },
        ios: { extension: '.wav', audioQuality: 96, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false, outputFormat: 'lpcm' },
        web: {},
      });
      recordingRef.current = recording;
      setMicDuration(0);
      setMicState('recording');
      micTimerRef.current = setInterval(() => setMicDuration(d => d + 1), 1000);
    } catch (err) {
      console.warn('[mic] start error:', err);
      setMicState('idle');
    }
  }, [micState, sessionId, wsService]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (micTimerRef.current) clearInterval(micTimerRef.current);
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
    };
  }, []);

  // ── Helper: find orb position (works for both free and in-group) ────────
  const findOrbPosition = useCallback((orbId: string): { x: number; y: number } | null => {
    // Check free orbs
    const free = freeOrbs[orbId];
    if (free) return { x: free.xPct * containerSize.width, y: free.yPct * containerSize.height };
    // Check groups
    for (const group of groups) {
      const idx = group.orbIds.indexOf(orbId);
      if (idx >= 0) {
        const gx = group.position.xPct * containerSize.width;
        const gy = group.position.yPct * containerSize.height;
        const ox = group.vertical ? PAD : PAD + idx * (MINI_SIZE + GAP);
        const oy = group.vertical ? PAD + idx * (MINI_SIZE + GAP) : PAD;
        return { x: gx + ox, y: gy + oy };
      }
    }
    return null;
  }, [freeOrbs, groups, containerSize]);

  // Track which orb is being dragged
  const draggingOrbIdRef = useRef<string | null>(null);

  // ── Dock entry animations ────────────────────────────────────────────────
  const dockScaleAnims = useRef<Animated.Value[]>([]);

  // Ensure we have enough animated values for dock orbs
  const availableDockOrbs = useMemo(
    () => dockOrder.filter((id) => !removedOrbIds.includes(id)),
    [dockOrder, removedOrbIds],
  );

  useEffect(() => {
    // Grow or shrink the anim array to match dock count
    while (dockScaleAnims.current.length < availableDockOrbs.length) {
      dockScaleAnims.current.push(new Animated.Value(0));
    }
  }, [availableDockOrbs.length]);

  useEffect(() => {
    if (keyboardVisible) {
      // Stagger scale-in for dock orbs
      const anims = availableDockOrbs.map((_, i) => {
        const anim = dockScaleAnims.current[i];
        if (!anim) return null;
        anim.setValue(0);
        return Animated.timing(anim, {
          toValue: 1,
          duration: 180,
          delay: i * 40,
          useNativeDriver: true,
        });
      }).filter(Boolean) as Animated.CompositeAnimation[];
      Animated.parallel(anims).start();
    } else {
      // Reset all to 0
      dockScaleAnims.current.forEach((a) => a.setValue(0));
    }
  }, [keyboardVisible, availableDockOrbs]);

  // ── Action routing ───────────────────────────────────────────────────────
  const handleOrbAction = useCallback(
    (orbId: string, posX?: number, posY?: number) => {
      const def = ORB_DEFINITIONS[orbId];
      if (!def) return;

      const { action } = def;

      if (action.startsWith('input:')) {
        const data = action.slice(6);
        if (sessionId && wsService) {
          wsService.send({ type: 'terminal:input', sessionId, payload: { data } });
        }
        return;
      }

      switch (action) {
        case 'clear':
          if (sessionId && wsService) {
            wsService.send({ type: 'terminal:clear', sessionId });
          }
          break;
        case 'scroll':
          onScrollToBottom();
          break;
        case 'range':
          onRangeToggle();
          break;
        case 'tools':
          onOpenTools({ x: posX ?? 0, y: posY ?? 0 });
          break;
        case 'spotlight':
          onOpenSpotlight();
          break;
        case 'manager':
          onOpenManager();
          break;
        case 'mic':
          handleMicPress();
          break;
        case 'dpad':
          setDpadOpen(prev => !prev);
          break;
      }
    },
    [sessionId, wsService, onScrollToBottom, onRangeToggle, onOpenTools, onOpenSpotlight, onOpenManager, handleMicPress],
  );

  // ── Drag helpers ─────────────────────────────────────────────────────────
  const findDropTarget = useCallback(
    (draggedId: string, x: number, y: number) => {
      // Center of dragged orb
      const cx = x + ORB_SIZE / 2;
      const cy = y + ORB_SIZE / 2;

      // Check proximity to other free orbs (center-to-center distance)
      for (const [id, pos] of Object.entries(freeOrbs)) {
        if (id === draggedId) continue;
        const ox = pos.xPct * containerSize.width + ORB_SIZE / 2;
        const oy = pos.yPct * containerSize.height + ORB_SIZE / 2;
        const dist = Math.sqrt((cx - ox) ** 2 + (cy - oy) ** 2);
        if (dist < DROP_PROXIMITY_ORB) {
          return { type: 'orb' as const, id };
        }
      }

      // Check if dragged orb overlaps with a group's bounding box
      // FIX Bug 6: compute actual group dimensions instead of hard-coded offsets
      for (const group of groups) {
        const numOrbs = group.orbIds.length;
        const gx = group.position.xPct * containerSize.width;
        const gy = group.position.yPct * containerSize.height;

        let gw: number, gh: number;
        if (group.vertical) {
          gw = MINI_SIZE + 2 * PAD;
          gh = numOrbs * MINI_SIZE + (numOrbs - 1) * GAP + 2 * PAD;
        } else {
          gw = numOrbs * MINI_SIZE + (numOrbs - 1) * GAP + 2 * PAD;
          gh = MINI_SIZE + 2 * PAD;
        }

        // Check if orb center is within expanded group bounds
        const pad = DROP_PROXIMITY_GROUP;
        if (cx >= gx - pad && cx <= gx + gw + pad && cy >= gy - pad && cy <= gy + gh + pad) {
          return { type: 'group' as const, id: group.id };
        }
      }

      return null;
    },
    [freeOrbs, groups, containerSize],
  );

  const handleDragStart = useCallback((orbId: string) => {
    draggingOrbIdRef.current = orbId;
  }, []);

  const handleDragMove = useCallback(
    (orbId: string, x: number, y: number) => {
      const target = findDropTarget(orbId, x, y);
      setDropTargetOrbId(target?.type === 'orb' ? target.id : null);
      setDropTargetGroupId(target?.type === 'group' ? target.id : null);
    },
    [findDropTarget],
  );

  const handleDragEnd = useCallback(
    (orbId: string, x: number, y: number) => {
      draggingOrbIdRef.current = null;
      const target = findDropTarget(orbId, x, y);

      if (target?.type === 'group') {
        addOrbToGroup(target.id, orbId);
      } else if (target?.type === 'orb') {
        const midX = (x + (freeOrbs[target.id]?.xPct ?? 0) * containerSize.width) / 2;
        const midY = (y + (freeOrbs[target.id]?.yPct ?? 0) * containerSize.height) / 2;
        createGroup(orbId, target.id, {
          xPct: containerSize.width > 0 ? midX / containerSize.width : 0,
          yPct: containerSize.height > 0 ? midY / containerSize.height : 0,
        });
      } else {
        // Drop on empty space — update position
        setOrbPosition(orbId, {
          xPct: containerSize.width > 0 ? x / containerSize.width : 0,
          yPct: containerSize.height > 0 ? y / containerSize.height : 0,
        });
      }

      setDropTargetOrbId(null);
      setDropTargetGroupId(null);
    },
    [findDropTarget, freeOrbs, containerSize, addOrbToGroup, createGroup, setOrbPosition],
  );

  // ── Long press → toggle edit mode ────────────────────────────────────────
  const handleLongPress = useCallback(() => {
    setEditMode((prev) => !prev);
  }, []);

  // ── Orb picker ───────────────────────────────────────────────────────────
  const handleRestoreOrb = useCallback(
    (id: string) => {
      // Restore to center of container
      restoreOrb(id, {
        xPct: 0.45,
        yPct: 0.5,
      });
      setPickerVisible(false);
    },
    [restoreOrb],
  );

  const pickerOrbs = useMemo(
    () =>
      removedOrbIds
        .map((id) => {
          const def = ORB_DEFINITIONS[id];
          if (!def) return null;
          return { id, ...def };
        })
        .filter(Boolean) as (OrbDefinition & { id: string })[],
    [removedOrbIds],
  );

  // ── Dock separator logic ─────────────────────────────────────────────────
  // Insert separators between logical groups in dock based on original layout:
  // Group 1: aktionen orbs, Group 2: navigation orbs, Group 3: free orbs
  const DOCK_SEPARATOR_AFTER = new Set(['scissors', 'spotlight']);

  // ── Render ───────────────────────────────────────────────────────────────
  const showMainOrbs = !keyboardVisible;

  // Reset dock edit mode and dpad when keyboard closes
  useEffect(() => {
    if (!keyboardVisible) {
      setDockEditMode(false);
      setDockPickerVisible(false);
      setDpadOpen(false); // close dpad arrows when keyboard closes
    }
  }, [keyboardVisible]);

  return (
    <View style={s.root} pointerEvents="box-none">
      {/* ── Free Orbs ─────────────────────────────────────────────────────── */}
      {showMainOrbs &&
        Object.entries(freeOrbs).map(([id, pos]) => {
          const def = ORB_DEFINITIONS[id];
          if (!def) return null;

          const absX = pos.xPct * containerSize.width;
          const absY = pos.yPct * containerSize.height;

          return (
            <LiquidOrb
              key={id}
              id={id}
              icon={def.icon(ORB_SIZE + 1, def.color === '#94A3B8' ? '#94A3B8' : def.color)}
              label={def.label}
              color={def.color}
              position={{ x: absX, y: absY }}
              editMode={editMode}
              isDropTarget={dropTargetOrbId === id}
              onPress={() => handleOrbAction(id, absX, absY)}
              onLongPress={handleLongPress}
              onDragStart={() => handleDragStart(id)}
              onDragMove={(x, y) => handleDragMove(id, x, y)}
              onDragEnd={(x, y) => handleDragEnd(id, x, y)}
              onRemove={() => removeOrb(id)}
              recording={id === 'mic' ? micState === 'recording' : false}
            />
          );
        })}

      {/* ── Groups ────────────────────────────────────────────────────────── */}
      {showMainOrbs &&
        groups.map((group) => {
          const miniOrbs = group.orbIds
            .map((orbId) => {
              const def = ORB_DEFINITIONS[orbId];
              if (!def) return null;
              return {
                id: orbId,
                icon: def.icon(40, def.color === '#94A3B8' ? '#94A3B8' : def.color),
                color: def.color,
                label: def.label,
              };
            })
            .filter(Boolean) as { id: string; icon: React.ReactNode; color: string; label: string }[];

          const absX = group.position.xPct * containerSize.width;
          const absY = group.position.yPct * containerSize.height;

          return (
            <OrbGroup
              key={group.id}
              groupId={group.id}
              label={group.label}
              vertical={group.vertical}
              orbs={miniOrbs}
              position={{ x: absX, y: absY }}
              editMode={editMode}
              isDropTarget={dropTargetGroupId === group.id}
              onOrbPress={(orbId) => handleOrbAction(orbId, absX, absY)}
              onLongPress={handleLongPress}
              onGroupDragEnd={(x, y) => {
                setGroupPosition(group.id, {
                  xPct: containerSize.width > 0 ? x / containerSize.width : 0,
                  yPct: containerSize.height > 0 ? y / containerSize.height : 0,
                });
              }}
              onRotate={() => toggleGroupOrientation(group.id)}
              onRemoveOrb={(orbId) => removeOrbFromGroup(group.id, orbId)}
              onReorderOrb={(from, to) => reorderInGroup(group.id, from, to)}
              onDragOrbOut={(orbId, absX, absY) => {
                // Remove orb from group and place as free orb at the drop position
                removeOrbFromGroup(group.id, orbId);
                setOrbPosition(orbId, {
                  xPct: containerSize.width > 0 ? absX / containerSize.width : 0.5,
                  yPct: containerSize.height > 0 ? absY / containerSize.height : 0.5,
                });
              }}
            />
          );
        })}

      {/* ── Edit Bar ──────────────────────────────────────────────────────── */}
      {editMode && (
        <View style={s.editBar}>
          <Text style={s.editBarTitle}>Bearbeitungsmodus</Text>
          <View style={s.editBarActions}>
            <TouchableOpacity
              style={s.editBarBtn}
              onPress={() => setPickerVisible(true)}
              activeOpacity={0.7}
            >
              <Feather name="plus-circle" size={16} color={colors.primary} />
              <Text style={s.editBarBtnText}>Orb</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.editBarDoneBtn}
              onPress={() => setEditMode(false)}
              activeOpacity={0.7}
            >
              <Text style={s.editBarDoneText}>Fertig</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Keyboard Dock ─────────────────────────────────────────────────── */}
      {keyboardVisible && (
        <View style={[s.dock, { bottom: 4 }]}>
          {/* Dock edit bar */}
          {dockEditMode && (
            <View style={s.dockEditBar}>
              <Text style={s.dockEditTitle}>Dock bearbeiten</Text>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <TouchableOpacity style={s.dockEditAddBtn} onPress={() => setDockPickerVisible(true)}>
                  <Feather name="plus" size={14} color={colors.primary} />
                </TouchableOpacity>
                <TouchableOpacity style={s.dockEditDoneBtn} onPress={() => setDockEditMode(false)}>
                  <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>Fertig</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Dock orbs */}
          <View style={s.dockOrbRow}>
            {availableDockOrbs.map((id, i) => {
              const def = ORB_DEFINITIONS[id];
              if (!def) return null;
              const scaleVal = dockScaleAnims.current[i] ?? new Animated.Value(1);
              const showSeparator = DOCK_SEPARATOR_AFTER.has(id);

              return (
                <React.Fragment key={id}>
                  {dockEditMode ? (
                    <DraggableDockOrb
                      orbId={id}
                      idx={i}
                      totalOrbs={availableDockOrbs.length}
                      icon={def.icon(DOCK_ORB_SIZE + 1, def.color === '#94A3B8' ? '#94A3B8' : def.color)}
                      onReorder={(fromIdx, toIdx) => reorderDock(fromIdx, toIdx)}
                      onRemove={() => removeFromDock(id)}
                    />
                  ) : (
                    <Animated.View style={{ transform: [{ scale: scaleVal }] }}>
                      <TouchableOpacity
                        style={s.dockOrb}
                        onPress={() => handleOrbAction(id)}
                        onLongPress={() => setDockEditMode(true)}
                        delayLongPress={600}
                        activeOpacity={0.6}
                      >
                        {def.icon(DOCK_ORB_SIZE + 1, def.color === '#94A3B8' ? '#94A3B8' : def.color)}
                      </TouchableOpacity>
                    </Animated.View>
                  )}
                  {showSeparator && !dockEditMode && <View style={s.dockSeparator} />}
                </React.Fragment>
              );
            })}
          </View>
        </View>
      )}

      {/* ── Dock Picker (inline overlay, no Modal to avoid closing keyboard) ── */}
      {dockPickerVisible && keyboardVisible && (
        <View style={s.dockPickerOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setDockPickerVisible(false)} />
          <View style={[s.dockPickerSheet, { bottom: 70 }]}>
            <View style={s.pickerHandle} />
            <Text style={[s.pickerTitle, { paddingHorizontal: 14, paddingBottom: 6 }]}>Zum Dock hinzufügen</Text>
            <ScrollView style={{ maxHeight: 200 }} contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 8 }}>
              {(() => {
                const notInDock = Object.keys(ORB_DEFINITIONS).filter(id => !dockOrder.includes(id));
                if (notInDock.length === 0) {
                  return <Text style={s.pickerEmptyText}>Alle Orbs sind im Dock</Text>;
                }
                return notInDock.map(id => {
                  const def = ORB_DEFINITIONS[id];
                  if (!def) return null;
                  return (
                    <TouchableOpacity
                      key={id}
                      style={s.pickerRow}
                      onPress={() => { addToDock(id); setDockPickerVisible(false); }}
                      activeOpacity={0.6}
                    >
                      <View style={s.pickerIcon}>{def.icon(28, def.color === '#94A3B8' ? '#94A3B8' : def.color)}</View>
                      <Text style={s.pickerLabel}>{def.label}</Text>
                      <Feather name="plus" size={16} color={colors.primary} />
                    </TouchableOpacity>
                  );
                });
              })()}
            </ScrollView>
          </View>
        </View>
      )}

      {/* ── D-Pad Overlay (works both with and without keyboard) ────────── */}
      {dpadOpen && (() => {
        const sendKey = (key: string) => {
          if (sessionId && wsService) {
            wsService.send({ type: 'terminal:input', sessionId, payload: { data: key } });
          }
        };

        if (keyboardVisible) {
          // Render above the dock
          return (
            <View style={[s.dpadOverlay, s.dpadOverDock, { bottom: 72 }]}>
              <TouchableOpacity style={s.dpadKey} onPress={() => sendKey('\x1b[A')} activeOpacity={0.6}>
                <Feather name="chevron-up" size={18} color="#94A3B8" />
              </TouchableOpacity>
              <View style={{ flexDirection: 'row', gap: 4 }}>
                <TouchableOpacity style={s.dpadKey} onPress={() => sendKey('\x1b[D')} activeOpacity={0.6}>
                  <Feather name="chevron-left" size={18} color="#94A3B8" />
                </TouchableOpacity>
                <TouchableOpacity style={s.dpadKey} onPress={() => sendKey('\x1b[B')} activeOpacity={0.6}>
                  <Feather name="chevron-down" size={18} color="#94A3B8" />
                </TouchableOpacity>
                <TouchableOpacity style={s.dpadKey} onPress={() => sendKey('\x1b[C')} activeOpacity={0.6}>
                  <Feather name="chevron-right" size={18} color="#94A3B8" />
                </TouchableOpacity>
              </View>
              <TouchableOpacity onPress={() => setDpadOpen(false)} style={s.dpadCloseBtn}>
                <Text style={{ color: '#64748B', fontSize: 10, fontWeight: '600' }}>Schließen</Text>
              </TouchableOpacity>
            </View>
          );
        }

        // Render above the orb
        const pos = findOrbPosition('dpad');
        if (!pos) return null;
        return (
          <View style={[s.dpadOverlay, { left: pos.x - 38, top: pos.y - 90 }]}>
            <TouchableOpacity style={s.dpadKey} onPress={() => sendKey('\x1b[A')} activeOpacity={0.6}>
              <Feather name="chevron-up" size={18} color="#94A3B8" />
            </TouchableOpacity>
            <View style={{ flexDirection: 'row', gap: 4 }}>
              <TouchableOpacity style={s.dpadKey} onPress={() => sendKey('\x1b[D')} activeOpacity={0.6}>
                <Feather name="chevron-left" size={18} color="#94A3B8" />
              </TouchableOpacity>
              <TouchableOpacity style={s.dpadKey} onPress={() => sendKey('\x1b[B')} activeOpacity={0.6}>
                <Feather name="chevron-down" size={18} color="#94A3B8" />
              </TouchableOpacity>
              <TouchableOpacity style={s.dpadKey} onPress={() => sendKey('\x1b[C')} activeOpacity={0.6}>
                <Feather name="chevron-right" size={18} color="#94A3B8" />
              </TouchableOpacity>
            </View>
          </View>
        );
      })()}

      {/* ── Mic Recording / Processing Overlay (always visible when active) ── */}
      {(micState === 'recording' || micState === 'processing') && (() => {
        const mm = String(Math.floor(micDuration / 60)).padStart(2, '0');
        const ss = String(micDuration % 60).padStart(2, '0');

        // Position: above dock when keyboard open, above orb when keyboard closed
        const posStyle = keyboardVisible
          ? { bottom: 62, alignSelf: 'center' as const }
          : (() => {
              const micPos = findOrbPosition('mic');
              if (!micPos) return { bottom: 100, alignSelf: 'center' as const };
              return { left: micPos.x - 30, top: micPos.y - 56 };
            })();

        return (
          <View style={[s.micOverlay, posStyle]}>
            {micState === 'recording' ? (
              <>
                <View style={s.micDot} />
                <Text style={s.micTimer}>{mm}:{ss}</Text>
                <TouchableOpacity style={s.micSendBtn} onPress={handleMicPress} activeOpacity={0.7}>
                  <Feather name="send" size={14} color="#F8FAFC" />
                </TouchableOpacity>
              </>
            ) : (
              <>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={s.micProcessing}>Transkribiert...</Text>
              </>
            )}
          </View>
        );
      })()}

      {/* ── Orb Picker Modal ──────────────────────────────────────────────── */}
      <Modal
        visible={pickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerVisible(false)}
      >
        <TouchableOpacity
          style={s.modalOverlay}
          activeOpacity={1}
          onPress={() => setPickerVisible(false)}
        >
          <View style={s.pickerSheet} onStartShouldSetResponder={() => true}>
            <View style={s.pickerHandle} />
            <Text style={s.pickerTitle}>Orb hinzufugen</Text>

            {pickerOrbs.length === 0 ? (
              <View style={s.pickerEmpty}>
                <Text style={s.pickerEmptyText}>Alle Orbs sind platziert</Text>
              </View>
            ) : (
              <FlatList
                data={pickerOrbs}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={s.pickerRow}
                    onPress={() => handleRestoreOrb(item.id)}
                    activeOpacity={0.6}
                  >
                    <View style={s.pickerIcon}>
                      {item.icon(32, '#E2E8F0')}
                    </View>
                    <Text style={s.pickerLabel}>{item.label}</Text>
                    <Feather name="plus" size={18} color={colors.primary} />
                  </TouchableOpacity>
                )}
                contentContainerStyle={s.pickerList}
              />
            )}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
  },

  // ── Edit Bar ──────────────────────────────────────────────────────────────
  editBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: 'rgba(30,58,138,0.75)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(59,130,246,0.25)',
    zIndex: 20,
  },
  editBarTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  editBarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  editBarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(59,130,246,0.15)',
  },
  editBarBtnText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  editBarDoneBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: colors.primary,
  },
  editBarDoneText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },

  // ── Keyboard Dock ─────────────────────────────────────────────────────────
  dock: {
    position: 'absolute',
    left: 8,
    right: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#0F172A',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    zIndex: 20,
  },
  dockOrbRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  dockOrb: {
    width: DOCK_ORB_SIZE,
    height: DOCK_ORB_SIZE,
    borderRadius: DOCK_ORB_SIZE / 2,
    backgroundColor: '#1B2336',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dockRemove: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.destructive,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#0F172A',
    zIndex: 5,
  },
  dockRemoveText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: '700',
  },
  dockEditBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingBottom: 6,
    marginBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  dockEditTitle: {
    color: '#93C5FD',
    fontSize: 11,
    fontWeight: '600',
  },
  dockEditAddBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: 'rgba(59,130,246,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dockEditDoneBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: colors.primary,
  },
  dockSeparator: {
    width: 1,
    height: 24,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  dockPickerOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 30,
  },
  dockPickerSheet: {
    position: 'absolute',
    left: 12,
    right: 12,
    backgroundColor: '#0F172A',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    paddingTop: 8,
  },

  // ── D-Pad Overlay ──────────────────────────────────────────────────────────
  dpadOverlay: {
    position: 'absolute',
    alignItems: 'center',
    gap: 4,
    zIndex: 25,
  },
  dpadOverDock: {
    left: 0,
    right: 0,
    alignItems: 'center',
    backgroundColor: '#0F172A',
    borderRadius: 14,
    marginHorizontal: 100,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    elevation: 8,
  },
  dpadCloseBtn: {
    marginTop: 4,
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  dpadKey: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Mic Recording Overlay ─────────────────────────────────────────────────
  micOverlay: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#0F172A',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    zIndex: 30,
  },
  micDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#EF4444',
  },
  micTimer: {
    color: '#EF4444',
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  micSendBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micProcessing: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '600',
  },

  // ── Orb Picker Modal ──────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: '#0F172A',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: 'rgba(255,255,255,0.1)',
    paddingBottom: 34,
    maxHeight: '50%',
  },
  pickerHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.2)',
    marginTop: 10,
    marginBottom: 12,
  },
  pickerTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  pickerList: {
    paddingHorizontal: spacing.lg,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  pickerIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#1B2336',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  pickerLabel: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
  },
  pickerEmpty: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  pickerEmptyText: {
    color: colors.textMuted,
    fontSize: 14,
  },
});
