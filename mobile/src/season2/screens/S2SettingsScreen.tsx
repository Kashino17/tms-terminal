/**
 * Season 2 Einstellungen — the S2-relevant preferences in glass; everything
 * else (Server-Profile, Sicherheit, Benachrichtigungen, Cloud-Tokens, …)
 * stays in the classic settings, reachable via bridge.
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../types/navigation.types';
import { useSettingsStore } from '../../store/settingsStore';
import { GlassSurface } from '../components/GlassSurface';
import { useS2Theme } from '../theme/tokens';
import { useUiPrefsStore } from '../store/uiPrefsStore';
import { IconSun, IconBack, IconChevronRight, IconPlus, IconTerminal } from '../icons';

interface S2SettingsScreenProps {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SeasonTwo'>;
}

export function S2SettingsScreen({ navigation }: S2SettingsScreenProps) {
  const { theme, toggleTheme } = useS2Theme();
  const { c, m } = theme;
  const setSeasonTwoEnabled = useSettingsStore((s) => s.setSeasonTwoEnabled);
  const fontSize = useUiPrefsStore((s) => s.terminalFontSize);
  const setFontSize = useUiPrefsStore((s) => s.setTerminalFontSize);

  const row = (pressed: boolean) => [styles.row, { borderTopColor: `rgba(${c.overlayRgb},0.08)` }, pressed && { opacity: 0.7 }];

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.headRow}>
        <Text style={[styles.pageTitle, { color: c.text, fontSize: m.font.title }]}>Einstellungen</Text>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: m.dockHeight + 40 }}>
        <Text style={[styles.section, { color: c.textDim }]}>DARSTELLUNG</Text>
        <GlassSurface style={{ paddingHorizontal: 8 }}>
          <Pressable onPress={toggleTheme} style={({ pressed }) => row(pressed)}>
            <IconSun size={m.icon.sm} color={c.accent} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontSize: m.font.body, fontWeight: '600' }}>Erscheinungsbild</Text>
              <Text style={{ color: c.textDim, fontSize: m.font.micro, marginTop: 2 }}>
                {theme.name === 'dark' ? 'Dunkel (Kindle-Grau)' : 'Hell (Outdoor)'} — antippen zum Wechseln
              </Text>
            </View>
          </Pressable>
          <View style={[styles.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: `rgba(${c.overlayRgb},0.08)` }]}>
            <IconTerminal size={m.icon.sm} color={c.textDim} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontSize: m.font.body, fontWeight: '600' }}>Terminal-Schriftgröße</Text>
              <Text style={{ color: c.textDim, fontSize: m.font.micro, marginTop: 2 }}>Gilt für Season-2-Terminals</Text>
            </View>
            <Pressable onPress={() => setFontSize(fontSize - 1)} hitSlop={6} style={[styles.stepBtn, { borderColor: c.glassBorder }]}>
              <Text style={{ color: c.text, fontSize: 16, fontWeight: '800' }}>−</Text>
            </Pressable>
            <Text style={{ color: c.text, fontSize: m.font.body, fontWeight: '700', minWidth: 26, textAlign: 'center' }}>{fontSize}</Text>
            <Pressable onPress={() => setFontSize(fontSize + 1)} hitSlop={6} style={[styles.stepBtn, { borderColor: c.glassBorder }]}>
              <IconPlus size={12} color={c.text} />
            </Pressable>
          </View>
        </GlassSurface>

        <Text style={[styles.section, { color: c.textDim }]}>UI-VERSION</Text>
        <GlassSurface style={{ paddingHorizontal: 8 }}>
          <Pressable onPress={() => setSeasonTwoEnabled(false)} style={({ pressed }) => row(pressed)}>
            <IconBack size={m.icon.sm} color={c.textDim} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontSize: m.font.body, fontWeight: '600' }}>Zurück zu Klassisch</Text>
              <Text style={{ color: c.textDim, fontSize: m.font.micro, marginTop: 2 }}>Jederzeit wieder umschaltbar</Text>
            </View>
          </Pressable>
        </GlassSurface>

        <Text style={[styles.section, { color: c.textDim }]}>ALLES WEITERE</Text>
        <GlassSurface style={{ paddingHorizontal: 8 }}>
          <Pressable onPress={() => navigation.navigate('Settings')} style={({ pressed }) => row(pressed)}>
            <IconChevronRight size={m.icon.sm} color={c.textDim} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontSize: m.font.body, fontWeight: '600' }}>Klassische Einstellungen öffnen</Text>
              <Text style={{ color: c.textDim, fontSize: m.font.micro, marginTop: 2 }}>
                Sicherheit, Benachrichtigungen, Cloud-Tokens, Manager, Sprache …
              </Text>
            </View>
          </Pressable>
        </GlassSurface>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  pageTitle: { fontWeight: '700', letterSpacing: -0.26 },
  headRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  section: { fontSize: 10.5, fontWeight: '700', letterSpacing: 1, marginTop: 14, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 13 },
  stepBtn: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2 },
});
