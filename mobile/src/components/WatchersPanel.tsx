import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  FlatList, StyleSheet, LayoutAnimation, Platform, UIManager,
  ActivityIndicator,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fonts } from '../theme';
import { WebSocketService } from '../services/websocket.service';
import { keywordAlertService, AlertCategory, KeywordRule } from '../services/keywordAlert.service';
import { useResponsive } from '../hooks/useResponsive';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ── Types ────────────────────────────────────────────────────────────────────
type WatcherType = 'file' | 'process' | 'keyword';

interface Watcher {
  id: string;
  type: WatcherType;
  label: string;
  enabled: boolean;
  config: Record<string, string>;
}

const TYPE_CONFIG: Record<WatcherType, {
  icon: string;
  color: string;
  label: string;
  fields: { key: string; label: string; placeholder: string; multiline?: boolean }[];
}> = {
  file: {
    icon: 'file',
    color: colors.info,
    label: 'File Change',
    fields: [
      { key: 'path', label: 'Path', placeholder: '/home/user/app/config.json' },
    ],
  },
  process: {
    icon: 'activity',
    color: colors.warning,
    label: 'Process Crash',
    fields: [
      { key: 'name', label: 'Process', placeholder: 'node, nginx, postgres...' },
    ],
  },
  keyword: {
    icon: 'search',
    color: '#A78BFA',
    label: 'Log Keyword',
    fields: [
      { key: 'file', label: 'Log File', placeholder: '/var/log/app.log' },
      { key: 'pattern', label: 'Keyword / Regex', placeholder: 'ERROR|FATAL|panic' },
    ],
  },
};

const ANIM = LayoutAnimation.create(200, LayoutAnimation.Types.easeOut, LayoutAnimation.Properties.opacity);

// ── Watcher Card ─────────────────────────────────────────────────────────────
interface CardProps {
  watcher: Watcher;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onTest: (id: string) => void;
}

function WatcherCard({ watcher, onToggle, onDelete, onTest }: CardProps) {
  const tc = TYPE_CONFIG[watcher.type];
  const [testing, setTesting] = useState(false);
  const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (testTimerRef.current) clearTimeout(testTimerRef.current); }, []);

  const handleTest = () => {
    setTesting(true);
    onTest(watcher.id);
    if (testTimerRef.current) clearTimeout(testTimerRef.current);
    testTimerRef.current = setTimeout(() => setTesting(false), 2000);
  };

  return (
    <View style={[wc.card, !watcher.enabled && wc.cardDisabled]}>
      {/* Header row */}
      <View style={wc.header}>
        <View style={[wc.typeBadge, { backgroundColor: tc.color + '18' }]}>
          <Feather name={tc.icon as any} size={12} color={tc.color} />
        </View>
        <View style={wc.headerText}>
          <Text style={[wc.label, !watcher.enabled && wc.labelDim]} numberOfLines={1}>
            {watcher.label}
          </Text>
          <Text style={wc.typeLabel}>{tc.label}</Text>
        </View>

        {/* Toggle */}
        <TouchableOpacity
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onToggle(watcher.id);
          }}
          activeOpacity={0.7}
          accessibilityRole={'switch' as any}
          accessibilityState={{ checked: watcher.enabled }}
          accessibilityLabel={`${watcher.label} ${watcher.enabled ? 'enabled' : 'disabled'}`}
        >
          <View style={[wc.track, watcher.enabled && wc.trackOn]}>
            <View style={[wc.knob, watcher.enabled && wc.knobOn]} />
          </View>
        </TouchableOpacity>
      </View>

      {/* Config preview */}
      <View style={wc.configPreview}>
        {tc.fields.map((f) => (
          <Text key={f.key} style={wc.configText} numberOfLines={1}>
            {f.label}: {watcher.config[f.key] || '—'}
          </Text>
        ))}
      </View>

      {/* Actions */}
      <View style={wc.actions}>
        <TouchableOpacity
          style={wc.actionBtn}
          onPress={handleTest}
          disabled={testing}
          activeOpacity={0.7}
          accessibilityLabel="Test trigger"
        >
          {testing
            ? <ActivityIndicator size={12} color={colors.info} />
            : <Feather name="send" size={12} color={colors.info} />
          }
          <Text style={wc.actionText}>{testing ? 'Sending...' : 'Test'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={wc.actionBtn}
          onPress={() => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            onDelete(watcher.id);
          }}
          activeOpacity={0.7}
          accessibilityLabel="Delete trigger"
        >
          <Feather name="trash-2" size={12} color={colors.destructive} />
          <Text style={[wc.actionText, { color: colors.destructive }]}>Delete</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Add Trigger Flow ─────────────────────────────────────────────────────────
