/**
 * Season 2 Cloud — native glass screen over the existing Render/Vercel
 * services. Delivers the user's original cloud pain points: favorites float
 * to top, env vars are COPYABLE and EDITABLE (create/update/delete), service
 * logs come in a large copyable viewer, deployments list + trigger.
 * Tokens/setup stay in the classic Cloud settings (bridge below).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, ActivityIndicator, Platform,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useCloudAuthStore, CloudPlatform } from '../../store/cloudAuthStore';
import { createRenderService } from '../../services/render.service';
import { createVercelService } from '../../services/vercel.service';
import {
  CloudProvider, Project, EnvVar, LogEntry, Deployment, PROJECT_STATUS_COLORS,
} from '../../services/cloud.types';
import { GlassSurface } from '../components/GlassSurface';
import { useCloudPrefsStore } from '../store/cloudPrefsStore';
import { useS2Theme } from '../theme/tokens';
import { IconDot, IconChevronRight, IconBack, IconClose, IconPlus, IconTrash, IconCloud } from '../icons';

interface CloudScreenProps {
  toast: (msg: string) => void;
  onOpenClassicCloud: () => void;
}

interface Row { platform: CloudPlatform; project: Project }

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

export function CloudScreen({ toast, onOpenClassicCloud }: CloudScreenProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const tokens = useCloudAuthStore((s) => s.tokens);
  const favorites = useCloudPrefsStore((s) => s.favorites);
  const folders = useCloudPrefsStore((s) => s.folders);
  const [folderFor, setFolderFor] = useState<Row | null>(null);
  const [folderDraft, setFolderDraft] = useState('');

  const providers = useMemo(() => {
    const map: Partial<Record<CloudPlatform, CloudProvider>> = {};
    if (tokens.render) map.render = createRenderService(tokens.render);
    if (tokens.vercel) map.vercel = createVercelService(tokens.vercel);
    return map;
  }, [tokens.render, tokens.vercel]);
  const connected = Object.keys(providers) as CloudPlatform[];

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<Row | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all: Row[] = [];
      for (const platform of connected) {
        const provider = providers[platform]!;
        try {
          const owners = await provider.listOwners();
          // M4: first owner per platform (personal account) — team switcher later.
          const owner = owners[0];
          if (!owner) continue;
          const page = await provider.listProjects(owner.id);
          page.items.forEach((project) => all.push({ platform, project }));
        } catch {
          toast(`${platform === 'render' ? 'Render' : 'Vercel'}: Projekte konnten nicht geladen werden`);
        }
      }
      setRows(all);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, toast]);

  useEffect(() => { if (connected.length) load(); }, [load, connected.length]);

  // Sections: favorites first, then user folders (alphabetical), then the rest.
  const sections = useMemo(() => {
    const key = (r: Row) => `${r.platform}:${r.project.id}`;
    const byName = (a: Row, b: Row) => a.project.name.localeCompare(b.project.name);
    const favs = rows.filter((r) => favorites[key(r)]).sort(byName);
    const nonFav = rows.filter((r) => !favorites[key(r)]);
    const folderNames = [...new Set(nonFav.map((r) => folders[key(r)]).filter(Boolean))].sort() as string[];
    const result: { title: string | null; rows: Row[] }[] = [];
    if (favs.length) result.push({ title: '★ Favoriten', rows: favs });
    folderNames.forEach((name) => {
      result.push({ title: name, rows: nonFav.filter((r) => folders[key(r)] === name).sort(byName) });
    });
    const loose = nonFav.filter((r) => !folders[key(r)]).sort(byName);
    if (loose.length) result.push({ title: folderNames.length || favs.length ? 'Weitere' : null, rows: loose });
    return result;
  }, [rows, favorites, folders]);

  if (detail) {
    return (
      <ProjectDetail
        row={detail}
        provider={providers[detail.platform]!}
        onBack={() => setDetail(null)}
        toast={toast}
      />
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.headRow}>
        <Text style={[styles.pageTitle, { color: c.text, fontSize: m.font.title }]}>Cloud</Text>
        <Pressable
          onPress={load}
          accessibilityLabel="Neu laden"
          style={({ pressed }) => [styles.headBtn, { borderColor: c.glassBorder }, pressed && styles.pressed]}
        >
          <Text style={{ color: c.text, fontSize: m.font.caption, fontWeight: '700' }}>↻</Text>
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: m.dockHeight + 40 }}>
        {connected.length === 0 && (
          <Pressable onPress={onOpenClassicCloud}>
            <GlassSurface style={{ padding: 18 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <IconCloud size={m.icon.lg} color={c.accent} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.text, fontSize: m.font.section, fontWeight: '700' }}>Cloud verbinden</Text>
                  <Text style={{ color: c.textDim, fontSize: m.font.caption, marginTop: 3 }}>
                    Render/Vercel-Token in den klassischen Cloud-Einstellungen hinterlegen — hier antippen.
                  </Text>
                </View>
                <IconChevronRight size={m.icon.sm} color={c.textDim} />
              </View>
            </GlassSurface>
          </Pressable>
        )}

        {loading && <ActivityIndicator color={c.accent} style={{ marginVertical: 24 }} />}

        {sections.map((section, si) => (
          <View key={section.title ?? `s${si}`}>
            {section.title != null && (
              <Text style={{ color: c.textDim, fontSize: m.font.micro, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8, marginTop: si === 0 ? 0 : 8 }}>
                {section.title}
              </Text>
            )}
            {section.rows.map((row) => {
              const key = `${row.platform}:${row.project.id}`;
              const fav = !!favorites[key];
              return (
                <Pressable
                  key={key}
                  onPress={() => setDetail(row)}
                  onLongPress={() => { setFolderFor(row); setFolderDraft(folders[key] ?? ''); }}
                  delayLongPress={420}
                  style={({ pressed }) => [pressed && styles.pressed]}
                >
                  <GlassSurface style={{ marginBottom: 10, padding: 14 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <IconDot size={9} color={PROJECT_STATUS_COLORS[row.project.status] ?? c.textDim} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1} style={{ color: c.text, fontSize: m.font.body, fontWeight: '700' }}>
                          {row.project.name}
                        </Text>
                        <Text numberOfLines={1} style={{ color: c.textDim, fontSize: m.font.micro, marginTop: 2 }}>
                          {row.platform === 'render' ? 'Render' : 'Vercel'} · {row.project.status} · {row.project.type}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => useCloudPrefsStore.getState().toggleFavorite(key)}
                        hitSlop={8}
                        accessibilityLabel="Favorit umschalten"
                      >
                        <Text style={{ fontSize: 18, color: fav ? c.warn : c.textDim, opacity: fav ? 1 : 0.5 }}>★</Text>
                      </Pressable>
                      <IconChevronRight size={m.icon.sm} color={c.textDim} />
                    </View>
                  </GlassSurface>
                </Pressable>
              );
            })}
          </View>
        ))}

        {folderFor && (
          <GlassSurface strong style={{ padding: 14, marginBottom: 10 }}>
            <Text style={{ color: c.text, fontSize: m.font.label, fontWeight: '700', marginBottom: 8 }}>
              Ordner für {folderFor.project.name}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {[...new Set(Object.values(folders))].sort().map((name) => (
                <Pressable
                  key={name}
                  onPress={() => setFolderDraft(name)}
                  style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: folderDraft === name ? `rgba(${c.accentRgb},0.5)` : c.glassBorder }}
                >
                  <Text style={{ color: c.textDim, fontSize: m.font.micro, fontWeight: '700' }}>{name}</Text>
                </Pressable>
              ))}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <TextInput
                value={folderDraft}
                onChangeText={setFolderDraft}
                placeholder="Ordnername (leer = entfernen)"
                placeholderTextColor={c.textDim}
                style={{ flex: 1, color: c.text, fontSize: m.font.caption, borderBottomWidth: 1, borderColor: c.glassBorder, paddingVertical: 4 }}
              />
              <Pressable
                onPress={() => {
                  const key = `${folderFor.platform}:${folderFor.project.id}`;
                  useCloudPrefsStore.getState().setFolder(key, folderDraft || null);
                  setFolderFor(null);
                  toast(folderDraft.trim() ? `In „${folderDraft.trim()}" verschoben` : 'Aus Ordner entfernt');
                }}
                hitSlop={6}
              >
                <Text style={{ color: c.ok, fontSize: m.font.caption, fontWeight: '800' }}>OK</Text>
              </Pressable>
              <Pressable onPress={() => setFolderFor(null)} hitSlop={6}>
                <IconClose size={m.icon.sm} color={c.textDim} />
              </Pressable>
            </View>
          </GlassSurface>
        )}

        {connected.length > 0 && !loading && rows.length === 0 && (
          <Text style={{ color: c.textDim, fontSize: m.font.caption, textAlign: 'center', paddingVertical: 20 }}>
            Keine Projekte gefunden.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

// ── Project detail: Env / Logs / Deploys ──

type DetailTab = 'env' | 'logs' | 'deploys';

function ProjectDetail({ row, provider, onBack, toast }: {
  row: Row; provider: CloudProvider; onBack: () => void; toast: (msg: string) => void;
}) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const [tab, setTab] = useState<DetailTab>('env');
  const [envs, setEnvs] = useState<EnvVar[] | null>(null);
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [deploys, setDeploys] = useState<Deployment[] | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<EnvVar | null>(null);
  const [editValue, setEditValue] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [busy, setBusy] = useState(false);

  const loadTab = useCallback(async (t: DetailTab) => {
    setBusy(true);
    try {
      if (t === 'env') setEnvs(await provider.listEnvVars(row.project.id));
      else if (t === 'logs') setLogs(await provider.getServiceLogs(row.project.id));
      else setDeploys((await provider.listDeployments(row.project.id)).items);
    } catch {
      toast('Laden fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }, [provider, row.project.id, toast]);

  useEffect(() => { loadTab(tab); }, [tab, loadTab]);

  const copy = useCallback(async (text: string, label: string) => {
    await Clipboard.setStringAsync(text);
    toast(`${label} kopiert ✓`);
  }, [toast]);

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await provider.updateEnvVar(row.project.id, editing.id, { key: editing.key, value: editValue, scope: editing.scope });
      toast('Gespeichert — Redeploy nötig');
      setEditing(null);
      setEnvs(await provider.listEnvVars(row.project.id));
    } catch {
      toast('Speichern fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }, [editing, editValue, provider, row.project.id, toast]);

  const addEnv = useCallback(async () => {
    const key = newKey.trim();
    if (!key || !newValue) return;
    setBusy(true);
    try {
      await provider.createEnvVar(row.project.id, { key, value: newValue, scope: [] });
      toast('Env-Variable angelegt');
      setNewKey(''); setNewValue('');
      setEnvs(await provider.listEnvVars(row.project.id));
    } catch {
      toast('Anlegen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }, [newKey, newValue, provider, row.project.id, toast]);

  const deleteEnv = useCallback(async (env: EnvVar) => {
    setBusy(true);
    try {
      await provider.deleteEnvVar(row.project.id, env.id);
      toast(`${env.key} gelöscht`);
      setEnvs(await provider.listEnvVars(row.project.id));
    } catch {
      toast('Löschen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }, [provider, row.project.id, toast]);

  const triggerDeploy = useCallback(async () => {
    setBusy(true);
    try {
      await provider.triggerDeploy(row.project.id);
      toast('Deploy ausgelöst 🚀');
      setDeploys((await provider.listDeployments(row.project.id)).items);
    } catch {
      toast('Deploy fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }, [provider, row.project.id, toast]);

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.headRow}>
        <Pressable onPress={onBack} accessibilityLabel="Zurück" style={({ pressed }) => [styles.headBtn, { borderColor: c.glassBorder }, pressed && styles.pressed]}>
          <IconBack size={m.icon.md} color={c.text} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ color: c.text, fontSize: m.font.section, fontWeight: '800' }}>
            {row.project.name}
          </Text>
          <Text style={{ color: c.textDim, fontSize: m.font.micro }}>
            {row.platform === 'render' ? 'Render' : 'Vercel'} · {row.project.status}
          </Text>
        </View>
        {busy && <ActivityIndicator color={c.accent} />}
      </View>

      <View style={styles.tabs}>
        {(['env', 'logs', 'deploys'] as DetailTab[]).map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            style={[styles.tabBtn, { borderColor: c.glassBorder }, tab === t && { backgroundColor: `rgba(${c.accentRgb},0.16)` }]}
          >
            <Text style={{ color: tab === t ? c.text : c.textDim, fontSize: m.font.caption, fontWeight: '700' }}>
              {t === 'env' ? 'Env' : t === 'logs' ? 'Logs' : 'Deploys'}
            </Text>
          </Pressable>
        ))}
        {tab === 'logs' && logs && logs.length > 0 && (
          <Pressable
            onPress={() => copy(logs.map((l) => `${l.timestamp} [${l.level}] ${l.message}`).join('\n'), 'Log')}
            style={[styles.tabBtn, { borderColor: c.glassBorder, marginLeft: 'auto' }]}
          >
            <Text style={{ color: c.accent, fontSize: m.font.caption, fontWeight: '700' }}>Alles kopieren</Text>
          </Pressable>
        )}
        {tab === 'deploys' && (
          <Pressable onPress={triggerDeploy} style={[styles.tabBtn, { borderColor: c.glassBorder, marginLeft: 'auto', backgroundColor: `rgba(${c.accentRgb},0.14)` }]}>
            <Text style={{ color: c.accent, fontSize: m.font.caption, fontWeight: '700' }}>Deploy ⚡</Text>
          </Pressable>
        )}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: m.dockHeight + 40 }} keyboardShouldPersistTaps="handled">
        {tab === 'env' && (
          <GlassSurface style={{ padding: 6 }}>
            {envs?.map((env) => (
              <View key={env.id} style={[styles.envRow, { borderTopColor: `rgba(${c.overlayRgb},0.08)` }]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ color: c.text, fontSize: m.font.caption, fontWeight: '700', fontFamily: MONO }}>
                    {env.key}
                  </Text>
                  {editing?.id === env.id ? (
                    <TextInput
                      value={editValue}
                      onChangeText={setEditValue}
                      onSubmitEditing={saveEdit}
                      autoFocus
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{ color: c.text, fontSize: m.font.caption, fontFamily: MONO, borderBottomWidth: 1, borderColor: c.glassBorder, paddingVertical: 2 }}
                    />
                  ) : (
                    <Pressable onPress={() => setRevealed((r) => ({ ...r, [env.id]: !r[env.id] }))}>
                      <Text numberOfLines={1} style={{ color: c.textDim, fontSize: m.font.caption, fontFamily: MONO, marginTop: 2 }}>
                        {revealed[env.id] ? env.value : '••••••••••••'}
                      </Text>
                    </Pressable>
                  )}
                </View>
                {editing?.id === env.id ? (
                  <>
                    <Pressable onPress={saveEdit} hitSlop={6}><Text style={{ color: c.ok, fontWeight: '800', fontSize: m.font.caption }}>Speichern</Text></Pressable>
                    <Pressable onPress={() => setEditing(null)} hitSlop={6}><IconClose size={m.icon.sm} color={c.textDim} /></Pressable>
                  </>
                ) : (
                  <>
                    <Pressable onPress={() => copy(env.value, env.key)} hitSlop={6}>
                      <Text style={{ color: c.accent, fontWeight: '700', fontSize: m.font.micro }}>Kopieren</Text>
                    </Pressable>
                    <Pressable onPress={() => { setEditing(env); setEditValue(env.value); }} hitSlop={6}>
                      <Text style={{ color: c.textDim, fontWeight: '700', fontSize: m.font.micro }}>Bearbeiten</Text>
                    </Pressable>
                    <Pressable onPress={() => deleteEnv(env)} hitSlop={6}>
                      <IconTrash size={m.icon.sm} color={c.textDim} />
                    </Pressable>
                  </>
                )}
              </View>
            ))}
            <View style={[styles.envRow, { borderTopColor: `rgba(${c.overlayRgb},0.08)` }]}>
              <TextInput
                value={newKey}
                onChangeText={setNewKey}
                placeholder="NEUER_KEY"
                placeholderTextColor={c.textDim}
                autoCapitalize="characters"
                autoCorrect={false}
                style={{ flex: 1, color: c.text, fontSize: m.font.caption, fontFamily: MONO }}
              />
              <TextInput
                value={newValue}
                onChangeText={setNewValue}
                placeholder="Wert"
                placeholderTextColor={c.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                style={{ flex: 1, color: c.text, fontSize: m.font.caption, fontFamily: MONO }}
              />
              <Pressable onPress={addEnv} hitSlop={6} accessibilityLabel="Env anlegen">
                <IconPlus size={m.icon.sm} color={c.accent} />
              </Pressable>
            </View>
            {envs && envs.length === 0 && (
              <Text style={{ color: c.textDim, fontSize: m.font.caption, textAlign: 'center', paddingVertical: 16 }}>
                Keine Env-Variablen.
              </Text>
            )}
          </GlassSurface>
        )}

        {tab === 'logs' && (
          <GlassSurface style={{ padding: 12 }}>
            {logs?.map((l, i) => (
              <Text key={i} selectable style={{ color: l.level === 'error' ? c.err : l.level === 'warn' ? c.warn : c.textDim, fontSize: m.font.micro, fontFamily: MONO, lineHeight: 16 }}>
                {l.timestamp} <Text style={{ color: c.text }}>{l.message}</Text>
              </Text>
            ))}
            {logs && logs.length === 0 && (
              <Text style={{ color: c.textDim, fontSize: m.font.caption, textAlign: 'center', paddingVertical: 16 }}>
                Keine Logs verfügbar.
              </Text>
            )}
          </GlassSurface>
        )}

        {tab === 'deploys' && (
          <GlassSurface style={{ padding: 6 }}>
            {deploys?.map((d) => (
              <View key={d.id} style={[styles.envRow, { borderTopColor: `rgba(${c.overlayRgb},0.08)` }]}>
                <IconDot size={8} color={d.status === 'ready' ? c.ok : d.status === 'error' ? c.err : c.warn} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ color: c.text, fontSize: m.font.caption, fontWeight: '600' }}>
                    {d.commitMessage || d.id}
                  </Text>
                  <Text style={{ color: c.textDim, fontSize: m.font.micro, marginTop: 1 }}>
                    {d.status} · {new Date(d.createdAt).toLocaleString('de-DE')}
                  </Text>
                </View>
              </View>
            ))}
            {deploys && deploys.length === 0 && (
              <Text style={{ color: c.textDim, fontSize: m.font.caption, textAlign: 'center', paddingVertical: 16 }}>
                Keine Deployments.
              </Text>
            )}
          </GlassSurface>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  pageTitle: { fontWeight: '700', letterSpacing: -0.26 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  headBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 12 },
  tabs: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  tabBtn: { paddingHorizontal: 14, height: 34, borderRadius: 999, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2 },
  envRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
});
