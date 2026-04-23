import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Asset } from 'expo-asset';
import type { VoicePhase } from '../../store/voiceStore';

interface Props {
  phase: VoicePhase;
}

export function CharacterWebView({ phase }: Props) {
  const webviewRef = useRef<WebView>(null);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const asset = Asset.fromModule(require('../../../assets/voice-character/index.html'));
      await asset.downloadAsync();
      const uri = asset.localUri ?? asset.uri;
      const res = await fetch(uri);
      const text = await res.text();
      if (!cancelled) setHtml(text);
    })().catch((err) => { console.warn('CharacterWebView asset load failed', err); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (webviewRef.current && html) {
      webviewRef.current.postMessage(JSON.stringify({ type: 'setPhase', phase }));
    }
  }, [phase, html]);

  if (!html) return <View style={styles.container} />;

  return (
    <View style={styles.container} pointerEvents="none">
      <WebView
        ref={webviewRef}
        source={{ html }}
        style={styles.webview}
        scrollEnabled={false}
        bounces={false}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        allowFileAccess
        androidLayerType="hardware"
        {...({ backgroundColor: 'transparent' } as any)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { ...StyleSheet.absoluteFillObject },
  webview: { flex: 1, backgroundColor: 'transparent' },
});
