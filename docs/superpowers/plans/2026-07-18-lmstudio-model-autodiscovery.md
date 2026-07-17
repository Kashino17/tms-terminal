# LM Studio Modell-Auto-Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alle in LM Studio installierten LLMs werden im Manager-Chat automatisch erkannt, als auswählbare Modelle angezeigt und mit einem pro Modell einstellbaren Context-Window geladen.

**Architecture:** Der Server ersetzt die drei hartkodierten LM-Studio-Provider durch dynamisch aus `GET /api/v0/models` erzeugte Provider (Ansatz B: jedes Modell = ein Provider `lmstudio:<key>`). Die App behandelt lokale Modelle bereits als Provider-Zeilen mit Context-Regler — die Discovery lebt komplett server-seitig, die App-Änderung ist minimal (ein neues Feld `savedContext`).

**Tech Stack:** Node.js + TypeScript (Server), Node's `node:test`-Runner + `ts-node`, React Native / Zustand-Store + Season-2-WebView-Mockup (App), Playwright (Smoke).

## Global Constraints

- Server-Code liegt im Worktree `~/Desktop/tms-terminal` auf Branch `feat/manager-chat-redesign`. Dort committen.
- Mockup-Quelle liegt im Worktree `/Users/ayysir/Desktop/TMS Terminal` auf `master` (`mockups/season2/liquid-deck/index.html`); der Build (`npm run build:season2`) liest sie hartkodiert von dort und erzeugt `mobile/src/season2/web/liquidDeckHtml.ts`.
- Reine Additivität: Fällt LM Studio aus, bleibt der Cloud-Inferenzpfad (GLM/Kimi) unberührt.
- UI-Strings Deutsch, Code-Kommentare/Bezeichner Englisch.
- Tests: `node:test` + `node:assert/strict`, Dateien `*.test.ts` neben dem Modul. Einzeln laufen lassen mit `node --require ts-node/register --test <pfad>` aus `server/`.
- Chat-fähige Modelle = alle **außer** `type === 'embeddings'` (Blocklist, damit unbekannte/künftige LLM-Typen automatisch erscheinen).
- Context-Default pro Modell: gemerkter Wert, sonst `min(16384, maxContext)`, geklemmt auf `[4096, maxContext]`.

---

### Task 1: LM-Studio-Discovery anreichern (`lmstudio.manager.ts`)

Erweitert die Modell-Info um `displayName` und `type`, zieht das JSON-Parsen in eine reine, testbare Funktion. **Kein** Filtern hier — die Info bleibt vollständige Quelle; die Registry (Task 2) filtert.

**Files:**
- Modify: `server/src/manager/lmstudio.manager.ts` (Interface `LmModelInfo` Z. 24–33, `getModelsInfo` Z. 41–61)
- Test: `server/src/manager/lmstudio.manager.test.ts` (neu)

**Interfaces:**
- Produces:
  - `interface LmModelInfo { key: string; displayName: string; type: string; maxContext: number; loadedContext: number | null; state: string }`
  - `function deriveDisplayName(key: string): string`
  - `function parseModelsResponse(json: unknown): Map<string, LmModelInfo>`
  - `function getModelsInfo(v1Url: string): Promise<Map<string, LmModelInfo>>` (unverändert Signatur)

- [ ] **Step 1: Failing test schreiben**

Create `server/src/manager/lmstudio.manager.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveDisplayName, parseModelsResponse } from './lmstudio.manager';

test('deriveDisplayName: strips vendor prefix and prettifies', () => {
  assert.equal(deriveDisplayName('qwen/qwen3.6-27b'), 'Qwen3.6 27b');
  assert.equal(deriveDisplayName('google/gemma-4-31b'), 'Gemma 4 31b');
  assert.equal(deriveDisplayName('llama-3'), 'Llama 3');
});

test('parseModelsResponse: keeps all types incl. embeddings, fills fields', () => {
  const json = { data: [
    { id: 'qwen/qwen3.6-27b', type: 'llm', max_context_length: 8192, loaded_context_length: 4096, state: 'loaded' },
    { id: 'nomic/embed', type: 'embeddings', max_context_length: 512, state: 'not-loaded' },
  ] };
  const m = parseModelsResponse(json);
  assert.equal(m.size, 2);
  const llm = m.get('qwen/qwen3.6-27b')!;
  assert.equal(llm.type, 'llm');
  assert.equal(llm.displayName, 'Qwen3.6 27b');
  assert.equal(llm.maxContext, 8192);
  assert.equal(llm.loadedContext, 4096);
  assert.equal(llm.state, 'loaded');
  const emb = m.get('nomic/embed')!;
  assert.equal(emb.type, 'embeddings');
  assert.equal(emb.loadedContext, null);
});
```

