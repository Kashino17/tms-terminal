import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';
import { colors, spacing, fontSizes } from '../theme';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ManagerMemory'>;
  route: RouteProp<RootStackParamList, 'ManagerMemory'>;
};

type Section = 'user' | 'personality' | 'projects' | 'insights' | 'stats';

const SECTION_LABELS: Record<Section, string> = {
  user: 'User-Profil',
  personality: 'Persönlichkeit',
  projects: 'Projekte',
  insights: 'Erkenntnisse',
  stats: 'Statistik',
};

const SECTION_ICONS: Record<Section, string> = {
  user: 'user',
  personality: 'heart',
  projects: 'folder',
  insights: 'zap',
  stats: 'bar-chart-2',
};

export function ManagerMemoryScreen({ navigation, route }: Props) {
  const { wsService } = route.params;
  const insets = useSafeAreaInsets();
  const [memory, setMemory] = useState<any>(null);
  const [activeSection, setActiveSection] = useState<Section>('user');
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');

  useEffect(() => {
    const unsub = wsService.addMessageListener((data: unknown) => {
      const msg = data as { type: string; payload?: any };
      if (msg.type === 'manager:memory_data' && msg.payload?.memory) {
        setMemory(msg.payload.memory);
      }
    });
    wsService.send({ type: 'manager:memory_read' } as any);
    return unsub;
  }, [wsService]);

  const startEdit = useCallback(() => {
    if (!memory) return;
    setEditText(JSON.stringify(memory[activeSection], null, 2));
    setEditing(true);
  }, [memory, activeSection]);

  const saveEdit = useCallback(() => {
    try {
      const parsed = JSON.parse(editText);
      wsService.send({ type: 'manager:memory_write', payload: { section: activeSection, data: parsed } } as any);
      setEditing(false);
    } catch {
      Alert.alert('Fehler', 'Ungültiges JSON');
    }
  }, [editText, activeSection, wsService]);

  const handleReset = useCallback(() => {
    Alert.alert(
      'Memory zurücksetzen',
      'Alle Daten (Persönlichkeit, Erkenntnisse, User-Profil) werden gelöscht.',
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Zurücksetzen',
          style: 'destructive',
          onPress: () => {
            wsService.send({ type: 'manager:memory_write', payload: { section: 'user', data: { name: '', role: '', techStack: [], preferences: [], learnedFacts: [] } } } as any);
            wsService.send({ type: 'manager:memory_write', payload: { section: 'personality', data: { agentName: 'Manager', tone: 'chill', detail: 'balanced', emojis: true, proactive: true, traits: [], sharedHistory: [] } } } as any);
            wsService.send({ type: 'manager:memory_write', payload: { section: 'projects', data: [] } } as any);
            wsService.send({ type: 'manager:memory_write', payload: { section: 'insights', data: [] } } as any);
          },
        },
      ],
    );
  }, [wsService]);

  const renderValue = (val: unknown, depth = 0): React.ReactNode => {
    if (val === null || val === undefined) return <Text style={s.valNull}>—</Text>;
    if (typeof val === 'boolean') return <Text style={[s.val, { color: val ? colors.accent : colors.destructive }]}>{val ? 'Ja' : 'Nein'}</Text>;
    if (typeof val === 'number') return <Text style={[s.val, { color: colors.info }]}>{val}</Text>;
    if (typeof val === 'string') return <Text style={s.val}>{val || '—'}</Text>;
    if (Array.isArray(val)) {
      if (val.length === 0) return <Text style={s.valNull}>Leer</Text>;
      return (
        <View style={{ gap: 4, marginTop: 2 }}>
          {val.map((item, i) => (
            <View key={i} style={s.listItem}>
              <Text style={s.listBullet}>•</Text>
              {typeof item === 'object' ? <View style={{ flex: 1 }}>{renderValue(item, depth + 1)}</View> : <Text style={[s.val, { flex: 1 }]}>{String(item)}</Text>}
            </View>
          ))}
        </View>
      );
    }
    if (typeof val === 'object') {
      return (
        <View style={{ gap: 4, marginTop: depth > 0 ? 2 : 0 }}>
          {Object.entries(val as Record<string, unknown>).map(([k, v]) => (
            <View key={k} style={s.field}>
              <Text style={s.fieldKey}>{k}</Text>
              {renderValue(v, depth + 1)}
            </View>
          ))}
        </View>
      );
    }
    return <Text style={s.val}>{String(val)}</Text>;
  };

  return (
    <View style={[s.container, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={8}>
          <Feather name="arrow-left" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Agent Memory</Text>
        <View style={s.headerRight}>
          {!editing && (
            <TouchableOpacity onPress={startEdit} hitSlop={8}>
              <Feather name="edit-2" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handleReset} hitSlop={8}>
            <Feather name="rotate-ccw" size={16} color={colors.destructive} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabBar} contentContainerStyle={s.tabBarContent}>
        {(Object.keys(SECTION_LABELS) as Section[]).map((sec) => (
          <TouchableOpacity
            key={sec}
            style={[s.tab, activeSection === sec && s.tabActive]}
            onPress={() => { setActiveSection(sec); setEditing(false); }}
          >
            <Feather name={SECTION_ICONS[sec] as any} size={14} color={activeSection === sec ? colors.primary : colors.textDim} />
            <Text style={[s.tabText, activeSection === sec && s.tabTextActive]}>{SECTION_LABELS[sec]}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView style={s.content} contentContainerStyle={s.contentInner}>
        {!memory ? (
          <Text style={s.valNull}>Lade Memory...</Text>
        ) : editing ? (
          <>
            <TextInput style={s.editInput} value={editText} onChangeText={setEditText} multiline autoFocus />
            <View style={s.editActions}>
              <TouchableOpacity style={s.editBtn} onPress={() => setEditing(false)}>
                <Text style={{ color: colors.textMuted }}>Abbrechen</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.editBtn, s.editBtnSave]} onPress={saveEdit}>
                <Text style={{ color: colors.primary, fontWeight: '700' }}>Speichern</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          renderValue(memory[activeSection])
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface },
  headerTitle: { flex: 1, color: colors.text, fontSize: fontSizes.lg, fontWeight: '700', marginLeft: spacing.md },
  headerRight: { flexDirection: 'row', gap: spacing.md },
  tabBar: { maxHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  tabBarContent: { paddingHorizontal: spacing.md, gap: spacing.xs, alignItems: 'center' },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: 8 },
  tabActive: { backgroundColor: colors.primary + '18' },
  tabText: { color: colors.textDim, fontSize: fontSizes.xs, fontWeight: '500' },
  tabTextActive: { color: colors.primary },
  content: { flex: 1 },
  contentInner: { padding: spacing.lg },
  field: { marginBottom: spacing.sm },
  fieldKey: { color: colors.textMuted, fontSize: fontSizes.xs, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  val: { color: colors.text, fontSize: fontSizes.sm, lineHeight: 20 },
  valNull: { color: colors.textDim, fontSize: fontSizes.sm, fontStyle: 'italic' },
  listItem: { flexDirection: 'row', gap: spacing.sm },
  listBullet: { color: colors.textDim, fontSize: fontSizes.sm },
  editInput: { backgroundColor: colors.surface, borderRadius: 12, padding: spacing.md, color: colors.text, fontSize: fontSizes.xs, fontFamily: 'monospace', minHeight: 200, textAlignVertical: 'top', borderWidth: 1, borderColor: colors.border },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  editBtn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: 8 },
  editBtnSave: { backgroundColor: colors.primary + '18' },
});
