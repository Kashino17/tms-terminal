/**
 * Season 2 Browser — FULLSCREEN glass browser with incognito tabs.
 * Address bar accepts: full URLs, bare `3000` / `3000/api/health` (resolved
 * against the connected Tailscale server host — the dev case), domains, or
 * search terms. Chrome (tabs + address) auto-hides while scrolling; the
 * context bottom bar exposes DevTools/Konsole/Netzwerk/Reload.
 */
import React, { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
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

export interface S2BrowserRef {
  reload: () => void;
  hardReload: () => void;
  toggleConsole: () => void;
  toggleNetwork: () => void;
  newTab: () => void;
}

const START_URL = 'https://www.google.com';

/** Injected once per page: mirrors console + fetch/XHR into a bridge so the
 *  in-app DevTools panel can show logs and network requests. */
const DEVTOOLS_JS = `
(function(){
  if (window.__tmsHooked) return; window.__tmsHooked = true;
  var post = function(kind, data){ try { window.ReactNativeWebView.postMessage(JSON.stringify({kind: kind, data: data})); } catch(e){} };
  ['log','warn','error','info'].forEach(function(level){
    var orig = console[level];
    console[level] = function(){
      try { post('console', { level: level, text: Array.prototype.map.call(arguments, function(a){
        try { return typeof a === 'string' ? a : JSON.stringify(a); } catch(e){ return String(a); }
      }).join(' ') }); } catch(e){}
      orig && orig.apply(console, arguments);
    };
  });
  window.addEventListener('error', function(e){ post('console', { level: 'error', text: e.message + ' @' + e.lineno }); });
  var of = window.fetch;
  window.fetch = function(input, init){
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var t0 = Date.now();
    return of.apply(this, arguments).then(function(res){
      post('net', { url: url, status: res.status, ms: Date.now() - t0, method: (init && init.method) || 'GET' });
      return res;
    }).catch(function(err){ post('net', { url: url, status: 0, ms: Date.now() - t0, method: 'GET' }); throw err; });
  };
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u){ this.__tms = { m: m, u: u, t0: Date.now() }; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(){
    var self = this;
    this.addEventListener('loadend', function(){
      if (self.__tms) post('net', { url: self.__tms.u, status: self.status, ms: Date.now() - self.__tms.t0, method: self.__tms.m });
    });
    return os.apply(this, arguments);
  };
  true;
})();
`;

interface S2BrowserScreenProps {
  toast: (msg: string) => void;
  /** Host of the connected server (Tailscale IP) — enables `port/slug` input. */
  serverHost?: string;
}

export const S2BrowserScreen = forwardRef<S2BrowserRef, S2BrowserScreenProps>(function S2BrowserScreen(
  { toast, serverHost },
  ref,
) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const [tabs, setTabs] = useState<BrowserTab[]>([{ id: `b-${Date.now()}`, url: START_URL, title: 'Neuer Tab' }]);
  const [activeId, setActiveId] = useState(tabs[0].id);
  const [address, setAddress] = useState('');
  const [progress, setProgress] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [chromeOpen, setChromeOpen] = useState(true);
  const [panel, setPanel] = useState<'none' | 'console' | 'network'>('none');
  const [logs, setLogs] = useState<{ level: string; text: string }[]>([]);
  const [net, setNet] = useState<{ url: string; status: number; ms: number; method: string }[]>([]);
  const [reloadNonce, setReloadNonce] = useState(0);
  const webRef = useRef<WebView>(null);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  /** URL resolution — the dev-friendly part: `3000`, `3000/api`, `:8080/x`
   *  all resolve against the connected server host (Tailscale). */
  const normalizeInput = useCallback((input: string): string => {
    const t = input.trim();
    if (!t) return START_URL;
    if (/^https?:\/\//i.test(t)) return t;
    const portOnly = t.match(/^:?(\d{2,5})(\/.*)?$/);
    if (portOnly && serverHost) {
      return `http://${serverHost}:${portOnly[1]}${portOnly[2] ?? ''}`;
    }
    if (/^\/[\w\-./?=&%]*$/.test(t) && serverHost) {
      return `http://${serverHost}${t}`;
    }
    if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(t)) return `https://${t}`;
    return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
  }, [serverHost]);

  const updateTab = useCallback((id: string, patch: Partial<BrowserTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const newTab = useCallback(() => {
    const tab: BrowserTab = { id: `b-${Date.now()}`, url: START_URL, title: 'Neuer Tab' };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
    setAddress('');
    setChromeOpen(true);
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
    updateTab(active.id, { url: normalizeInput(address) });
    setAddress('');
    setChromeOpen(false);
  }, [address, active, updateTab, normalizeInput]);

  useImperativeHandle(ref, () => ({
    reload: () => webRef.current?.reload(),
    hardReload: () => { setLogs([]); setNet([]); setReloadNonce((n) => n + 1); toast('Hard-Reload — Sitzung frisch'); },
    toggleConsole: () => setPanel((p) => (p === 'console' ? 'none' : 'console')),
    toggleNetwork: () => setPanel((p) => (p === 'network' ? 'none' : 'network')),
    newTab,
  }), [newTab, toast]);

  return (
    <View style={{ flex: 1 }}>
      {/* Chrome (tabs + address) — collapsible so the page is truly fullscreen. */}
      {chromeOpen && (
        <>
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
                  <Text numberOfLines={1} style={{ color: isActive ? c.text : c.textDim, fontSize: m.font.micro, fontWeight: '700', maxWidth: 110 }}>
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

          <GlassSurface strong radius={m.radius.pill} style={styles.addressWrap}>
            <View style={styles.addressRow}>
              <Pressable onPress={() => webRef.current?.goBack()} disabled={!canGoBack} style={{ opacity: canGoBack ? 1 : 0.35 }} accessibilityLabel="Zurück">
                <IconBack size={m.icon.sm} color={c.text} />
              </Pressable>
              <Pressable onPress={() => webRef.current?.goForward()} disabled={!canGoForward} style={{ opacity: canGoForward ? 1 : 0.35 }} accessibilityLabel="Vor">
                <IconChevronRight size={m.icon.sm} color={c.text} />
              </Pressable>
              <TextInput
                value={address}
                onChangeText={setAddress}
                onSubmitEditing={go}
                placeholder={serverHost ? `Port (z.B. 3000/api) · URL · Suche` : 'Suchen oder URL…'}
                placeholderTextColor={c.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                style={{ flex: 1, color: c.text, fontSize: m.font.caption, paddingVertical: 8 }}
              />
              <Pressable onPress={() => setChromeOpen(false)} hitSlop={6} accessibilityLabel="Vollbild">
                <Text style={{ color: c.textDim, fontSize: 15, fontWeight: '700' }}>⤢</Text>
              </Pressable>
            </View>
            {progress > 0 && progress < 1 && (
              <View style={styles.progressTrack}>
                <View style={[styles.progressBar, { width: `${Math.round(progress * 100)}%`, backgroundColor: c.accent }]} />
              </View>
            )}
          </GlassSurface>
        </>
      )}

      {!chromeOpen && (
        <Pressable onPress={() => setChromeOpen(true)} style={styles.chromeHandleZone} accessibilityLabel="Adressleiste einblenden">
          <View style={[styles.chromeHandle, { backgroundColor: c.glassBorder }]} />
        </Pressable>
      )}

      {/* Page — fullscreen, edge to edge. */}
      <View style={{ flex: 1 }}>
        {active && (
          <WebView
            key={`${active.id}-${reloadNonce}`}
            ref={webRef}
            source={{ uri: active.url }}
            incognito
            injectedJavaScript={DEVTOOLS_JS}
            onMessage={(e) => {
              try {
                const msg = JSON.parse(e.nativeEvent.data);
                if (msg.kind === 'console') setLogs((prev) => [...prev.slice(-199), msg.data]);
                else if (msg.kind === 'net') setNet((prev) => [...prev.slice(-199), msg.data]);
              } catch { /* ignore malformed bridge payloads */ }
            }}
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

      {/* DevTools panel — console or network, driven by the context bar. */}
      {panel !== 'none' && (
        <GlassSurface strong style={[styles.panel, { marginBottom: m.dockHeight + 26 }]}>
          <View style={styles.panelHead}>
            <Text style={{ color: c.text, fontSize: m.font.caption, fontWeight: '800' }}>
              {panel === 'console' ? `Konsole (${logs.length})` : `Netzwerk (${net.length})`}
            </Text>
            <Pressable onPress={() => (panel === 'console' ? setLogs([]) : setNet([]))} hitSlop={6}>
              <Text style={{ color: c.textDim, fontSize: m.font.micro, fontWeight: '700' }}>Leeren</Text>
            </Pressable>
            <Pressable onPress={() => setPanel('none')} hitSlop={6} accessibilityLabel="Panel schließen">
              <IconClose size={m.icon.sm} color={c.textDim} />
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: 190 }}>
            {panel === 'console' && logs.map((l, i) => (
              <Text key={i} selectable style={{ color: l.level === 'error' ? c.err : l.level === 'warn' ? c.warn : c.textDim, fontSize: m.font.micro, fontFamily: 'monospace', lineHeight: 15 }}>
                {l.text}
              </Text>
            ))}
            {panel === 'network' && net.map((n, i) => (
              <Text key={i} selectable numberOfLines={1} style={{ color: n.status >= 400 || n.status === 0 ? c.err : c.textDim, fontSize: m.font.micro, fontFamily: 'monospace', lineHeight: 15 }}>
                {n.status} {n.method} {n.ms}ms {n.url}
              </Text>
            ))}
            {((panel === 'console' && logs.length === 0) || (panel === 'network' && net.length === 0)) && (
              <Text style={{ color: c.textDim, fontSize: m.font.micro, paddingVertical: 8 }}>Noch nichts aufgezeichnet.</Text>
            )}
          </ScrollView>
        </GlassSurface>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  tabStrip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 6 },
  tabChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 32, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth * 2 },
  addressWrap: { marginHorizontal: 14, marginBottom: 6 },
  addressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 },
  progressTrack: { height: 2, marginHorizontal: 12, marginBottom: 4, borderRadius: 2, overflow: 'hidden' },
  progressBar: { height: 2, borderRadius: 2 },
  chromeHandleZone: { alignItems: 'center', paddingVertical: 6 },
  chromeHandle: { width: 44, height: 4, borderRadius: 3 },
  panel: { position: 'absolute', left: 12, right: 12, bottom: 0, padding: 10 },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 6 },
});
