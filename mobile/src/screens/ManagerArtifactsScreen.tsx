import React, { useCallback, useMemo, useState } from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  SectionList,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';
import { useManagerStore } from '../store/managerStore';
import { PresentationViewer } from '../components/PresentationViewer';
import { colors, fonts, spacing, fontSizes } from '../theme';

// ── Types ───────────────────────────────────────────────────────────────────

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ManagerArtifacts'>;
  route: RouteProp<RootStackParamList, 'ManagerArtifacts'>;
};

interface Artifact {
  id: string;
  type: 'presentation' | 'image';
  filename: string;
  timestamp: number;
  messageText: string;
}

type FilterType = 'all' | 'presentation' | 'image';

// ── Helpers ─────────────────────────────────────────────────────────────────

function getTitle(art: Artifact): string {
  if (art.type === 'presentation') {
    return art.messageText?.match(/(?:Präsentation|Presentation)[:\s]*["„]?([^"""\n]{5,60})/i)?.[1]?.trim()
      || 'Präsentation';
  }
  return art.messageText?.match(/(?:Bild|Image|Logo|Diagramm|generiert)[:\s]*["„]?([^"""\n]{5,60})/i)?.[1]?.trim()
    || 'Generiertes Bild';
}

function getDescription(art: Artifact): string {
  // Extract first 2 meaningful sentences from the AI message
  const text = art.messageText || '';
  const sentences = text.split(/[.!]\s/).filter(s => s.length > 20 && !s.startsWith('['));
  return sentences.slice(0, 2).join('. ').slice(0, 120) || '';
}

