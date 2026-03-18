import React, { useCallback, useState, memo, useRef, useEffect, useMemo } from 'react';
import {
  Alert,
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Feather } from '@expo/vector-icons';
import { useSQLStore, SQLEntry } from '../store/sqlStore';
import { useSupabaseStore } from '../store/supabaseStore';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

// ── SQL Syntax Highlighter ────────────────────────────────────────────────────
const KW_RE = /\b(SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|ADD|COLUMN|INDEX|VIEW|DATABASE|SCHEMA|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|ON|AS|AND|OR|NOT|IN|IS|NULL|LIKE|BETWEEN|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|DISTINCT|COUNT|SUM|AVG|MIN|MAX|UNION|ALL|EXISTS|CASE|WHEN|THEN|ELSE|END|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|DEFAULT|UNIQUE|CHECK|CASCADE|REPLACE|OR)\b/gi;
const STR_RE = /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
const NUM_RE = /\b(\d+(?:\.\d+)?)\b/g;
const CMT_RE = /(--[^\n]*|\/\*[\s\S]*?\*\/)/g;

interface Token { text: string; type: 'kw' | 'str' | 'num' | 'cmt' | 'plain' }

function tokenize(sql: string): Token[] {
  const combined = new RegExp(
    `(${CMT_RE.source})|(${STR_RE.source})|(${KW_RE.source})|(${NUM_RE.source})`,
    'gi',
  );
  const tokens: Token[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = combined.exec(sql)) !== null) {
    if (m.index > lastIdx) {
      tokens.push({ text: sql.slice(lastIdx, m.index), type: 'plain' });
    }
    if (m[1]) tokens.push({ text: m[0], type: 'cmt' });
    else if (m[3]) tokens.push({ text: m[0], type: 'str' });
    else if (m[5]) tokens.push({ text: m[0], type: 'kw' });
    else tokens.push({ text: m[0], type: 'num' });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < sql.length) tokens.push({ text: sql.slice(lastIdx), type: 'plain' });
  return tokens;
}

const TOKEN_COLORS: Record<Token['type'], string> = {
  kw:    colors.primary,
  str:   colors.accent,
  num:   '#F97316',
  cmt:   colors.textDim,
  plain: colors.text,
};

