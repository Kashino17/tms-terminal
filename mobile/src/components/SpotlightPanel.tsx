import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity,
  Modal, Animated, StyleSheet, Pressable,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, fonts } from '../theme';
import type { TerminalTab } from '../types/terminal.types';
import { tabDisplayName } from '../utils/tabDisplayName';

// ── Types ───────────────────────────────────────────────────────────────────

interface SpotlightPanelProps {
  visible: boolean;
  tabs: TerminalTab[];
  activeTabId: string | undefined;
  onClose: () => void;
  onSelectTab: (tabId: string) => void;
  onSelectTool: (toolId: string) => void;
  onNavigate: (dest: string) => void;
}

interface SpotlightItem {
  id: string;
  label: string;
  category: 'TABS' | 'TOOLS' | 'NAVIGATION';
  dotColor: string;
  badge?: string;
  badgeColor?: string;
}

// ── Static data ─────────────────────────────────────────────────────────────

const TOOL_ITEMS: SpotlightItem[] = [
  { id: 'autoApprove',  label: 'Auto Approve',  category: 'TOOLS', dotColor: '#22C55E' },
  { id: 'snippets',     label: 'Snippets',      category: 'TOOLS', dotColor: '#F59E0B' },
  { id: 'files',        label: 'Dateien',        category: 'TOOLS', dotColor: '#F59E0B' },
  { id: 'screenshots',  label: 'Screenshots',    category: 'TOOLS', dotColor: '#06B6D4' },
  { id: 'autopilot',    label: 'Autopilot',      category: 'TOOLS', dotColor: '#A78BFA' },
  { id: 'watchers',     label: 'Watchers',       category: 'TOOLS', dotColor: '#F59E0B' },
  { id: 'ports',        label: 'Ports',          category: 'TOOLS', dotColor: '#10B981' },
  { id: 'sql',          label: 'SQL',            category: 'TOOLS', dotColor: '#3B82F6' },
  { id: 'render',       label: 'Render',         category: 'TOOLS', dotColor: '#6366F1' },
  { id: 'vercel',       label: 'Vercel',         category: 'TOOLS', dotColor: '#F8FAFC' },
  { id: 'supabase',     label: 'Supabase',       category: 'TOOLS', dotColor: '#3ECF8E' },
];

const NAV_ITEMS: SpotlightItem[] = [
  { id: 'browser',      label: 'Browser',        category: 'NAVIGATION', dotColor: '#3B82F6' },
  { id: 'manager',      label: 'Manager Agent',  category: 'NAVIGATION', dotColor: '#A78BFA' },
  { id: 'draw',         label: 'Zeichnen',       category: 'NAVIGATION', dotColor: '#F59E0B' },
  { id: 'processes',    label: 'Prozesse',       category: 'NAVIGATION', dotColor: '#10B981' },
];

// ── Component ───────────────────────────────────────────────────────────────