- [ ] **Step 2: Test läuft (rot)**

Run: `cd server && node --require ts-node/register --test src/manager/lmstudio.manager.test.ts`
Expected: FAIL — `deriveDisplayName`/`parseModelsResponse` sind nicht exportiert.

- [ ] **Step 3: Implementieren**

Ersetze das `LmModelInfo`-Interface (Z. 24–33) durch:

```ts
export interface LmModelInfo {
  /** Der Modell-Schlüssel wie in LM Studio, z. B. "qwen/qwen3.6-27b". */
  key: string;
  /** Lesbar aufbereiteter Anzeigename (Vendor-Präfix gestrippt). */
  displayName: string;
  /** Modelltyp aus LM Studio: 'llm' | 'vlm' | 'embeddings' | … */
  type: string;
  /** Trainiertes Context-Maximum (Obergrenze des Reglers). */
  maxContext: number;
  /** Aktuell geladene Context-Länge, falls das Modell geladen ist. */
  loadedContext: number | null;
  /** 'loaded' | 'not-loaded' | … wie von LM Studio gemeldet. */
  state: string;
}

/** Aus dem Modell-Schlüssel einen lesbaren Namen ableiten: Vendor-Präfix weg,
 *  Trenner zu Leerzeichen, Wortanfänge groß. Kosmetisch — Eindeutigkeit liefert der key. */
export function deriveDisplayName(key: string): string {
  const afterVendor = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key;
  const spaced = afterVendor.replace(/[-_]+/g, ' ').trim();
  return spaced.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

/** Reine Umwandlung der /api/v0/models-Antwort in die Info-Map. Kein Filtern. */
export function parseModelsResponse(json: unknown): Map<string, LmModelInfo> {
  const out = new Map<string, LmModelInfo>();
  const data = (json as { data?: Array<Record<string, any>> })?.data ?? [];
  for (const m of data) {
    const key = String(m.id ?? '');
    if (!key) continue;
    out.set(key, {
      key,
      displayName: deriveDisplayName(key),
      type: String(m.type ?? 'llm'),
      maxContext: Number(m.max_context_length) || 0,
      loadedContext: m.loaded_context_length != null ? Number(m.loaded_context_length) : null,
      state: String(m.state ?? 'not-loaded'),
    });
  }
  return out;
}
```

Ersetze den Body von `getModelsInfo` (Z. 41–61) so, dass er `parseModelsResponse` nutzt:

```ts
/** Alle in LM Studio bekannten Modelle mit Context-Maximum, Typ + Ladezustand. */
export async function getModelsInfo(v1Url: string): Promise<Map<string, LmModelInfo>> {
  try {
    const res = await fetch(`${nativeApiBase(v1Url)}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return new Map();
    return parseModelsResponse(await res.json());
  } catch (err) {
    logger.warn(`LM Studio: Modell-Info nicht lesbar (${err instanceof Error ? err.message : String(err)})`);
    return new Map();
  }
}
```

- [ ] **Step 4: Test läuft (grün)**

Run: `cd server && node --require ts-node/register --test src/manager/lmstudio.manager.test.ts`
Expected: PASS (2 Tests).

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/lmstudio.manager.ts server/src/manager/lmstudio.manager.test.ts
git commit -m "feat(manager): LM-Studio-Discovery liefert displayName + type (parseModelsResponse)"
```

---

### Task 2: Registry erzeugt lokale Provider dynamisch (`ai-provider.ts`)

Entfernt die drei festen LM-Studio-Provider, ergänzt Discovery-basierte Provider, Fallback und Context-Gedächtnis.

**Files:**
- Modify: `server/src/manager/ai-provider.ts` (ProviderConfig Z. 30–36; `LMStudioProvider` Z. 563–576; Registry Z. 880–978)
- Test: `server/src/manager/ai-provider.test.ts` (neu)

