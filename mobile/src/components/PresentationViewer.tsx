import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
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
  /** Called when user confirms a drill-down question */
  onDrillDown?: (text: string, slideIndex: number) => void;
  /** The AI's answer to the last drill-down question */
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

  // Animated overlay slide-up
  const overlayAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (showAnswer && drillDownAnswer) {
      Animated.spring(overlayAnim, { toValue: 1, tension: 60, friction: 10, useNativeDriver: false }).start();
    } else {
      Animated.timing(overlayAnim, { toValue: 0, duration: 200, useNativeDriver: false }).start();
    }
  }, [showAnswer, drillDownAnswer]);

  // Show answer overlay when a new answer arrives
  useEffect(() => {
    if (drillDownAnswer) setShowAnswer(true);
  }, [drillDownAnswer]);

  // Reset state when viewer closes
  useEffect(() => {
    if (!visible) {
      setSelectedText(null);
      setShowAnswer(false);
      overlayAnim.setValue(0);
    }
  }, [visible]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'slideChange' || data.type === 'ready') {
        setSlideInfo({ index: data.index ?? 0, total: data.total ?? 1 });
      } else if (data.type === 'drillDown' && data.text) {
        // User confirmed in the HTML confirm bar → send to manager
        setSelectedText(data.text);
        setShowAnswer(false);
        onDrillDown?.(data.text, data.slideIndex ?? 0);
      }
    } catch {}
  }, [onDrillDown]);

  const handleShare = useCallback(async () => {
    try { await Share.share({ url, title }); } catch {}
  }, [url, title]);

  const dismissOverlay = useCallback(() => {
    setShowAnswer(false);
  }, []);

  const overlayTranslateY = overlayAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [300, 0],
  });

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <StatusBar hidden translucent />
      <View style={s.container}>
        {/* Header */}
        <View style={[s.header, { paddingTop: insets.top > 0 ? insets.top : 12 }]}>
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

        {/* Slide counter — hide when overlay is showing */}
        {slideInfo && !showAnswer && !drillDownLoading && (
          <View style={[s.counter, { bottom: insets.bottom + 16 }]}>
            <Text style={s.counterText}>
              {slideInfo.index + 1} / {slideInfo.total}
            </Text>
          </View>
        )}

        {/* Loading Banner */}
        {drillDownLoading && selectedText && !showAnswer && (
          <View style={[s.loadingBanner, { bottom: insets.bottom + 48 }]}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={s.loadingText} numberOfLines={1}>
              Frage wird beantwortet...
            </Text>
          </View>
        )}

        {/* Answer Overlay — animated slide-up */}
        {showAnswer && drillDownAnswer && (
          <Animated.View style={[
            s.answerOverlay,
            { paddingBottom: insets.bottom + 12, transform: [{ translateY: overlayTranslateY }] },
          ]}>
            {/* Drag handle */}
            <View style={s.dragHandle} />

            {/* Header */}
            <View style={s.answerHeader}>
              <Feather name="message-circle" size={14} color={colors.primary} style={{ marginTop: 2 }} />
              <View style={{ flex: 1 }}>
                <Text style={s.answerLabel}>Nachfrage zum Punkt:</Text>
                <Text style={s.answerQuestion} numberOfLines={2}>{selectedText}</Text>
              </View>
              <Pressable onPress={dismissOverlay} hitSlop={12} style={s.closeBtn}>
                <Feather name="x" size={18} color="#94A3B8" />
              </Pressable>
            </View>

            {/* Answer body */}
            <ScrollView style={s.answerScroll} showsVerticalScrollIndicator contentContainerStyle={{ paddingBottom: 16 }}>
              <Markdown style={markdownStyles}>{drillDownAnswer}</Markdown>
            </ScrollView>
          </Animated.View>
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
  loadingBanner: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(15,23,42,0.92)',
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
  // ── Answer Overlay
  answerOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: '55%',
    backgroundColor: 'rgba(15,23,42,0.97)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(59,130,246,0.25)',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 6,
    // Shadow for depth
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 20,
  },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(148,163,184,0.25)',
    alignSelf: 'center',
    marginBottom: 10,
  },
  answerHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(51,65,85,0.4)',
  },
  answerLabel: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  answerQuestion: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(51,65,85,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
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