function getDateGroup(ts: number): string {
  const now = new Date();
  const d = new Date(ts);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((today.getTime() - target.getTime()) / 86400000);
  if (diffDays === 0) return 'Heute';
  if (diffDays === 1) return 'Gestern';
  if (diffDays < 7) return 'Diese Woche';
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long' });
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays < 2) {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

function getMeta(art: Artifact): string {
  if (art.type === 'presentation') {
    // Try to extract slide count from message
    const slideMatch = art.messageText?.match(/(\d+)\s*Slide/i);
    return slideMatch ? `${slideMatch[1]} Slides` : 'Präsentation';
  }
  return 'Bild';
}

// ── Component ───────────────────────────────────────────────────────────────

export function ManagerArtifactsScreen({ navigation, route }: Props) {
  const { serverHost, serverPort, serverToken } = route.params;
  const insets = useSafeAreaInsets();
  const messages = useManagerStore((s) => s.messages);

  const [filter, setFilter] = useState<FilterType>('all');
  const [activePres, setActivePres] = useState<{ url: string; title: string } | null>(null);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Extract all artifacts from messages
  const allArtifacts = useMemo(() => {
    const result: Artifact[] = [];
    (messages ?? []).forEach(msg => {
      msg.presentations?.forEach(p => result.push({
        id: `p-${msg.id}-${p}`,
        type: 'presentation',
        filename: p,
        timestamp: msg.timestamp ?? Date.now(),
        messageText: msg.text ?? '',
      }));
      msg.images?.forEach(img => result.push({
        id: `i-${msg.id}-${img}`,
        type: 'image',
        filename: img,
        timestamp: msg.timestamp ?? Date.now(),
        messageText: msg.text ?? '',
      }));
    });
    return result.sort((a, b) => b.timestamp - a.timestamp);
  }, [messages]);

  // Filter
  const filtered = filter === 'all' ? allArtifacts : allArtifacts.filter(a => a.type === filter);

  // Group by date for SectionList
  const sections = useMemo(() => {
    const groups = new Map<string, Artifact[]>();
    filtered.forEach(art => {
      const group = getDateGroup(art.timestamp);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(art);
    });
    return Array.from(groups.entries()).map(([title, data]) => ({ title, data }));
  }, [filtered]);

  // Counts
  const presCount = allArtifacts.filter(a => a.type === 'presentation').length;
  const imgCount = allArtifacts.filter(a => a.type === 'image').length;

  // URL builder
  const getUrl = useCallback((art: Artifact) => {
    const dir = art.type === 'presentation' ? 'generated-presentations' : 'generated-images';
    return `http://${serverHost}:${serverPort}/${dir}/${encodeURIComponent(art.filename)}?token=${serverToken}`;
  }, [serverHost, serverPort, serverToken]);

  // Tap handler
  const handleTap = useCallback((art: Artifact) => {
    const url = getUrl(art);
    if (art.type === 'presentation') {
      setActivePres({ url, title: getTitle(art) });
    } else {
      setLightboxImage(url);
    }
  }, [getUrl]);

  // Share handler
  const handleShare = useCallback(async (art: Artifact) => {
    try {
      await Share.share({ url: getUrl(art), title: getTitle(art) });
    } catch {}
  }, [getUrl]);

  // ── Render ──────────────────────────────────────────────────────────────

  const renderItem = useCallback(({ item }: { item: Artifact }) => {
    const isPres = item.type === 'presentation';
    return (
      <TouchableOpacity
        style={s.artifact}
        activeOpacity={0.7}
        onPress={() => handleTap(item)}
        onLongPress={() => handleShare(item)}
      >
        {/* Icon */}
        <View style={[s.artIcon, isPres ? s.artIconPres : s.artIconImage]}>
          <Feather name={isPres ? 'monitor' : 'image'} size={20} color={isPres ? colors.primary : colors.accent} />
        </View>

        {/* Info */}
        <View style={s.artInfo}>
          <Text style={s.artName} numberOfLines={1}>{getTitle(item)}</Text>
          <View style={s.artMeta}>
            <Text style={s.artMetaText}>{getMeta(item)}</Text>
            <View style={s.sep} />
            <Text style={s.artMetaText}>{formatTime(item.timestamp)}</Text>
          </View>
          {getDescription(item) ? (
            <Text style={s.artDesc} numberOfLines={2}>{getDescription(item)}</Text>
          ) : null}
        </View>

        {/* Right */}
        <View style={s.artRight}>
          <View style={[s.typeTag, isPres ? s.typeTagPres : s.typeTagImage]}>
            <Text style={[s.typeTagText, isPres ? s.typeTagTextPres : s.typeTagTextImage]}>
              {isPres ? 'PPT' : 'IMG'}
            </Text>
          </View>
          <Feather name="chevron-right" size={16} color="#334155" />
        </View>
      </TouchableOpacity>
    );
  }, [handleTap, handleShare]);

  const renderSectionHeader = useCallback(({ section }: { section: { title: string } }) => (
    <View style={s.sectionHeader}>
      <Text style={s.sectionLabel}>{section.title}</Text>
    </View>
  ), []);

  return (
    <View style={[s.container, { paddingTop: insets.top }]}>
      {/* ── Header ──────────────────────────────────────── */}
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} hitSlop={8}>
          <Feather name="arrow-left" size={18} color="#94A3B8" />
        </TouchableOpacity>
        <View style={s.titleGroup}>
          <Text style={s.title}>Artefakte</Text>
          <Text style={s.subtitle}>Präsentationen & Bilder</Text>
        </View>
        {allArtifacts.length > 0 && (
          <View style={s.countBadge}>
            <Text style={s.countText}>{allArtifacts.length}</Text>
          </View>
        )}
      </View>

      {/* ── Filter Chips ────────────────────────────────── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterBar} contentContainerStyle={s.filterContent}>
        <TouchableOpacity style={[s.chip, filter === 'all' && s.chipActive]} onPress={() => setFilter('all')}>
          <Feather name="layers" size={14} color={filter === 'all' ? '#60A5FA' : '#94A3B8'} />
          <Text style={[s.chipText, filter === 'all' && s.chipTextActive]}>Alle</Text>
          <Text style={[s.chipNum, filter === 'all' && s.chipNumActive]}>{allArtifacts.length}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.chip, filter === 'presentation' && s.chipActive]} onPress={() => setFilter('presentation')}>
          <Feather name="monitor" size={14} color={filter === 'presentation' ? '#60A5FA' : '#94A3B8'} />
          <Text style={[s.chipText, filter === 'presentation' && s.chipTextActive]}>Präsentationen</Text>
          <Text style={[s.chipNum, filter === 'presentation' && s.chipNumActive]}>{presCount}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.chip, filter === 'image' && s.chipActive]} onPress={() => setFilter('image')}>
          <Feather name="image" size={14} color={filter === 'image' ? '#60A5FA' : '#94A3B8'} />
          <Text style={[s.chipText, filter === 'image' && s.chipTextActive]}>Bilder</Text>
          <Text style={[s.chipNum, filter === 'image' && s.chipNumActive]}>{imgCount}</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* ── List ────────────────────────────────────────── */}
      {sections.length === 0 ? (
        <View style={s.empty}>
          <Feather name="package" size={40} color={colors.border} />
          <Text style={s.emptyText}>Noch keine Artefakte</Text>
          <Text style={s.emptyHint}>Erstelle eine Präsentation mit /ppt</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          renderSectionHeader={renderSectionHeader}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        />
      )}

      {/* ── Presentation Viewer ─────────────────────────── */}
      <PresentationViewer
        visible={!!activePres}
        url={activePres?.url ?? ''}
        title={activePres?.title ?? ''}
        onClose={() => setActivePres(null)}
      />

      {/* ── Image Lightbox ──────────────────────────────── */}
      <Modal visible={!!lightboxImage} animationType="fade" onRequestClose={() => setLightboxImage(null)}>
        <Pressable style={s.lightbox} onPress={() => setLightboxImage(null)}>
          <View style={[s.lightboxHeader, { paddingTop: insets.top + 8 }]}>
            <TouchableOpacity onPress={() => setLightboxImage(null)} hitSlop={12}>
              <Feather name="x" size={24} color="#F8FAFC" />
            </TouchableOpacity>
          </View>
          {lightboxImage && (
            <Image
              source={{ uri: lightboxImage }}
              style={s.lightboxImage}
              resizeMode="contain"
            />
          )}
        </Pressable>
      </Modal>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg,
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(51,65,85,0.4)', gap: 12,
  },
  backBtn: {
    width: 32, height: 32, borderRadius: 10, backgroundColor: 'rgba(30,41,59,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  titleGroup: { flex: 1 },
  title: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.text, letterSpacing: -0.2 },
  subtitle: { fontSize: fontSizes.xs, color: colors.textDim, marginTop: 1 },
  countBadge: {
    backgroundColor: 'rgba(59,130,246,0.1)', borderWidth: 1, borderColor: 'rgba(59,130,246,0.15)',
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 4,
  },
  countText: { color: '#60A5FA', fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },

  // Filters
  filterBar: { flexShrink: 0, borderBottomWidth: 1, borderBottomColor: 'rgba(51,65,85,0.25)' },
  filterContent: { paddingHorizontal: spacing.lg, paddingVertical: 10, gap: 6 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 13, paddingVertical: 6,
    borderRadius: 10, borderWidth: 1, borderColor: '#334155', backgroundColor: 'rgba(30,41,59,0.3)',
  },
  chipActive: { backgroundColor: 'rgba(59,130,246,0.1)', borderColor: 'rgba(59,130,246,0.25)' },
  chipText: { fontSize: 12, fontWeight: '600', color: '#94A3B8' },
  chipTextActive: { color: '#60A5FA' },
  chipNum: { fontSize: 11, color: '#475569' },
  chipNumActive: { color: '#60A5FA' },

  // Section header
  sectionHeader: { paddingHorizontal: spacing.lg, paddingTop: 14, paddingBottom: 6 },
  sectionLabel: { fontSize: 11, fontWeight: '700', color: '#475569', textTransform: 'uppercase', letterSpacing: 0.6 },

  // Artifact row
  artifact: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: spacing.lg, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: 'rgba(51,65,85,0.15)',
  },
  artIcon: { width: 42, height: 42, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  artIconPres: { backgroundColor: 'rgba(59,130,246,0.08)', borderWidth: 1, borderColor: 'rgba(59,130,246,0.12)' },
  artIconImage: { backgroundColor: 'rgba(34,197,94,0.08)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.12)' },
  artInfo: { flex: 1, minWidth: 0 },
  artName: { fontSize: 14, fontWeight: '600', color: colors.text, letterSpacing: -0.1 },
  artMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  artMetaText: { fontSize: 11, color: colors.textDim },
  sep: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: '#334155' },
  artDesc: { fontSize: 12, color: '#94A3B8', lineHeight: 17, marginTop: 4 },
  artRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  typeTag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  typeTagPres: { backgroundColor: 'rgba(59,130,246,0.08)' },
  typeTagImage: { backgroundColor: 'rgba(34,197,94,0.08)' },
  typeTagText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase' },
  typeTagTextPres: { color: '#60A5FA' },
  typeTagTextImage: { color: '#4ADE80' },

  // Empty state
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 40 },
  emptyText: { fontSize: 14, color: '#475569', fontWeight: '600' },
  emptyHint: { fontSize: 12, color: '#334155' },

  // Lightbox
  lightbox: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  lightboxHeader: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 16, zIndex: 10 },
  lightboxImage: { width: '100%', height: '80%' },
});