**Interfaces:**
- Consumes (aus Task 1): `LmModelInfo`, `deriveDisplayName`.
- Produces:
  - `ProviderConfig.lmStudioModelContext?: Record<string, number>`
  - `LMStudioProvider` mit Konstruktor `(id, name, modelId, getBaseUrl, modelType?)` und `getModelType(): string`
  - `registry.refreshLocalProviders(info: Map<string, LmModelInfo>): void`
  - `registry.getSavedContext(key: string): number | undefined`
  - `registry.rememberContext(key: string, contextLength: number): void`
  - `registry.getModelContextMap(): Record<string, number>`
  - `function defaultContextFor(maxContext: number): number` (exportiert)
  - `registry.getLocalModelKey('lmstudio:<key>') → '<key>'`

- [ ] **Step 1: Failing test schreiben**

Create `server/src/manager/ai-provider.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiProviderRegistry, defaultContextFor } from './ai-provider';
import type { LmModelInfo } from './lmstudio.manager';

function info(entries: Array<Partial<LmModelInfo> & { key: string; type: string }>): Map<string, LmModelInfo> {
  const m = new Map<string, LmModelInfo>();
  for (const e of entries) {
    m.set(e.key, {
      key: e.key, displayName: e.displayName ?? e.key, type: e.type,
      maxContext: e.maxContext ?? 8192, loadedContext: e.loadedContext ?? null, state: e.state ?? 'not-loaded',
    });
  }
  return m;
}

test('refreshLocalProviders: creates chat models, skips embeddings, keeps cloud', () => {
  const reg = new AiProviderRegistry({ glmApiKey: 'k' });
  reg.refreshLocalProviders(info([
    { key: 'qwen/q27b', type: 'llm', displayName: 'Qwen 27B' },
    { key: 'meta/vision', type: 'vlm' },
    { key: 'nomic/embed', type: 'embeddings' },
  ]));
  const ids = reg.list().map(p => p.id);
  assert.ok(ids.includes('lmstudio:qwen/q27b'));
  assert.ok(ids.includes('lmstudio:meta/vision'));
  assert.ok(!ids.includes('lmstudio:nomic/embed'));
  assert.ok(ids.includes('glm')); // cloud unberührt
  assert.equal(reg.list().find(p => p.id === 'lmstudio:qwen/q27b')!.name, 'Qwen 27B');
});

test('refreshLocalProviders: removes stale local providers when uninstalled', () => {
  const reg = new AiProviderRegistry({ glmApiKey: 'k' });
  reg.refreshLocalProviders(info([{ key: 'qwen/q27b', type: 'llm' }]));
  assert.ok(reg.list().some(p => p.id === 'lmstudio:qwen/q27b'));
  reg.refreshLocalProviders(new Map());
  assert.ok(!reg.list().some(p => p.isLocal));
  assert.ok(reg.list().some(p => p.id === 'glm'));
});

test('getLocalModelKey resolves lmstudio: prefix', () => {
  const reg = new AiProviderRegistry({ glmApiKey: 'k' });
  reg.refreshLocalProviders(info([{ key: 'qwen/q27b', type: 'llm' }]));
  assert.equal(reg.getLocalModelKey('lmstudio:qwen/q27b'), 'qwen/q27b');
  assert.equal(reg.getLocalModelKey('glm'), null);
});

test('getActive falls back to configured cloud when active local model gone', () => {
  const reg = new AiProviderRegistry({ glmApiKey: 'k' });
  reg.refreshLocalProviders(info([{ key: 'qwen/q27b', type: 'llm' }]));
  reg.setActive('lmstudio:qwen/q27b');
  reg.refreshLocalProviders(new Map()); // Modell verschwindet
  assert.equal(reg.getActive().id, 'glm');
});

test('rememberContext + getSavedContext round-trip', () => {
  const reg = new AiProviderRegistry({ glmApiKey: 'k' });
  reg.rememberContext('qwen/q27b', 20000);
  assert.equal(reg.getSavedContext('qwen/q27b'), 20000);
  assert.equal(reg.getModelContextMap()['qwen/q27b'], 20000);
});

test('defaultContextFor: moderate default, clamps to model range', () => {
  assert.equal(defaultContextFor(128000), 16384);
  assert.equal(defaultContextFor(8192), 8192);
  assert.equal(defaultContextFor(2048), 4096); // floor
  assert.equal(defaultContextFor(0), 16384);   // unknown max
});
```

