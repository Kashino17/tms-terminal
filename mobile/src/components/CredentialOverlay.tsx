import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, LayoutAnimation, Platform, UIManager, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { WebView } from 'react-native-webview';
import { colors, fonts } from '../theme';
import {
  useCredentialStore,
  buildAutofillJS,
  FIELD_DEFS,
  FIELD_TYPE_LIST,
  type FieldType,
  type Credential,
  type CredentialField,
} from '../store/credentialStore';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const ACCENT = '#EAB308'; // Yellow-500

// ── Props ────────────────────────────────────────────────────────────────────
interface Props {
  serverId: string;
  currentUrl: string;
  webviewRef: React.RefObject<WebView | null>;
  /** 'pill' = floating bottom-left (split view), 'header' = inline icon for nav bar */
  variant?: 'pill' | 'header';
  /** True when the WebView has detected form fields on the page */
  formDetected?: boolean;
}

// ── Main Component ───────────────────────────────────────────────────────────
export function CredentialOverlay({
  serverId,
  currentUrl,
  webviewRef,
  variant = 'pill',
  formDetected = false,
}: Props) {
  const store = useCredentialStore();
  const allCreds = useCredentialStore((s) => s.getAll(serverId));
  const matchingCreds = useCredentialStore((s) => s.getForUrl(serverId, currentUrl));

  const [popupOpen, setPopupOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showFieldPicker, setShowFieldPicker] = useState<string | null>(null);
  const [autofillFlash, setAutofillFlash] = useState<string | null>(null);
  const autoShownUrlRef = useRef('');

  useEffect(() => { store.load(serverId); }, [serverId]);

  // Auto-show popup when form detected + matching credentials exist (once per URL)
  useEffect(() => {
    if (formDetected && matchingCreds.length > 0 && autoShownUrlRef.current !== currentUrl) {
      autoShownUrlRef.current = currentUrl;
      const timer = setTimeout(() => setPopupOpen(true), 400);
      return () => clearTimeout(timer);
    }
  }, [formDetected, matchingCreds.length, currentUrl]);

  // Reset when URL changes
  useEffect(() => {
    autoShownUrlRef.current = '';
    setPopupOpen(false);
  }, [currentUrl]);

  const urlPortPattern = useMemo(() => {
    try { return `:${new URL(currentUrl).port}`; } catch { return ':3000'; }
  }, [currentUrl]);

  // ── Handlers ──
  const handleAutofill = useCallback((cred: Credential) => {
    const js = buildAutofillJS(cred.fields);
    if (!js || !webviewRef.current) return;
    webviewRef.current.injectJavaScript(js);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setAutofillFlash(cred.id);
    setTimeout(() => setAutofillFlash(null), 800);
    setPopupOpen(false);
  }, [webviewRef]);

  const handleAdd = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.create(200, LayoutAnimation.Types.easeOut, LayoutAnimation.Properties.opacity));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const id = store.addCredential(serverId, urlPortPattern);
    setExpandedId(id);
  }, [serverId, urlPortPattern]);

  const handleDelete = useCallback((credId: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.create(180, LayoutAnimation.Types.easeIn, LayoutAnimation.Properties.opacity));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    store.removeCredential(serverId, credId);
    if (expandedId === credId) setExpandedId(null);
  }, [serverId, expandedId]);

  const toggleExpand = useCallback((credId: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.create(200, LayoutAnimation.Types.easeOut, LayoutAnimation.Properties.scaleXY));
    Haptics.selectionAsync();
    setExpandedId((prev) => (prev === credId ? null : credId));
    setShowFieldPicker(null);
  }, []);

  const matchCount = matchingCreds.length;
  const hasIndicator = matchCount > 0 || formDetected;

  return (
    <>
      {/* ═══ Trigger ═══ */}
      {variant === 'pill' ? (
        <TouchableOpacity
          style={[pill.wrap, matchCount > 0 && pill.wrapActive]}
          onPress={() => (matchCount > 0 ? setPopupOpen(true) : setManagerOpen(true))}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Feather name="key" size={11} color={matchCount > 0 ? ACCENT : colors.textDim} />
          {matchCount > 0 && <Text style={pill.badge}>{matchCount}</Text>}
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={hdr.btn}
          onPress={() => (hasIndicator ? setPopupOpen((v) => !v) : setManagerOpen(true))}
          onLongPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); setManagerOpen(true); }}
          delayLongPress={350}
          activeOpacity={0.7}
        >
          <Feather name="key" size={16} color={hasIndicator ? ACCENT : colors.textMuted} />
          {hasIndicator && <View style={hdr.dot} />}
        </TouchableOpacity>
      )}

      {/* ═══ Quick Popup ═══ */}
      <Modal visible={popupOpen} transparent animationType="fade" onRequestClose={() => setPopupOpen(false)}>
        <Pressable style={pop.overlay} onPress={() => setPopupOpen(false)}>
          <View
            style={[pop.card, variant === 'header' ? pop.cardTop : pop.cardBottom]}
            onStartShouldSetResponder={() => true}
          >
            {/* Header */}
            <View style={pop.header}>
              <View style={pop.headerIcon}>
                <Feather name="key" size={10} color={ACCENT} />
              </View>
              <Text style={pop.title}>Autofill</Text>
              <View style={{ flex: 1 }} />
              <TouchableOpacity onPress={() => setPopupOpen(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Feather name="x" size={14} color={colors.textDim} />
              </TouchableOpacity>
            </View>

            {/* Matching credentials */}
            {matchingCreds.length > 0 ? (
              matchingCreds.map((cred) => {
                const preview = cred.fields.find((f) => f.type !== 'password' && f.value)?.value ?? '';
                return (
                  <TouchableOpacity
                    key={cred.id}
                    style={[pop.item, autofillFlash === cred.id && pop.itemFlash]}
                    onPress={() => handleAutofill(cred)}
                    activeOpacity={0.7}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={pop.itemLabel} numberOfLines={1}>{cred.label}</Text>
                      {preview ? <Text style={pop.itemPreview} numberOfLines={1}>{preview}</Text> : null}
                    </View>
                    <View style={pop.fillBtn}>
                      <Feather name="edit-3" size={10} color={colors.bg} />
                      <Text style={pop.fillBtnText}>Fill</Text>
                    </View>
                  </TouchableOpacity>
                );
              })
            ) : (
              <View style={pop.emptyRow}>
                <Feather name="info" size={11} color={colors.textDim} />
                <Text style={pop.emptyText}>Keine passenden Credentials</Text>
              </View>
            )}

            {/* Footer */}
            <TouchableOpacity
              style={pop.footer}
              onPress={() => { setPopupOpen(false); setManagerOpen(true); }}
              activeOpacity={0.7}
            >
              <Text style={pop.footerText}>Verwalten</Text>
              <Feather name="chevron-right" size={12} color={colors.textDim} />
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* ═══ Full Manager Modal ═══ */}
      <Modal visible={managerOpen} animationType="slide" statusBarTranslucent onRequestClose={() => setManagerOpen(false)}>
        <SafeAreaView style={modal.safe} edges={['top']}>
          {/* Header */}
          <View style={modal.header}>
            <View style={modal.headerIcon}>
              <Feather name="key" size={15} color={ACCENT} />
            </View>
            <Text style={modal.title}>Passwort-Manager</Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity style={modal.closeBtn} onPress={() => setManagerOpen(false)} activeOpacity={0.7}>
              <Feather name="x" size={18} color={colors.text} />
            </TouchableOpacity>
          </View>

          {/* Hint */}
          <View style={modal.hint}>
            <Feather name="info" size={11} color={colors.textDim} />
            <Text style={modal.hintText}>
              Dev-Tool zum Speichern von Test-Credentials, Logins, Adressen, etc. Kein sicherer Passwort-Tresor.
            </Text>
          </View>

          <ScrollView style={modal.body} contentContainerStyle={modal.bodyPad} keyboardShouldPersistTaps="handled">
            {/* ── Matching Section ── */}
            {matchCount > 0 && (
              <>
                <Text style={sec.label}>
                  <Feather name="zap" size={11} color={ACCENT} />
                  {'  '}Für diese Seite
                </Text>
                {matchingCreds.map((cred) => (
                  <View key={cred.id} style={[qf.card, autofillFlash === cred.id && qf.cardFlash]}>
                    <View style={qf.row}>
                      <View style={{ flex: 1 }}>
                        <Text style={qf.label} numberOfLines={1}>{cred.label}</Text>
                        <Text style={qf.pattern} numberOfLines={1}>{cred.urlPattern}</Text>
                      </View>
                      <TouchableOpacity
                        style={qf.fillBtn}
                        onPress={() => { handleAutofill(cred); setManagerOpen(false); }}
                        activeOpacity={0.8}
                      >
                        <Feather name="edit-3" size={12} color={colors.bg} />
                        <Text style={qf.fillBtnText}>Autofill</Text>
                      </TouchableOpacity>
                    </View>
                    <View style={qf.fields}>
                      {cred.fields.filter((f) => f.value).map((f) => (
                        <View key={f.id} style={qf.fieldChip}>
                          <Feather name={FIELD_DEFS[f.type].icon as any} size={9} color={colors.textMuted} />
                          <Text style={qf.fieldText} numberOfLines={1}>
                            {f.type === 'password' ? '••••••' : f.value}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>
                ))}
                <View style={sec.divider} />
              </>
            )}

            {/* ── All Credentials ── */}
            <Text style={sec.label}>
              <Feather name="database" size={11} color={colors.textMuted} />
              {'  '}Alle Credentials ({allCreds.length})
            </Text>

            {allCreds.length === 0 && (
              <View style={sec.empty}>
                <Feather name="key" size={28} color={colors.border} />
                <Text style={sec.emptyText}>Noch keine Credentials</Text>
                <Text style={sec.emptyHint}>Tippe "+", um Test-Logins zu speichern</Text>
              </View>
            )}

            {allCreds.map((cred) => {
              const isExpanded = expandedId === cred.id;
              const isMatch = matchingCreds.some((m) => m.id === cred.id);
              return (
                <View key={cred.id} style={[card.wrap, isMatch && card.wrapMatch]}>
                  {/* Summary */}
                  <TouchableOpacity style={card.summary} onPress={() => toggleExpand(cred.id)} activeOpacity={0.7}>
                    <View style={[card.dot, isMatch && card.dotMatch]} />
                    <View style={{ flex: 1 }}>
                      <Text style={card.label} numberOfLines={1}>{cred.label}</Text>
                      <Text style={card.pattern} numberOfLines={1}>{cred.urlPattern}</Text>
                    </View>
                    {!isExpanded && (
                      <TouchableOpacity
                        style={qf.fillBtn}
                        onPress={() => { handleAutofill(cred); setManagerOpen(false); }}
                        activeOpacity={0.8}
                      >
                        <Feather name="edit-3" size={12} color={colors.bg} />
                      </TouchableOpacity>
                    )}
                    <Feather name={isExpanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textDim} />
                  </TouchableOpacity>

                  {/* Expanded */}
                  {isExpanded && (
                    <View style={card.expanded}>
                      <View style={inp.row}>
                        <Text style={inp.label}>Label</Text>
                        <TextInput
                          style={inp.input}
                          value={cred.label}
                          onChangeText={(v) => store.updateCredential(serverId, cred.id, { label: v })}
                          placeholder="z.B. Admin Login"
                          placeholderTextColor={colors.textDim}
                          selectTextOnFocus
                        />
                      </View>
                      <View style={inp.row}>
                        <Text style={inp.label}>URL</Text>
                        <TextInput
                          style={inp.input}
                          value={cred.urlPattern}
                          onChangeText={(v) => store.updateCredential(serverId, cred.id, { urlPattern: v })}
                          placeholder=":3000 oder :5173/login"
                          placeholderTextColor={colors.textDim}
                          autoCapitalize="none"
                          autoCorrect={false}
                          selectTextOnFocus
                        />
                      </View>

                      <Text style={[inp.label, { marginTop: 8, marginBottom: 4 }]}>Felder</Text>
                      {cred.fields.map((field) => (
                        <FieldRow
                          key={field.id}
                          field={field}
                          onUpdate={(u) => store.updateField(serverId, cred.id, field.id, u)}
                          onRemove={() => {
                            LayoutAnimation.configureNext(LayoutAnimation.create(180, LayoutAnimation.Types.easeIn, LayoutAnimation.Properties.opacity));
                            store.removeField(serverId, cred.id, field.id);
                          }}
                        />
                      ))}

                      {showFieldPicker === cred.id ? (
                        <View style={fp.wrap}>
                          {FIELD_TYPE_LIST.map((t) => (
                            <TouchableOpacity
                              key={t}
                              style={fp.chip}
                              onPress={() => {
                                LayoutAnimation.configureNext(LayoutAnimation.create(200, LayoutAnimation.Types.easeOut, LayoutAnimation.Properties.opacity));
                                store.addField(serverId, cred.id, t);
                                setShowFieldPicker(null);
                              }}
                              activeOpacity={0.7}
                            >
                              <Feather name={FIELD_DEFS[t].icon as any} size={11} color={colors.textMuted} />
                              <Text style={fp.chipText}>{FIELD_DEFS[t].label}</Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      ) : (
                        <TouchableOpacity style={fp.addBtn} onPress={() => setShowFieldPicker(cred.id)} activeOpacity={0.7}>
                          <Feather name="plus" size={12} color={ACCENT} />
                          <Text style={fp.addBtnText}>Feld hinzufügen</Text>
                        </TouchableOpacity>
                      )}

                      <View style={card.actions}>
                        <TouchableOpacity
                          style={card.autofillBtn}
                          onPress={() => { handleAutofill(cred); setManagerOpen(false); }}
                          activeOpacity={0.85}
                        >
                          <Feather name="edit-3" size={13} color={colors.bg} />
                          <Text style={card.autofillBtnText}>Autofill</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={card.deleteBtn} onPress={() => handleDelete(cred.id)} activeOpacity={0.7}>
                          <Feather name="trash-2" size={13} color={colors.destructive} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}
                </View>
              );
            })}

            <TouchableOpacity style={sec.addBtn} onPress={handleAdd} activeOpacity={0.75}>
              <Feather name="plus" size={15} color={ACCENT} />
              <Text style={sec.addBtnText}>Neues Credential</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}

// ── Field Row ────────────────────────────────────────────────────────────────
function FieldRow({
  field,
  onUpdate,
  onRemove,
}: {
  field: CredentialField;
  onUpdate: (u: Partial<Pick<CredentialField, 'label' | 'value' | 'type'>>) => void;
  onRemove: () => void;
}) {
  const [showPw, setShowPw] = useState(false);
  const def = FIELD_DEFS[field.type];
  const isPw = field.type === 'password';

  return (
    <View style={fr.wrap}>
      <View style={fr.header}>
        <Feather name={def.icon as any} size={11} color={ACCENT} />
        {field.type === 'custom' ? (
          <TextInput
            style={fr.typeLabel}
            value={field.label}
            onChangeText={(v) => onUpdate({ label: v })}
            placeholder="Feldname"
            placeholderTextColor={colors.textDim}
          />
        ) : (
          <Text style={fr.typeLabelText}>{def.label}</Text>
        )}
        <TouchableOpacity onPress={onRemove} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Feather name="x" size={12} color={colors.textDim} />
        </TouchableOpacity>
      </View>
      <View style={fr.inputRow}>
        <TextInput
          style={fr.input}
          value={field.value}
          onChangeText={(v) => onUpdate({ value: v })}
          placeholder={`${def.label} eingeben`}
          placeholderTextColor={colors.textDim}
          secureTextEntry={isPw && !showPw}
          autoCapitalize="none"
          autoCorrect={false}
          selectTextOnFocus
        />
        {isPw && (
          <TouchableOpacity style={fr.eyeBtn} onPress={() => setShowPw((v) => !v)} activeOpacity={0.7}>
            <Feather name={showPw ? 'eye-off' : 'eye'} size={14} color={colors.textDim} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Styles ───────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// Floating pill (split view)
const pill = StyleSheet.create({
  wrap: {
    position: 'absolute', bottom: 4, left: 4, flexDirection: 'row', alignItems: 'center',
    gap: 3, backgroundColor: colors.surface + 'E0', borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 4, borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border, zIndex: 20,
  },
  wrapActive: { borderColor: ACCENT + '60' },
  badge: { fontSize: 9, fontWeight: '700', color: ACCENT, fontFamily: fonts.mono },
});

// Header icon (nav bar)
const hdr = StyleSheet.create({
  btn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  dot: {
    position: 'absolute', top: 6, right: 6,
    width: 6, height: 6, borderRadius: 3, backgroundColor: ACCENT,
  },
});

// Quick popup
const pop = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' },
  card: {
    backgroundColor: colors.surface, borderRadius: 12, marginHorizontal: 16,
    borderWidth: 1, borderColor: ACCENT + '40',
    overflow: 'hidden',
  },
  cardTop: { marginTop: 56 }, // below nav bar
  cardBottom: { position: 'absolute', bottom: 44, left: 0, right: 0 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  headerIcon: {
    width: 20, height: 20, borderRadius: 6, backgroundColor: ACCENT + '20',
    alignItems: 'center', justifyContent: 'center',
  },
  title: { color: colors.text, fontSize: 12, fontWeight: '700' },
  item: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  itemFlash: { backgroundColor: ACCENT + '15' },
  itemLabel: { color: colors.text, fontSize: 12, fontWeight: '600' },
  itemPreview: { color: colors.textDim, fontSize: 10, fontFamily: fonts.mono, marginTop: 1 },
  fillBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: ACCENT,
    borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4,
  },
  fillBtnText: { color: colors.bg, fontSize: 10, fontWeight: '700' },
  emptyRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 10 },
  emptyText: { color: colors.textDim, fontSize: 11 },
  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: 8,
  },
  footerText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
});

// Manager modal
const modal = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border, gap: 8,
  },
  headerIcon: {
    width: 28, height: 28, borderRadius: 8, backgroundColor: ACCENT + '20',
    alignItems: 'center', justifyContent: 'center',
  },
  title: { color: colors.text, fontSize: 14, fontWeight: '700', letterSpacing: 0.3 },
  closeBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  hint: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: colors.surfaceAlt, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  hintText: { flex: 1, fontSize: 10, color: colors.textDim, lineHeight: 14 },
  body: { flex: 1 },
  bodyPad: { padding: 12, paddingBottom: 40 },
});

const sec = StyleSheet.create({
  label: { color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 8 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 14 },
  empty: { alignItems: 'center', paddingVertical: 28, gap: 6 },
  emptyText: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
  emptyHint: { color: colors.textDim, fontSize: 10 },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: ACCENT + '40',
    borderStyle: 'dashed', marginTop: 10,
  },
  addBtnText: { color: ACCENT, fontSize: 12, fontWeight: '600' },
});

const qf = StyleSheet.create({
  card: {
    backgroundColor: colors.surface, borderRadius: 10, padding: 10, marginBottom: 8,
    borderWidth: 1, borderColor: ACCENT + '30',
  },
  cardFlash: { borderColor: ACCENT, backgroundColor: ACCENT + '10' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: colors.text, fontSize: 12, fontWeight: '600' },
  pattern: { color: colors.textDim, fontSize: 10, fontFamily: fonts.mono },
  fillBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: ACCENT,
    borderRadius: 7, paddingHorizontal: 10, paddingVertical: 5,
  },
  fillBtnText: { color: colors.bg, fontSize: 11, fontWeight: '700' },
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 },
  fieldChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: colors.surfaceAlt, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2,
  },
  fieldText: { fontSize: 9, color: colors.textMuted, fontFamily: fonts.mono, maxWidth: 120 },
});

