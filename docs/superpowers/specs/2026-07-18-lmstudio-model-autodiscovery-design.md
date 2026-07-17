# LM Studio Modell-Auto-Discovery im Manager-Chat

**Datum:** 2026-07-18
**Branch:** feat/manager-chat-redesign
**Status:** Design — wartet auf Review

## Ziel

Im Manager-Agent-Chat sollen **alle in LM Studio installierten LLMs automatisch erkannt
und als auswählbare Modelle angezeigt** werden. Für jedes lokale Modell lässt sich vor
dem Laden das Context-Window einstellen; das Modell wird mit genau dieser Context-Länge
in LM Studio geladen.

Heute sind stattdessen **drei feste Modelle** hartkodiert (`gemma-4`, `qwen-3-27b`,
`qwen-3-35b`). Ein neu heruntergeladenes Modell taucht nie auf.

## Ist-Zustand (verifiziert im Code)

- `server/src/manager/ai-provider.ts` (Z. 891–903): drei `LMStudioProvider`-Instanzen
  mit fest verdrahteten Modell-Schlüsseln werden in der `AiProviderRegistry` registriert.
- `server/src/manager/lmstudio.manager.ts`:
  - `getModelsInfo(v1Url)` liest **bereits alle** Modelle über `GET /api/v0/models`
    (liefert `id`, `state`, `max_context_length`, `loaded_context_length` — und zusätzlich
    ungenutzt `type`, `quantization`, `publisher`).
  - `loadLocalModel(key, contextLength)` entlädt alles (`lms unload --all`) und lädt dann
    `lms load <key> --context-length N --gpu max -y`. Ein Wechsel dauert real ~50–90 s.
- `manager.service.ts › getProviders()` (Z. 4093): reichert **nur die drei festen** Provider
  mit der Modell-Info an. Alle anderen installierten Modelle werden verworfen.
- App/Mockup: jedes Modell ist bereits eine **eigene Provider-Zeile**; ein Tap auf ein
  lokales Modell öffnet ein Sheet mit Context-Regler (`openManagerModelSheet`), „Laden"
  schickt `managerSelectProvider(id, contextLength)`. `manager:model_loading` zeigt „lädt…".

## Design-Entscheidungen (mit Nutzer geklärt)

1. **Reine Discovery** — die drei hartkodierten LM-Studio-Einträge entfallen. Nur was
   LM Studio als installiert meldet, wird angezeigt. Cloud-Provider (GLM, Kimi) bleiben fix.
2. **Alle verfügbaren LLMs** — angezeigt werden alle chat-fähigen Modelle
   (`type === 'llm'` oder `type === 'vlm'`). Reine Embedding-Modelle (`type === 'embeddings'`)
   werden ausgefiltert, da sie nicht chatten können.
3. **Context-Default „zuletzt genutzt, sonst moderat"** — die App merkt sich pro Modell die
   zuletzt geladene Context-Länge. Beim ersten Laden Startwert `min(16384, maxContext)`.
   Der Regler reicht von 4096 bis zum trainierten Modell-Maximum.

## Architektur — Ansatz B: jedes entdeckte Modell ist ein eigener Provider

Die App behandelt lokale Modelle bereits als Provider-Zeilen mit
`maxContext/loadedContext/loaded/available`. Ansatz B erzeugt die lokalen Provider dynamisch
aus der Discovery und braucht daher **fast keine UI-Änderung** — der Datenfluss von
`getProviders()` → Provider-Liste → Modell-Sheet bleibt identisch.

### 1. Discovery-Erweiterung — `lmstudio.manager.ts`

`LmModelInfo` bekommt zusätzliche Felder:

```ts
export interface LmModelInfo {
  key: string;
  displayName: string;   // lesbar aufbereiteter Name (Vendor-Präfix gestrippt)
  type: string;          // 'llm' | 'vlm' | 'embeddings' | …
  quant?: string;        // z. B. "Q4_K_M" (nur Anzeige)
  maxContext: number;
  loadedContext: number | null;
  state: string;         // 'loaded' | 'not-loaded' | …
}
```

`getModelsInfo()` liest `type`, `quantization`, `publisher` mit und setzt `displayName`
(z. B. `qwen/qwen3.6-27b` → `Qwen3.6 27B`). **Kein** Filtern hier — die Registry filtert,
damit `getModelsInfo` eine vollständige Info-Quelle bleibt.

### 2. Registry dynamisch — `ai-provider.ts`

- Die drei festen `LMStudioProvider`-Instanzen und ihre `providers.set(...)`-Aufrufe entfallen.
  Cloud-Provider (Kimi, GLM) bleiben unverändert registriert.
- `LMStudioProvider` bekommt zusätzlich `displayName`, `modelType`, `quant` (für die Liste).
- Neue Methode `refreshLocalProviders(info: Map<string, LmModelInfo>)`:
  erzeugt/aktualisiert für jedes chat-fähige Modell (`type` in `{llm, vlm}`) einen
  `LMStudioProvider` mit stabiler ID `lmstudio:<modelKey>`; entfernt lokale Provider, deren
  Modell nicht mehr in der Info-Map ist. Der Cache liegt in `this.providers`, damit
  Chat-Routing und `setProvider` die Instanz wiederfinden.