- [ ] **Step 2: Test läuft (rot)**

Run: `cd server && node --require ts-node/register --test src/manager/ai-provider.test.ts`
Expected: FAIL — `refreshLocalProviders`/`defaultContextFor` etc. existieren nicht.

- [ ] **Step 3: Implementieren — ProviderConfig-Feld**

In `ProviderConfig` (Z. 30–36) ergänze eine Zeile vor der schließenden Klammer:

```ts
export interface ProviderConfig {
  kimiApiKey?: string;
  glmApiKey?: string;
  openaiApiKey?: string;
  activeProvider?: string;
  lmStudioUrl?: string;
  /** Zuletzt gewählte Context-Länge je LM-Studio-Modell-Key (Regler-Gedächtnis). */
  lmStudioModelContext?: Record<string, number>;
}
```

- [ ] **Step 4: Implementieren — LMStudioProvider-Felder**

Ersetze Konstruktor + Felder von `LMStudioProvider` (Z. 563–579) durch:

```ts
class LMStudioProvider implements AiProvider {
  id: string;
  name: string;
  isLocal = true;
  private modelId: string;
  private modelType: string;
  private getBaseUrl: () => string;
  private available: boolean | null = null;

  constructor(id: string, name: string, modelId: string, getBaseUrl: () => string, modelType = 'llm') {
    this.id = id;
    this.name = name;
    this.modelId = modelId;
    this.modelType = modelType;
    this.getBaseUrl = getBaseUrl;
  }

  /** Modelltyp aus LM Studio (für die Provider-Liste). */
  getModelType(): string { return this.modelType; }

  /** Der LM-Studio-Modellschlüssel (z. B. "qwen/qwen3.6-27b") — für Laden & Info. */
  getModelKey(): string { return this.modelId; }
```

(Der Rest der Klasse — `getUrl`, `isConfigured`, `chat`, `chatStream`, `chatStreamWithTools` — bleibt unverändert.)

- [ ] **Step 5: Implementieren — Registry: feste Provider raus, Discovery + Fallback + Context**

Ersetze den Konstruktor (Z. 885–914) so, dass nur Cloud fix registriert wird:

```ts
  constructor(config: ProviderConfig) {
    this.config = config;

    const kimi = new KimiProvider(() => this.config.kimiApiKey);
    const glm = new GlmProvider(() => this.config.glmApiKey);
    this.providers.set(kimi.id, kimi);
    this.providers.set(glm.id, glm);

    // Lokale LM-Studio-Modelle werden NICHT mehr hartkodiert — sie kommen per
    // refreshLocalProviders() aus der Discovery. Bis dahin: nur Cloud-Provider.
    this.activeId = config.activeProvider && this.providers.has(config.activeProvider)
      ? config.activeProvider
      : 'glm';
    logger.info(`Manager AI: ${this.providers.size} cloud providers registered, active: ${this.activeId}`);
  }

  /** URL-Getter für dynamisch erzeugte LM-Studio-Provider. */
  private lmStudioUrlGetter = () => this.config.lmStudioUrl ?? LMSTUDIO_DEFAULT_URL;

  /**
   * Lokale Provider aus der LM-Studio-Discovery synchronisieren: für jedes
   * chat-fähige Modell (alles außer 'embeddings') einen Provider `lmstudio:<key>`
   * anlegen/aktualisieren, verschwundene Modelle entfernen. Cloud-Provider bleiben.
   */
  refreshLocalProviders(info: Map<string, LmModelInfo>): void {
    const wanted = new Set<string>();
    for (const mi of info.values()) {
      if (mi.type === 'embeddings') continue; // kein Chat möglich
      const id = `lmstudio:${mi.key}`;
      wanted.add(id);
      const existing = this.providers.get(id);
      if (existing && existing instanceof LMStudioProvider) {
        existing.name = mi.displayName || mi.key; // Name aktualisieren
      } else {
        this.providers.set(id, new LMStudioProvider(id, mi.displayName || mi.key, mi.key, this.lmStudioUrlGetter, mi.type));
      }
    }
    // Verschwundene lokale Provider entfernen.
    for (const [id, p] of [...this.providers.entries()]) {
      if (p.isLocal && !wanted.has(id)) this.providers.delete(id);
    }
  }

  /** Gemerkte Context-Länge eines Modell-Keys, falls vorhanden. */
  getSavedContext(key: string): number | undefined {
    return this.config.lmStudioModelContext?.[key];
  }

  /** Context-Länge eines Modell-Keys merken (In-Memory; Persistenz macht der Aufrufer). */
  rememberContext(key: string, contextLength: number): void {
    this.config.lmStudioModelContext = { ...(this.config.lmStudioModelContext ?? {}), [key]: contextLength };
  }

  /** Die komplette Context-Gedächtnis-Map (für saveManagerConfig). */
  getModelContextMap(): Record<string, number> {
    return { ...(this.config.lmStudioModelContext ?? {}) };
  }
```

