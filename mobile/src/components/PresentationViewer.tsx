import React, { useCallback, useState } from 'react';
import {
  Modal,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

// ── Props ───────────────────────────────────────────────────────────────────

interface PresentationViewerProps {
  visible: boolean;
  url: string;
  title: string;
  onClose: () => void;
}

// ── Component ───────────────────────────────────────────────────────────────

export function PresentationViewer({ visible, url, title, onClose }: PresentationViewerProps) {
  const insets = useSafeAreaInsets();
  const [slideInfo, setSlideInfo] = useState<{ index: number; total: number } | null>(null);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'slideChange' || data.type === 'ready') {
        setSlideInfo({ index: data.index ?? 0, total: data.total ?? 1 });
      }
    } catch {}
  }, []);

  const handleShare = useCallback(async () => {
    try {
      await Share.share({ url, title });
    } catch {}
  }, [url, title]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <StatusBar hidden translucent />
      <View style={styles.container}>
        {/* Header — below status bar */}
        <View style={[styles.header, { paddingTop: 12 }]}>
          <TouchableOpacity style={styles.headerBtn} onPress={onClose} hitSlop={8}>
            <Feather name="x" size={22} color="#F8FAFC" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
          </View>
          <TouchableOpacity style={styles.headerBtn} onPress={handleShare} hitSlop={8}>
            <Feather name="share" size={20} color="#F8FAFC" />
          </TouchableOpacity>
        </View>

        {/* WebView — below header, not overlapping */}
        <WebView
          source={{ uri: url }}
          style={styles.webview}
          onMessage={handleMessage}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          startInLoadingState
        />

        {/* Slide counter overlay */}
        {slideInfo && (
          <View style={[styles.counter, { bottom: insets.bottom + 16 }]}>
            <Text style={styles.counterText}>
              {slideInfo.index + 1} / {slideInfo.total}
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  webview: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 8,
    backgroundColor: '#0F172A',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(148,163,184,0.06)',
  },
  headerBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  headerTitle: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '600',
  },
  counter: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: 'rgba(15,23,42,0.8)',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
  },
  counterText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
});