export function SpotlightPanel({
  visible,
  tabs,
  activeTabId,
  onClose,
  onSelectTab,
  onSelectTool,
  onNavigate,
}: SpotlightPanelProps) {
  const scaleAnim = useRef(new Animated.Value(0.94)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const [query, setQuery] = useState('');
  const [inputFocused, setInputFocused] = useState(false);

  // Reset state and animate on open
  useEffect(() => {
    if (visible) {
      setQuery('');
      setInputFocused(false);
      scaleAnim.setValue(0.94);
      opacityAnim.setValue(0);
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 260,
          friction: 18,
          useNativeDriver: true,
        }),
        Animated.spring(opacityAnim, {
          toValue: 1,
          tension: 260,
          friction: 18,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, scaleAnim, opacityAnim]);

  // Build tab items from props
  const tabItems: SpotlightItem[] = useMemo(
    () =>
      tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const hasNotifications = (tab.notificationCount ?? 0) > 0;
        const dotColor = tab.aiTool ? '#A78BFA' : '#3B82F6';
        let badge: string | undefined;
        let badgeColor: string | undefined;
        if (isActive) {
          badge = 'aktiv';
          badgeColor = undefined; // default muted style
        } else if (hasNotifications) {
          badge = String(tab.notificationCount);
          badgeColor = '#EF4444';
        }
        return {
          id: tab.id,
          label: tabDisplayName(tab),
          category: 'TABS' as const,
          dotColor,
          badge,
          badgeColor,
        };
      }),
    [tabs, activeTabId],
  );

  // All items combined
  const allItems = useMemo(
    () => [...tabItems, ...TOOL_ITEMS, ...NAV_ITEMS],
    [tabItems],
  );

  // Filtered items
  const filtered = useMemo(() => {
    if (!query.trim()) return allItems;
    const q = query.toLowerCase();
    return allItems.filter((item) => item.label.toLowerCase().includes(q));
  }, [allItems, query]);

  // Group by category, skip empty
  const grouped = useMemo(() => {
    const categories: Array<{ title: string; items: SpotlightItem[] }> = [];
    const tabGroup = filtered.filter((i) => i.category === 'TABS');
    const toolGroup = filtered.filter((i) => i.category === 'TOOLS');
    const navGroup = filtered.filter((i) => i.category === 'NAVIGATION');
    if (tabGroup.length > 0) categories.push({ title: 'TABS', items: tabGroup });
    if (toolGroup.length > 0) categories.push({ title: 'TOOLS', items: toolGroup });
    if (navGroup.length > 0) categories.push({ title: 'NAVIGATION', items: navGroup });
    return categories;
  }, [filtered]);

  const dismiss = useCallback(() => {
    Animated.parallel([
      Animated.timing(opacityAnim, { toValue: 0, duration: 150, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 0.94, duration: 150, useNativeDriver: true }),
    ]).start(() => onClose());
  }, [opacityAnim, scaleAnim, onClose]);

  const handleSelect = useCallback(
    (item: SpotlightItem) => {
      dismiss();
      // Delay callback so exit animation is visible
      setTimeout(() => {
        if (item.category === 'TABS') onSelectTab(item.id);
        else if (item.category === 'TOOLS') onSelectTool(item.id);
        else onNavigate(item.id);
      }, 160);
    },
    [dismiss, onSelectTab, onSelectTool, onNavigate],
  );

  if (!visible) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={dismiss}>
      {/* Backdrop */}
      <Pressable style={styles.backdrop} onPress={dismiss}>
        <Animated.View style={[styles.backdrop, { opacity: opacityAnim }]} />
      </Pressable>

      {/* Card */}
      <Animated.View
        style={[
          styles.card,
          {
            opacity: opacityAnim,
            transform: [{ scale: scaleAnim }],
          },
        ]}
      >
        {/* Search input */}
        <TextInput
          style={[
            styles.input,
            inputFocused && styles.inputFocused,
          ]}
          placeholder="Suchen..."
          placeholderTextColor="#475569"
          value={query}
          onChangeText={setQuery}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          autoFocus
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
        />

        {/* Results */}
        <ScrollView style={styles.results} keyboardShouldPersistTaps="handled">
          {grouped.map((group, gi) => (
            <View key={group.title}>
              {gi > 0 && <View style={styles.separator} />}
              <Text style={styles.categoryHeader}>{group.title}</Text>
              {group.items.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={styles.resultRow}
                  onPress={() => handleSelect(item)}
                  activeOpacity={0.6}
                >
                  <View style={[styles.dot, { backgroundColor: item.dotColor }]} />
                  <Text style={styles.resultLabel} numberOfLines={1}>
                    {item.label}
                  </Text>
                  {item.badge != null && (
                    <View
                      style={[
                        styles.badge,
                        item.badgeColor != null && { backgroundColor: item.badgeColor + '22', borderColor: item.badgeColor + '44' },
                      ]}
                    >
                      <Text
                        style={[
                          styles.badgeText,
                          item.badgeColor != null && { color: item.badgeColor },
                        ]}
                      >
                        {item.badge}
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          ))}

          {grouped.length === 0 && (
            <Text style={styles.emptyText}>Keine Ergebnisse</Text>
          )}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  card: {
    position: 'absolute',
    top: 80,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(15,23,42,0.92)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 8,
  },
  input: {
    backgroundColor: '#0F172A',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontSize: 13,
    fontFamily: fonts.mono,
    color: colors.text,
  },
  inputFocused: {
    borderColor: '#3B82F6',
  },
  results: {
    maxHeight: 320,
    marginTop: 6,
  },
  categoryHeader: {
    fontSize: 9,
    fontWeight: '700',
    color: '#475569',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  resultLabel: {
    flex: 1,
    fontSize: 13,
    color: colors.text,
  },
  badge: {
    backgroundColor: '#1B2336',
    borderWidth: 1,
    borderColor: '#243044',
    borderRadius: 4,
    paddingVertical: 1,
    paddingHorizontal: 5,
  },
  badgeText: {
    fontSize: 9,
    fontFamily: fonts.mono,
    color: '#475569',
  },
  separator: {
    height: 1,
    backgroundColor: '#1E293B',
    marginVertical: 4,
  },
  emptyText: {
    fontSize: 12,
    color: '#475569',
    textAlign: 'center',
    paddingVertical: 20,
  },
});
