/**
 * The Browser screen's page area — a real, native, incognito WebView laid over
 * the exact rectangle the Liquid-Deck chrome reports for #browserContent.
 *
 * Why an overlay and not an <iframe> inside the page: half the web refuses to
 * be framed (X-Frame-Options / frame-ancestors), so an iframe browser would
 * break on the first real site. A native WebView has no such limit — and the
 * mockup keeps owning the tabs, the address bar, the progress bar and the
 * sheets, which is the whole design.
 */
import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

export interface BrowserRect { x: number; y: number; w: number; h: number }

interface Props {
  visible: boolean;
  tabId: string | null;
  url: string;
  rect: BrowserRect | null;
  /** Host of the connected server, so `3000` / `3000/api` / `/x` resolve to it. */
  serverHost?: string;
  onTitle: (tabId: string, title: string, url: string) => void;
}

/** `3000`, `:8080/api`, `/health` → the connected Tailscale host. */
export function resolveUrl(input: string, serverHost?: string): string {
  const t = input.trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  const portOnly = t.match(/^:?(\d{2,5})(\/.*)?$/);
  if (portOnly && serverHost) return `http://${serverHost}:${portOnly[1]}${portOnly[2] ?? ''}`;
  if (/^\/[\w\-./?=&%]*$/.test(t) && serverHost) return `http://${serverHost}${t}`;
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

export function NativeBrowserLayer({ visible, tabId, url, rect, serverHost, onTitle }: Props) {
  const resolved = useMemo(() => resolveUrl(url, serverHost), [url, serverHost]);

  if (!visible || !rect || !tabId || !resolved) return null;

  return (
    <View
      style={[styles.layer, { left: rect.x, top: rect.y, width: rect.w, height: rect.h }]}
      pointerEvents="box-none"
    >
      <WebView
        // A new key per tab is the isolation: no shared history, no shared JS
        // context. `incognito` on top means no cookies or cache survive either.
        key={tabId}
        source={{ uri: resolved }}
        incognito
        cacheEnabled={false}
        thirdPartyCookiesEnabled={false}
        javaScriptEnabled
        domStorageEnabled={false}
        allowsBackForwardNavigationGestures
        setSupportMultipleWindows={false}
        onNavigationStateChange={(nav) => {
          if (!nav.loading) onTitle(tabId, nav.title ?? '', nav.url ?? resolved);
        }}
        style={styles.web}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', overflow: 'hidden', borderRadius: 14 },
  web: { flex: 1, backgroundColor: '#fff' },
});