- `getActive()` / `getActiveWithTools()`: findet die aktive ID nicht (LM Studio offline oder
  Modell deinstalliert) → **Fallback auf den ersten konfigurierten Cloud-Provider** (GLM,
  sonst Kimi) für die Inferenz. Kein Crash, keine leere Antwort. Ist keiner konfiguriert,
  bleibt die bestehende „kein Provider"-Meldung.
- `getLocalModelKey('lmstudio:<key>')` löst zur `<key>` auf.
- `list()` liefert die lokalen Provider inkl. `displayName/modelType/quant`.
- **Cache-Warmup:** Der lokale Provider-Cache wird durch `getProviders()` gefüllt, das die
  App bei `state==='connected'` aufruft — also vor jedem Chat. `setProvider` ruft die
  Discovery ebenfalls, sodass die aktive lokale Instanz garantiert existiert, bevor sie
  aktiv gesetzt wird (auch direkt nach Server-Neustart).

### 3. `getProviders()` — `manager.service.ts`

```
info = await getModelsInfo(url)          // alle installierten Modelle
this.registry.refreshLocalProviders(info) // dynamische Provider erzeugen/entfernen
base = this.registry.list()               // Cloud + entdeckte lokale
→ pro lokalem Provider: modelKey, maxContext, loadedContext, loaded, available,
  savedContext (gemerkter Wert), displayName, modelType, quant
```

Ist LM Studio offline (`info` leer): `refreshLocalProviders` entfernt alle lokalen Provider,
die Liste zeigt nur Cloud-Provider — wie heute bei Offline.

### 4. Context-Gedächtnis pro Modell

- `ProviderConfig` bekommt `lmStudioModelContext?: Record<string, number>` (Modell-Key → Länge).
  `manager.config.ts` persistiert es automatisch über den `{...existing, ...config}`-Merge;
  keine Verschlüsselung nötig (keine Secrets).
- `setProvider(id, contextLength)`: nach **erfolgreichem** `loadLocalModel` wird
  `contextLength` unter dem Modell-Key gespeichert.
- `getProviders()` liefert pro lokalem Provider `savedContext` = gemerkter Wert **oder**
  `min(16384, maxContext)` als Default.

### 5. App/Mockup — minimal

- `managerStore.ProviderInfo`: optionale Felder `displayName`, `modelType`, `quant`,
  `savedContext`.
- Modell-Sheet: Regler-Startwert = `savedContext` (statt fixer Default). Liste zeigt
  `displayName`; bei Bedarf kleine Info-Zeile mit `quant`.
- `managerSelectProvider(id, contextLength)` unverändert — `id` ist jetzt `lmstudio:<key>`.
- Keine Änderung am Lade-Status-Fluss (`manager:model_loading`).

### 6. Fehler & Offline

- LM Studio nicht erreichbar → lokale Liste leer, Cloud bleibt, keine Fehler-Sheets.
- `lms`-CLI fehlt → bestehende klare Meldung aus `loadLocalModel` („lms bootstrap ausführen").
- Aktives lokales Modell wurde deinstalliert → Fallback-GLM bei der Inferenz; die Liste
  zeigt das Modell nicht mehr, der Nutzer wählt ein anderes.

## Abgrenzung (YAGNI)

- **Kein** Prettify-Katalog für Modellnamen — simples Vendor-Präfix-Strippen genügt.
- **Kein** Nachladen/Download von Modellen aus der App — nur bereits installierte.
- **Keine** Änderung an Cloud-Providern oder am Inferenz-Pfad selbst.
- **Kein** Filter-UI für Modelltypen — Embeddings still ausgefiltert, Rest angezeigt.

## Verifikation

- **Server real:** Auf dem Mac läuft LM Studio → Discovery gegen `curl /api/v0/models`
  prüfen (alle installierten LLMs erscheinen), `loadLocalModel(key, 16384)` gegen echte
  Instanz (state=loaded, loadedContext=16384). Embedding-Modell taucht **nicht** in der
  Provider-Liste auf.
- **App:** Playwright-Smoke gegen das gebaute `liquidDeckHtml.ts` — Modell-Sheet öffnet,
  Regler startet auf `savedContext`, „Laden" postet `managerSelectProvider` mit der Länge.
- **Additiv:** LM Studio aus → alter Inferenz-Pfad (Cloud) unberührt.

## Betroffene Dateien

**Server** (`~/Desktop/tms-terminal`, Branch `feat/manager-chat-redesign`):
- `server/src/manager/lmstudio.manager.ts` — Info-Felder erweitern, `displayName`
- `server/src/manager/ai-provider.ts` — feste Provider raus, `refreshLocalProviders`,
  Fallback, `ProviderConfig.lmStudioModelContext`
- `server/src/manager/manager.service.ts` — `getProviders()` + `setProvider()` anpassen

**App/Mockup** (Season-2-Bridge + Store):
- `managerStore` — `ProviderInfo`-Felder
- Mockup-Modell-Sheet / bridge.js — Regler-Startwert `savedContext`, `displayName`-Anzeige

**Auslieferung:** Server-Änderung braucht `tms-terminal update`; App-Änderung braucht
Season-2-Rebuild + Release.
