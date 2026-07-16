# Cloud-Seite: Render & Vercel verknüpfen — Design

**Datum:** 2026-07-17
**Status:** vom User freigegeben

## Ziel

Die Season-2-Cloud-Seite soll Render- und Vercel-Konten direkt in der App
verknüpfen können. Anforderungen des Users:

1. API-Keys direkt auf der Cloud-Seite eingeben (kein Umweg über Season-1-Settings).
2. Keys später wieder **ansehen und kopieren** können.
3. Keys **sicher lokal** gespeichert (nur auf dem Handy), überleben
   App-Updates; Server-Neustarts sind irrelevant, da die App die Cloud-APIs
   direkt anspricht.

## Ist-Zustand

- `mobile/src/services/render.service.ts` und `vercel.service.ts` sind fertige
  API-Clients (Projekte, Env-Vars, Logs, Deployments) hinter dem gemeinsamen
  `CloudProvider`-Interface (`cloud.types.ts`).
- `useCloudBridge` (`season2/web/useSeasonTwoBackends.ts`, Worktree
  `~/Desktop/tms-terminal`, Branch `feat/manager-chat-redesign`) lädt **nur
  Vercel** und nur, wenn bereits ein Token existiert. Render ist nicht verkabelt.
- Season 2 hat **keine** Key-Eingabe; die Eingabe existiert nur im alten
  Season-1-UI (`CloudSetup.tsx`).
- `cloudAuthStore` persistiert Tokens in **AsyncStorage (Klartext)**.
  Server-Tokens nutzen dagegen bereits `expo-secure-store`
  (`storage.service.ts`) — dieses Muster wird übernommen.

## Architektur-Entscheidung

**Direkte API-Anbindung vom Handy** (bestehende Services), kein Server-Proxy
über den Mac. Keys bleiben ausschließlich auf dem Gerät im Android Keystore.

## Komponenten

### 1. Sichere Key-Ablage (SecureStore-Migration)

- `cloudAuthStore`: Tokens (`render`, `vercel`) wandern nach
  `expo-secure-store` (Keys z. B. `tms_cloud_token_render`).
- Übriger Store-Inhalt (activeOwnerId, notificationsEnabled,
  pollingIntervalMs) bleibt in AsyncStorage; das persistierte JSON enthält
  **keine** Tokens mehr.
- **Einmalige Migration** beim Store-Hydrate: Falls das AsyncStorage-JSON
  (`tms-cloud-auth`) noch Tokens enthält → in SecureStore schreiben → aus
  AsyncStorage entfernen.
- Alle bestehenden Konsumenten (`CloudSetup`, Panels, Polling, Bridge) lesen
  weiterhin über den Store; die Hydration füllt `tokens` aus SecureStore.

### 2. UI auf der Cloud-Seite (Mockup `mockups/season2/liquid-deck/index.html`)

- **Leerer Zustand** (kein Provider verbunden): zwei Verbinden-Karten
  (▲ Vercel / R Render) mit Key-Eingabefeld, „Verbinden“-Button und
  Kurzhinweis, wo der Key erstellt wird (Vercel: Account Settings → Tokens;
  Render: Account Settings → API Keys).
- **Toolbar**: Zahnrad-Button neben dem Ordner/Liste-Toggle öffnet das
  **Konten-Sheet**. Pro Anbieter:
  - verbunden → Key maskiert (`rnd_••••…sp4`), Auge-Button zum Aufdecken,
    Kopieren-Button, „Trennen“.
  - nicht verbunden → Eingabefeld + „Verbinden“.
- Nur ein Anbieter verbunden → Projektliste des verbundenen Anbieters plus
  dezente „<anderen Anbieter> verbinden“-Zeile.
- Im Standalone-Mockup (ohne Bridge) simulieren Stubs das Verhalten mit den
  Seed-Daten, damit die Mockup-Vorschau bedienbar bleibt.

### 3. Bridge-Protokoll (WebView ⇄ RN)

Neue Nachrichten:

| Nachricht | Richtung | Zweck |
|---|---|---|
| `cloud:connect {provider, token}` | Web → RN | Key validieren (billiger Call: `listOwners`), bei Erfolg speichern + Projekte laden; bei Fehler Toast |
| `cloud:disconnect {provider}` | Web → RN | Token löschen (Store + SecureStore), Projekte des Providers entfernen |
| `cloud:accounts` | Web → RN, Antwort `setCloudAccounts` | Status je Provider + maskierter Key |
| `cloud:revealKey {provider}` | Web → RN, Antwort mit Klartext-Key | Fürs Auge-Icon im Konten-Sheet |
| `cloud:copyKey {provider}` | Web → RN | RN kopiert nativ via `expo-clipboard`, Toast „Kopiert“ |

### 4. `useCloudBridge` zweigleisig

- Lädt Vercel **und** Render parallel (jeweils falls Token vorhanden) und
  merged die Projektlisten.
- Projekt-IDs bekommen Provider-Präfix (`vercel:<id>` / `render:<id>`), damit
  `cloud:open`-Detailaufrufe (Env/Logs/Deploys) an den richtigen Service
  gehen. Die Render-Detailfunktionen existieren im Service bereits.
- Pro Provider eine Service-Instanz-Ref statt der heutigen einzelnen
  `provider.current`.

### 5. Fehlerbehandlung

- 401/403 (`TokenExpiredError`) → Provider im Konten-Sheet als „Key ungültig —
  neu eingeben“ markieren, Toast. Token wird **nicht** automatisch gelöscht
  (User kann ihn noch ansehen/kopieren).
- Netzwerk-/API-Fehler → Toast, zuletzt geladene Liste bleibt stehen.
- Fällt ein Provider beim parallelen Laden aus, wird der andere trotzdem
  angezeigt.

## Nicht im Scope

- OAuth-Flows (beide Anbieter werden per API-Key verknüpft).
- Server-seitiges Key-Backup auf dem Mac (explizit abgelehnt).
- Änderungen am Season-1-Cloud-UI über die Storage-Migration hinaus.

## Test-Strategie

- Store-Migration: Unit-Test (AsyncStorage-JSON mit Token → nach Hydrate in
  SecureStore, JSON bereinigt).
- Mockup-Logik (Maskierung, Empty-State, Sheet): bestehende
  `data.test.cjs`-/Mockup-Testmuster erweitern.
- Bridge-Merge (Präfix-Routing, Ausfall eines Providers): Unit-Tests für die
  Merge-/Routing-Helfer.
- Ende-zu-Ende: manuell auf dem Fold 7 mit echten Keys.

## Implementierungsorte

- Mockup/UI: dieser Worktree (`mockups/season2/liquid-deck/index.html`,
  `mockups/season2/shared/data.js`).
- RN/Bridge/Store: Worktree `~/Desktop/tms-terminal`, Branch
  `feat/manager-chat-redesign` (dort läuft auch `npm run build:season2`).
