import React from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, ScrollView } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fonts } from '../theme';
import { useSplitViewStore, SplitLayout, TriMainPane } from '../store/splitViewStore';

const LAYOUTS: { id: SplitLayout; icon: string; label: string; minWidth: number }[] = [
  { id: 'stack', icon: 'layers',    label: 'Stacked',      minWidth: 0 },
  { id: 'side',  icon: 'columns',   label: 'Side by Side', minWidth: 0 },
  { id: 'tri',   icon: 'layout',    label: 'Tri-Split',    minWidth: 600 },
];

const MAIN_PANE_OPTIONS: { id: TriMainPane; label: string; icon: string }[] = [
  { id: 'terminal', label: 'Terminal',   icon: 'terminal' },
  { id: 'browser1', label: 'Browser 1',  icon: 'globe' },
  { id: 'browser2', label: 'Browser 2',  icon: 'globe' },
];

const QUICK_PORTS = ['3000', '5173', '8080'];

interface Props {
  serverHost: string;
  screenWidth: number;
}

export function SplitViewPanel({ serverHost, screenWidth }: Props) {
  const {
    active, layout, mainPane, browserPort, browserPort2,
    activate, deactivate, setLayout, setMainPane, cycleMain,
    setBrowserPort, setBrowserPort2,
  } = useSplitViewStore();

  const availableLayouts = LAYOUTS.filter((l) => screenWidth >= l.minWidth);
  const isTri = layout === 'tri';

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      {/* Header */}
      <View style={s.header}>
        <Feather name="sidebar" size={14} color="#F472B6" />
        <Text style={s.title}>Split View</Text>
      </View>
      <View style={s.divider} />

      {/* Status */}
      <View style={s.section}>
        <View style={s.statusRow}>
          <View style={[s.statusDot, active && s.statusDotActive]} />
          <Text style={s.statusText}>{active ? 'Active' : 'Inactive'}</Text>
        </View>
      </View>

      {/* Layout Selector */}
      <View style={s.section}>
        <Text style={s.sectionLabel}>Layout</Text>
        <View style={s.layoutGrid}>
          {availableLayouts.map((l) => (
            <TouchableOpacity
              key={l.id}
              style={[s.layoutBtn, layout === l.id && s.layoutBtnActive]}
              onPress={() => { Haptics.selectionAsync(); setLayout(l.id); }}
              activeOpacity={0.7}
              accessibilityLabel={l.label}
              accessibilityState={{ selected: layout === l.id }}
            >
              <Feather name={l.icon as any} size={18} color={layout === l.id ? '#F472B6' : colors.textDim} />
              <Text style={[s.layoutLabel, layout === l.id && s.layoutLabelActive]}>{l.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Browser 1 Port */}
      <View style={s.section}>
        <Text style={s.sectionLabel}>{isTri ? 'Browser 1 Port' : 'Browser Port'}</Text>
        <View style={s.portRow}>
          {QUICK_PORTS.map((p) => (
            <TouchableOpacity
              key={p}
              style={[s.portChip, browserPort === p && s.portChipActive]}
              onPress={() => setBrowserPort(p)}
              activeOpacity={0.7}
            >
              <Text style={[s.portChipText, browserPort === p && s.portChipTextActive]}>{p}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TextInput
          style={s.portInput}
          value={browserPort}
          onChangeText={(v) => setBrowserPort(v.replace(/\D/g, ''))}
          keyboardType="number-pad"
          placeholder="Custom port"
          placeholderTextColor={colors.textDim}
          maxLength={5}
        />
      </View>

      {/* Browser 2 Port (Tri-Split only) */}
      {isTri && (
        <View style={s.section}>
          <Text style={s.sectionLabel}>Browser 2 Port</Text>
          <View style={s.portRow}>
            {QUICK_PORTS.map((p) => (
              <TouchableOpacity
                key={p}
                style={[s.portChip, browserPort2 === p && s.portChipActive]}
                onPress={() => setBrowserPort2(p)}
                activeOpacity={0.7}
              >
                <Text style={[s.portChipText, browserPort2 === p && s.portChipTextActive]}>{p}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput
            style={s.portInput}
            value={browserPort2}
            onChangeText={(v) => setBrowserPort2(v.replace(/\D/g, ''))}
            keyboardType="number-pad"
            placeholder="Custom port"
            placeholderTextColor={colors.textDim}
            maxLength={5}
          />
        </View>
      )}

      {/* Main Pane selector (Tri-Split only) */}
      {isTri && (
        <View style={s.section}>
          <Text style={s.sectionLabel}>Main Pane (left, larger)</Text>
          {MAIN_PANE_OPTIONS.map((opt) => (
            <TouchableOpacity
              key={opt.id}
              style={[s.mainPaneBtn, mainPane === opt.id && s.mainPaneBtnActive]}
              onPress={() => { Haptics.selectionAsync(); setMainPane(opt.id); }}
              activeOpacity={0.7}
            >
              <Feather name={opt.icon as any} size={14} color={mainPane === opt.id ? '#F472B6' : colors.textDim} />
              <Text style={[s.mainPaneLabel, mainPane === opt.id && s.mainPaneLabelActive]}>
                {opt.label}
              </Text>
              {mainPane === opt.id && (
                <View style={s.mainPaneDot} />
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* URL Previews */}
      <View style={s.urlSection}>
        <Text style={s.urlPreview} numberOfLines={1}>
          <Feather name="globe" size={9} color={colors.textDim} /> http://{serverHost}:{browserPort}
        </Text>
        {isTri && (
          <Text style={s.urlPreview} numberOfLines={1}>
            <Feather name="globe" size={9} color={colors.textDim} /> http://{serverHost}:{browserPort2}
          </Text>
        )}
      </View>

      {/* Activate / Deactivate */}
      <TouchableOpacity
        style={[s.actionBtn, active && s.actionBtnDeactivate]}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          if (active) deactivate(); else activate(browserPort);
        }}
        activeOpacity={0.8}
      >
        <Feather
          name={active ? 'minimize-2' : 'maximize-2'}
          size={16}
          color={active ? colors.destructive : colors.bg}
        />
        <Text style={[s.actionBtnText, active && s.actionBtnTextDeactivate]}>
          {active ? 'Exit Split View' : 'Activate Split View'}
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { paddingBottom: 20 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
    paddingVertical: 10, gap: 7,
  },
  title: { color: colors.text, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
  divider: { height: 1, backgroundColor: 'rgba(51,65,85,0.7)' },

  section: { paddingHorizontal: 12, paddingTop: 12, gap: 6 },
  sectionLabel: {
    color: colors.textDim, fontSize: 10, fontWeight: '600',
    letterSpacing: 0.5, textTransform: 'uppercase',
  },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textDim },
  statusDotActive: { backgroundColor: colors.accent },
  statusText: { color: colors.textMuted, fontSize: 12, fontWeight: '500' },

  layoutGrid: { gap: 6 },
  layoutBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  layoutBtnActive: { backgroundColor: 'rgba(244,114,182,0.08)', borderColor: '#F472B6' },
  layoutLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '500' },
  layoutLabelActive: { color: '#F472B6' },

  portRow: { flexDirection: 'row', gap: 6 },
  portChip: {
    flex: 1, paddingVertical: 6, borderRadius: 6, alignItems: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  portChipActive: { backgroundColor: 'rgba(244,114,182,0.12)', borderColor: '#F472B6' },
  portChipText: { color: colors.textDim, fontSize: 11, fontFamily: fonts.mono, fontWeight: '600' },
  portChipTextActive: { color: '#F472B6' },
  portInput: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: 8, color: colors.text, fontSize: 12, fontFamily: fonts.mono,
    paddingHorizontal: 10, paddingVertical: 7,
  },

  mainPaneBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  mainPaneBtnActive: { backgroundColor: 'rgba(244,114,182,0.08)', borderColor: '#F472B6' },
  mainPaneLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '500', flex: 1 },
  mainPaneLabelActive: { color: '#F472B6' },
  mainPaneDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#F472B6' },

  urlSection: { paddingHorizontal: 12, paddingTop: 10, gap: 2 },
  urlPreview: { color: colors.textDim, fontSize: 10, fontFamily: fonts.mono },

  actionBtn: {
    marginHorizontal: 12, marginTop: 12, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 8, paddingVertical: 10, borderRadius: 9,
    backgroundColor: '#F472B6',
  },
  actionBtnDeactivate: {
    backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.destructive,
  },
  actionBtnText: { color: colors.bg, fontWeight: '700', fontSize: 13 },
  actionBtnTextDeactivate: { color: colors.destructive },
});