const card = StyleSheet.create({
  wrap: {
    backgroundColor: colors.surface, borderRadius: 10, marginBottom: 8,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  wrapMatch: { borderColor: ACCENT + '40' },
  summary: { flexDirection: 'row', alignItems: 'center', padding: 10, gap: 8 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.borderStrong },
  dotMatch: { backgroundColor: ACCENT },
  label: { color: colors.text, fontSize: 12, fontWeight: '600' },
  pattern: { color: colors.textDim, fontSize: 10, fontFamily: fonts.mono },
  expanded: { padding: 10, paddingTop: 0, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  autofillBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: ACCENT, borderRadius: 8, paddingVertical: 8,
  },
  autofillBtnText: { color: colors.bg, fontSize: 12, fontWeight: '700' },
  deleteBtn: {
    width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.destructive + '15', borderWidth: 1, borderColor: colors.destructive + '30',
  },
});

const inp = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  label: { color: colors.textDim, fontSize: 10, fontWeight: '600', width: 36, textTransform: 'uppercase' },
  input: {
    flex: 1, backgroundColor: colors.surfaceAlt, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5,
    color: colors.text, fontSize: 12, fontFamily: fonts.mono, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
});

const fr = StyleSheet.create({
  wrap: {
    backgroundColor: colors.surfaceAlt, borderRadius: 8, padding: 8, marginBottom: 6,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  typeLabel: { flex: 1, color: colors.textMuted, fontSize: 10, fontWeight: '600', textTransform: 'uppercase', padding: 0 },
  typeLabelText: { flex: 1, color: colors.textMuted, fontSize: 10, fontWeight: '600', textTransform: 'uppercase' },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  input: {
    flex: 1, backgroundColor: colors.bg, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 4,
    color: colors.text, fontSize: 12, fontFamily: fonts.mono, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  eyeBtn: { marginLeft: 6, padding: 4 },
});

const fp = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5,
    borderWidth: 1, borderColor: colors.border,
  },
  chipText: { fontSize: 10, color: colors.textMuted },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, paddingVertical: 6 },
  addBtnText: { fontSize: 11, color: ACCENT, fontWeight: '600' },
});
