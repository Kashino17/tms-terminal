import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useServerStore } from '../store/serverStore';
import { ServerProfile } from '../types/server.types';
import { colors, fonts, fontSizes, spacing } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation.types';

// ── Constants ────────────────────────────────────────────────────────────────

const POLL_MS = 10_000;

// ── Types ────────────────────────────────────────────────────────────────────

interface SystemStats {
  cpuPercent: number;
  memPercent: number;
  diskPercent: number;
  uptime: string;
  loadAvg: number[];
}

type EntryState = 'connecting' | 'online' | 'offline';

interface ServerEntry {
  state: EntryState;
  stats: SystemStats | null;
  latency: number | null;
  lastSeen: number | null;
}

type LiveMap = Record<string, ServerEntry>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatLastSeen(ts: number | null): string {
  if (!ts) return '—';
  const delta = Math.floor((Date.now() - ts) / 1000);
  if (delta < 5) return 'Just now';
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function metricColor(pct: number): string {
  if (pct >= 85) return colors.destructive;
  if (pct >= 60) return colors.warning;
  return colors.accent;
}

// ── MetricRow ─────────────────────────────────────────────────────────────────

interface MetricRowProps {
  label: string;
  value: number;
}

function MetricRow({ label, value }: MetricRowProps) {
  const clamped = Math.min(100, Math.max(0, Math.round(value)));
  const color = metricColor(clamped);
  const filled = clamped / 100;
  const empty = 1 - filled;

  return (
    <View style={metric.row}>
      <Text style={metric.label}>{label}</Text>
      <View style={metric.track}>
        <View style={[metric.fill, { flex: filled, backgroundColor: color }]} />
        {empty > 0 && <View style={{ flex: empty }} />}
      </View>
      <Text style={[metric.pct, { color }]}>{clamped}%</Text>
    </View>
  );
}

const metric = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs + 2,
    gap: spacing.sm,
  },
  label: {
    color: colors.textDim,
    fontSize: fontSizes.xs,
    fontFamily: fonts.mono,
    width: 32,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  track: {
    flex: 1,
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  fill: {
    height: 4,
    borderRadius: 2,
  },
  pct: {
    fontSize: fontSizes.xs,
    fontFamily: fonts.mono,
    width: 30,
    textAlign: 'right',
  },
});

// ── StatusDot ─────────────────────────────────────────────────────────────────

function StatusDot({ state }: { state: EntryState }) {
  const color = state === 'online' ? colors.accent
    : state === 'connecting' ? colors.warning
    : colors.textDim;
  return <View style={[dot.circle, { backgroundColor: color }]} />;
}

const dot = StyleSheet.create({
  circle: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});

// ── DashboardScreen ───────────────────────────────────────────────────────────

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Dashboard'>;
};

