import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet, Alert,
  ActivityIndicator,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fonts } from '../theme';
import { WebSocketService } from '../services/websocket.service';
import { useResponsive } from '../hooks/useResponsive';

// ── Types ────────────────────────────────────────────────────────────────────
interface SystemStats {
  cpuPercent: number;
  memPercent: number;
  memUsedMB: number;
  memTotalMB: number;
  uptime: string;
  loadAvg: number[];
}

interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  mem: number;
  user: string;
}

type SortKey = 'cpu' | 'mem';

// ── Progress Bar ─────────────────────────────────────────────────────────────
function getThresholdColor(percent: number): string {
  if (percent > 80) return colors.destructive;
  if (percent >= 50) return colors.warning;
  return colors.accent;
}

function ProgressBar({ percent, color }: { percent: number; color: string }) {
  const clamped = Math.round(Math.min(100, Math.max(0, percent)));
  return (
    <View
      style={barStyles.track}
      accessibilityRole="progressbar"
      accessibilityLabel={`Usage ${clamped} percent`}
      accessibilityValue={{ now: clamped, min: 0, max: 100 }}
    >
      <View
        style={[
          barStyles.fill,
          { width: `${Math.min(100, percent)}%`, backgroundColor: color },
        ]}
      />
    </View>
  );
}

// ── Process Row ──────────────────────────────────────────────────────────────
interface ProcessRowProps {
  process: ProcessInfo;
  index: number;
  onKill: (p: ProcessInfo) => void;
}

function ProcessRow({ process, index, onKill }: ProcessRowProps) {
  const cpuColor = getThresholdColor(process.cpu);
  const isAlt = index % 2 === 1;

  return (
    <View
      style={[
        row.container,
        isAlt && row.containerAlt,
        row.borderBottom,
      ]}
    >
      {/* Left: name + pid */}
      <View style={row.info}>
        <Text style={row.name} numberOfLines={1}>{process.name}</Text>
        <Text style={row.pid}>PID {process.pid}</Text>
      </View>

      {/* Middle: CPU + MEM badges */}
      <View style={row.badges}>
        <View style={[row.badge, { backgroundColor: cpuColor + '20' }]}>
          <Text style={[row.badgeText, { color: cpuColor }]}>
            {process.cpu.toFixed(1)}%
          </Text>
        </View>
        <View style={[row.badge, { backgroundColor: colors.textDim + '20' }]}>
          <Text style={[row.badgeText, { color: colors.textDim }]}>
            {process.mem.toFixed(1)}%
          </Text>
        </View>
      </View>

      {/* Right: kill */}
      <TouchableOpacity
        onPress={() => onKill(process)}
        activeOpacity={0.6}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityLabel={`Kill process ${process.name}`}
        accessibilityRole="button"
      >
        <Feather name="x-circle" size={16} color={colors.destructive} />
      </TouchableOpacity>
    </View>
  );
}

// ── Main Panel ───────────────────────────────────────────────────────────────
interface Props {
  wsService: WebSocketService;
}

