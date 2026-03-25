// mobile/src/components/CloudProjectList.tsx
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  LayoutAnimation,
  StyleSheet,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import NetInfo from '@react-native-community/netinfo';
import { useResponsive } from '../hooks/useResponsive';
import { useCloudAuthStore } from '../store/cloudAuthStore';
import { useCloudProjectsStore } from '../store/cloudProjectsStore';
import { colors } from '../theme';
import { PROJECT_STATUS_COLORS } from '../services/cloud.types';
import type { CloudProvider, Project, Owner } from '../services/cloud.types';
import { TokenExpiredError } from '../services/cloud.types';
import type { CloudPlatform } from '../store/cloudAuthStore';

interface Props {
  platform: CloudPlatform;
  service: CloudProvider;
  onSelectProject: (project: Project) => void;
  onTokenExpired?: () => void;
}

export function CloudProjectList({ platform, service, onSelectProject, onTokenExpired }: Props) {
  const { rf, rs, ri, isCompact } = useResponsive();

  const activeOwnerId = useCloudAuthStore((s) => s.activeOwnerId[platform]);
  const setActiveOwnerId = useCloudAuthStore((s) => s.setActiveOwnerId);

  const [owners, setOwners] = useState<Owner[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  const { getProjects, setProjects, appendProjects, isStale } = useCloudProjectsStore();
  const cached = activeOwnerId ? getProjects(platform, activeOwnerId) : null;
  const projects = cached?.items ?? [];
  const cursor = cached?.cursor;

  // Network status
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => setIsOffline(!state.isConnected));
    return () => unsub();
  }, []);

  // Load owners on mount
  useEffect(() => {
    service
      .listOwners()
      .then((o) => {
        setOwners(o);
        if (!activeOwnerId && o.length > 0) {
          setActiveOwnerId(platform, o[0].id);
        }
      })
      .catch((e) => {
        if (e instanceof TokenExpiredError) { onTokenExpired?.(); return; }
        setError('Accounts konnten nicht geladen werden');
      });
  }, [service]);

  // Load projects when owner changes or cache is stale
  useEffect(() => {
    if (!activeOwnerId || isOffline) return;
    if (!isStale(platform, activeOwnerId) && projects.length > 0) return;
    loadProjects();
  }, [activeOwnerId, isOffline]);

  const loadProjects = useCallback(async () => {
    if (!activeOwnerId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await service.listProjects(activeOwnerId);
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setProjects(platform, activeOwnerId, {
        items: result.items,
        cursor: result.cursor,
        fetchedAt: Date.now(),
      });
    } catch (e: any) {
      if (e instanceof TokenExpiredError) { onTokenExpired?.(); return; }
      setError(e.message ?? 'Fehler beim Laden der Projekte');
    } finally {
      setLoading(false);
    }
  }, [activeOwnerId, service, platform, onTokenExpired]);

  const loadMore = useCallback(async () => {
    if (!activeOwnerId || !cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await service.listProjects(activeOwnerId, cursor);
      appendProjects(platform, activeOwnerId, result.items, result.cursor);
    } catch (e: any) {
      if (e instanceof TokenExpiredError) { onTokenExpired?.(); return; }
      setError(e.message ?? 'Fehler beim Nachladen');
    } finally {
      setLoadingMore(false);
    }
  }, [activeOwnerId, cursor, service, platform, loadingMore, onTokenExpired]);

  // Cycle to next owner on press (simple MVP switcher)
  const cycleOwner = useCallback(() => {
    if (owners.length <= 1) return;
    const currentIndex = owners.findIndex((o) => o.id === activeOwnerId);
    const nextIndex = (currentIndex + 1) % owners.length;
    setActiveOwnerId(platform, owners[nextIndex].id);
  }, [owners, activeOwnerId, platform, setActiveOwnerId]);

  // Client-side search filter
  const filtered = useMemo(() => {
    if (!search.trim()) return projects;
    const q = search.toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, search]);

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={[s.header, { paddingHorizontal: rs(12), paddingVertical: rs(10) }]}>
        <Feather
          name={platform === 'render' ? 'box' : 'triangle'}
          size={ri(14)}
          color={platform === 'render' ? '#4353FF' : '#FFFFFF'}
        />
        <Text style={[s.title, { fontSize: rf(13) }]}>
          {platform === 'render' ? 'Render' : 'Vercel'}
        </Text>
      </View>
      <View style={s.divider} />

      {/* Offline banner */}
      {isOffline && (
        <View style={s.offlineBanner}>
          <Feather name="wifi-off" size={ri(11)} color={colors.warning} />
          <Text style={[s.offlineText, { fontSize: rf(11) }]}>Offline — letzte Daten</Text>
        </View>
      )}

      {/* Owner switcher — shown only when multiple owners exist */}
      {owners.length > 1 && (
        <TouchableOpacity
          style={[s.ownerSwitcher, { paddingHorizontal: rs(12), paddingVertical: rs(8) }]}
          onPress={cycleOwner}
          activeOpacity={0.7}
        >
          <Text style={[s.ownerLabel, { fontSize: rf(11) }]}>Account:</Text>
          <Text style={[s.ownerName, { fontSize: rf(12) }]} numberOfLines={1}>
            {owners.find((o) => o.id === activeOwnerId)?.name ?? '—'}
          </Text>
          <Feather name="chevron-down" size={ri(12)} color={colors.textDim} />
        </TouchableOpacity>
      )}

      {/* Search */}
      <TextInput
        style={[
          s.searchInput,
          {
            fontSize: rf(12),
            marginHorizontal: rs(12),
            marginVertical: rs(6),
            padding: rs(8),
          },
        ]}
        placeholder="Suche..."
        placeholderTextColor={colors.textDim}
        value={search}
        onChangeText={setSearch}
      />

      {/* Error banner */}
      {error && (
        <View style={s.errorBanner}>
          <Text style={[s.errorText, { fontSize: rf(11) }]} numberOfLines={2}>
            {error}
          </Text>
          <TouchableOpacity onPress={loadProjects} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={s.retryText}>Erneut</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Project list / loading / empty state */}
      {loading && projects.length === 0 ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: rs(24) }} />
      ) : filtered.length === 0 ? (
        <View style={s.empty}>
          <Feather name="inbox" size={ri(28)} color={colors.border} />
          <Text style={[s.emptyText, { fontSize: rf(12) }]}>Keine Projekte gefunden</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(p) => p.id}
          onRefresh={loadProjects}
          refreshing={loading}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[
                s.projectRow,
                { paddingHorizontal: rs(12), paddingVertical: rs(10) },
                isOffline && s.projectRowOffline,
              ]}
              onPress={() => onSelectProject(item)}
              disabled={isOffline}
              activeOpacity={0.7}
            >
              <View
                style={[
                  s.statusDot,
                  { backgroundColor: PROJECT_STATUS_COLORS[item.status] ?? colors.border },
                ]}
              />
              <Text style={[s.projectName, { fontSize: rf(12) }]} numberOfLines={1}>
                {item.name}
              </Text>
              {!isCompact && (
                <Text style={[s.projectType, { fontSize: rf(10) }]}>{item.type}</Text>
              )}
            </TouchableOpacity>
          )}
          ListFooterComponent={
            cursor ? (
              <TouchableOpacity
                style={s.loadMore}
                onPress={loadMore}
                disabled={loadingMore}
                activeOpacity={0.7}
              >
                {loadingMore ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Text style={[s.loadMoreText, { fontSize: rf(11) }]}>Mehr laden</Text>
                )}
              </TouchableOpacity>
            ) : null
          }
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  title: {
    color: colors.text,
    fontWeight: '700',
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(51,65,85,0.7)',
  },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: colors.warning + '22',
    paddingVertical: 4,
  },
  offlineText: {
    color: colors.warning,
  },
  ownerSwitcher: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ownerLabel: {
    color: colors.textDim,
  },
  ownerName: {
    color: colors.text,
    fontWeight: '600',
    flex: 1,
  },
  searchInput: {
    backgroundColor: colors.surfaceAlt,
    color: colors.text,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.destructive + '22',
  },
  errorText: {
    color: colors.destructive,
    flex: 1,
  },
  retryText: {
    color: colors.primary,
    fontWeight: '600',
    fontSize: 11,
    paddingLeft: 8,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingTop: 40,
  },
  emptyText: {
    color: colors.textDim,
  },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border + '44',
  },
  projectRowOffline: {
    opacity: 0.5,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  projectName: {
    color: colors.text,
    flex: 1,
  },
  projectType: {
    color: colors.textDim,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  loadMore: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  loadMoreText: {
    color: colors.primary,
    fontWeight: '600',
  },
});
