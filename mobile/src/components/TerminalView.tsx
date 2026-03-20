import React, { useRef, useCallback, useEffect, useState, useImperativeHandle, forwardRef } from 'react';
import { Animated, Keyboard, Platform, StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { WebSocketService } from '../services/websocket.service';
import { TERMINAL_HTML } from './terminalHtml';
import { TOOLBAR_HEIGHT } from './TerminalToolbar';
import { TOOL_RAIL_WIDTH } from './ToolRail';
import { colors, fonts } from '../theme';
import type { AiToolType } from '../types/terminal.types';
import { useSQLStore } from '../store/sqlStore';
import { keywordAlertService } from '../services/keywordAlert.service';
import * as Clipboard from 'expo-clipboard';

// ── View-buffer ─────────────────────────────────────────────────────────────
// Lives at module level so it survives component unmounts (navigation away / back).
// Stores every byte of terminal output per session.
// Replayed into a fresh xterm.js instance when the WebView remounts.
const VIEW_BUFFER_MAX = 400_000; // 400 KB per session
const MAX_VIEW_BUFFERS = 20;
const viewBuffers = new Map<string, string>();

function appendViewBuffer(sessionId: string, data: string) {
  // Cap total number of sessions to prevent unbounded memory growth
  if (!viewBuffers.has(sessionId) && viewBuffers.size >= MAX_VIEW_BUFFERS) {
    const oldest = viewBuffers.keys().next().value;
    if (oldest) viewBuffers.delete(oldest);
  }

  const existing = viewBuffers.get(sessionId) ?? '';
  const combined = existing + data;
  if (combined.length > VIEW_BUFFER_MAX) {
    const sliced = combined.slice(combined.length - VIEW_BUFFER_MAX);
    const firstNl = sliced.indexOf('\n');
    viewBuffers.set(sessionId, firstNl >= 0 ? sliced.slice(firstNl + 1) : sliced);
  } else {
    viewBuffers.set(sessionId, combined);
  }
}

/** Call this when a tab/session is permanently closed (not just navigated away). */
export function clearViewBuffer(sessionId: string) {
  viewBuffers.delete(sessionId);
}

// ── AI-tool detection ────────────────────────────────────────────────────────
import { stripAnsi } from '../utils/stripAnsi';

function detectAiTool(rawData: string): AiToolType {
  const clean = stripAnsi(rawData);
  if (/\bclaude\b/i.test(clean)) return 'claude';
  if (/\bcodex\b/i.test(clean)) return 'codex';
  if (/\bgemini\b/i.test(clean)) return 'gemini';
  return null;
}
// ────────────────────────────────────────────────────────────────────────────

export interface TerminalViewRef {
  /** Reads the last `count` lines from the xterm.js buffer. Resolves within 3 s. */
  requestLastLines: (count?: number) => Promise<string[]>;
  /** Scrolls the terminal to the very bottom. */
  scrollToBottom: () => void;
}

interface Props {
  sessionId: string | undefined;
  wsService: WebSocketService;
  visible: boolean;
  onReady?: (cols: number, rows: number) => void;
  onAiToolDetected?: (tool: AiToolType) => void;
  rangeActive?: boolean;
  onRangeClose?: () => void;
  railWidth?: Animated.Value;
}

export const TerminalView = forwardRef<TerminalViewRef, Props>(function TerminalView(
  { sessionId, wsService, visible, onReady, onAiToolDetected, rangeActive = false, onRangeClose, railWidth }: Props,
  ref,
) {
  const webViewRef  = useRef<WebView>(null);
  const [selection, setSelection] = useState('');
  const [selText,   setSelText]   = useState('');
  const [tapStep,   setTapStep]   = useState(1); // 1=tap start  2=tap end  0=done
  const addSQLEntry = useSQLStore((state) => state.addEntry);
  // Starts at TOOLBAR_HEIGHT, grows by keyboard height when keyboard opens.
  // Drives the container's bottom edge so xterm.js always stays above the keyboard.
  const bottomAnim  = useRef(new Animated.Value(TOOLBAR_HEIGHT)).current;
  // Track last detected AI tool to avoid repeated callbacks
  const lastAiToolRef = useRef<AiToolType>(null);
  const onAiToolDetectedRef = useRef(onAiToolDetected);
  onAiToolDetectedRef.current = onAiToolDetected;

  // Pending resolver for requestLastLines — fulfilled when WebView replies 'last_lines'
  const pendingLinesRef = useRef<((lines: string[]) => void) | null>(null);
  const pendingLinesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // CDN failure recovery: if xterm.js fails to load, the WebView never sends 'ready'.
  // Reload after 10s to retry CDN scripts.
  const readyReceivedRef = useRef(false);
  useEffect(() => {
    readyReceivedRef.current = false;
    const timer = setTimeout(() => {
      if (!readyReceivedRef.current && webViewRef.current) {
        webViewRef.current.reload();
      }
    }, 10_000);
    return () => clearTimeout(timer);
  }, [sessionId]);

  useImperativeHandle(ref, () => ({
    requestLastLines: (count = 20) =>
      new Promise<string[]>((resolve) => {
        // Clear previous pending request
        if (pendingLinesTimerRef.current) clearTimeout(pendingLinesTimerRef.current);
        pendingLinesRef.current = resolve;
        if (webViewRef.current) {
          const msg = JSON.stringify({ type: 'get_last_lines', count });
          webViewRef.current.injectJavaScript(
            `window.postMessage(${JSON.stringify(msg)}, '*'); true;`,
          );
        } else {
          resolve([]);
        }
        // Fallback: resolve empty after 3 s so the caller never hangs
        pendingLinesTimerRef.current = setTimeout(() => {
          if (pendingLinesRef.current === resolve) {
            pendingLinesRef.current = null;
            resolve([]);
          }
          pendingLinesTimerRef.current = null;
        }, 3000);
      }),
    scrollToBottom: () => {
      if (webViewRef.current) {
        const msg = JSON.stringify({ type: 'scroll_to_bottom' });
        webViewRef.current.injectJavaScript(
          `window.postMessage(${JSON.stringify(msg)}, '*'); true;`,
        );
      }
    },
  }), []);

  // ── Keyboard tracking ──────────────────────────────────────────────────────
  useEffect(() => {
    // On Android with adjustResize, the window already shrinks for the keyboard —
    // bottom: TOOLBAR_HEIGHT is correct without manual offset. Only iOS needs it.
    if (Platform.OS !== 'ios') return;

    const showSub = Keyboard.addListener('keyboardWillShow', (e) => {
      Animated.timing(bottomAnim, {
        toValue: TOOLBAR_HEIGHT + e.endCoordinates.height,
        duration: e.duration > 0 ? e.duration : 220,
        useNativeDriver: false,
      }).start();
    });

    const hideSub = Keyboard.addListener('keyboardWillHide', (e) => {
      Animated.timing(bottomAnim, {
        toValue: TOOLBAR_HEIGHT,
        duration: e.duration > 0 ? e.duration : 220,
        useNativeDriver: false,
      }).start();
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const copyText = useCallback((text: string) => {
    if (!text) return;
    Clipboard.setStringAsync(text);
  }, []);

  const dismissSelection = useCallback(() => {
    setSelection('');
    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(
        `window.postMessage(JSON.stringify({ type: 'clear_selection' }), '*'); true;`
      );
    }
  }, []);

  const sendToTerminal = useCallback((type: string, data?: string) => {
    if (webViewRef.current) {
      const msg = JSON.stringify({ type, data });
      webViewRef.current.injectJavaScript(`
        window.postMessage(${JSON.stringify(msg)}, '*');
        true;
      `);
    }
  }, []);

  // Route server output to xterm.js AND persist it in the view-buffer
  useEffect(() => {
    if (!sessionId) return;
    return wsService.addMessageListener((msg: unknown) => {
      const m = msg as { type: string; sessionId?: string; payload?: { data?: string } };
      if (m.type === 'terminal:output' && m.sessionId === sessionId && m.payload?.data) {
        appendViewBuffer(sessionId, m.payload.data);
        sendToTerminal('output', m.payload.data);

        // AI tool detection
        const detected = detectAiTool(m.payload.data);
        if (detected && detected !== lastAiToolRef.current) {
          lastAiToolRef.current = detected;
          onAiToolDetectedRef.current?.(detected);
        }

        // Keyword alert scanning (vibration + sound per category)
        keywordAlertService.scan(m.payload.data);
      }
    });
  }, [sessionId, wsService, sendToTerminal]);

  useEffect(() => {
    if (visible) {
      setTimeout(() => sendToTerminal('focus'), 100);
    }
  }, [visible, sendToTerminal]);

  // Sync range-select mode into WebView
  useEffect(() => {
    const msg = JSON.stringify({ type: rangeActive ? 'enter_select_mode' : 'exit_select_mode' });
    webViewRef.current?.injectJavaScript(
      `window.postMessage(${JSON.stringify(msg)}, '*'); true;`
    );
    if (!rangeActive) { setSelText(''); setTapStep(1); }
  }, [rangeActive]);

  // Clear xterm.js when a session dies so the new session starts on a clean screen
  const prevSessionIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevSessionIdRef.current !== undefined && sessionId === undefined) {
      sendToTerminal('clear');
    }
    prevSessionIdRef.current = sessionId;
  }, [sessionId, sendToTerminal]);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);

      if (msg.type === 'ready') {
        readyReceivedRef.current = true;
        // Replay saved output into the fresh xterm.js instance BEFORE requesting
        // terminal:reattach, so history appears instantly and new output appends after.
        if (sessionId) {
          const buffered = viewBuffers.get(sessionId);
          if (buffered) sendToTerminal('output', buffered);
        }
        onReadyRef.current?.(msg.cols, msg.rows);
      } else if (msg.type === 'input' && sessionId) {
        // Mark this session as "user is typing" so auto-approve pauses
        const { markTyping } = require('../store/autoApproveStore').useAutoApproveStore.getState();
        markTyping(sessionId);

        wsService.send({
          type: 'terminal:input',
          sessionId,
          payload: { data: msg.data },
        });
      } else if (msg.type === 'resize' && sessionId && msg.cols > 0 && msg.rows > 0) {
        wsService.send({
          type: 'terminal:resize',
          sessionId,
          payload: { cols: msg.cols, rows: msg.rows },
        });
      } else if (msg.type === 'selection') {
        setSelection(msg.text ?? '');
      } else if (msg.type === 'all_text') {
        copyText(msg.text ?? '');
        setSelection('');
      } else if (msg.type === 'sql_detected' && sessionId && Array.isArray(msg.sqls)) {
        (msg.sqls as string[]).forEach((sql) => addSQLEntry(sessionId, sql));
      } else if (msg.type === 'tap_step') {
        setTapStep(msg.step);
      } else if (msg.type === 'sel_update') {
        setSelText(msg.text ?? '');
        setTapStep(0);
      } else if (msg.type === 'range_text') {
        copyText(msg.text ?? '');
        setSelText('');
        onRangeClose?.();
      } else if (msg.type === 'last_lines') {
        if (pendingLinesTimerRef.current) { clearTimeout(pendingLinesTimerRef.current); pendingLinesTimerRef.current = null; }
        if (pendingLinesRef.current) {
          pendingLinesRef.current(msg.lines ?? []);
          pendingLinesRef.current = null;
        }
      }
    } catch {
      // ignore
    }
  }, [sessionId, wsService, sendToTerminal, copyText, onRangeClose]);

  return (
    <Animated.View
      style={
        visible
          ? [styles.visibleContainer, { bottom: bottomAnim, right: railWidth ?? TOOL_RAIL_WIDTH }]
          : [styles.hiddenContainer, railWidth ? { right: railWidth } : undefined]
      }
      pointerEvents={visible ? 'auto' : 'none'}
    >
      <WebView
        ref={webViewRef}
        source={{ html: TERMINAL_HTML, baseUrl: 'https://cdn.jsdelivr.net/' }}
        style={styles.webView}
        onMessage={onMessage}
        onError={() => {}}
        onHttpError={() => {}}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        scrollEnabled={false}
        overScrollMode="never"
        textInteractionEnabled={false}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        mixedContentMode="always"
        allowsInlineMediaPlayback
      />
      {visible && rangeActive && (
        <View style={[styles.rangeBar, selText ? styles.rangeBarActive : tapStep === 2 ? styles.rangeBarStep2 : null]}>
          {/* Left: step instruction */}
          <View style={styles.rangeLeft}>
            <View style={[
              styles.rangePip,
              tapStep === 2 && styles.rangePipStep2,
              !!selText  && styles.rangePipActive,
            ]} />
            <Text style={[styles.rangeHint, (tapStep === 2 || !!selText) && styles.rangeHintActive]} numberOfLines={1}>
              {selText
                ? `${selText.length} Zeichen markiert`
                : tapStep === 2
                  ? 'Endzeile antippen'
                  : 'Startzeile antippen'}
            </Text>
          </View>
          {/* Copy button */}
          {!!selText && (
            <TouchableOpacity
              style={styles.rangeCopyBtn}
              onPress={() => webViewRef.current?.injectJavaScript(
                `window.postMessage(JSON.stringify({type:'copy_selection'}),'*');true;`
              )}
              activeOpacity={0.65}
            >
              <Text style={styles.rangeCopyTxt}>KOPIEREN</Text>
            </TouchableOpacity>
          )}
          {/* Dismiss */}
          <TouchableOpacity
            style={styles.rangeDismiss}
            onPress={() => {
              webViewRef.current?.injectJavaScript(
                `window.postMessage(JSON.stringify({type:'exit_select_mode'}),'*');true;`
              );
              setSelText('');
              setTapStep(1);
              onRangeClose?.();
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.rangeDismissTxt}>✕</Text>
          </TouchableOpacity>
        </View>
      )}
      {visible && selection.length > 0 && (
        <View style={styles.copyBar}>
          <TouchableOpacity
            style={styles.copyBtn}
            onPress={() => { copyText(selection); dismissSelection(); }}
            activeOpacity={0.7}
            accessibilityLabel="Copy selection"
            accessibilityRole="button"
          >
            <Text style={styles.copyBtnText}>Copy</Text>
          </TouchableOpacity>
          <View style={styles.copyDivider} />
          <TouchableOpacity
            style={styles.copyBtn}
            onPress={() => {
              if (webViewRef.current) {
                webViewRef.current.injectJavaScript(
                  `window.postMessage(JSON.stringify({ type: 'get_all' }), '*'); true;`
                );
              }
            }}
            activeOpacity={0.7}
            accessibilityLabel="Copy all text"
            accessibilityRole="button"
          >
            <Text style={styles.copyBtnText}>Copy All</Text>
          </TouchableOpacity>
          <View style={styles.copyDivider} />
          <TouchableOpacity
            style={styles.copyDismiss}
            onPress={dismissSelection}
            activeOpacity={0.7}
            accessibilityLabel="Dismiss selection"
            accessibilityRole="button"
          >
            <Feather name="x" size={14} color={colors.primary} />
          </TouchableOpacity>
        </View>
      )}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  visibleContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: TOOL_RAIL_WIDTH,
    // bottom is set dynamically via bottomAnim — no static value here
    zIndex: 1,
  },
  hiddenContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: TOOL_RAIL_WIDTH,
    bottom: TOOLBAR_HEIGHT,
    zIndex: 0,
    opacity: 0,
  },
  webView: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  rangeBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 44,
    backgroundColor: colors.bg,
    borderTopWidth: 1.5,
    borderTopColor: colors.accent,      // green = ready to select
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
    zIndex: 15,
  },
  rangeBarActive: {
    borderTopColor: colors.primary,     // blue = text selected
  },
  rangeBarStep2: {
    borderTopColor: colors.primary,     // blue = waiting for end tap
  },
  rangeLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    overflow: 'hidden',
  },
  rangePip: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.textDim,
  },
  rangePipStep2: {
    backgroundColor: colors.primary,
  },
  rangePipActive: {
    backgroundColor: colors.accent,
  },
  rangeHint: {
    color: colors.textDim,
    fontSize: 11,
    fontFamily: fonts.mono,
    flexShrink: 1,
  },
  rangeHintActive: {
    color: colors.text,
  },
  rangeCopyBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: 'rgba(59,130,246,0.1)',
  },
  rangeCopyTxt: {
    color: colors.primary,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: fonts.mono,
    letterSpacing: 1.2,
  },
  rangeDismiss: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rangeDismissTxt: {
    color: colors.textDim,
    fontSize: 13,
    fontFamily: fonts.mono,
  },
  copyBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 44,
    backgroundColor: colors.surfaceAlt,
    borderTopWidth: 1,
    borderTopColor: colors.borderStrong,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 20,
  },
  copyBtn: {
    flex: 1,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copyBtnText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  copyDivider: {
    width: 1,
    height: 24,
    backgroundColor: colors.border,
  },
  copyDismiss: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