Ersetze `getActive()` (Z. 916–918) durch die Fallback-Variante:

```ts
  getActive(): AiProvider {
    const p = this.providers.get(this.activeId);
    if (p) return p;
    // Aktives lokales Modell nicht verfügbar (LM Studio offline / deinstalliert)
    // → auf den ersten konfigurierten Cloud-Provider ausweichen, statt zu crashen.
    const cloud = [...this.providers.values()].find(x => !x.isLocal && x.isConfigured());
    if (cloud) return cloud;
    return this.providers.get('glm')!; // letzte Instanz; meldet ggf. "nicht eingerichtet"
  }
```

Ersetze `list()` (Z. 940–947), damit lokale Provider ihren Typ mitliefern:

```ts
  list(): Array<{ id: string; name: string; configured: boolean; isLocal?: boolean; modelType?: string }> {
    return [...this.providers.values()].map(p => ({
      id: p.id,
      name: p.name,
      configured: p.isConfigured(),
      isLocal: p.isLocal,
      modelType: p instanceof LMStudioProvider ? p.getModelType() : undefined,
    }));
  }
```

Am Dateianfang den Import ergänzen (nach der bestehenden `logger`-Zeile Z. 1):

```ts
import type { LmModelInfo } from './lmstudio.manager';
```

Und die exportierte Hilfsfunktion `defaultContextFor` unten im File (vor der schließenden Klasse oder danach als freie Funktion) hinzufügen — z. B. direkt nach `LMSTUDIO_DEFAULT_URL` (Z. 561):

```ts
/** Moderater Context-Default für ein Modell: min(16384, max), geklemmt auf [4096, max]. */
export function defaultContextFor(maxContext: number): number {
  const cap = maxContext && maxContext > 0 ? maxContext : 32768;
  return Math.max(4096, Math.min(16384, cap));
}
```

(`getLocalModelKey` Z. 954–959 funktioniert unverändert: es prüft `p instanceof LMStudioProvider` und gibt `getModelKey()` — für dynamische Provider ist das der reine `<key>`.)

- [ ] **Step 6: Test läuft (grün)**

Run: `cd server && node --require ts-node/register --test src/manager/ai-provider.test.ts`
Expected: PASS (6 Tests).