function SQLHighlight({ sql }: { sql: string }) {
  const tokens = tokenize(sql);
  return (
    <Text style={hl.base}>
      {tokens.map((t, i) => (
        <Text key={i} style={{ color: TOKEN_COLORS[t.type] }}>{t.text}</Text>
      ))}
    </Text>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// ── Execution state ───────────────────────────────────────────────────────────
type ExecState =
  | { status: 'loading' }
  | { status: 'done'; rows: Record<string, unknown>[] }
  | { status: 'error'; error: string };

// ── Result View ───────────────────────────────────────────────────────────────
function ResultView({ rows, error }: { rows?: Record<string, unknown>[]; error?: string }) {
  const [errCopied, setErrCopied] = useState(false);

  const copyError = useCallback(async () => {
    if (!error) return;
    await Clipboard.setStringAsync(error);
    setErrCopied(true);
    setTimeout(() => setErrCopied(false), 1600);
  }, [error]);

  if (error) {
    return (
      <View style={rv.container}>
        <View style={rv.errorRow}>
          <Feather name="x-circle" size={10} color={colors.destructive} />
          <Text style={rv.errorTxt} numberOfLines={4}>{error}</Text>
          <TouchableOpacity onPress={copyError} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Feather name={errCopied ? 'check' : 'copy'} size={11} color={errCopied ? colors.accent : colors.textDim} />
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  if (!rows) return null;

  if (rows.length === 0) {
    return (
      <View style={rv.container}>
        <View style={rv.successRow}>
          <Feather name="check-circle" size={12} color={colors.accent} />
          <Text style={rv.successTxt}>Success</Text>
        </View>
      </View>
    );
  }

  const colKeys = Object.keys(rows[0]).slice(0, 3);
  const displayRows = rows.slice(0, 3);
  const more = rows.length - 3;

  return (
    <View style={rv.container}>
      <View style={rv.successRow}>
        <Feather name="check-circle" size={12} color={colors.accent} />
        <Text style={rv.successTxt}>Success · {rows.length} {rows.length === 1 ? 'Zeile' : 'Zeilen'}</Text>
      </View>
      {displayRows.map((row, i) => (
        <Text key={i} style={rv.rowTxt} numberOfLines={1}>
          {colKeys.map((k) => `${k}: ${row[k] ?? 'null'}`).join(' · ')}
        </Text>
      ))}
      {more > 0 && <Text style={rv.moreTxt}>+{more} weitere</Text>}
    </View>
  );
}

// ── SQL Card ──────────────────────────────────────────────────────────────────
interface CardProps {
  entry: SQLEntry;
  onDelete: (id: string) => void;
  onExecute?: (entry: SQLEntry) => void;
  execState?: ExecState;
  hasConnection: boolean;
}

const SQLCard = memo(function SQLCard({ entry, onDelete, onExecute, execState, hasConnection }: CardProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(entry.sql);
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1600);
  }, [entry.sql]);

  const lineCount = (entry.sql.match(/\n/g) ?? []).length + 1;
  const truncated = !expanded && lineCount > 6;
  const displaySql = truncated ? entry.sql.split('\n').slice(0, 6).join('\n') + '…' : entry.sql;
  const isLoading = execState?.status === 'loading';

  return (
    <View style={cs.card}>
      <View style={cs.accentBar} />

      {/* Header row */}
      <View style={cs.header}>
        <View style={cs.badge}>
          <Text style={cs.badgeTxt}>SQL</Text>
        </View>
        <Text style={cs.timestamp}>{formatTime(entry.detectedAt)}</Text>
        {lineCount > 6 && (
          <TouchableOpacity onPress={() => setExpanded((v) => !v)} activeOpacity={0.7} style={cs.expandRow}>
            <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={12} color={colors.textDim} />
            <Text style={cs.expandBtn}>{expanded ? ' weniger' : ` ${lineCount} Zeilen`}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Code */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={cs.codeScroll}
        contentContainerStyle={cs.codeContent}
      >
        <SQLHighlight sql={displaySql} />
      </ScrollView>

      {/* Result */}
      {execState && execState.status !== 'loading' && (
        <ResultView
          rows={execState.status === 'done' ? execState.rows : undefined}
          error={execState.status === 'error' ? execState.error : undefined}
        />
      )}

      {/* Footer */}
      <View style={cs.footer}>
        <TouchableOpacity
          style={[cs.copyBtn, copied && cs.copyBtnActive]}
          onPress={handleCopy}
          activeOpacity={0.7}
        >
          <Text style={[cs.copyTxt, copied && cs.copyTxtActive]}>
            <Feather name={copied ? 'check' : 'copy'} size={12} color={copied ? colors.accent : colors.primary} />
            {copied ? ' Kopiert' : ' Kopieren'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={cs.delBtn}
          onPress={() => onDelete(entry.id)}
          activeOpacity={0.7}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Feather name="trash-2" size={12} color={colors.destructive} />
        </TouchableOpacity>
      </View>

      {/* Execute button — only shown when a Supabase connection is assigned */}
      {hasConnection && (
        <TouchableOpacity
          style={[cs.execBtn, isLoading && cs.execBtnLoading]}
          onPress={() => !isLoading && onExecute?.(entry)}
          activeOpacity={0.8}
        >
          {isLoading ? (
            <ActivityIndicator size="small" color={colors.text} />
          ) : (
            <Text style={cs.execTxt}>
              <Feather name="play" size={11} color="#34D399" />{' '}In Supabase ausführen
            </Text>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
});

// ── Settings View ─────────────────────────────────────────────────────────────
function SettingsView({ serverId, onBack }: { serverId: string; onBack: () => void }) {
  const connections  = useSupabaseStore((s) => s.connections);
  const assignments  = useSupabaseStore((s) => s.assignments);
  const addConnection    = useSupabaseStore((s) => s.addConnection);
  const removeConnection = useSupabaseStore((s) => s.removeConnection);
  const assignToServer   = useSupabaseStore((s) => s.assignToServer);

  const [showForm, setShowForm] = useState(false);
  const [name, setName]         = useState('');
  const [ref, setRef]           = useState('');
  const [token, setToken]       = useState('');

  const assigned = assignments[serverId];

  const handleSave = () => {
    if (!name.trim() || !ref.trim() || !token.trim()) return;
    addConnection(name, ref, token);
    setName(''); setRef(''); setToken('');
    setShowForm(false);
  };

  return (
    <View style={ss.container}>
      {/* Header */}
      <View style={ss.header}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Feather name="arrow-left" size={14} color={colors.textDim} />
        </TouchableOpacity>
        <Text style={ss.title}>Supabase</Text>
        <TouchableOpacity onPress={() => setShowForm((v) => !v)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Feather name={showForm ? 'x' : 'plus'} size={14} color={colors.primary} />
        </TouchableOpacity>
      </View>
      <View style={ps.divider} />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={ss.scrollContent}>
        {/* Add form */}
        {showForm && (
          <View style={ss.form}>
            <Text style={ss.label}>Name</Text>
            <TextInput
              style={ss.input}
              value={name}
              onChangeText={setName}
              placeholder="Meine DB"
              placeholderTextColor={colors.textDim}
            />
            <Text style={ss.label}>Project Ref</Text>
            <TextInput
              style={ss.input}
              value={ref}
              onChangeText={setRef}
              placeholder="abcdefghijklmno"
              placeholderTextColor={colors.textDim}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={ss.labelHint}>
              Der Teil vor .supabase.co in deiner URL
            </Text>
            <Text style={ss.label}>Access Token</Text>
            <TextInput
              style={ss.input}
              value={token}
              onChangeText={setToken}
              placeholder="sbp_..."
              placeholderTextColor={colors.textDim}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={ss.labelHint}>
              app.supabase.com → Account → Access Tokens
            </Text>
            <TouchableOpacity
              style={[ss.saveBtn, (!name || !ref || !token) && ss.saveBtnDisabled]}
              onPress={handleSave}
              activeOpacity={0.8}
            >
              <Text style={ss.saveTxt}>Speichern</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Connections list */}
        {connections.length === 0 && !showForm ? (
          <View style={ss.empty}>
            <Feather name="database" size={28} color={colors.border} />
            <Text style={ss.emptyTxt}>Keine Verbindungen</Text>
            <Text style={ss.emptyHint}>Tippe + um eine hinzuzufügen</Text>
          </View>
        ) : (
          connections.map((conn) => {
            const isActive = assigned === conn.id;
            return (
              <View key={conn.id} style={[ss.connRow, isActive && ss.connRowActive]}>
                <View style={{ flex: 1 }}>
                  <Text style={ss.connName} numberOfLines={1}>{conn.name}</Text>
                  <Text style={ss.connRef} numberOfLines={1}>{conn.projectRef}</Text>
                </View>
                <TouchableOpacity
                  style={[ss.assignBtn, isActive && ss.assignBtnActive]}
                  onPress={() => assignToServer(serverId, isActive ? null : conn.id)}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                >
                  <Feather
                    name={isActive ? 'check' : 'link'}
                    size={12}
                    color={isActive ? colors.accent : colors.textDim}
                  />
                </TouchableOpacity>
                <TouchableOpacity
                  style={ss.delConnBtn}
                  onPress={() => removeConnection(conn.id)}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                >
                  <Feather name="trash-2" size={12} color={colors.destructive} />
                </TouchableOpacity>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────
interface Props { sessionId: string | undefined; serverId: string }

export function SQLPanel({ sessionId, serverId }: Props) {
  const { rf, rs, ri } = useResponsive();
  const entries      = useSQLStore((s) => sessionId ? s.getEntries(sessionId) : []);
  const removeEntry  = useSQLStore((s) => s.removeEntry);
  const clearSession = useSQLStore((s) => s.clearSession);
  const loadSupabase = useSupabaseStore((s) => s.load);
  const assigned     = useSupabaseStore((s) => s.getAssigned(serverId));

  const [view, setView] = useState<'list' | 'settings'>('list');
  const [execStates, setExecStates] = useState<Record<string, ExecState>>({});

  useEffect(() => { loadSupabase(); }, []);

  const handleDelete = useCallback((id: string) => {
    if (sessionId) removeEntry(sessionId, id);
  }, [sessionId, removeEntry]);

  const handleClearAll = useCallback(() => {
    if (sessionId) clearSession(sessionId);
  }, [sessionId, clearSession]);

  const doExecute = useCallback(async (entry: SQLEntry) => {
    if (!assigned) return;
    if (!assigned.accessToken) {
      setExecStates((s) => ({
        ...s,
        [entry.id]: { status: 'error', error: 'Token fehlt — Verbindung in Settings neu anlegen' },
      }));
      return;
    }
    setExecStates((s) => ({ ...s, [entry.id]: { status: 'loading' } }));
    try {
      const res = await fetch(
        `https://api.supabase.com/v1/projects/${assigned.projectRef}/database/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${assigned.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: entry.sql }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setExecStates((s) => ({
          ...s,
          [entry.id]: { status: 'error', error: data.message ?? `HTTP ${res.status}` },
        }));
      } else {
        setExecStates((s) => ({
          ...s,
          [entry.id]: { status: 'done', rows: Array.isArray(data) ? data : [] },
        }));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Netzwerkfehler';
      setExecStates((s) => ({ ...s, [entry.id]: { status: 'error', error: msg } }));
    }
  }, [assigned]);

  const handleExecute = useCallback((entry: SQLEntry) => {
    const isDangerous = /\b(DROP|DELETE|ALTER|UPDATE|INSERT|TRUNCATE|CREATE)\b/i.test(entry.sql);
    if (isDangerous) {
      Alert.alert(
        'Destructive SQL',
        'This query may modify data. Execute anyway?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Execute', style: 'destructive', onPress: () => doExecute(entry) },
        ],
      );
      return;
    }
    doExecute(entry);
  }, [doExecute]);

  if (view === 'settings') {
    return <SettingsView serverId={serverId} onBack={() => setView('list')} />;
  }

  return (
    <View style={ps.container}>
      {/* Header */}
      <View style={[ps.header, { paddingHorizontal: rs(12), paddingVertical: rs(10) }]}>
        <View style={ps.titleRow}>
          <Feather name="database" size={ri(14)} color={colors.primary} />
          <Text style={[ps.title, { fontSize: rf(13) }]}>SQL</Text>
          {entries.length > 0 && (
            <View style={ps.countBadge}>
              <Text style={ps.countTxt}>{entries.length}</Text>
            </View>
          )}
          {/* Supabase connection indicator */}
          {assigned && (
            <View style={ps.connIndicator}>
              <Feather name="link" size={10} color={colors.accent} />
              <Text style={ps.connIndicatorTxt} numberOfLines={1}>{assigned.name}</Text>
            </View>
          )}
        </View>
        <View style={ps.headerActions}>
          {entries.length > 0 && (
            <TouchableOpacity onPress={handleClearAll} activeOpacity={0.7}>
              <Text style={ps.clearAll}>Alle löschen</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={() => setView('settings')}
            activeOpacity={0.7}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            <Feather name="settings" size={13} color={assigned ? colors.accent : colors.textDim} />
          </TouchableOpacity>
        </View>
      </View>

      {/* No connection hint */}
      {!assigned && (
        <TouchableOpacity style={ps.connectHint} onPress={() => setView('settings')} activeOpacity={0.8}>
          <Feather name="link" size={11} color={colors.textDim} />
          <Text style={ps.connectHintTxt}>Supabase verbinden</Text>
          <Feather name="chevron-right" size={11} color={colors.textDim} />
        </TouchableOpacity>
      )}

      <View style={ps.divider} />

      {/* List */}
      <FlatList
        data={entries}
        keyExtractor={(e) => e.id}
        style={ps.list}
        contentContainerStyle={ps.listContent}
        renderItem={({ item }) => (
          <SQLCard
            entry={item}
            onDelete={handleDelete}
            onExecute={handleExecute}
            execState={execStates[item.id]}
            hasConnection={!!assigned}
          />
        )}
        ListEmptyComponent={
          <View style={ps.empty}>
            <Feather name="database" size={32} color={colors.border} />
            <Text style={ps.emptyTitle}>Kein SQL erkannt</Text>
            <Text style={ps.emptyHint}>
              SQL-Blöcke aus dem Terminal{'\n'}werden hier automatisch gesammelt
            </Text>
          </View>
        }
      />
    </View>
  );
}

// ── Result styles ─────────────────────────────────────────────────────────────
const rv = StyleSheet.create({
  container: {
    marginHorizontal: 10,
    marginBottom: 6,
    padding: 7,
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  successRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 3,
  },
  successTxt: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: fonts.mono,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 5,
  },
  errorTxt: {
    flex: 1,
    color: colors.destructive,
    fontSize: 10,
    fontFamily: fonts.mono,
    lineHeight: 14,
  },
  rowTxt: {
    color: colors.textDim,
    fontSize: 9.5,
    fontFamily: fonts.mono,
    lineHeight: 14,
  },
  moreTxt: {
    color: colors.textDim,
    fontSize: 9,
    fontFamily: fonts.mono,
    marginTop: 2,
  },
});

// ── Settings styles ───────────────────────────────────────────────────────────
const ss = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  title: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  scrollContent: {
    paddingBottom: 20,
  },
  form: {
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 4,
  },
  label: {
    color: colors.textDim,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.4,
    marginTop: 6,
    marginBottom: 2,
  },
  labelHint: {
    color: colors.textDim,
    fontSize: 9,
    lineHeight: 13,
    opacity: 0.7,
  },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: colors.text,
    fontSize: 11,
    fontFamily: fonts.mono,
  },
  saveBtn: {
    marginTop: 8,
    backgroundColor: colors.primary,
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
  },
  saveBtnDisabled: {
    opacity: 0.4,
  },
  saveTxt: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  empty: {
    alignItems: 'center',
    paddingTop: 36,
    gap: 6,
  },
  emptyTxt: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: '600',
  },
  emptyHint: {
    color: colors.textDim,
    fontSize: 11,
    textAlign: 'center',
  },
  connRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 8,
  },
  connRowActive: {
    backgroundColor: 'rgba(52,211,153,0.06)',
  },
  connName: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
  connRef: {
    color: colors.textDim,
    fontSize: 9.5,
    fontFamily: fonts.mono,
    marginTop: 1,
  },
  assignBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  assignBtnActive: {
    backgroundColor: 'rgba(52,211,153,0.12)',
    borderColor: colors.accent,
  },
  delConnBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: 'rgba(239,68,68,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

// ── Card styles ───────────────────────────────────────────────────────────────
const cs = StyleSheet.create({
  card: {
    marginHorizontal: 8,
    marginVertical: 5,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    overflow: 'hidden',
  },
  accentBar: {
    height: 2,
    backgroundColor: colors.primary,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 4,
    gap: 6,
  },
  badge: {
    backgroundColor: 'rgba(59,130,246,0.14)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  badgeTxt: {
    color: colors.primary,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
    fontFamily: fonts.mono,
  },
  timestamp: {
    flex: 1,
    color: colors.textDim,
    fontSize: 10,
    fontFamily: fonts.mono,
  },
  expandRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  expandBtn: {
    color: colors.textDim,
    fontSize: 9,
    letterSpacing: 0.3,
  },
  codeScroll: {
    maxHeight: 130,
  },
  codeContent: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 8,
  },
  copyBtn: {
    flex: 1,
    backgroundColor: 'rgba(59,130,246,0.08)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingVertical: 5,
    alignItems: 'center',
  },
  copyBtnActive: {
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderColor: colors.accent,
  },
  copyTxt: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: '700',
  },
  copyTxtActive: { color: colors.accent },
  delBtn: {
    width: 34,
    height: 34,
    borderRadius: 6,
    backgroundColor: 'rgba(239,68,68,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  execBtn: {
    marginHorizontal: 10,
    marginBottom: 10,
    paddingVertical: 7,
    borderRadius: 6,
    backgroundColor: 'rgba(52,211,153,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(52,211,153,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
  },
  execBtnLoading: {
    opacity: 0.7,
  },
  execTxt: {
    color: '#34D399',
    fontSize: 11,
    fontWeight: '700',
  },
});

// ── Highlight styles ──────────────────────────────────────────────────────────
const hl = StyleSheet.create({
  base: {
    fontSize: 10.5,
    lineHeight: 17,
    fontFamily: fonts.mono,
    flexWrap: 'nowrap',
  },
});

// ── Panel styles ──────────────────────────────────────────────────────────────
const ps = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  titleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  title: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  countBadge: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  countTxt: {
    color: colors.bg,
    fontSize: 9,
    fontWeight: '800',
  },
  connIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(52,211,153,0.1)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    maxWidth: 70,
  },
  connIndicatorTxt: {
    color: colors.accent,
    fontSize: 9,
    fontWeight: '600',
    flexShrink: 1,
  },
  connectHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    borderStyle: 'dashed',
  },
  connectHintTxt: {
    flex: 1,
    color: colors.textDim,
    fontSize: 11,
  },
  clearAll: {
    color: colors.textDim,
    fontSize: 11,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(51,65,85,0.7)',
  },
  list: { flex: 1 },
  listContent: { paddingTop: 4, paddingBottom: 12 },
  empty: {
    alignItems: 'center',
    paddingTop: 44,
    gap: 8,
  },
  emptyTitle: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: '600',
  },
  emptyHint: {
    color: colors.textDim,
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 17,
  },
});