export function ProcessMonitorPanel({ wsService }: Props) {
  const { rf, rs, ri } = useResponsive();
  const [system, setSystem] = useState<SystemStats | null>(null);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [sortBy, setSortBy] = useState<SortKey>('cpu');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Request snapshot + subscribe to responses
  useEffect(() => {
    wsService.send({ type: 'system:snapshot' });

    const unsubscribe = wsService.addMessageListener((msg: unknown) => {
      const m = msg as { type?: string; payload?: any };
      if (m.type === 'system:snapshot' && m.payload) {
        if (m.payload.system) setSystem(m.payload.system);
        if (m.payload.processes) setProcesses(m.payload.processes);
        setLastUpdated(new Date());
      }
    });

    // Auto-refresh every 2s
    intervalRef.current = setInterval(() => {
      wsService.send({ type: 'system:snapshot' });
    }, 2000);

    return () => {
      unsubscribe();
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [wsService]);

  const handleKill = useCallback((p: ProcessInfo) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert(
      'Kill Process',
      `Kill ${p.name} (PID ${p.pid})?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Kill',
          style: 'destructive',
          onPress: () => {
            wsService.send({ type: 'system:kill', payload: { pid: p.pid } });
          },
        },
      ],
    );
  }, [wsService]);

  // Sort processes
  const sorted = useMemo(
    () => [...processes].sort((a, b) => sortBy === 'cpu' ? b.cpu - a.cpu : b.mem - a.mem),
    [processes, sortBy],
  );

  const cpuColor = system ? getThresholdColor(system.cpuPercent) : colors.accent;
  const memColor = system ? getThresholdColor(system.memPercent) : colors.accent;

  return (
    <View style={ps.container}>
      {/* Header */}
      <View style={[ps.header, { paddingHorizontal: rs(12), paddingVertical: rs(10), gap: rs(7) }]}>
        <Feather name="activity" size={ri(14)} color={colors.info} />
        <Text style={[ps.title, { fontSize: rf(13) }]}>Processes</Text>
        {processes.length > 0 && (
          <Text style={[ps.counter, { fontSize: rf(11) }]}>{processes.length}</Text>
        )}
      </View>
      <View style={ps.divider} />

      {system ? (
        <>
          {/* System Stats Card */}
          <View style={ps.statsCard}>
            {/* CPU */}
            <View style={ps.statRow}>
              <Text style={ps.statLabel}>CPU</Text>
              <Text style={[ps.statValue, { color: cpuColor }]}>
                {system.cpuPercent.toFixed(1)}%
              </Text>
            </View>
            <ProgressBar percent={system.cpuPercent} color={cpuColor} />

            {/* RAM */}
            <View style={[ps.statRow, { marginTop: 8 }]}>
              <Text style={ps.statLabel}>RAM</Text>
              <Text style={[ps.statValue, { color: memColor }]}>
                {system.memUsedMB} / {system.memTotalMB} MB
              </Text>
            </View>
            <ProgressBar percent={system.memPercent} color={memColor} />

            {/* Info row */}
            <View style={ps.infoRow}>
              <Text style={ps.infoText}>Up {system.uptime}</Text>
              <Text style={ps.infoText}>
                Load {system.loadAvg.map((v) => v.toFixed(2)).join(' ')}
              </Text>
            </View>
          </View>

          {/* Sort selector */}
          <View style={ps.sortRow}>
            <Text style={ps.sortLabel}>Sort by</Text>
            <TouchableOpacity
              style={[ps.sortChip, sortBy === 'cpu' && ps.sortChipActive]}
              onPress={() => setSortBy('cpu')}
              activeOpacity={0.7}
              accessibilityLabel="Sort by CPU"
              accessibilityRole="button"
              accessibilityState={{ selected: sortBy === 'cpu' }}
            >
              <Text style={[ps.sortChipText, sortBy === 'cpu' && ps.sortChipTextActive]}>CPU</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[ps.sortChip, sortBy === 'mem' && ps.sortChipActive]}
              onPress={() => setSortBy('mem')}
              activeOpacity={0.7}
              accessibilityLabel="Sort by memory"
              accessibilityRole="button"
              accessibilityState={{ selected: sortBy === 'mem' }}
            >
              <Text style={[ps.sortChipText, sortBy === 'mem' && ps.sortChipTextActive]}>MEM</Text>
            </TouchableOpacity>
          </View>

          {/* Process list */}
          <FlatList
            data={sorted}
            keyExtractor={(item) => String(item.pid)}
            style={ps.list}
            contentContainerStyle={ps.listContent}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item, index }) => (
              <ProcessRow process={item} index={index} onKill={handleKill} />
            )}
            ListEmptyComponent={
              <View style={ps.empty}>
                <ActivityIndicator size="small" color={colors.textDim} />
                <Text style={ps.emptyText}>Loading...</Text>
              </View>
            }
          />
        </>
      ) : (
        /* Empty state: no data yet */
        <View style={ps.empty}>
          <ActivityIndicator size="small" color={colors.textDim} />
          <Text style={ps.emptyText}>Loading...</Text>
        </View>
      )}

      {/* Footer: last updated */}
      {lastUpdated && (
        <View style={[ps.footer, { paddingHorizontal: rs(12), paddingVertical: rs(8), gap: rs(6) }]}>
          <Feather name="clock" size={ri(10)} color={colors.textDim} />
          <Text style={[ps.footerText, { fontSize: rf(9) }]}>
            Updated {lastUpdated.toLocaleTimeString()}
          </Text>
        </View>
      )}
    </View>
  );
}

// ── Progress bar styles ──────────────────────────────────────────────────────
const barStyles = StyleSheet.create({
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    overflow: 'hidden',
    marginTop: 4,
  },
  fill: {
    height: 4,
    borderRadius: 2,
  },
});

// ── Process row styles ───────────────────────────────────────────────────────
const row = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 44,
    gap: 6,
  },
  containerAlt: {
    backgroundColor: colors.surfaceAlt + '4D', // ~0.3 opacity
  },
  borderBottom: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  info: {
    flex: 1,
    gap: 2,
  },
  name: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '700',
  },
  pid: {
    color: colors.textDim,
    fontSize: 9,
    fontFamily: fonts.mono,
  },
  badges: {
    flexDirection: 'row',
    gap: 4,
    alignItems: 'center',
  },
  badge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 9,
    fontFamily: fonts.mono,
    fontWeight: '600',
  },
});

// ── Panel styles ─────────────────────────────────────────────────────────────
const ps = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 7,
  },
  title: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  counter: {
    color: colors.textDim,
    fontSize: 11,
    fontFamily: fonts.mono,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(51,65,85,0.7)',
  },

  // Stats card
  statsCard: {
    margin: 8,
    padding: 10,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 8,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  statValue: {
    fontSize: 10,
    fontFamily: fonts.mono,
    fontWeight: '700',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  infoText: {
    color: colors.textDim,
    fontSize: 9,
    fontFamily: fonts.mono,
  },

  // Sort
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 6,
  },
  sortLabel: {
    color: colors.textDim,
    fontSize: 10,
    fontWeight: '600',
    marginRight: 2,
  },
  sortChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sortChipActive: {
    backgroundColor: colors.primary + '25',
    borderColor: colors.primary,
  },
  sortChipText: {
    color: colors.textDim,
    fontSize: 9,
    fontFamily: fonts.mono,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  sortChipTextActive: {
    color: colors.primary,
  },

  // List
  list: { flex: 1 },
  listContent: { paddingBottom: 8 },

  // Empty
  empty: {
    alignItems: 'center',
    paddingTop: 40,
    gap: 8,
    flex: 1,
    justifyContent: 'center',
  },
  emptyText: {
    color: colors.textDim,
    fontSize: 12,
  },

  // Footer
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(51,65,85,0.5)',
  },
  footerText: {
    color: colors.textDim,
    fontSize: 9,
    fontFamily: fonts.mono,
    flex: 1,
  },
});