- [ ] **Step 7: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: Keine Fehler (insb. keine „Cannot find name gemma/qwen27b/qwen35b" — alle Referenzen entfernt).

- [ ] **Step 8: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/ai-provider.ts server/src/manager/ai-provider.test.ts
git commit -m "feat(manager): Registry erzeugt LM-Studio-Provider dynamisch aus Discovery + Fallback/Context-Gedächtnis"
```

---

### Task 3: getProviders/setProvider verdrahten + Context persistieren (`manager.service.ts`)

`getProviders()` löst die Discovery aus und reichert jeden lokalen Provider mit `savedContext` an; `setProvider()` merkt die geladene Context-Länge und schreibt sie auf Platte.

**Files:**
- Modify: `server/src/manager/manager.service.ts` (`getProviders` Z. 4093–4113, `setProvider` Z. 4118–4124, Import Z. 2)

**Interfaces:**
- Consumes: `registry.refreshLocalProviders`, `registry.getSavedContext`, `registry.rememberContext`, `registry.getModelContextMap`, `defaultContextFor` (Task 2); `getModelsInfo` (Task 1); `saveManagerConfig` (bestehend).
- Produces: `getProviders()`-Payload pro lokalem Provider zusätzlich `savedContext: number` und `modelType?: string`.

- [ ] **Step 1: Import ergänzen**

In `manager.service.ts` Z. 2 den Import erweitern:

```ts
import { getModelsInfo, loadLocalModel } from './lmstudio.manager';
```
→
```ts
import { getModelsInfo, loadLocalModel, type LmModelInfo } from './lmstudio.manager';
import { defaultContextFor } from './ai-provider';
import { saveManagerConfig } from './manager.config';
```

(Falls `ProviderConfig`/andere Namen aus `./ai-provider` schon importiert werden, `defaultContextFor` an den bestehenden Import anhängen statt neue Zeile.)

- [ ] **Step 2: `getProviders()` ersetzen (Z. 4093–4113)**

```ts
  async getProviders() {
    let info = new Map<string, LmModelInfo>();
    try { info = await getModelsInfo(this.registry.getLmStudioUrl()); } catch { /* offline */ }
    // Lokale Provider aus der Discovery synchronisieren (anlegen/entfernen).
    this.registry.refreshLocalProviders(info);

    const providers = this.registry.list().map(p => {
      if (!p.isLocal) return p;
      const key = this.registry.getLocalModelKey(p.id);
      const mi = key ? info.get(key) : undefined;
      const maxContext = mi?.maxContext ?? 0;
      const saved = key ? this.registry.getSavedContext(key) : undefined;
      return {
        ...p,
        modelKey: key ?? undefined,
        maxContext,
        loadedContext: mi?.loadedContext ?? null,
        loaded: mi?.state === 'loaded',
        available: !!mi,
        savedContext: saved ?? defaultContextFor(maxContext),
      };
    });
    return { providers, active: this.registry.getActiveId() };
  }
```

- [ ] **Step 3: `setProvider()` ersetzen (Z. 4118–4124)**

```ts
  async setProvider(id: string, contextLength?: number): Promise<void> {
    const key = this.registry.getLocalModelKey(id);
    if (key) {
      await loadLocalModel(key, contextLength ?? 0);
      // Erst nach erfolgreichem Laden merken + persistieren (Regler-Gedächtnis).
      if (contextLength && contextLength > 0) {
        this.registry.rememberContext(key, contextLength);
        saveManagerConfig({ lmStudioModelContext: this.registry.getModelContextMap() });
      }
    }
    this.registry.setActive(id);
  }
```

- [ ] **Step 4: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: Keine Fehler.

- [ ] **Step 5: Reale Discovery-Verifikation (LM Studio läuft auf dem Mac)**

Prüfe, dass die native API alle installierten Modelle liefert (inkl. eventueller Embedding-Modelle):

Run: `curl -s http://localhost:1234/api/v0/models | python3 -c "import sys,json; [print(m['id'], m.get('type'), m.get('max_context_length')) for m in json.load(sys.stdin)['data']]"`
Expected: Liste aller installierten Modelle mit Typ + max_context.

Baue den Server und starte ihn neu (damit die Änderung aktiv ist):
Run: `cd server && rm -f .tsbuildinfo && npx tsc && echo BUILD_OK`
Expected: `BUILD_OK`, `dist/` neu erzeugt. (Bei MODULE_NOT_FOUND: `.tsbuildinfo` war stale — erneut ohne Cache bauen.)

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/manager/manager.service.ts
git commit -m "feat(manager): getProviders löst Discovery aus + savedContext; setProvider merkt Context-Länge"
```

---

### Task 4: App zeigt entdeckte Modelle mit gemerktem Context (`managerStore` + Mockup)

Die App reicht die Provider-Objekte unverändert durch; nur der Regler-Default nutzt jetzt `savedContext`. TypeScript-Interfaces bekommen das Feld.

**Files:**
- Modify: `mobile/src/store/managerStore.ts` (`ProviderInfo` Z. 30–41)
- Modify: `mobile/src/season2/manager/useManagerWire.ts` (`ProviderInfo` Z. 30–41)
- Modify (Mockup, master-Worktree): `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` (`openManagerModelSheet`, Default-Zeile ~5745)
- Test: `mobile/scripts/smoke-model-sheet.mjs` (neu, Playwright-Smoke)

**Interfaces:**
- Consumes: `getProviders()`-Payload mit `savedContext` (Task 3).
- Produces: `ProviderInfo.savedContext?: number`; Modell-Sheet-Regler startet auf `savedContext`.

- [ ] **Step 1: `ProviderInfo` in beiden Stores erweitern**

In **beiden** Dateien (`mobile/src/store/managerStore.ts` und `mobile/src/season2/manager/useManagerWire.ts`) im `ProviderInfo`-Interface nach `available?: boolean;` ergänzen:

```ts
  savedContext?: number;      // vom Server: gemerkte/empfohlene Context-Länge (Regler-Default)
  modelType?: string;         // 'llm' | 'vlm' | … (nur Info)
```

- [ ] **Step 2: Mockup — Regler-Default auf `savedContext`**

Im Mockup `mockups/season2/liquid-deck/index.html`, in `openManagerModelSheet`, ersetze die Default-Berechnung (aktuell ~Z. 5745–5746):

```js
        const def = modelSheetCtx[p.id] != null ? modelSheetCtx[p.id]
          : clampCtx(p.loadedContext || 8192, max);
```
durch:
```js
        const def = modelSheetCtx[p.id] != null ? modelSheetCtx[p.id]
          : clampCtx(p.savedContext || p.loadedContext || 8192, max);
```

- [ ] **Step 3: Season-2-HTML neu bauen**

Run: `cd mobile && npm run build:season2 && echo BUILD_OK`
Expected: `BUILD_OK`; `mobile/src/season2/web/liquidDeckHtml.ts` regeneriert (der `patch()`-Helper wirft, falls ein Anker fehlt — dann Mockup-Änderung prüfen).

- [ ] **Step 4: Playwright-Smoke schreiben**

Create `mobile/scripts/smoke-model-sheet.mjs`:

```js
// Smoke: gebautes Season-2-HTML lädt, Modell-Sheet öffnet, Regler startet auf savedContext.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

// liquidDeckHtml.ts exportiert das HTML als JSON-String: export const LIQUID_DECK_HTML = "...";
const ts = readFileSync(new URL('../src/season2/web/liquidDeckHtml.ts', import.meta.url), 'utf8');
const match = ts.match(/export const LIQUID_DECK_HTML = ("[\s\S]*")\s*;?\s*$/);
if (!match) { console.error('FAIL: LIQUID_DECK_HTML-Literal nicht gefunden'); process.exit(1); }
const page = JSON.parse(match[1]); // JSON.parse entschlüsselt alle Escapes korrekt

const browser = await chromium.launch();
const p = await browser.newPage();
await p.addInitScript(() => { window.ReactNativeWebView = { postMessage: () => {} }; });
await p.setContent(page, { waitUntil: 'domcontentloaded' });

await p.evaluate(() => {
  window.TMS_DATA.manager.providers = [
    { id: 'lmstudio:qwen/q27b', name: 'Qwen 27B', configured: true, isLocal: true,
      maxContext: 32768, loadedContext: null, loaded: false, available: true, savedContext: 12288 },
  ];
  window.TMS_DATA.manager.activeProvider = '';
  window.openManagerModelSheet();
  document.querySelector('.mgr-model-row[data-mgr="expand"]').click(); // aufklappen
});
const val = await p.$eval('.mgr-ctx-slider', el => el.value);
if (val !== '12288') { console.error('FAIL: slider default', val, 'expected 12288'); process.exit(1); }
console.log('OK: slider default =', val);
await browser.close();
```

- [ ] **Step 5: Smoke läuft (grün)**

Run: `cd mobile && node scripts/smoke-model-sheet.mjs`
Expected: `OK: slider default = 12288`. (Ist Playwright nicht installiert: `npx playwright install chromium` einmalig.)

- [ ] **Step 6: Commit**

```bash
# App-Store-Interfaces + gebautes HTML auf dem Feature-Branch
cd ~/Desktop/tms-terminal
git add mobile/src/store/managerStore.ts mobile/src/season2/manager/useManagerWire.ts mobile/src/season2/web/liquidDeckHtml.ts mobile/scripts/smoke-model-sheet.mjs
git commit -m "feat(manager): Modell-Sheet nutzt savedContext als Regler-Default; ProviderInfo.savedContext"

# Mockup-Quelle separat im master-Worktree committen
cd "/Users/ayysir/Desktop/TMS Terminal"
git add mockups/season2/liquid-deck/index.html
git commit -m "feat(season2): Modell-Sheet Regler-Default = savedContext"
```

---

### Task 5: End-to-End-Verifikation + Auslieferung

Reale Prüfung gegen die laufende LM-Studio-Instanz und Ausspielung.

**Files:** keine (nur Ausführung/Verifikation).

**Interfaces:** Consumes alles aus Tasks 1–4.

- [ ] **Step 1: Alle Server-Tests grün**

Run: `cd server && npm test`
Expected: Alle Tests PASS (inkl. der neuen lmstudio/ai-provider-Tests).

- [ ] **Step 2: Reale Discovery über den Server prüfen**

Server läuft (Task 3 Step 5 gebaut). In der App (oder via WS-Testclient) `manager:get_providers` auslösen und prüfen:
- Alle in `curl /api/v0/models` gelisteten **LLMs** erscheinen als Modelle.
- Ein Embedding-Modell erscheint **nicht** in der Liste.
- Jedes lokale Modell zeigt `maxContext > 0` und einen `savedContext`.

- [ ] **Step 3: Laden mit Context real prüfen**

Ein Modell mit z. B. 16384 auswählen → „Laden". Nach ~50–90 s:
Run: `curl -s http://localhost:1234/api/v0/models | python3 -c "import sys,json; [print(m['id'], m.get('state'), m.get('loaded_context_length')) for m in json.load(sys.stdin)['data'] if m.get('state')=='loaded']"`
Expected: Das gewählte Modell `state=loaded`, `loaded_context_length=16384`.

Run: `python3 -c "import json;print(json.load(open('$HOME/.tms-terminal/manager.json')).get('lmStudioModelContext'))"`
Expected: Map enthält `<modelKey>: 16384` (Gedächtnis persistiert).

- [ ] **Step 4: Regressionsschutz — LM Studio aus**

LM Studio stoppen, `manager:get_providers` erneut: Liste zeigt nur Cloud-Provider, kein Crash; ein Cloud-Modell chattet normal.

- [ ] **Step 5: Ausliefern**

- Server: `tms-terminal update` (bzw. der etablierte Server-Update-Weg) und Neustart — der Nutzer bestätigt.
- App: Season-2-Release nach dem üblichen Workflow (Version bump + CI-Build). Release-Notes: „Manager: alle installierten LM-Studio-Modelle werden automatisch erkannt; Context-Window pro Modell einstellbar und gemerkt."

---

## Self-Review (vom Autor durchgeführt)

**Spec-Abdeckung:**
- „Reine Discovery, feste Einträge weg" → Task 2 (Konstruktor entfernt gemma/qwen; `refreshLocalProviders`).
- „Alle verfügbaren LLMs, Embeddings raus" → Task 2 (`type === 'embeddings'`-Blocklist) + Task 1 (kein Filter, vollständige Info).
- „Context-Window pro Modell einstellbar + gemerkt, Default min(16384,max)" → Task 2 (`defaultContextFor`, `rememberContext`), Task 3 (`savedContext`, persist), Task 4 (Regler-Default).
- „Fallback bei offline/deinstalliert" → Task 2 (`getActive`-Fallback).
- „App-Änderung minimal" → Task 4 (ein Feld + eine Mockup-Zeile).
- „Verifikation real + Playwright" → Task 4 Step 5, Task 5.

**Platzhalter-Scan:** Keine TBD/TODO; alle Code-Schritte mit vollständigem Code.

**Typ-Konsistenz:** `LmModelInfo` (Task 1) wird in `refreshLocalProviders`/`getProviders` (Task 2/3) identisch verwendet; `savedContext`/`modelType` konsistent über Server-Payload → `ProviderInfo` (Task 4). `defaultContextFor` exportiert in Task 2, importiert in Task 3. `lmStudioModelContext` konsistent zwischen `ProviderConfig`, `rememberContext`, `getModelContextMap`, `saveManagerConfig`.