export function DashboardScreen({ navigation }: Props) {
  const { servers } = useServerStore();
  const [live, setLive] = useState<LiveMap>({});
  const [refreshing, setRefreshing] = useState(false);
  const wsRefs = useRef<Map<string, WebSocket>>(new Map());
  const timerRefs = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const responsive = useResponsive();
  const { rf, rs, ri } = responsive;

  const patchEntry = useCallback((id: string, patch: Partial<ServerEntry>) => {
    const defaults: ServerEntry = { state: 'connecting', stats: null, latency: null, lastSeen: null };
    setLive(prev => ({
      ...prev,
      [id]: { ...defaults, ...prev[id], ...patch },
    }));
  }, []);

  const connectServer = useCallback((server: ServerProfile) => {
    // Tear down any existing connection first
    wsRefs.current.get(server.id)?.close();
    const existing = timerRefs.current.get(server.id);
    if (existing) clearInterval(existing);

    patchEntry(server.id, { state: 'connecting', stats: null, latency: null });

    const url = `ws://${server.host}:${server.port}?token=${encodeURIComponent(server.token ?? '')}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      patchEntry(server.id, { state: 'offline' });
      return;
    }
    wsRefs.current.set(server.id, ws);

    let pingAt = 0;

    const requestSnapshot = () => {
      if (ws.readyState === WebSocket.OPEN) {
        pingAt = Date.now();
        ws.send(JSON.stringify({ type: 'system:snapshot' }));
      }
    };

    ws.onopen = () => {
      requestSnapshot();
      const interval = setInterval(requestSnapshot, POLL_MS);
      timerRefs.current.set(server.id, interval);
    };

    ws.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string);
        if (msg.type === 'system:snapshot' && msg.payload?.system) {
          const s = msg.payload.system as SystemStats;
          patchEntry(server.id, {
            state: 'online',
            stats: s,
            latency: pingAt ? Date.now() - pingAt : null,
            lastSeen: Date.now(),
          });
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      const t = timerRefs.current.get(server.id);
      if (t) { clearInterval(t); timerRefs.current.delete(server.id); }
      patchEntry(server.id, { state: 'offline' });
    };

    ws.onerror = () => {
      patchEntry(server.id, { state: 'offline' });
    };
  }, [patchEntry]);

  const connectAll = useCallback(() => {
    servers.forEach(s => connectServer(s));
  }, [servers, connectServer]);

  // Mount: connect to all servers
  useEffect(() => {
    connectAll();
    return () => {
      wsRefs.current.forEach(ws => ws.close());
      timerRefs.current.forEach(t => clearInterval(t));
      wsRefs.current.clear();
      timerRefs.current.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setRefreshing(true);
    connectAll();
    setTimeout(() => setRefreshing(false), 1500);
  }, [connectAll]);

  // ── Derived summary values ────────────────────────────────────────────────

  const { onlineCount, offlineCount, connectingCount, avgCpu } = useMemo(() => {
    const online = servers.filter(s => live[s.id]?.state === 'online').length;
    const offline = servers.filter(s => live[s.id]?.state === 'offline').length;
    const connecting = servers.filter(s => live[s.id]?.state === 'connecting').length;

    const onlineWithStats = servers.filter(s => live[s.id]?.stats);
    const cpu = onlineWithStats.length
      ? Math.round(onlineWithStats.reduce((sum, s) => sum + (live[s.id].stats!.cpuPercent), 0) / onlineWithStats.length)
      : null;

    return { onlineCount: online, offlineCount: offline, connectingCount: connecting, avgCpu: cpu };
  }, [servers, live]);

  // ── Render each server card ───────────────────────────────────────────────

  const renderItem = useCallback(({ item: server }: { item: ServerProfile }) => {
    const entry = live[server.id];
    const isOnline = entry?.state === 'online';
    const isConnecting = entry?.state === 'connecting';
    const stats = entry?.stats;

    return (
      <TouchableOpacity
        style={[styles.card, isOnline && styles.cardOnline, { padding: rs(16), borderRadius: rs(12) }]}
        onPress={() => navigation.navigate('Terminal', { serverId: server.id, serverName: server.name, serverHost: server.host, serverPort: server.port, token: server.token ?? '' })}
        activeOpacity={0.72}
        accessibilityLabel={`${server.name}, ${isOnline ? 'Online' : isConnecting ? 'Connecting' : 'Offline'}`}
        accessibilityRole="button"
        accessibilityHint="Double tap to open terminal"
      >
        {/* Card header */}
        <View style={styles.cardHeader}>
          <StatusDot state={entry?.state ?? 'offline'} />
          <Text style={[styles.serverName, { fontSize: rf(15) }]} numberOfLines={1}>{server.name}</Text>
          <View style={styles.badgeArea}>
            {isOnline && entry.latency != null && (
              <View style={[styles.latencyBadge, { paddingHorizontal: rs(6), paddingVertical: rs(2) }]}>
                <Text style={[styles.latencyText, { fontSize: rf(11) }]}>{entry.latency}ms</Text>
              </View>
            )}
            {isConnecting && (
              <ActivityIndicator size={12} color={colors.warning} />
            )}
            {!isOnline && !isConnecting && (
              <View style={[styles.offlineBadge, { paddingHorizontal: rs(6), paddingVertical: rs(2) }]}>
                <Text style={[styles.offlineBadgeText, { fontSize: rf(11) }]}>Offline</Text>
              </View>
            )}
          </View>
        </View>

        {/* Host:port */}
        <Text style={[styles.host, { fontSize: rf(11), marginBottom: rs(12) }]}>{server.host}:{server.port}</Text>

        {/* Metric bars — only when online with data */}
        {isOnline && stats ? (
          <>
            <View style={styles.metricsBlock}>
              <MetricRow label="CPU" value={stats.cpuPercent} />
              <MetricRow label="RAM" value={stats.memPercent} />
              <MetricRow label="DISK" value={stats.diskPercent} />
            </View>

            <View style={styles.cardFooter}>
              <View style={styles.footerItem}>
                <Feather name="clock" size={ri(11)} color={colors.textDim} />
                <Text style={[styles.footerText, { fontSize: rf(11) }]}>{stats.uptime}</Text>
              </View>
              <View style={styles.footerItem}>
                <Feather name="radio" size={ri(11)} color={colors.textDim} />
                <Text style={[styles.footerText, { fontSize: rf(11) }]}>{formatLastSeen(entry.lastSeen)}</Text>
              </View>
              {stats.loadAvg.length > 0 && (
                <Text style={[styles.loadAvg, { fontSize: rf(11) }]}>
                  {stats.loadAvg[0].toFixed(2)}
                </Text>
              )}
            </View>
          </>
        ) : isConnecting ? (
          <View style={styles.skeletonBlock}>
            {['CPU', 'RAM', 'DISK'].map(label => (
              <View key={label} style={metric.row}>
                <Text style={metric.label}>{label}</Text>
                <View style={[metric.track, styles.skeletonBar]} />
                <View style={styles.skeletonPct} />
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.offlineBody}>
            <Feather name="wifi-off" size={ri(13)} color={colors.textDim} />
            <Text style={[styles.offlineBodyText, { fontSize: rf(11) }]}>
              {entry?.lastSeen ? `Last seen ${formatLastSeen(entry.lastSeen)}` : 'Unreachable'}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    );
  }, [live, navigation, rf, rs, ri]);

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>

      {/* Fleet summary bar */}
      <View style={[styles.summaryBar, { paddingHorizontal: rs(16), paddingVertical: rs(12) }]}>
        <View style={styles.summaryItem}>
          <View style={[dot.circle, { backgroundColor: colors.accent }]} />
          <Text style={[styles.summaryCount, { fontSize: rf(13) }]}>{onlineCount}</Text>
          <Text style={[styles.summaryLabel, { fontSize: rf(11) }]}>Online</Text>
        </View>

        <View style={styles.summaryDivider} />

        <View style={styles.summaryItem}>
          <View style={[dot.circle, { backgroundColor: colors.textDim }]} />
          <Text style={[styles.summaryCount, { fontSize: rf(13) }]}>{offlineCount}</Text>
          <Text style={[styles.summaryLabel, { fontSize: rf(11) }]}>Offline</Text>
        </View>

        {connectingCount > 0 && (
          <>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <ActivityIndicator size={10} color={colors.warning} />
              <Text style={[styles.summaryCount, { color: colors.warning, fontSize: rf(13) }]}>{connectingCount}</Text>
              <Text style={[styles.summaryLabel, { fontSize: rf(11) }]}>Connecting</Text>
            </View>
          </>
        )}

        {avgCpu != null && (
          <>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Feather name="cpu" size={ri(11)} color={metricColor(avgCpu)} />
              <Text style={[styles.summaryCount, { color: metricColor(avgCpu), fontSize: rf(13) }]}>{avgCpu}%</Text>
              <Text style={[styles.summaryLabel, { fontSize: rf(11) }]}>Avg CPU</Text>
            </View>
          </>
        )}
      </View>

      <FlatList
        data={servers}
        key={String(responsive.listColumns)}
        numColumns={responsive.listColumns}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingVertical: rs(12), paddingHorizontal: rs(16), gap: rs(8) }}
        columnWrapperStyle={responsive.listColumns === 2 ? { gap: rs(12) } : undefined}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Feather name="server" size={ri(44)} color={colors.border} />
            <Text style={[styles.emptyText, { fontSize: rf(15) }]}>No servers configured</Text>
            <Text style={[styles.emptySubtext, { fontSize: rf(13) }]}>Add servers from the main screen</Text>
          </View>
        }
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  // ── Summary bar
  summaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  summaryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  summaryCount: {
    color: colors.text,
    fontWeight: '600',
    fontFamily: fonts.mono,
  },
  summaryLabel: {
    color: colors.textMuted,
  },
  summaryDivider: {
    width: 1,
    height: 14,
    backgroundColor: colors.border,
    marginHorizontal: spacing.xs,
  },

  // ── Server card
  card: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.border,
  },
  cardOnline: {
    borderLeftColor: colors.accent,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 4,
  },
  serverName: {
    flex: 1,
    color: colors.text,
    fontWeight: '600',
  },
  badgeArea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  latencyBadge: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 4,
  },
  latencyText: {
    color: colors.accent,
    fontFamily: fonts.mono,
  },
  offlineBadge: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 4,
  },
  offlineBadgeText: {
    color: colors.textDim,
  },
  host: {
    color: colors.textDim,
    fontFamily: fonts.mono,
  },

  // ── Metrics block
  metricsBlock: {
    marginBottom: spacing.sm,
  },

  // ── Card footer
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  footerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  footerText: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
  },
  loadAvg: {
    marginLeft: 'auto',
    color: colors.textDim,
    fontFamily: fonts.mono,
  },

  // ── Skeleton bars (connecting state)
  skeletonBlock: {
    marginBottom: spacing.sm,
    opacity: 0.4,
  },
  skeletonBar: {
    backgroundColor: colors.surfaceAlt,
  },
  skeletonPct: {
    width: 30,
    height: 10,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 3,
  },

  // ── Offline body
  offlineBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  offlineBodyText: {
    color: colors.textDim,
    fontFamily: fonts.mono,
  },

  // ── Empty state
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 100,
    gap: spacing.sm,
  },
  emptyText: {
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
  emptySubtext: {
    color: colors.textDim,
  },
});
