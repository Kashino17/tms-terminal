import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useResponsive } from '../hooks/useResponsive';
import { useCloudWatchStore, type WatchedDeployment } from '../store/cloudWatchStore';
import { colors, fonts } from '../theme';
import { DEPLOYMENT_STATUS_COLORS, TokenExpiredError } from '../services/cloud.types';
import { CloudEnvSheet } from './CloudEnvSheet';
import type { CloudProvider, Project, Deployment, LogEntry, EnvVar, CronJob } from '../services/cloud.types';
import type { CloudPlatform } from '../store/cloudAuthStore';

// ── Types ─────────────────────────────────────────────────────────────────────

type TabId = 'deploys' | 'env' | 'logs' | 'actions';

interface Props {
  platform: CloudPlatform;
  service: CloudProvider;
  project: Project;
  onBack: () => void;
  onTokenExpired?: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

// ── DeploysTab ─────────────────────────────────────────────────────────────────

interface DeploysTabProps {
  service: CloudProvider;
  projectId: string;
  platform: CloudPlatform;
  refreshKey: number;
  addWatch: (deploy: WatchedDeployment) => void;
  projectName: string;
  onTokenExpired?: () => void;
}

function DeploysTab({ service, projectId, platform, refreshKey, addWatch, projectName, onTokenExpired }: DeploysTabProps) {
  const { rf, rs, ri } = useResponsive();
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({});
  const [logsLoading, setLogsLoading] = useState<Record<string, boolean>>({});

  const load = useCallback(async (reset = true) => {
    if (reset) {
      setLoading(true);
      setCursor(undefined);
    } else {
      setLoadingMore(true);
    }
    try {
      const result = await service.listDeployments(projectId, reset ? undefined : cursor);
      setDeployments(prev => reset ? result.items : [...prev, ...result.items]);
      setCursor(result.cursor);
      setHasMore(!!result.cursor);
    } catch (err: unknown) {
      if (err instanceof TokenExpiredError) { onTokenExpired?.(); return; }
      const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
      Alert.alert('Fehler', message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [service, projectId, cursor, onTokenExpired]);

  useEffect(() => {
    load(true);
  }, [service, projectId, refreshKey]);

  const handleExpand = async (deploy: Deployment) => {
    const newId = expandedId === deploy.id ? null : deploy.id;
    setExpandedId(newId);

    if (newId && !logs[newId]) {
      setLogsLoading(prev => ({ ...prev, [newId]: true }));
      try {
        const entries = await service.getDeploymentLogs(deploy.id);
        setLogs(prev => ({ ...prev, [deploy.id]: entries }));
      } catch {
        setLogs(prev => ({ ...prev, [deploy.id]: [] }));
      } finally {
        setLogsLoading(prev => ({ ...prev, [deploy.id]: false }));
      }
    }
  };

  const handleCopyLog = async (deploy: Deployment) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    let logText: string;
    if (logs[deploy.id]) {
      logText = logs[deploy.id].map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n');
    } else {
      try {
        const entries = await service.getDeploymentLogs(deploy.id);
        logText = entries.map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n');
        setLogs(prev => ({ ...prev, [deploy.id]: entries }));
      } catch {
        logText = 'Fehler beim Laden der Logs';
      }
    }
    await Clipboard.setStringAsync(logText);
  };

  const handleWatch = (deploy: Deployment) => {
    addWatch({
      deployId: deploy.id,
      projectId,
      projectName,
      platform,
      status: deploy.status,
      addedAt: Date.now(),
    });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const renderItem = ({ item }: { item: Deployment }) => {
    const statusColor = DEPLOYMENT_STATUS_COLORS[item.status] ?? colors.textDim;
    const isExpanded = expandedId === item.id;
    const deployLogs = logs[item.id];
    const isLogsLoading = logsLoading[item.id];

    return (
      <TouchableOpacity
        style={[styles.deployItem, { padding: rs(12) }]}
        onPress={() => handleExpand(item)}
        activeOpacity={0.75}
      >
        <View style={styles.deployRow}>
          {/* Status dot */}
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />

          {/* Info */}
          <View style={styles.deployInfo}>
            <Text style={[styles.commitMsg, { fontSize: rf(13) }]} numberOfLines={1}>
              {item.commitMessage ?? '(kein Commit-Nachricht)'}
            </Text>
            <Text style={[styles.deployMeta, { fontSize: rf(11) }]}>
              {item.status} · {relativeTime(item.createdAt)}
              {item.commitHash ? ` · ${item.commitHash.slice(0, 7)}` : ''}
            </Text>
          </View>

          {/* Actions */}
          <View style={[styles.deployActions, { gap: rs(8) }]}>
            <TouchableOpacity
              onPress={() => handleWatch(item)}
              hitSlop={8}
              activeOpacity={0.7}
            >
              <Feather name="eye" size={ri(16)} color={colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleCopyLog(item)}
              hitSlop={8}
              activeOpacity={0.7}
            >
              <Feather name="copy" size={ri(16)} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Expanded log */}
        {isExpanded && (
          <View style={[styles.logExpanded, { marginTop: rs(10) }]}>
            {isLogsLoading ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : deployLogs && deployLogs.length > 0 ? (
              <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled>
                <Text style={[styles.logText, { fontSize: rf(11) }]}>
                  {deployLogs.map(l => `[${l.level}] ${l.message}`).join('\n')}
                </Text>
              </ScrollView>
            ) : (
              <Text style={[styles.emptyText, { fontSize: rf(12) }]}>Keine Logs verfügbar</Text>
            )}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <FlatList
      data={deployments}
      keyExtractor={item => item.id}
      renderItem={renderItem}
      contentContainerStyle={{ paddingBottom: 24 }}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      ListEmptyComponent={
        <View style={styles.centered}>
          <Text style={[styles.emptyText, { fontSize: rf(14) }]}>Keine Deployments</Text>
        </View>
      }
      ListFooterComponent={
        hasMore ? (
          <TouchableOpacity
            style={[styles.loadMoreBtn, { margin: rs(12) }]}
            onPress={() => load(false)}
            disabled={loadingMore}
            activeOpacity={0.7}
          >
            {loadingMore ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={[styles.loadMoreText, { fontSize: rf(13) }]}>Mehr laden</Text>
            )}
          </TouchableOpacity>
        ) : null
      }
    />
  );
}

// ── EnvTab ────────────────────────────────────────────────────────────────────

interface EnvTabProps {
  service: CloudProvider;
  projectId: string;
  platform: CloudPlatform;
}

function EnvTab({ service, projectId, platform }: EnvTabProps) {
  const { rf, rs, ri } = useResponsive();
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [selectedEnv, setSelectedEnv] = useState<EnvVar | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const vars = await service.listEnvVars(projectId);
      setEnvVars(vars);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
      Alert.alert('Fehler', message);
    } finally {
      setLoading(false);
    }
  }, [service, projectId]);

  useEffect(() => { load(); }, []);

  const handleLongPress = (env: EnvVar) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(
      'Variable löschen',
      `Soll „${env.key}" wirklich gelöscht werden?`,
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Löschen',
          style: 'destructive',
          onPress: async () => {
            try {
              await service.deleteEnvVar(projectId, env.id);
              setEnvVars(prev => prev.filter(v => v.id !== env.id));
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
              Alert.alert('Fehler beim Löschen', message);
            }
          },
        },
      ],
    );
  };

  const handleTap = (env: EnvVar) => {
    setSelectedEnv(env);
    setSheetVisible(true);
  };

  const handleAddNew = () => {
    setSelectedEnv(undefined);
    setSheetVisible(true);
  };

  const renderItem = ({ item }: { item: EnvVar }) => (
    <TouchableOpacity
      style={[styles.envItem, { padding: rs(12) }]}
      onPress={() => handleTap(item)}
      onLongPress={() => handleLongPress(item)}
      activeOpacity={0.75}
    >
      <Text style={[styles.envKey, { fontSize: rf(13) }]}>{item.key}</Text>
      <Text style={[styles.envValue, { fontSize: rf(12) }]}>••••••</Text>
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={envVars}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingBottom: 80 }}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <View style={styles.centered}>
            <Text style={[styles.emptyText, { fontSize: rf(14) }]}>Keine Umgebungsvariablen</Text>
          </View>
        }
      />

      {/* FAB */}
      <TouchableOpacity
        style={[styles.fab, { bottom: rs(20), right: rs(20) }]}
        onPress={handleAddNew}
        activeOpacity={0.8}
      >
        <Feather name="plus" size={ri(22)} color="#fff" />
      </TouchableOpacity>

      <CloudEnvSheet
        visible={sheetVisible}
        onClose={() => setSheetVisible(false)}
        platform={platform}
        service={service}
        projectId={projectId}
        envVar={selectedEnv}
        onSaved={load}
      />
    </View>
  );
}

