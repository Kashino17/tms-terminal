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
import React, { useMemo, useState, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { View, StyleSheet, Text, Pressable } from 'react-native';
import { WebView } from 'react-native-webview';

export interface BrowserRect { x: number; y: number; w: number; h: number }

/** Was die Seite dem nativen Browser befehlen kann. */
export interface BrowserHandle {
  reload: () => void;
  clearCache: () => void;
}

interface Props {
  /** Wird die Seite gezeichnet? (Overlay der Deck-Seite darüber → false.) */
  visible: boolean;
  /** Steht der Browser-Bildschirm vorn? Sonst wird der WebView abgebaut. */
  onScreen: boolean;
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

export const NativeBrowserLayer = forwardRef<BrowserHandle, Props>(function NativeBrowserLayer(
  { visible, onScreen, tabId, url, rect, serverHost, onTitle }: Props,
  ref,
) {
  const resolved = useMemo(() => resolveUrl(url, serverHost), [url, serverHost]);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const webRef = useRef<WebView>(null);

  // WICHTIG: Die Quelle MUSS ihre Identität behalten, solange sich die Adresse
  // nicht ändert. Als Inline-Objekt (`source={{ uri: resolved }}`) war sie bei
  // JEDEM Rendern neu — und gerendert wird bei jedem browser:sync, also auch,
  // wenn die Seite nur eine Body-Klasse umlegt (Ruhemodus, Tastenleiste, Theme).
  // Der native WebView bekam so laufend eine "neue" Quelle gereicht und lud die
  // Seite immer wieder neu: das weiße Bild.
  const source = useMemo(() => ({ uri: resolved }), [resolved]);

  // Ein neuer Tab / eine neue Adresse startet ohne alten Fehler.
  useEffect(() => setError(null), [tabId, resolved]);

  useImperativeHandle(ref, () => ({
    reload: () => { setError(null); webRef.current?.reload(); },
    clearCache: () => {
      // Erst den nativen Cache wegwerfen, dann den WebView neu aufbauen: nur der
      // Neuaufbau wirft auch die Sitzung (incognito) und den Speicher der Seite weg.
      webRef.current?.clearCache?.(true);
      setError(null);
      setReloadKey((k) => k + 1);
    },
  }), []);

  // WÄRME: Ausgeblendet ist nicht ausgeschaltet. Ein Android-WebView führt sein
  // JavaScript auch mit display:'none' weiter aus — ein Dashboard-Tab (Render,
  // Vercel …) pollt und animiert dann stundenlang weiter, während man im Terminal
  // sitzt. Verlässt man den Browser-Bildschirm, wird er deshalb ABGEBAUT. Nur für
  // Overlays (Tab-Liste, Menü) bleibt er montiert und wird bloß versteckt — dort
  // wäre ein Neuladen beim Zurückkommen die schlechtere Wahl.
  if (!onScreen || !rect || !tabId || !resolved) return null;

  return (
    <View
      // Unsichtbar heißt AUSGEBLENDET, nicht abgerissen: würde der WebView bei
      // jedem Tab-Sheet aushängen, lüde die Seite danach komplett neu (und der
      // Scroll-Stand wäre weg). display:'none' hält ihn am Leben.
      style={[
        styles.layer,
        { left: rect.x, top: rect.y, width: rect.w, height: rect.h },
        !visible && styles.hidden,
      ]}
      pointerEvents={visible ? 'box-none' : 'none'}
    >
      <WebView
        ref={webRef}
        // A new key per tab is the isolation: no shared history, no shared JS
        // context. `incognito` on top means no cookies or cache survive either.
        key={`${tabId}:${reloadKey}`}
        source={source}
        incognito
        cacheEnabled={false}
        thirdPartyCookiesEnabled={false}
        javaScriptEnabled
        // MUSS an sein. Ohne DOM-Storage wirft jede React-/Next-Seite beim
        // ersten localStorage-Zugriff — die Seite lädt, der Titel kommt an,
        // gerendert wird aber nichts: die weiße Seite. `incognito` sorgt weiter
        // dafür, dass nichts davon die Sitzung überlebt.
        domStorageEnabled
        // Seiten auf dem eigenen Server laufen über http (Tailscale verschlüsselt),
        // ziehen aber oft https-Unterressourcen — sonst bleibt die Seite leer.
        mixedContentMode="always"
        originWhitelist={['*']}
        allowsBackForwardNavigationGestures
        setSupportMultipleWindows={false}
        onNavigationStateChange={(nav) => {
          if (!nav.loading) onTitle(tabId, nav.title ?? '', nav.url ?? resolved);
        }}
        // Fehler dürfen nicht mehr als weiße Fläche enden — sie werden benannt.
        onError={(e) => setError(e.nativeEvent.description || 'Unbekannter Fehler')}
        onHttpError={(e) =>
          setError(`HTTP ${e.nativeEvent.statusCode} — ${e.nativeEvent.description || 'Seite nicht erreichbar'}`)
        }
        // Stirbt der Seiten-Prozess (Android killt ihn bei Speichermangel), ist die
        // WebView-Instanz TOT — eine Fehlermeldung allein liesse sie tot. Also neu
        // aufbauen: ein frischer key erzeugt eine lebende Instanz, die die Adresse
        // wieder lädt.
        onRenderProcessGone={() => {
          setError(null);
          setReloadKey((k) => k + 1);
        }}
        style={styles.web}
      />
      {error && (
        <View style={styles.error}>
          <Text style={styles.errorTitle}>Seite konnte nicht geladen werden</Text>
          <Text style={styles.errorMsg} numberOfLines={3}>{error}</Text>
          <Text style={styles.errorUrl} numberOfLines={1}>{resolved}</Text>
          <Pressable
            style={styles.errorBtn}
            onPress={() => { setError(null); setReloadKey((k) => k + 1); }}
          >
            <Text style={styles.errorBtnText}>Erneut versuchen</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  layer: { position: 'absolute', overflow: 'hidden', borderRadius: 14 },
  hidden: { display: 'none' },
  web: { flex: 1, backgroundColor: '#fff' },
  error: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#12161f',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  errorTitle: { color: '#E7ECF3', fontSize: 15, fontWeight: '700' },
  errorMsg: { color: '#93A1B5', fontSize: 13, textAlign: 'center' },
  errorUrl: { color: '#5C6B82', fontSize: 11, marginTop: 2 },
  errorBtn: {
    marginTop: 12,
    paddingVertical: 9,
    paddingHorizontal: 18,
    borderRadius: 999,
    backgroundColor: 'rgba(96,165,250,.18)',
  },
  errorBtnText: { color: '#60A5FA', fontSize: 13, fontWeight: '700' },
});
