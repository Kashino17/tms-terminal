import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
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
import Markdown from 'react-native-markdown-display';
import { colors, fonts } from '../theme';

// ── Props ───────────────────────────────────────────────────────────────────

interface PresentationViewerProps {
  visible: boolean;
  url: string;
  title: string;
  onClose: () => void;
  /** Called when user taps a slide element. Parent should send the question and call setDrillDownAnswer when AI responds. */
  onDrillDown?: (text: string, slideIndex: number) => void;
  /** The AI's answer to the last drill-down question. Set by parent. */
  drillDownAnswer?: string | null;
  /** Whether a drill-down answer is loading */
  drillDownLoading?: boolean;
}

// ── Component ───────────────────────────────────────────────────────────────

export function PresentationViewer({
  visible, url, title, onClose, onDrillDown, drillDownAnswer, drillDownLoading,
}: PresentationViewerProps) {
  const insets = useSafeAreaInsets();
  const [slideInfo, setSlideInfo] = useState<{ index: number; total: number } | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);

  // Show answer overlay when a new answer arrives
  useEffect(() => {
    if (drillDownAnswer) setShowAnswer(true);
  }, [drillDownAnswer]);

  // Reset state when viewer closes
  useEffect(() => {
    if (!visible) {
      setSelectedText(null);
      setShowAnswer(false);
    }
  }, [visible]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'slideChange' || data.type === 'ready') {
        setSlideInfo({ index: data.index ?? 0, total: data.total ?? 1 });
      } else if (data.type === 'drillDown' && data.text) {
        setSelectedText(data.text);
        setShowAnswer(false); // Clear previous answer
        onDrillDown?.(data.text, data.slideIndex ?? 0);
      }
    } catch {}
  }, [onDrillDown]);

  const handleShare = useCallback(async () => {
    try {
      await Share.share({ url, title });
    } catch {}
  }, [url, title]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <StatusBar hidden translucent />
      <View style={s.container}>
        {/* Header */}
        <View style={[s.header, { paddingTop: 12 }]}>
          <TouchableOpacity style={s.headerBtn} onPress={onClose} hitSlop={8}>
            <Feather name="x" size={22} color="#F8FAFC" />
          </TouchableOpacity>
          <View style={s.headerCenter}>
            <Text style={s.headerTitle} numberOfLines={1}>{title}</Text>
          </View>
          <TouchableOpacity style={s.headerBtn} onPress={handleShare} hitSlop={8}>
            <Feather name="share" size={20} color="#F8FAFC" />
          </TouchableOpacity>
        </View>

        {/* WebView */}
        <WebView
          source={{ uri: url }}
          style={s.webview}
          onMessage={handleMessage}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          startInLoadingState
        />

        {/* Slide counter */}
        {slideInfo && !showAnswer && (
          <View style={[s.counter, { bottom: insets.bottom + 16 }]}>
            <Text style={s.counterText}>
              {slideInfo.index + 1} / {slideInfo.total}
            </Text>
          </View>
        )}

        {/* Drill-Down Loading Banner */}
        {drillDownLoading && selectedText && !showAnswer && (
          <View style={[s.loadingBanner, { bottom: insets.bottom + 48 }]}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={s.loadingText} numberOfLines={1}>
              Frage: "{selectedText.slice(0, 60)}..."
            </Text>
          </View>
        )}

        {/* Drill-Down Answer Overlay */}
        {showAnswer && drillDownAnswer && (
          <View style={[s.answerOverlay, { paddingBottom: insets.bottom + 12 }]}>
            {/* Header with question + close */}
            <View style={s.answerHeader}>
              <View style={{ flex: 1 }}>
                <Text style={s.answerQuestion} numberOfLines={2}>
                  {selectedText}
                </Text>
              </View>
              <Pressable onPress={() => setShowAnswer(false)} hitSlop={10}>
                <Feather name="x-circle" size={20} color="#94A3B8" />
              </Pressable>
            </View>
            {/* Scrollable answer */}
            <ScrollView style={s.answerScroll} showsVerticalScrollIndicator>
              <Markdown style={markdownStyles}>{drillDownAnswer}</Markdown>
            </ScrollView>
          </View>
        )}
      </View>
    </Modal>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
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
  // ── Drill-Down Loading Banner
  loadingBanner: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(15,23,42,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.3)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    maxWidth: '85%',
  },
  loadingText: {
    color: '#94A3B8',
    fontSize: 12,
    fontFamily: fonts.mono,
    flexShrink: 1,
  },
  // ── Drill-Down Answer Overlay
  answerOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: '55%',
    backgroundColor: 'rgba(15,23,42,0.95)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(59,130,246,0.3)',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  answerHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(51,65,85,0.5)',
  },
  answerQuestion: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: fonts.mono,
  },
  answerScroll: {
    flex: 1,
  },
});

const markdownStyles: Record<string, any> = {
  body: { color: '#CBD5E1', fontSize: 13, lineHeight: 20 },
  heading2: { color: '#F8FAFC', fontSize: 16, fontWeight: '700', marginBottom: 6, marginTop: 10 },
  heading3: { color: '#E2E8F0', fontSize: 14, fontWeight: '600', marginBottom: 4, marginTop: 8 },
  paragraph: { color: '#CBD5E1', marginBottom: 6 },
  strong: { color: '#F8FAFC', fontWeight: '700' },
  code_inline: { backgroundColor: '#1E293B', color: '#06B6D4', paddingHorizontal: 4, borderRadius: 3, fontSize: 12 },
  fence: { backgroundColor: '#1E293B', borderRadius: 8, padding: 10, marginBottom: 8 },
  bullet_list: { marginBottom: 6 },
  list_item: { color: '#CBD5E1', marginBottom: 3 },
  link: { color: '#3B82F6' },
};