// ── LogsTab ───────────────────────────────────────────────────────────────────

interface LogsTabProps {
  service: CloudProvider;
  projectId: string;
}

function LogsTab({ service, projectId }: LogsTabProps) {
  const { rf, rs } = useResponsive();
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollViewRef = useRef<ScrollView>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const entries = await service.getServiceLogs(projectId);
        setLogEntries(entries);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
        Alert.alert('Fehler', message);
      } finally {
        setLoading(false);
      }
    })();
  }, [service, projectId]);

  const handleCopyAll = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const text = logEntries.map(l => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`).join('\n');
    await Clipboard.setStringAsync(text);
  };

  const handleCopyLine = async (entry: LogEntry) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await Clipboard.setStringAsync(`[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`);
  };

  const levelColor = (level: LogEntry['level']): string => {
    if (level === 'error') return '#EF4444';
    if (level === 'warn') return '#F59E0B';
    return colors.text;
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Header action */}
      <View style={[styles.logsHeader, { padding: rs(8) }]}>
        <TouchableOpacity onPress={handleCopyAll} activeOpacity={0.7} style={styles.copyAllBtn}>
          <Feather name="copy" size={14} color={colors.primary} />
          <Text style={[styles.copyAllText, { fontSize: rf(12) }]}>Alles kopieren</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={scrollViewRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: rs(10), paddingBottom: 24 }}
        onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: false })}
      >
        {logEntries.length === 0 ? (
          <Text style={[styles.emptyText, { fontSize: rf(14) }]}>Keine Logs verfügbar</Text>
        ) : (
          logEntries.map((entry, idx) => (
            <TouchableOpacity
              key={`${entry.timestamp}-${idx}`}
              onPress={() => handleCopyLine(entry)}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.logLine,
                  {
                    fontSize: rf(11),
                    color: levelColor(entry.level),
                    marginBottom: rs(2),
                  },
                ]}
              >
                <Text style={styles.logTimestamp}>{entry.timestamp} </Text>
                {entry.message}
              </Text>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </View>
  );
}

// ── ActionsTab ────────────────────────────────────────────────────────────────

interface ActionsTabProps {
  service: CloudProvider;
  project: Project;
  platform: CloudPlatform;
  addWatch: (deploy: WatchedDeployment) => void;
}

function ActionsTab({ service, project, platform, addWatch }: ActionsTabProps) {
  const { rf, rs, ri } = useResponsive();
  const [deploying, setDeploying] = useState(false);
  const [prevDeploys, setPrevDeploys] = useState<Deployment[]>([]);
  const [prevLoading, setPrevLoading] = useState(true);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [cronLoading, setCronLoading] = useState(true);
  const [cronRunning, setCronRunning] = useState<Record<string, boolean>>({});
  const [rollingBack, setRollingBack] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setPrevLoading(true);
      try {
        const result = await service.listDeployments(project.id);
        // Keep only successful past deployments (skip current one)
        const successful = result.items.filter(d => d.status === 'ready').slice(1, 6);
        setPrevDeploys(successful);
      } catch {
        setPrevDeploys([]);
      } finally {
        setPrevLoading(false);
      }
    })();
  }, [service, project.id]);

  useEffect(() => {
    (async () => {
      setCronLoading(true);
      try {
        const jobs = await service.listCronJobs(project.id);
        setCronJobs(jobs);
      } catch {
        setCronJobs([]);
      } finally {
        setCronLoading(false);
      }
    })();
  }, [service, project.id]);

  const handleRedeploy = () => {
    Alert.alert(
      'Neu deployen',
      `„${project.name}" jetzt neu deployen?`,
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Deployen',
          onPress: async () => {
            setDeploying(true);
            try {
              const deploy = await service.triggerDeploy(project.id);
              addWatch({
                deployId: deploy.id,
                projectId: project.id,
                projectName: project.name,
                platform,
                status: deploy.status,
                addedAt: Date.now(),
              });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              Alert.alert('Gestartet', 'Deployment wurde gestartet.');
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
              Alert.alert('Fehler', message);
            } finally {
              setDeploying(false);
            }
          },
        },
      ],
    );
  };

  const handleRollback = (deploy: Deployment) => {
    Alert.alert(
      'Rollback',
      `Zu „${deploy.commitMessage ?? deploy.id.slice(0, 8)}" zurückrollen?`,
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Rollback',
          style: 'destructive',
          onPress: async () => {
            setRollingBack(deploy.id);
            try {
              await service.rollbackDeploy(project.id, deploy.id);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              Alert.alert('Erfolg', 'Rollback wurde durchgeführt.');
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
              Alert.alert('Fehler', message);
            } finally {
              setRollingBack(null);
            }
          },
        },
      ],
    );
  };

  const handleRunCron = async (job: CronJob) => {
    setCronRunning(prev => ({ ...prev, [job.id]: true }));
    try {
      await service.triggerCronJob(job.id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Ausgeführt', `„${job.name}" wurde ausgeführt.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
      Alert.alert('Fehler', message);
    } finally {
      setCronRunning(prev => ({ ...prev, [job.id]: false }));
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: rs(16), paddingBottom: 40 }}>
      {/* Redeploy */}
      <Text style={[styles.sectionTitle, { fontSize: rf(12), marginBottom: rs(10) }]}>
        DEPLOYMENT
      </Text>
      <TouchableOpacity
        style={[styles.actionBtn, { paddingVertical: rs(14), opacity: deploying ? 0.6 : 1 }]}
        onPress={handleRedeploy}
        disabled={deploying}
        activeOpacity={0.75}
      >
        {deploying ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <>
            <Feather name="upload-cloud" size={ri(18)} color="#fff" />
            <Text style={[styles.actionBtnText, { fontSize: rf(14) }]}>Neu deployen</Text>
          </>
        )}
      </TouchableOpacity>

      {/* Rollback */}
      <Text style={[styles.sectionTitle, { fontSize: rf(12), marginTop: rs(24), marginBottom: rs(10) }]}>
        ROLLBACK
      </Text>
      {prevLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginVertical: rs(12) }} />
      ) : prevDeploys.length === 0 ? (
        <Text style={[styles.emptyText, { fontSize: rf(13), marginBottom: rs(8) }]}>
          Keine früheren Deployments verfügbar
        </Text>
      ) : (
        prevDeploys.map(deploy => (
          <TouchableOpacity
            key={deploy.id}
            style={[styles.rollbackItem, { padding: rs(12), marginBottom: rs(8) }]}
            onPress={() => handleRollback(deploy)}
            disabled={rollingBack === deploy.id}
            activeOpacity={0.75}
          >
            <View style={styles.rollbackInfo}>
              <Text style={[styles.commitMsg, { fontSize: rf(13) }]} numberOfLines={1}>
                {deploy.commitMessage ?? deploy.id.slice(0, 12)}
              </Text>
              <Text style={[styles.deployMeta, { fontSize: rf(11) }]}>
                {relativeTime(deploy.createdAt)}
                {deploy.commitHash ? ` · ${deploy.commitHash.slice(0, 7)}` : ''}
              </Text>
            </View>
            {rollingBack === deploy.id ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Feather name="rotate-ccw" size={ri(16)} color={colors.primary} />
            )}
          </TouchableOpacity>
        ))
      )}

      {/* Cron Jobs */}
      <Text style={[styles.sectionTitle, { fontSize: rf(12), marginTop: rs(24), marginBottom: rs(10) }]}>
        CRON JOBS
      </Text>
      {cronLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginVertical: rs(12) }} />
      ) : cronJobs.length === 0 ? (
        <Text style={[styles.emptyText, { fontSize: rf(13) }]}>Keine Cron Jobs konfiguriert</Text>
      ) : (
        cronJobs.map(job => (
          <View key={job.id} style={[styles.cronItem, { padding: rs(12), marginBottom: rs(8) }]}>
            <View style={styles.cronInfo}>
              <Text style={[styles.cronName, { fontSize: rf(13) }]}>{job.name}</Text>
              <Text style={[styles.deployMeta, { fontSize: rf(11) }]}>
                {job.schedule}
                {job.lastRunAt ? ` · Zuletzt: ${relativeTime(job.lastRunAt)}` : ''}
                {job.lastRunStatus ? ` · ${job.lastRunStatus === 'success' ? '✓' : '✗'}` : ''}
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.cronRunBtn, { paddingHorizontal: rs(12), paddingVertical: rs(6) }]}
              onPress={() => handleRunCron(job)}
              disabled={cronRunning[job.id]}
              activeOpacity={0.75}
            >
              {cronRunning[job.id] ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Text style={[styles.cronRunText, { fontSize: rf(12) }]}>Jetzt ausführen</Text>
              )}
            </TouchableOpacity>
          </View>
        ))
      )}
    </ScrollView>
  );
}

