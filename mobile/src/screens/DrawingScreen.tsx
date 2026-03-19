import React, { useRef, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet,
  ActivityIndicator, Modal, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { Feather } from '@expo/vector-icons';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';

// ── Pending result — consumed by TerminalScreen on focus ────────────────────
let _pendingResult: string | null = null;
export function consumeDrawingResult(): string | null {
  const r = _pendingResult;
  _pendingResult = null;
  return r;
}

// ── Canvas HTML ─────────────────────────────────────────────────────────────
const DRAWING_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{overflow:hidden;touch-action:none;background:#fff}
canvas{display:block;width:100%;height:100%;touch-action:none}
</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
var c=document.getElementById('c'),ctx=c.getContext('2d');
var dpr=window.devicePixelRatio||1;
function resize(){
  c.width=window.innerWidth*dpr;
  c.height=window.innerHeight*dpr;
  c.style.width=window.innerWidth+'px';
  c.style.height=window.innerHeight+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,window.innerWidth,window.innerHeight);
}
resize();
var drawing=false,color='#000000',lw=6,lastX,lastY,erasing=false;
function pos(e){var t=e.touches?e.touches[0]:e;var r=c.getBoundingClientRect();return{x:t.clientX-r.left,y:t.clientY-r.top}}
function onDown(e){
  e.preventDefault();e.stopPropagation();drawing=true;var p=pos(e);lastX=p.x;lastY=p.y;
  if(erasing){
    ctx.save();ctx.globalCompositeOperation='destination-out';
    ctx.beginPath();ctx.arc(p.x,p.y,lw*2,0,Math.PI*2);ctx.fill();
    ctx.restore();
  } else {
    ctx.beginPath();ctx.arc(p.x,p.y,lw/2,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
  }
}
function onMove(e){
  e.preventDefault();e.stopPropagation();if(!drawing)return;var p=pos(e);
  if(erasing){
    ctx.save();ctx.globalCompositeOperation='destination-out';
    ctx.beginPath();ctx.moveTo(lastX,lastY);ctx.lineTo(p.x,p.y);
    ctx.lineWidth=lw*4;ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke();
    ctx.restore();
  } else {
    ctx.beginPath();ctx.moveTo(lastX,lastY);ctx.lineTo(p.x,p.y);
    ctx.strokeStyle=color;ctx.lineWidth=lw;ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke();
  }
  lastX=p.x;lastY=p.y;
}
function onUp(e){if(e)e.preventDefault();drawing=false;}
c.addEventListener('touchstart',onDown,{passive:false});
c.addEventListener('touchmove',onMove,{passive:false});
c.addEventListener('touchend',onUp,{passive:false});
c.addEventListener('touchcancel',onUp,{passive:false});
c.addEventListener('pointerdown',onDown,{passive:false});
c.addEventListener('pointermove',onMove,{passive:false});
c.addEventListener('pointerup',onUp,{passive:false});
c.addEventListener('pointercancel',onUp,{passive:false});
function handle(msg){
  if(msg.type==='color'){color=msg.value;erasing=false;}
  if(msg.type==='size')lw=msg.value;
  if(msg.type==='eraser'){erasing=msg.value;}
  if(msg.type==='clear'){
    ctx.clearRect(0,0,c.width,c.height);
  }
  if(msg.type==='export'){
    // Composite: white background + drawing layer
    var exp=document.createElement('canvas');
    exp.width=c.width;exp.height=c.height;
    var ectx=exp.getContext('2d');
    ectx.fillStyle='#FFFFFF';
    ectx.fillRect(0,0,exp.width,exp.height);
    ectx.drawImage(c,0,0);
    var data=exp.toDataURL('image/png').split(',')[1];
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'export',data:data}));
  }
}
document.addEventListener('message',function(e){try{handle(JSON.parse(e.data))}catch(x){}});
window.addEventListener('message',function(e){try{handle(JSON.parse(e.data))}catch(x){}});
</script>
</body>
</html>`;

// ── Constants ───────────────────────────────────────────────────────────────
const COLORS = [
  { hex: '#000000', label: 'Schwarz' },
  { hex: '#EF4444', label: 'Rot' },
  { hex: '#3B82F6', label: 'Blau' },
  { hex: '#22C55E', label: 'Grün' },
  { hex: '#A855F7', label: 'Lila' },
];

const SIZES = [
  { width: 2,  label: 'S' },
  { width: 6,  label: 'M' },
  { width: 14, label: 'L' },
];

// ── Component ───────────────────────────────────────────────────────────────
type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList>;
  route: RouteProp<RootStackParamList, 'Drawing'>;
};

export function DrawingScreen({ navigation, route }: Props) {
  const { serverHost, serverPort, serverToken } = route.params as {
    serverHost: string;
    serverPort: number;
    serverToken: string;
  };

  const webViewRef = useRef<WebView>(null);
  const [activeColor, setActiveColor] = useState('#000000');
  const [activeSize, setActiveSize] = useState(6);
  const [erasing, setErasing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showNameModal, setShowNameModal] = useState(false);
  const [drawingName, setDrawingName] = useState('');
  const pendingNameRef = useRef<string | null>(null);
  const { rf, rs, ri } = useResponsive();

  const sendToCanvas = useCallback((msg: object) => {
    webViewRef.current?.injectJavaScript(
      `handle(${JSON.stringify(msg)});true;`,
    );
  }, []);

  const selectColor = useCallback((hex: string) => {
    setActiveColor(hex);
    setErasing(false);
    sendToCanvas({ type: 'color', value: hex });
  }, [sendToCanvas]);

  const toggleEraser = useCallback(() => {
    setErasing((prev) => {
      const next = !prev;
      sendToCanvas({ type: 'eraser', value: next });
      return next;
    });
  }, [sendToCanvas]);

  const selectSize = useCallback((width: number) => {
    setActiveSize(width);
    sendToCanvas({ type: 'size', value: width });
  }, [sendToCanvas]);

  const clearCanvas = useCallback(() => {
    sendToCanvas({ type: 'clear' });
  }, [sendToCanvas]);

  const requestSave = useCallback(() => {
    setDrawingName('');
    setShowNameModal(true);
  }, []);

  const doSave = useCallback(() => {
    const name = drawingName.trim() || `drawing_${Date.now()}`;
    pendingNameRef.current = name;
    setShowNameModal(false);
    setSaving(true);
    sendToCanvas({ type: 'export' });
  }, [drawingName, sendToCanvas]);

  const onMessage = useCallback(async (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type !== 'export' || !msg.data) return;

      const name = pendingNameRef.current || `drawing_${Date.now()}`;
      pendingNameRef.current = null;

      const filename = `${name}.png`;
      const uploadUrl = `http://${serverHost}:${serverPort}/upload/drawing`;

      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serverToken}`,
        },
        body: JSON.stringify({ filename, data: msg.data, mimeType: 'image/png' }),
      });

      if (!response.ok) throw new Error(`Server error ${response.status}`);

      const json = (await response.json()) as { path: string };
      setSaving(false);

      // Store result for TerminalScreen to consume, then go back
      _pendingResult = json.path;
      navigation.goBack();
    } catch (err) {
      setSaving(false);
      Alert.alert('Fehler', err instanceof Error ? err.message : 'Upload fehlgeschlagen');
    }
  }, [serverHost, serverPort, serverToken, navigation]);

  const colorBtnSize = ri(28);
  const sizeBtnSize = ri(32);
  const clearBtnSize = ri(36);

  return (
    <SafeAreaView style={s.container} edges={['top', 'left', 'right', 'bottom']}>
      {/* Header */}
      <View style={[s.header, { paddingHorizontal: rs(12), paddingVertical: rs(8) }]}>
        <TouchableOpacity style={[s.backBtn, { gap: rs(4), paddingVertical: rs(4) }]} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Feather name="arrow-left" size={ri(18)} color={colors.primary} />
          <Text style={[s.backBtnText, { fontSize: rf(15) }]}>Zurück</Text>
        </TouchableOpacity>
        <Text style={[s.headerTitle, { fontSize: rf(15) }]}>Zeichnung</Text>
        <TouchableOpacity
          style={[s.saveBtn, { gap: rs(5), paddingVertical: rs(7), paddingHorizontal: rs(12) }]}
          onPress={requestSave}
          activeOpacity={0.7}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <>
              <Feather name="save" size={ri(14)} color={colors.accent} />
              <Text style={[s.saveBtnText, { fontSize: rf(13) }]}>Speichern</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* Canvas */}
      <View style={s.canvasWrap}>
        <WebView
          ref={webViewRef}
          source={{ html: DRAWING_HTML }}
          style={s.webView}
          onMessage={onMessage}
          scrollEnabled={false}
          overScrollMode="never"
          bounces={false}
          nestedScrollEnabled={false}
          javaScriptEnabled
          originWhitelist={['*']}
          androidLayerType="hardware"
          setSupportMultipleWindows={false}
          onLoadEnd={() => {
            // Re-trigger canvas resize after WebView layout is stable
            webViewRef.current?.injectJavaScript('resize();true;');
          }}
        />
        {saving && (
          <View style={s.savingOverlay}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={[s.savingText, { fontSize: rf(14) }]}>Wird gespeichert…</Text>
          </View>
        )}
      </View>

      {/* Toolbar */}
      <View style={[s.toolbar, { paddingHorizontal: rs(12), paddingVertical: rs(10), gap: rs(10) }]}>
        {/* Colors */}
        <View style={[s.toolGroup, { gap: rs(8) }]}>
          {COLORS.map((c) => (
            <TouchableOpacity
              key={c.hex}
              style={[
                s.colorBtn,
                { backgroundColor: c.hex, width: colorBtnSize, height: colorBtnSize, borderRadius: colorBtnSize / 2 },
                activeColor === c.hex && s.colorBtnActive,
              ]}
              onPress={() => selectColor(c.hex)}
              activeOpacity={0.7}
              accessibilityLabel={c.label}
            />
          ))}
        </View>

        <View style={s.divider} />

        {/* Sizes */}
        <View style={[s.toolGroup, { gap: rs(8) }]}>
          {SIZES.map((sz) => (
            <TouchableOpacity
              key={sz.width}
              style={[s.sizeBtn, { width: sizeBtnSize, height: sizeBtnSize }, activeSize === sz.width && s.sizeBtnActive]}
              onPress={() => selectSize(sz.width)}
              activeOpacity={0.7}
              accessibilityLabel={`Größe ${sz.label}`}
            >
              <View
                style={[
                  s.sizeDot,
                  {
                    width: Math.min(sz.width + 6, 20),
                    height: Math.min(sz.width + 6, 20),
                    borderRadius: Math.min(sz.width + 6, 20) / 2,
                  },
                ]}
              />
            </TouchableOpacity>
          ))}
        </View>

        <View style={s.divider} />

        {/* Eraser */}
        <TouchableOpacity
          style={[s.sizeBtn, { width: clearBtnSize, height: clearBtnSize }, erasing && s.eraserActive]}
          onPress={toggleEraser}
          activeOpacity={0.7}
          accessibilityLabel={erasing ? 'Radiergummi aus' : 'Radiergummi'}
        >
          <Feather name="edit-3" size={ri(18)} color={erasing ? '#F59E0B' : colors.textDim} />
        </TouchableOpacity>

        {/* Clear */}
        <TouchableOpacity
          style={[s.clearBtn, { width: clearBtnSize, height: clearBtnSize }]}
          onPress={clearCanvas}
          activeOpacity={0.7}
          accessibilityLabel="Leinwand leeren"
        >
          <Feather name="trash-2" size={ri(18)} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      {/* Name modal */}
      <Modal visible={showNameModal} transparent animationType="fade">
        <KeyboardAvoidingView
          style={s.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={[s.modalCard, { padding: rs(20) }]}>
            <Text style={[s.modalTitle, { fontSize: rf(16), marginBottom: rs(14) }]}>Zeichnung benennen</Text>
            <TextInput
              style={[s.modalInput, { padding: rs(12), fontSize: rf(14) }]}
              placeholder="z.B. wireframe_login"
              placeholderTextColor={colors.textDim}
              value={drawingName}
              onChangeText={setDrawingName}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={doSave}
            />
            <Text style={[s.modalHint, { fontSize: rf(11), marginTop: rs(8) }]}>~/Desktop/Drawings/</Text>
            <View style={[s.modalActions, { gap: rs(10), marginTop: rs(18) }]}>
              <TouchableOpacity style={[s.modalCancel, { paddingVertical: rs(9), paddingHorizontal: rs(16) }]} onPress={() => setShowNameModal(false)} activeOpacity={0.7}>
                <Text style={[s.modalCancelText, { fontSize: rf(13) }]}>Abbrechen</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.modalSaveBtn, { gap: rs(6), paddingVertical: rs(9), paddingHorizontal: rs(16) }]} onPress={doSave} activeOpacity={0.7}>
                <Feather name="save" size={ri(14)} color={colors.bg} />
                <Text style={[s.modalSaveText, { fontSize: rf(13) }]}>Speichern</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  backBtnText: { color: colors.primary, fontWeight: '600' },
  headerTitle: { color: colors.text, fontWeight: '700' },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: 'rgba(34,197,94,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.3)',
  },
  saveBtnText: { color: colors.accent, fontWeight: '700' },

  // Canvas
  canvasWrap: { flex: 1, backgroundColor: '#FFFFFF' },
  webView: { flex: 1, backgroundColor: '#FFFFFF' },
  savingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  savingText: { color: '#fff', fontWeight: '600' },

  // Toolbar
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  toolGroup: { flexDirection: 'row', alignItems: 'center' },
  divider: { width: 1, height: 24, backgroundColor: colors.border },
  colorBtn: {
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorBtnActive: { borderColor: colors.text, borderWidth: 2.5 },
  sizeBtn: {
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sizeBtnActive: {
    borderColor: colors.primary,
    backgroundColor: 'rgba(59,130,246,0.15)',
  },
  sizeDot: { backgroundColor: colors.text },
  eraserActive: {
    borderColor: '#F59E0B',
    backgroundColor: 'rgba(245,158,11,0.15)',
  },
  clearBtn: {
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 'auto',
  },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalTitle: { color: colors.text, fontWeight: '700' },
  modalInput: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    color: colors.text,
    fontFamily: fonts.mono,
  },
  modalHint: {
    color: colors.textDim,
    fontFamily: fonts.mono,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  modalCancel: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalCancelText: { color: colors.textMuted, fontWeight: '600' },
  modalSaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: colors.accent,
  },
  modalSaveText: { color: colors.bg, fontWeight: '700' },
});
