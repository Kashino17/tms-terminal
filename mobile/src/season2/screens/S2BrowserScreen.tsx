/**
 * Season 2 Browser — native glass browser with INCOGNITO tabs (WebView
 * `incognito` — no cookies/storage persisted, tabs fully isolated), glass
 * address bar with back/forward/reload, load progress, tab strip with
 * unlimited tabs. App-level (dock item), independent of terminals.
 */
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { GlassSurface } from '../components/GlassSurface';
import { useS2Theme } from '../theme/tokens';
import { IconPlus, IconClose, IconBack, IconChevronRight, IconBrowser } from '../icons';

interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

const START_URL = 'https://www.google.com';

function normalizeInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return START_URL;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

export function S2BrowserScreen({ toast }: { toast: (msg: string) => void }) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const [tabs, setTabs] = useState<BrowserTab[]>([{ id: `b-${Date.now()}`, url: START_URL, title: 'Neuer Tab' }]);
  const [activeId, setActiveId] = useState(tabs[0].id);
  const [address, setAddress] = useState('');
  const [progress, setProgress] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const webRef = useRef<WebView>(null);
  // Remount key per tab — bumping it hard-reloads the isolated session.
  const [reloadNonce, setReloadNonce] = useState(0);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const updateTab = useCallback((id: string, patch: Partial<BrowserTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const newTab = useCallback(() => {
    const tab: BrowserTab = { id: `b-${Date.now()}`, url: START_URL, title: 'Neuer Tab' };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
    setAddress('');
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        const fresh: BrowserTab = { id: `b-${Date.now()}`, url: START_URL, title: 'Neuer Tab' };
        setActiveId(fresh.id);
        return [fresh];
      }
      if (id === activeId) setActiveId(next[next.length - 1].id);
      return next;
    });
  }, [activeId]);

  const go = useCallback(() => {
    if (!active) return;
    const url = normalizeInput(address);
    updateTab(active.id, { url });
    setAddress('');
  }, [address, active, updateTab]);

  const clearSession = useCallback(() => {
    setReloadNonce((n) => n + 1);
    toast('Sitzung geleert — Tab startet frisch');
  }, [toast]);

  return (
    <View style={{ flex: 1 }}>
      {/* Tab strip */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={styles.tabStrip}>
        {tabs.map((tab) => {
          const isActive = tab.id === active?.id;
          return (
            <Pressable
              key={tab.id}
              onPress={() => setActiveId(tab.id)}
              style={[styles.tabChip, { borderColor: isActive ? `rgba(${c.accentRgb},0.5)` : c.glassBorder, backgroundColor: isActive ? `rgba(${c.accentRgb},0.14)` : `rgba(${c.overlayRgb},0.05)` }]}
            >
              <IconBrowser size={12} color={isActive ? c.accent : c.textDim} />
              <Text numberOfLines={1} style={{ color: isActive ? c.text : c.textDim, fontSize: m.font.micro, fontWeight: '700', maxWidth: 120 }}>
                {tab.title || 'Tab'}
              </Text>
              <Pressable onPress={() => closeTab(tab.id)} hitSlop={8} accessibilityLabel="Tab schließen">
                <IconClose size={11} color={c.textDim} />
              </Pressable>
            </Pressable>
          );
        })}
        <Pressable onPress={newTab} accessibilityLabel="Neuer Tab" style={[styles.tabChip, { borderColor: c.glassBorder }]}>
          <IconPlus size={12} color={c.accent} />
          <Text style={{ color: c.accent, fontSize: m.font.micro, fontWeight: '800' }}>Neu</Text>
        </Pressable>
      </ScrollView>

      {/* Address bar */}
      <GlassSurface strong radius={m.radius.pill} style={styles.addressWrap}>
        <View style={styles.addressRow}>
          <Pressable
            onPress={() => webRef.current?.goBack()}
            disabled={!canGoBack}
            accessibilityLabel="Zurück"
            style={{ opacity: canGoBack ? 1 : 0.35 }}
          >
            <IconBack size={m.icon.sm} color={c.text} />
          </Pressable>
          <Pressable
            onPress={() => webRef.current?.goForward()}
            disabled={!canGoForward}
            accessibilityLabel="Vor"
            style={{ opacity: canGoForward ? 1 : 0.35 }}
          >
            <IconChevronRight size={m.icon.sm} color={c.text} />
          </Pressable>
          <TextInput
            value={address}
            onChangeText={setAddress}
            onSubmitEditing={go}
            placeholder={active?.url ?? 'Suchen oder URL…'}
            placeholderTextColor={c.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            style={{ flex: 1, color: c.text, fontSize: m.font.caption, paddingVertical: 8 }}
          />
          <Pressable onPress={() => webRef.current?.reload()} accessibilityLabel="Neu laden" hitSlop={6}>
            <Text style={{ color: c.text, fontSize: 15, fontWeight: '700' }}>↻</Text>
          </Pressable>
          <Pressable onPress={clearSession} accessibilityLabel="Sitzung leeren" hitSlop={6}>
            <IconClose size={m.icon.sm} color={c.textDim} />
          </Pressable>
        </View>
        {progress > 0 && progress < 1 && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressBar, { width: `${Math.round(progress * 100)}%`, backgroundColor: c.accent }]} />
          </View>
        )}
      </GlassSurface>

      <Text style={{ color: c.textDim, fontSize: m.font.micro, textAlign: 'center', paddingBottom: 6 }}>
        Inkognito · isoliert · keine Cookies
      </Text>

      {/* Active tab — incognito WebView, remounted per tab (full isolation). */}
      <View style={[styles.webWrap, { borderColor: c.glassBorder, marginBottom: m.dockHeight + 34 }]}>
        {active && (
          <WebView
            key={`${active.id}-${reloadNonce}`}
            ref={webRef}
            source={{ uri: active.url }}
            incognito
            onLoadProgress={(e) => setProgress(e.nativeEvent.progress)}
            onNavigationStateChange={(nav) => {
              setCanGoBack(nav.canGoBack);
              setCanGoForward(nav.canGoForward);
              if (nav.title) updateTab(active.id, { title: nav.title });
              if (nav.url) updateTab(active.id, { url: nav.url });
            }}
            style={{ flex: 1, backgroundColor: 'transparent' }}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tabStrip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  tabChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 32, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth * 2 },
  addressWrap: { marginHorizontal: 16, marginBottom: 6 },
  addressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 },
  progressTrack: { height: 2, marginHorizontal: 12, marginBottom: 4, borderRadius: 2, overflow: 'hidden' },
  progressBar: { height: 2, borderRadius: 2 },
  webWrap: { flex: 1, marginHorizontal: 12, borderRadius: 18, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth * 2 },
});
