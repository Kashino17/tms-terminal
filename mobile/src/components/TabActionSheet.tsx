import React, { useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fonts } from '../theme';
import type { TabCategory } from '../types/terminal.types';

/**
 * Umbenennen und Kategorie setzen fuer einen Terminal-Reiter.
 *
 * Beide Aktionen gab es schon (handleRenameTab / handleChangeCategory in
 * TerminalScreen.tsx), waren aber an TerminalTabs gebunden — eine Leiste, die
 * nirgends gerendert wird. Seit der Umstellung auf den Orb-Layer war ein
 * Umbenennen gar nicht mehr moeglich, und bei 6 bis 8 offenen Terminals ist
 * "welches ist das nochmal" eine Frage, die man sich dann bei jedem Umschalten
 * neu beantwortet.
 */

const CATEGORIES: { id: TabCategory; label: string; icon: string; color: string }[] = [
  { id: 'ai',    label: 'KI / Agent', icon: 'zap',        color: '#A78BFA' },
  { id: 'server', label: 'Server',    icon: 'server',     color: '#3B82F6' },
  { id: 'shell', label: 'Shell',     icon: 'terminal',   color: '#10B981' },
];

interface Props {
  visible: boolean;
  /** Aktueller Titel — wird als Startwert uebernommen. */
  currentTitle: string;
  currentCategory?: TabCategory;
  onRename: (name: string) => void;
  onCategory: (category: TabCategory) => void;
  onClose: () => void;
}

export function TabActionSheet({
  visible, currentTitle, currentCategory, onRename, onCategory, onClose,
}: Props) {
  const [mode, setMode] = useState<'menu' | 'rename'>('menu');
  const [draft, setDraft] = useState(currentTitle);

  const close = () => {
    setMode('menu');
    onClose();
  };

  const startRename = () => {
    setDraft(currentTitle);
    setMode('rename');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== currentTitle) {
      onRename(trimmed);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    close();
  };

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={close}>
      <TouchableOpacity style={s.scrim} activeOpacity={1} onPress={close} />
      <View style={s.sheet}>
        {mode === 'menu' ? (
          <>
            <Text style={s.title}>Terminal</Text>
            <Text style={s.subtitle} numberOfLines={1}>{currentTitle}</Text>

            <TouchableOpacity style={s.row} onPress={startRename} activeOpacity={0.7}>
              <Feather name="edit-2" size={16} color={colors.text} />
              <Text style={s.rowLabel}>Umbenennen</Text>
            </TouchableOpacity>

            <Text style={s.sectionLabel}>Kategorie</Text>
            {CATEGORIES.map((c) => {
              const active = currentCategory === c.id;
              return (
                <TouchableOpacity
                  key={c.id}
                  style={s.row}
                  activeOpacity={0.7}
                  onPress={() => { onCategory(c.id); close(); }}
                >
                  <Feather name={c.icon as any} size={16} color={c.color} />
                  <Text style={[s.rowLabel, active && { color: c.color, fontWeight: '700' }]}>
                    {c.label}
                  </Text>
                  {active && <Feather name="check" size={16} color={c.color} />}
                </TouchableOpacity>
              );
            })}
          </>
        ) : (
          <>
            <Text style={s.title}>Neuer Name</Text>
            <TextInput
              style={s.input}
              value={draft}
              onChangeText={setDraft}
              autoFocus
              selectTextOnFocus
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={commitRename}
              placeholder="z. B. API-Server"
              placeholderTextColor={colors.textMuted}
            />
            <View style={s.buttonRow}>
              <TouchableOpacity style={s.button} onPress={() => setMode('menu')} activeOpacity={0.7}>
                <Text style={s.buttonText}>Abbrechen</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.button, s.buttonPrimary]} onPress={commitRename} activeOpacity={0.7}>
                <Text style={[s.buttonText, { color: '#fff' }]}>Speichern</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    position: 'absolute',
    left: 16, right: 16, bottom: 24,
    backgroundColor: colors.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 14,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 12, marginTop: 2, marginBottom: 10 },
  sectionLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 10,
    marginBottom: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
  },
  rowLabel: { color: colors.text, fontSize: 15, flex: 1 },
  input: {
    marginTop: 12,
    backgroundColor: colors.bg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  button: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.surfaceAlt,
  },
  buttonPrimary: { backgroundColor: colors.primary },
  buttonText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
});