// ── CloudProjectDetail ─────────────────────────────────────────────────────────

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'deploys', label: 'Deploys',  icon: 'package' },
  { id: 'env',     label: 'Env',      icon: 'key' },
  { id: 'logs',    label: 'Logs',     icon: 'terminal' },
  { id: 'actions', label: '⚡',       icon: 'zap' },
];

export function CloudProjectDetail({ platform, service, project, onBack, onTokenExpired }: Props) {
  const { rf, rs, ri, isCompact } = useResponsive();
  const { addWatch } = useCloudWatchStore();

  const [activeTab, setActiveTab] = useState<TabId>('deploys');
  const [refreshKey, setRefreshKey] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Foreground polling — every 30s bump refreshKey to re-fetch deploys
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setRefreshKey(k => k + 1);
    }, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const renderTabContent = () => {
    switch (activeTab) {
      case 'deploys':
        return (
          <DeploysTab
            service={service}
            projectId={project.id}
            platform={platform}
            refreshKey={refreshKey}
            addWatch={addWatch}
            projectName={project.name}
            onTokenExpired={onTokenExpired}
          />
        );
      case 'env':
        return (
          <EnvTab
            service={service}
            projectId={project.id}
            platform={platform}
          />
        );
      case 'logs':
        return (
          <LogsTab
            service={service}
            projectId={project.id}
          />
        );
      case 'actions':
        return (
          <ActionsTab
            service={service}
            project={project}
            platform={platform}
            addWatch={addWatch}
          />
        );
    }
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingHorizontal: rs(16), paddingVertical: rs(12) }]}>
        <TouchableOpacity
          onPress={onBack}
          hitSlop={10}
          activeOpacity={0.7}
          style={styles.backBtn}
        >
          <Feather name="arrow-left" size={ri(20)} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { fontSize: rf(16) }]} numberOfLines={1}>
          {project.name}
        </Text>
        <View style={{ width: ri(20) }} />
      </View>

      {/* Tab bar */}
      <View style={[styles.tabBar, { paddingHorizontal: rs(8) }]}>
        {TABS.map(tab => {
          const isActive = activeTab === tab.id;
          return (
            <TouchableOpacity
              key={tab.id}
              style={[
                styles.tabBtn,
                {
                  paddingVertical: rs(10),
                  paddingHorizontal: rs(isCompact ? 8 : 14),
                  borderBottomWidth: isActive ? 2 : 0,
                  borderBottomColor: isActive ? colors.primary : 'transparent',
                },
              ]}
              onPress={() => setActiveTab(tab.id)}
              activeOpacity={0.7}
            >
              {isCompact ? (
                <Feather
                  name={tab.icon as any}
                  size={ri(18)}
                  color={isActive ? colors.primary : colors.textMuted}
                />
              ) : (
                <Text
                  style={[
                    styles.tabLabel,
                    {
                      fontSize: rf(13),
                      color: isActive ? colors.primary : colors.textMuted,
                      fontWeight: isActive ? '700' : '400',
                    },
                  ]}
                >
                  {tab.id === 'actions' ? '⚡' : tab.label}
                </Text>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Tab content */}
      <View style={{ flex: 1 }}>
        {renderTabContent()}
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: {
    marginRight: 12,
  },
  headerTitle: {
    flex: 1,
    color: colors.text,
    fontWeight: '700',
  },

  // Tab bar
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tabBtn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabLabel: {
    fontWeight: '400',
  },

  // Deploys
  deployItem: {
    backgroundColor: colors.surface,
  },
  deployRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
    flexShrink: 0,
  },
  deployInfo: {
    flex: 1,
    marginRight: 8,
  },
  commitMsg: {
    color: colors.text,
    fontWeight: '500',
  },
  deployMeta: {
    color: colors.textMuted,
    marginTop: 2,
  },
  deployActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logExpanded: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 8,
    padding: 10,
  },
  logText: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    lineHeight: 16,
  },
  logTimestamp: {
    color: colors.textDim,
    fontFamily: fonts.mono,
  },

  // Env
  envItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  envKey: {
    color: colors.text,
    fontWeight: '600',
    fontFamily: fonts.mono,
    flex: 1,
  },
  envValue: {
    color: colors.textDim,
    fontFamily: fonts.mono,
  },
  fab: {
    position: 'absolute',
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 3 },
    shadowRadius: 6,
  },

  // Logs
  logsHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  copyAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  copyAllText: {
    color: colors.primary,
    fontWeight: '600',
  },
  logLine: {
    fontFamily: fonts.mono,
    lineHeight: 17,
  },

  // Actions
  sectionTitle: {
    color: colors.textDim,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: colors.primary,
    borderRadius: 12,
  },
  actionBtnText: {
    color: '#fff',
    fontWeight: '700',
  },
  rollbackItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rollbackInfo: {
    flex: 1,
    marginRight: 12,
  },
  cronItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cronInfo: {
    flex: 1,
    marginRight: 12,
  },
  cronName: {
    color: colors.text,
    fontWeight: '600',
  },
  cronRunBtn: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: `${colors.primary}18`,
  },
  cronRunText: {
    color: colors.primary,
    fontWeight: '600',
  },

  // Shared
  separator: {
    height: 1,
    backgroundColor: colors.border,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    minHeight: 150,
  },
  emptyText: {
    color: colors.textMuted,
    textAlign: 'center',
  },
  loadMoreBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  loadMoreText: {
    color: colors.primary,
    fontWeight: '600',
  },
});
