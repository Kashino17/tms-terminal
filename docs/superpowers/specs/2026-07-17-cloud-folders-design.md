# Cloud-Seite: Eigene Ordner, Start-Ordner, persistente Filter — Design

**Datum:** 2026-07-17
**Status:** vom User freigegeben (Startansicht: Start-Ordner + Ordnerleiste;
Zuweisung: Long-Press + Mehrfachauswahl)

## Ziel

Die Cloud-Projektliste (53 Services) ist unübersichtlich: Gruppentitel sind
rohe GitHub-URLs, alle Karten sehen gleich aus, gesunde Services schreien so
laut wie kaputte. Der User will **eigene Projektordner** mit Zuweisung,
**Start-Ordner**, **persistente Standardfilter**, Favoriten und ein ruhiges,
funktionales Farbsystem. Funktionalität > Optik.

## UI

### Ordnerleiste (oben, horizontal scrollbar)
- Chips: Ordnerfarbe (Punkt/Akzent) + Name + Service-Zähler + ⚠-Badge, wenn
  der Ordner error/suspended-Services enthält. Aktiver Chip hervorgehoben.
- Virtuelle Ordner immer vorhanden: `★ Favoriten`, `Alle`, `Unsortiert`
  (nicht zugewiesene Services). Eigene Ordner dahinter, `[+]` am Ende
  erstellt einen (Sheet: Name + Farbe aus 8er-Palette).
- Tap = Ordner wechseln (Liste zeigt nur dessen Services).
- Long-Press auf eigenen Ordner-Chip → Sheet: Umbenennen, Farbe ändern,
  „Als Start-Ordner festlegen", Löschen (Services → Unsortiert).
  Long-Press auf virtuelle Ordner: nur „Als Start-Ordner festlegen".
- Beim Öffnen der Cloud-Seite ist der Start-Ordner aktiv (Default:
  Favoriten, wenn welche existieren, sonst Alle).
- Die Konten-Verwaltung (Zahnrad „Konten") bleibt erreichbar (Chip am Ende
  der Filterzeile).

### Filterzeile (unter der Ordnerleiste)
- Provider-Filter: Alle / ▲ Vercel / R Render (bestehende Chips, kompakter).
- Status-Filter: Alle / Aktiv (ready+building) / Probleme (error+suspended).
- Suchfeld: filtert live nach Service-Name (case-insensitive).
- „Als Standard"-Knopf: speichert Provider+Status-Filter (nicht die Suche);
  wird bei jedem Öffnen automatisch angewandt. Aktiver Zustand sichtbar
  (Knopf „is-on", solange aktuelle Filter == gespeicherte).
- Der bisherige Ordner/Liste-Toggle entfällt (Ordner sind jetzt die Struktur).

### Service-Zeilen (dicht)
- Links farbiges Provider-Glyph (▲ weiß auf dunkel, R violett #8A05FF-Ton).
- Name fett; Unterzeile klein/gedimmt: bereinigter Repo-Name (aus der
  Repo-URL nur der letzte Pfadteil, lowercase; ohne Repo: Provider-Name).
- Rechts Status-Punkt + relative Zeit: ready = gedimmtes Grün (leise),
  building = Amber pulsierend, error = Rot + roter Zeilenakzent,
  suspended = Grau + Pausen-Glyph. Kein READY-Chip-Geschrei mehr.
- Stern (Favorit) bleibt direkt antippbar.
- Tap öffnet wie bisher das Detail (Env/Logs/Deploys — unverändert).

### Mehrfachauswahl (Zuweisung)
- Long-Press auf eine Service-Zeile → Auswahlmodus: Checkboxen links,
  Aktionsleiste unten: „In Ordner ▾" (Sheet mit Ordnerliste + „Neuer
  Ordner…"), „★ Favorit" (toggelt alle gewählten), „Fertig".
- Tap toggelt Auswahl weiterer Zeilen. Zuweisen ersetzt die bisherige
  Ordner-Zuordnung der gewählten Services (ein Service ∈ genau ein Ordner
  oder Unsortiert).

## Daten & Persistenz

Neuer RN-Store `cloudOrgStore` (zustand + AsyncStorage, Name
`tms-cloud-org`):

```ts
folders: Array<{ id: string; name: string; color: string; order: number }>
assignments: Record<string /* prefixed serviceId */, string /* folderId */>
favorites: Record<string, true>
startFolderId: string | null   // 'fav' | 'all' | 'unsorted' | folderId
defaultFilters: { provider: 'all'|'vercel'|'render'; status: 'all'|'active'|'attention' }
```

- Favoriten wandern aus dem WebView-localStorage hierher. Einmalige
  Migration: Die Seite schickt beim ersten `cloud:org:update` ihre
  localStorage-Favoriten mit; RN merged sie, localStorage-Key wird danach
  von der Seite gelöscht.
- Ordnerfarben-Palette (8): #f03e3e, #f76707, #f59f00, #37b24d, #1c7ed6,
  #7048e8, #d6336c, #64748B.

## Bridge

- RN → Seite: `setCloudOrg(org)` (kompletter Org-Zustand; zusammen mit dem
  bestehenden `setCloud` beim Öffnen und nach jeder Änderung).
- Seite → RN: `cloud:org:update { org }` (kompletter Zustand nach jeder
  Änderung: Ordner anlegen/ändern/löschen, Zuweisung, Favorit, Start-Ordner,
  Standardfilter). RN persistiert und pusht NICHT zurück (die Seite hat den
  Zustand schon — kein Echo-Loop).
- Demo-Stubs im Mockup: Org-Zustand lebt in `TMS_DATA.cloudOrg` (Seed in
  data.js), Änderungen gehen an `window.requestCloudOrgUpdate(org)` (Demo:
  nur lokal + Toast; Bridge: post).

## Nicht im Scope

- Drag & Drop-Sortierung (Ordner-Reihenfolge = Anlagereihenfolge).
- Server-seitige Synchronisation der Ordner (nur Handy-lokal).
- Änderungen am Detail (Env/Logs/Deploys) und an der Konten-Verwaltung.
- Verschachtelte Ordner.

## Tests / Verifikation

- data.test.cjs: Seed-Form von `cloudOrg` (Ordner mit id/name/color,
  assignments referenzieren existierende Projekt-IDs, Palette 8 Farben).
- Headless (380 dp): Ordnerleiste + Wechsel, Filter + „Als Standard",
  Suche, Mehrfachauswahl + Verschieben, Long-Press-Sheets, Empty-States
  (leerer Ordner, keine Favoriten). Screenshots an den User VOR der
  RN-Verkabelung.
- RN: tsc; Migration und Persistenz manuell auf dem Gerät.

## Implementierungsorte

- Mockup/UI: `mockups/season2/liquid-deck/index.html`,
  `mockups/season2/shared/data.js` (dieser Worktree).
- RN: `mobile/src/store/cloudOrgStore.ts` (neu), `bridge.js`,
  `useSeasonTwoBackends.ts`, `SeasonTwoWebRoot.tsx`, ggf.
  `build-season2-html.js`-Boot-Reset (Worktree `~/Desktop/tms-terminal`).