interface AddFlowProps {
  onAdd: (type: WatcherType, label: string, config: Record<string, string>) => void;
  onCancel: () => void;
}

function AddTriggerFlow({ onAdd, onCancel }: AddFlowProps) {
  const [step, setStep] = useState<'type' | 'config'>('type');
  const [type, setType] = useState<WatcherType>('file');
  const [label, setLabel] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});

  const selectType = (t: WatcherType) => {
    Haptics.selectionAsync();
    LayoutAnimation.configureNext(ANIM);
    setType(t);
    setLabel(TYPE_CONFIG[t].label);
    setConfig({});
    setStep('config');
  };

  const handleSubmit = () => {
    const trimmedLabel = label.trim() || TYPE_CONFIG[type].label;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onAdd(type, trimmedLabel, config);
  };

  const tc = TYPE_CONFIG[type];
  const hasRequiredFields = tc.fields.every((f) => (config[f.key] || '').trim().length > 0);

  if (step === 'type') {
    return (
      <View style={af.container}>
        <Text style={af.stepLabel}>Choose Trigger Type</Text>
        {(Object.keys(TYPE_CONFIG) as WatcherType[]).map((t) => {
          const c = TYPE_CONFIG[t];
          return (
            <TouchableOpacity
              key={t}
              style={af.typeBtn}
              onPress={() => selectType(t)}
              activeOpacity={0.7}
            >
              <View style={[af.typeIcon, { backgroundColor: c.color + '18' }]}>
                <Feather name={c.icon as any} size={16} color={c.color} />
              </View>
              <View style={af.typeText}>
                <Text style={af.typeLabel}>{c.label}</Text>
                <Text style={af.typeHint}>
                  {t === 'file' ? 'Notify on file changes' :
                   t === 'process' ? 'Notify when process dies' :
                   'Notify on log matches'}
                </Text>
              </View>
              <Feather name="chevron-right" size={14} color={colors.textDim} />
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity style={af.cancelBtn} onPress={onCancel} activeOpacity={0.7}>
          <Text style={af.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={af.container}>
      {/* Back to type selection */}
      <TouchableOpacity
        style={af.backRow}
        onPress={() => { LayoutAnimation.configureNext(ANIM); setStep('type'); }}
        activeOpacity={0.7}
      >
        <Feather name="chevron-left" size={14} color={colors.textMuted} />
        <View style={[af.typeIcon, { backgroundColor: tc.color + '18', width: 24, height: 24 }]}>
          <Feather name={tc.icon as any} size={12} color={tc.color} />
        </View>
        <Text style={af.backLabel}>{tc.label}</Text>
      </TouchableOpacity>

      {/* Label */}
      <View style={af.fieldGroup}>
        <Text style={af.fieldLabel}>Name</Text>
        <TextInput
          style={af.input}
          value={label}
          onChangeText={setLabel}
          placeholder={tc.label}
          placeholderTextColor={colors.textDim}
          maxLength={40}
        />
      </View>

      {/* Type-specific fields */}
      {tc.fields.map((f) => (
        <View key={f.key} style={af.fieldGroup}>
          <Text style={af.fieldLabel}>{f.label}</Text>
          <TextInput
            style={[af.input, f.multiline && af.inputMultiline]}
            value={config[f.key] || ''}
            onChangeText={(v) => setConfig((prev) => ({ ...prev, [f.key]: v }))}
            placeholder={f.placeholder}
            placeholderTextColor={colors.textDim}
            multiline={f.multiline}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      ))}

      {/* Submit */}
      <TouchableOpacity
        style={[af.submitBtn, !hasRequiredFields && af.submitBtnDisabled]}
        onPress={handleSubmit}
        disabled={!hasRequiredFields}
        activeOpacity={0.8}
      >
        <Feather name="bell" size={14} color={hasRequiredFields ? colors.bg : colors.textDim} />
        <Text style={[af.submitText, !hasRequiredFields && af.submitTextDisabled]}>Create Trigger</Text>
      </TouchableOpacity>

      <TouchableOpacity style={af.cancelBtn} onPress={onCancel} activeOpacity={0.7}>
        <Text style={af.cancelText}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Keyword Alert Category Config ────────────────────────────────────────────
const ALERT_CATEGORIES: Record<AlertCategory, { color: string; icon: string; label: string; vibDesc: string }> = {
  error:   { color: colors.destructive, icon: 'alert-circle',   label: 'Error',   vibDesc: 'SOS triple' },
  warning: { color: colors.warning,     icon: 'alert-triangle', label: 'Warning', vibDesc: 'Double buzz' },
  success: { color: colors.accent,      icon: 'check-circle',   label: 'Success', vibDesc: 'Long buzz' },
  custom:  { color: colors.primary,     icon: 'tag',            label: 'Custom',  vibDesc: 'Triple tap' },
};

// ── Keyword Alert Rule Row ───────────────────────────────────────────────────
function AlertRuleRow({ rule, onToggle, onDelete }: { rule: KeywordRule; onToggle: () => void; onDelete: () => void }) {
  const cc = ALERT_CATEGORIES[rule.category];
  return (
    <TouchableOpacity
      style={[kr.row, !rule.enabled && kr.rowDim]}
      onPress={onToggle}
      onLongPress={() => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        onDelete();
      }}
      delayLongPress={400}
      activeOpacity={0.7}
      accessibilityLabel={`${rule.keyword}, ${cc.label}`}
      accessibilityHint="Tap to toggle, hold to delete"
    >
      <View style={[kr.dot, { backgroundColor: cc.color }, !rule.enabled && kr.dotDim]} />
      <Text style={[kr.keyword, !rule.enabled && kr.keywordOff]} numberOfLines={1}>{rule.keyword}</Text>
      <View style={[kr.toggle, rule.enabled && kr.toggleOn]}>
        <View style={[kr.knob, rule.enabled && kr.knobOn]} />
      </View>
    </TouchableOpacity>
  );
}

const kr = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 8, paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(51,65,85,0.3)',
  },
  rowDim: { opacity: 0.4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  keyword: { flex: 1, color: colors.text, fontSize: 11, fontFamily: fonts.mono, fontWeight: '600' },
  keywordOff: { textDecorationLine: 'line-through', color: colors.textDim },
  dotDim: { opacity: 0.3 },
  toggle: { width: 26, height: 14, borderRadius: 7, backgroundColor: colors.border, justifyContent: 'center', paddingHorizontal: 2 },
  toggleOn: { backgroundColor: colors.accent },
  knob: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.textMuted },
  knobOn: { alignSelf: 'flex-end', backgroundColor: colors.bg },
});

// ── Main Panel ───────────────────────────────────────────────────────────────
type PanelTab = 'watchers' | 'alerts';

interface Props {
  serverId: string;
  wsService: WebSocketService;
}

export function WatchersPanel({ serverId, wsService }: Props) {
  const { rf, rs, ri } = useResponsive();
  const [tab, setTab] = useState<PanelTab>('watchers');
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [adding, setAdding] = useState(false);

  // ── Keyword alert state ──
  const [alertRules, setAlertRules] = useState<KeywordRule[]>([]);
  const [alertEnabled, setAlertEnabled] = useState(true);
  const [addingAlert, setAddingAlert] = useState(false);
  const [alertKeyword, setAlertKeyword] = useState('');
  const [alertCategory, setAlertCategory] = useState<AlertCategory>('error');

  // Load keyword alerts
  useEffect(() => {
    keywordAlertService.init().then(() => {
      setAlertRules(keywordAlertService.getRules());
      setAlertEnabled(keywordAlertService.isEnabled());
    });
  }, []);

  const refreshAlerts = () => setAlertRules([...keywordAlertService.getRules()]);

  // Request watcher list from server on mount
  useEffect(() => {
    wsService.send({ type: 'watcher:list', payload: {} });

    return wsService.addMessageListener((msg: unknown) => {
      const m = msg as { type: string; payload?: any };
      if (m.type === 'watcher:list' && m.payload?.watchers) {
        setWatchers(m.payload.watchers);
      } else if (m.type === 'watcher:created' && m.payload) {
        LayoutAnimation.configureNext(ANIM);
        setWatchers((prev) => [m.payload, ...prev]);
      } else if (m.type === 'watcher:deleted' && m.payload?.id) {
        LayoutAnimation.configureNext(ANIM);
        setWatchers((prev) => prev.filter((w) => w.id !== m.payload.id));
      } else if (m.type === 'watcher:updated' && m.payload) {
        setWatchers((prev) => prev.map((w) => w.id === m.payload.id ? { ...w, ...m.payload } : w));
      }
    });
  }, [wsService]);

  // ── Watcher handlers ──
  const handleAdd = useCallback((type: WatcherType, label: string, config: Record<string, string>) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const watcher: Watcher = { id, type, label, enabled: true, config };
    LayoutAnimation.configureNext(ANIM);
    setWatchers((prev) => [watcher, ...prev]);
    setAdding(false);
    wsService.send({ type: 'watcher:create', payload: watcher });
  }, [wsService]);

  const handleToggle = useCallback((id: string) => {
    setWatchers((prev) => prev.map((w) => {
      if (w.id !== id) return w;
      const updated = { ...w, enabled: !w.enabled };
      wsService.send({ type: 'watcher:update', payload: { id, enabled: updated.enabled } });
      return updated;
    }));
  }, [wsService]);

  const handleDelete = useCallback((id: string) => {
    LayoutAnimation.configureNext(ANIM);
    setWatchers((prev) => prev.filter((w) => w.id !== id));
    wsService.send({ type: 'watcher:delete', payload: { id } });
  }, [wsService]);

  const handleTest = useCallback((id: string) => {
    wsService.send({ type: 'watcher:test', payload: { id } });
  }, [wsService]);

  // ── Alert handlers ──
  const handleAddAlert = useCallback(() => {
    const kw = alertKeyword.trim().toLowerCase();
    if (!kw) return;
    keywordAlertService.addRule(kw, alertCategory);
    LayoutAnimation.configureNext(ANIM);
    refreshAlerts();
    setAlertKeyword('');
    setAddingAlert(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [alertKeyword, alertCategory]);

  const enabledCount = watchers.filter((w) => w.enabled).length;

  return (
    <View style={ps.container}>
      {/* Header */}
      <View style={[ps.header, { paddingHorizontal: rs(12), paddingVertical: rs(10), gap: rs(7) }]}>
        <Feather name="bell" size={ri(14)} color={colors.warning} />
        <Text style={[ps.title, { fontSize: rf(13) }]}>Notifications</Text>
      </View>

      {/* Tab switcher */}
      <View style={ps.tabs}>
        <TouchableOpacity
          style={[ps.tab, tab === 'watchers' && ps.tabActive]}
          onPress={() => { Haptics.selectionAsync(); LayoutAnimation.configureNext(ANIM); setTab('watchers'); setAdding(false); setAddingAlert(false); }}
          activeOpacity={0.7}
        >
          <Feather name="eye" size={11} color={tab === 'watchers' ? colors.warning : colors.textDim} />
          <Text style={[ps.tabText, tab === 'watchers' && ps.tabTextActive]}>Watchers</Text>
          {watchers.length > 0 && <Text style={ps.tabBadge}>{enabledCount}</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          style={[ps.tab, tab === 'alerts' && ps.tabActive]}
          onPress={() => { Haptics.selectionAsync(); LayoutAnimation.configureNext(ANIM); setTab('alerts'); setAdding(false); setAddingAlert(false); }}
          activeOpacity={0.7}
        >
          <Feather name="volume-2" size={11} color={tab === 'alerts' ? '#F472B6' : colors.textDim} />
          <Text style={[ps.tabText, tab === 'alerts' && { color: '#F472B6' }]}>Alerts</Text>
          {alertRules.filter((r) => r.enabled).length > 0 && (
            <Text style={ps.tabBadge}>{alertRules.filter((r) => r.enabled).length}</Text>
          )}
        </TouchableOpacity>
      </View>
      <View style={ps.divider} />

      {/* ══════ WATCHERS TAB ══════ */}
      {tab === 'watchers' && (
        <>
          {/* Add button */}
          <View style={ps.tabHeader}>
            <Text style={ps.tabHeaderHint}>Server-side monitors</Text>
            <TouchableOpacity
              style={[ps.addBtn, adding && ps.addBtnActive]}
              onPress={() => { LayoutAnimation.configureNext(ANIM); setAdding((v) => !v); }}
              activeOpacity={0.7}
            >
              <Feather name={adding ? 'x' : 'plus'} size={14} color={adding ? colors.destructive : colors.text} />
            </TouchableOpacity>
          </View>

          {adding && (
            <AddTriggerFlow
              onAdd={handleAdd}
              onCancel={() => { LayoutAnimation.configureNext(ANIM); setAdding(false); }}
            />
          )}

          {!adding && (
            <FlatList
              data={watchers}
              keyExtractor={(w) => w.id}
              style={ps.list}
              contentContainerStyle={ps.listContent}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <WatcherCard watcher={item} onToggle={handleToggle} onDelete={handleDelete} onTest={handleTest} />
              )}
              ListEmptyComponent={
                <View style={ps.empty}>
                  <Feather name="eye-off" size={28} color={colors.border} />
                  <Text style={ps.emptyText}>No server watchers</Text>
                  <Text style={ps.emptyHint}>Monitor files, processes, logs</Text>
                </View>
              }
            />
          )}
        </>
      )}

      {/* ══════ KEYWORD ALERTS TAB ══════ */}
      {tab === 'alerts' && (
        <>
          {/* Alert header: toggle + add */}
          <View style={ps.tabHeader}>
            <TouchableOpacity
              onPress={() => {
                const next = !alertEnabled;
                setAlertEnabled(next);
                keywordAlertService.setEnabled(next);
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              activeOpacity={0.7}
              style={ps.globalRow}
            >
              <View style={[kr.toggle, alertEnabled && kr.toggleOn]}>
                <View style={[kr.knob, alertEnabled && kr.knobOn]} />
              </View>
              <Text style={ps.tabHeaderHint}>{alertEnabled ? 'Active' : 'Paused'}</Text>
            </TouchableOpacity>
            <View style={{ flex: 1 }} />
            <TouchableOpacity
              style={[ps.addBtn, addingAlert && ps.addBtnActive]}
              onPress={() => { LayoutAnimation.configureNext(ANIM); setAddingAlert((v) => !v); setAlertKeyword(''); }}
              activeOpacity={0.7}
            >
              <Feather name={addingAlert ? 'x' : 'plus'} size={14} color={addingAlert ? colors.destructive : colors.text} />
            </TouchableOpacity>
          </View>

          {/* Add alert form */}
          {addingAlert && (
            <View style={ps.alertForm}>
              <TextInput
                style={ps.alertInput}
                value={alertKeyword}
                onChangeText={setAlertKeyword}
                placeholder="Keyword (e.g. error, SIGTERM)"
                placeholderTextColor={colors.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
              />
              <View style={ps.alertCatRow}>
                {(Object.keys(ALERT_CATEGORIES) as AlertCategory[]).map((cat) => {
                  const cc = ALERT_CATEGORIES[cat];
                  return (
                    <TouchableOpacity
                      key={cat}
                      style={[ps.alertCatChip, alertCategory === cat && { backgroundColor: cc.color + '22', borderColor: cc.color }]}
                      onPress={() => setAlertCategory(cat)}
                      activeOpacity={0.7}
                    >
                      <Feather name={cc.icon as any} size={9} color={alertCategory === cat ? cc.color : colors.textDim} />
                      <Text style={[ps.alertCatText, alertCategory === cat && { color: cc.color }]}>{cc.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TouchableOpacity
                style={[ps.alertConfirm, !alertKeyword.trim() && { backgroundColor: colors.border }]}
                onPress={handleAddAlert}
                disabled={!alertKeyword.trim()}
                activeOpacity={0.8}
              >
                <Text style={ps.alertConfirmText}>Add</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Compact legend + hint */}
          {!addingAlert && (
            <View style={ps.legendWrap}>
              <View style={ps.legend}>
                {(Object.entries(ALERT_CATEGORIES) as [AlertCategory, typeof ALERT_CATEGORIES[AlertCategory]][]).map(([, cc]) => (
                  <View key={cc.label} style={ps.legendChip}>
                    <View style={[ps.legendDot, { backgroundColor: cc.color }]} />
                    <Text style={ps.legendLabel}>{cc.label}</Text>
                  </View>
                ))}
              </View>
              <Text style={ps.legendHint}>Tap to toggle · Hold to delete</Text>
            </View>
          )}

          {/* Rule list */}
          <FlatList
            data={alertRules}
            keyExtractor={(r) => r.id}
            style={ps.list}
            contentContainerStyle={ps.listContent}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <AlertRuleRow
                rule={item}
                onToggle={() => { keywordAlertService.toggleRule(item.id); refreshAlerts(); }}
                onDelete={() => { LayoutAnimation.configureNext(ANIM); keywordAlertService.removeRule(item.id); refreshAlerts(); }}
              />
            )}
            ListEmptyComponent={
              <View style={ps.empty}>
                <Feather name="volume-x" size={28} color={colors.border} />
                <Text style={ps.emptyText}>No keyword rules</Text>
              </View>
            }
          />
        </>
      )}

      {/* Footer */}
      <View style={[ps.footer, { paddingHorizontal: rs(12), paddingVertical: rs(8), gap: rs(6) }]}>
        <Feather name="info" size={ri(10)} color={colors.textDim} />
        <Text style={[ps.footerText, { fontSize: rf(9) }]}>
          {tab === 'watchers'
            ? 'Watchers run on the server even when the app is closed'
            : 'Each category vibrates differently so you can tell by feel'}
        </Text>
      </View>
    </View>
  );
}

// ── Watcher Card styles ──────────────────────────────────────────────────────
const wc = StyleSheet.create({
  card: {
    marginHorizontal: 8, marginVertical: 4, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: 'hidden',
  },
  cardDisabled: { opacity: 0.5 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingTop: 10, paddingBottom: 6,
  },
  typeBadge: {
    width: 28, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center',
  },
  headerText: { flex: 1, gap: 1 },
  label: { color: colors.text, fontSize: 12, fontWeight: '600' },
  labelDim: { color: colors.textMuted },
  typeLabel: { color: colors.textDim, fontSize: 9, fontFamily: fonts.mono, letterSpacing: 0.3, textTransform: 'uppercase' },
  configPreview: { paddingHorizontal: 10, paddingBottom: 8, gap: 2 },
  configText: { color: colors.textDim, fontSize: 10, fontFamily: fonts.mono },
  actions: {
    flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 5, paddingVertical: 8,
  },
  actionText: { color: colors.textMuted, fontSize: 10, fontWeight: '600' },
  // Toggle
  track: {
    width: 34, height: 18, borderRadius: 9, backgroundColor: colors.border,
    justifyContent: 'center', paddingHorizontal: 2,
  },
  trackOn: { backgroundColor: colors.accent },
  knob: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.textMuted },
  knobOn: { alignSelf: 'flex-end', backgroundColor: colors.bg },
});

// ── Add flow styles ──────────────────────────────────────────────────────────
const af = StyleSheet.create({
  container: { padding: 10, gap: 8 },
  stepLabel: {
    color: colors.textDim, fontSize: 10, fontWeight: '600',
    letterSpacing: 0.5, textTransform: 'uppercase', paddingHorizontal: 2, marginBottom: 2,
  },
  typeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, paddingHorizontal: 10, borderRadius: 8,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  typeIcon: {
    width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
  },
  typeText: { flex: 1, gap: 2 },
  typeLabel: { color: colors.text, fontSize: 13, fontWeight: '500' },
  typeHint: { color: colors.textDim, fontSize: 10 },
  backRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4,
  },
  backLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  fieldGroup: { gap: 4 },
  fieldLabel: {
    color: colors.textDim, fontSize: 10, fontWeight: '600',
    letterSpacing: 0.3, textTransform: 'uppercase', paddingHorizontal: 2,
  },
  input: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: 8, color: colors.text, fontSize: 12, fontFamily: fonts.mono,
    paddingHorizontal: 10, paddingVertical: 8, minHeight: 38,
  },
  inputMultiline: { minHeight: 60, textAlignVertical: 'top' },
  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 10, borderRadius: 9, backgroundColor: colors.warning, marginTop: 4,
  },
  submitBtnDisabled: { backgroundColor: colors.border },
  submitText: { color: colors.bg, fontWeight: '700', fontSize: 13 },
  submitTextDisabled: { color: colors.textDim },
  cancelBtn: { paddingVertical: 8, alignItems: 'center' },
  cancelText: { color: colors.textDim, fontSize: 12 },
});

// ── Panel styles ─────────────────────────────────────────────────────────────
const ps = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
    paddingVertical: 10, gap: 7,
  },
  title: { color: colors.text, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
  // ── Tabs ──
  tabs: {
    flexDirection: 'row', paddingHorizontal: 8, gap: 4, paddingBottom: 6,
  },
  tab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingVertical: 7, borderRadius: 6,
    backgroundColor: 'transparent',
  },
  tabActive: { backgroundColor: colors.surfaceAlt },
  tabText: { color: colors.textDim, fontSize: 10, fontWeight: '600' },
  tabTextActive: { color: colors.warning },
  tabBadge: {
    color: colors.textDim, fontSize: 9, fontFamily: fonts.mono,
    backgroundColor: colors.border, borderRadius: 4,
    paddingHorizontal: 4, paddingVertical: 1, overflow: 'hidden',
  },
  // ── Common ──
  tabHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  tabHeaderHint: { color: colors.textDim, fontSize: 9 },
  globalRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  addBtn: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: 'rgba(51,65,85,0.8)', borderWidth: 1, borderColor: colors.borderStrong,
    alignItems: 'center', justifyContent: 'center',
  },
  addBtnActive: { backgroundColor: 'rgba(239,68,68,0.15)', borderColor: colors.destructive },
  divider: { height: 1, backgroundColor: 'rgba(51,65,85,0.7)' },
  list: { flex: 1 },
  listContent: { paddingTop: 4, paddingBottom: 12 },
  empty: { alignItems: 'center', paddingTop: 32, gap: 6 },
  emptyText: { color: colors.textDim, fontSize: 12, fontWeight: '500' },
  emptyHint: { color: colors.textDim, fontSize: 10, textAlign: 'center', lineHeight: 15 },
  footer: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: 'rgba(51,65,85,0.5)',
  },
  footerText: { color: colors.textDim, fontSize: 9, flex: 1, lineHeight: 13 },
  // ── Alert-specific ──
  alertForm: { padding: 10, gap: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  alertInput: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: 8, color: colors.text, fontSize: 12, fontFamily: fonts.mono,
    paddingHorizontal: 10, paddingVertical: 7,
  },
  alertCatRow: { flexDirection: 'row', gap: 3, flexWrap: 'wrap' },
  alertCatChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 4, borderRadius: 5,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  alertCatText: { color: colors.textDim, fontSize: 9, fontWeight: '600' },
  alertConfirm: {
    paddingVertical: 7, borderRadius: 7, alignItems: 'center',
    backgroundColor: '#F472B6',
  },
  alertConfirmText: { color: colors.bg, fontWeight: '700', fontSize: 12 },
  legendWrap: { paddingHorizontal: 8, paddingVertical: 6, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(51,65,85,0.3)' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  legendChip: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  legendDot: { width: 5, height: 5, borderRadius: 3 },
  legendLabel: { color: colors.textDim, fontSize: 8 },
  legendHint: { color: colors.textDim, fontSize: 8, fontStyle: 'italic' },
});
