# Diktat-Wörterbuch + neue Einstellungen (Diktat-Bubble 2.0, Teil B/E/F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Nutzer sieht und pflegt ein Wörterbuch für sein Diktat in einer neu aufgebauten Einstellungsseite; es wirkt beim Zuhören und ersetzt bekannte Hörfehler — ohne Wartezeit.

**Architecture:** Das Wörterbuch lebt auf dem Rechner, der transkribiert (`~/.tms-terminal/dictionary.json`). Der Server gibt seine Begriffe Whisper als Prompt mit und ersetzt nach jedem Stück die bekannten Hörfehler (reines Suchen und Ersetzen in Node). Die Seite spricht über vier `dict:*`-Nachrichten mit diesem Rechner; die App reicht sie nur durch.

**Tech Stack:** Node + TypeScript (`node:test`), Python-Sidecar (ein Feld mehr), Season-2-Seite (`mockups/season2/liquid-deck/settings.js` + `.css`, `bridge.js`, `npm run build:season2`), React Native (Durchreichen).

**Spec:** `docs/superpowers/specs/2026-11-11-diktat-bubble-2-design.md` — Teil B ohne „Lernen von selbst“, Teil E, Teil F, dazu die Tempo-Anzeige aus A5.

## Global Constraints

- Keine Attrappen: In der Seite erscheint nur, was wirkt. „Neu gelernt“, „Aus Korrekturen lernen“, „Denkpausen“ und „Flüstermodus“ kommen erst mit ihren eigenen Plänen in die Seite.
- Das Wörterbuch ersetzt nur ganze Wörter bzw. Wortfolgen, nie Wortteile; ohne Rücksicht auf Groß-/Kleinschreibung; längste Treffer zuerst.
- Der Nutzer hat am 2026-11-11 entschieden: Das Tempo reicht; der schnellere Upload-Takt der App wird nicht gebaut.
- Alle Einstellungsseiten matt (`--card-matte`, keine Unschärfe). Texte Deutsch, Code Englisch.
- Quelle der Seite ist das Mockup; `mobile/src/season2/web/liquidDeckHtml.ts` wird gebaut und mit eingecheckt.
- Alte App + neuer Server und neue App + alter Server müssen weiter diktieren können.
- Release und Server-Neustart gibt der Nutzer frei.

## Review Focus

1. **Ersetzen trifft Wortteile oder normale Wörter:** „Stock“ als Hörfehler für „Stopp“ darf „Stockwerk“ nicht anfassen. → Test in Task 1.
2. **Kaputte oder fehlende Wörterbuch-Datei:** Diktieren muss weiter funktionieren; eine beschädigte Datei wird nicht still überschrieben. → Test in Task 1.
3. **Sehr großes Wörterbuch:** Whispers Prompt ist begrenzt; zu lange Prompts verschlechtern die Erkennung. Erwartet: gekappt, meistgenutzte zuerst. → Test in Task 1.
4. **Diktat-Rechner nicht erreichbar:** Die Seite zeigt das, statt endlos zu laden oder eine leere Liste. → Test in Task 5.
5. **Zeichen mit Sonderbedeutung im Begriff** („C++“, „.env“, „a.b“): dürfen das Ersetzen nicht zum Absturz bringen oder alles treffen. → Test in Task 1.

---

### Task 1: Wörterbuch auf dem Server

**Files:** Create `server/src/audio/dictionary.ts`, `server/src/audio/dictionary.test.ts`

**Interfaces — Produces:**
```ts
export interface DictEntry { id: string; term: string; heard: string[]; source: 'seed' | 'manual' | 'learned'; uses: number; createdAt: number }
export function applyDictionary(text: string, entries: DictEntry[]): { text: string; hits: Record<string, number> }  // hits by entry id
export function whisperPrompt(entries: DictEntry[], maxChars?: number): string                                        // default 600
export class DictionaryStore {
  constructor(file: string, seed?: Array<{ term: string; heard?: string[] }>);
  list(): DictEntry[];
  add(term: string): DictEntry | null;                    // null: empty or already there (case-insensitive)
  update(id: string, patch: { term?: string; heard?: string[] }): DictEntry | null;
  remove(id: string): boolean;
  /** Replaces known mishearings and counts the uses. */
  fix(text: string): string;
  prompt(): string;
}
export const DICTIONARY_SEED: Array<{ term: string; heard?: string[] }>;   // today's INITIAL_PROMPT terms + the rewriter's mishearing list
```
Regeln: `term` und `heard` getrimmt, höchstens 60 Zeichen, Steuerzeichen raus; ein `heard`, das einem `term` (irgendeines Eintrags) gleicht, wird abgelehnt. Wortgrenze = davor/danach kein Buchstabe und keine Ziffer (Unicode). Datei `{ "version": 1, "entries": [...] }`, atomar geschrieben, Modus 0600; fehlt sie, wird mit dem Seed begonnen; ist sie unlesbar, wandert sie nach `.bad` und es wird mit dem Seed begonnen.

- [ ] Tests schreiben: ersetzt ganze Wörter und Wortfolgen ohne Rücksicht auf Großschreibung; „Stock“→„Stopp“ lässt „Stockwerk“ und „Wurzelstock“ in Ruhe; längster Treffer zuerst („Cloud Code Sitzung“ vor „Cloud Code“); Sonderzeichen („C plus plus“→„C++“, Begriff „.env“); Satzzeichen bleiben („Vispa Flow.“→„Wispr Flow.“); `hits` zählt; `whisperPrompt` kappt bei 600 Zeichen, meistgenutzte und neueste zuerst; Store: add/Dublette/update/remove, übersteht Neustart, Seed bei fehlender Datei, `.bad` bei kaputter Datei, `fix` erhöht `uses`.
- [ ] Fehlschlag prüfen, umsetzen, Tests grün, Commit `feat(dictation): dictionary store with whole-word replacement`.

### Task 2: Wörterbuch wirkt im Diktat

**Files:** Modify `server/src/audio/dictation.ts`, `server/src/audio/whisper-sidecar.ts`, `server/audio/whisper_sidecar_mlx.py`, `server/src/websocket/ws.handler.ts`; Tests `dictation.test.ts`, `server/audio/test_whisper_sidecar_mlx.py`

**Interfaces:** `DictationDeps.transcribeWav(wavBase64: string): Promise<string>` bleibt; neu `DictationDeps.fix?: (text: string) => string` (auf jedes Stück und jedes Vorab-Stück angewandt). `TranscribeOptions.prompt?: string` → Sidecar-Feld `prompt`; fehlt es, gilt der feste `INITIAL_PROMPT`. Verdrahtung: `transcribeWav: (b) => whisperTranscribe(b, { prompt: dictionary.prompt() })`, `fix: (t) => dictionary.fix(t)`; dasselbe für den alten `audio:transcribe`-Weg.

- [ ] Tests: Manager wendet `fix` auf reguläre Stücke und auf ein vorab transkribiertes Stück an; Python: `prompt` aus dem Auftrag wird an `transcribe` gereicht, ohne Feld der feste Prompt.
- [ ] Umsetzen, Tests grün (`npm test`, `python3 -m pytest server/audio/test_whisper_sidecar_mlx.py` bzw. wie die Datei heute läuft), Commit.

### Task 3: Nachrichten

**Files:** Create `server/src/audio/dictionary.connection.ts` + Test; Modify `server/src/websocket/ws.handler.ts`, `shared/protocol.ts`

**Interfaces:** Client → Server `dict:get {}`, `dict:add { term }`, `dict:update { id, term?, heard? }`, `dict:remove { id }`. Server → Client `dict:state { entries: DictEntry[], speed: DictationSummary }` — als Antwort an den Fragenden und nach jeder Änderung an alle verbundenen Apps.
`export function handleDictionaryMessage(store, stats, msg, reply, broadcast): boolean` (false für fremde Nachrichten).

- [ ] Tests: jede Nachricht → richtige Wirkung + `dict:state`; Änderung → `broadcast`, `dict:get` → nur `reply`; kaputte Nutzlast wird ignoriert, ohne zu werfen.
- [ ] Umsetzen, verdrahten (nur Hauptverbindung), Typen ergänzen, Commit.

### Task 4: KI-Prompt entfernen (Server)

**Files:** Delete `server/src/audio/prompt-rewriter-sidecar.ts`, `…sidecar.test.ts`, `server/audio/prompt_rewriter_sidecar.py`, `server/audio/test_prompt_rewriter_sidecar.py`; Modify `dictation.ts` (kein `rewrite`, kein `acceptRewrite`, `enhance` wird angenommen und ignoriert), `dictation.connection.ts`, `ws.handler.ts`, `index.ts`, Tests, `scripts/dictation-e2e.ts`, `scripts/dictation-test-server.ts`.

- [ ] Tests anpassen (Test „enhance runs the rewriter…“ → „enhance from an old app is accepted and ignored“), umsetzen, `npm test` + `tsc` grün, Commit.

### Task 5: Die Seite

**Files:** Modify `mockups/season2/liquid-deck/settings.js`, `settings.css`, `mobile/src/season2/web/bridge.js`, `mobile/src/season2/SeasonTwoWebRoot.tsx`, `mobile/src/screens/SettingsScreen.tsx` (klassischer Schalter weg), gebaut `mobile/src/season2/web/liquidDeckHtml.ts`; Create `mobile/scripts/webview-dictionary.test.mjs`.

Vorlage ist `mockups/diktat-plan/app/liquid-deck/` (Block `DW`, Regeln `.dw-*`). Abweichungen davon: keine Beispieldaten in der App — Daten aus `window.TMS_DATA.dictionary` (`{ entries, speed }` oder `{ offline: true }`), im Mockup ohne App Demo-Daten; kein „Neu gelernt“; Filter Alle / Von dir / Mitgeliefert; im aufgeklappten Eintrag ein Feld „Hörfehler ergänzen“; Reiter „Diktat“ zeigt nur die Tempo-Karte (aus `speed`; ohne Werte: „Noch keine Diktate gemessen“); Zeile der Kategorie: `Bubble … · N Begriffe · Ø x,x s`.
Seite → App: `post('dict:get'|'dict:add'|'dict:update'|'dict:remove', payload)`. App → Seite: `TMSBridge.setDictionary(data)`. Die App reicht die vier Nachrichten an die Verbindung des Diktat-Rechners (`dictWs`) durch und `dict:state` von genau diesem Rechner zurück; ohne Diktat-Rechner antwortet sie selbst mit `{ offline: true }`. `voicePrompt` verschwindet aus `setSettings`/`applySetting`; `useDictation` und die Bubble senden `enhance` nicht mehr.

- [ ] Test (gebaute Seite im Headless-Browser, Muster `mobile/scripts/webview-bubble.test.mjs`): Reiter wechseln; `setDictionary({entries,speed})` zeigt Begriffe und Tempo; Hinzufügen postet `dict:add`; Hörfehler ergänzen postet `dict:update`; Löschen postet `dict:remove`; `{offline:true}` zeigt den Hinweis; kein Schalter „KI-Prompt“ mehr; Karten ohne `backdrop-filter`.
- [ ] Umsetzen, `npm run build:season2`, Test grün, `npx tsc --noEmit` ohne neue Fehler, Screenshots 412×915 und 840 breit ansehen, Commit.

### Task 6: Probe aufs Exempel

- [ ] `scripts/dictation-e2e.ts` mit einer Aufnahme, in der ein Wörterbuch-Begriff falsch gehört wird (`--dict=<datei>`): vorher/nachher-Text festhalten; Tempo darf sich nicht ändern (Vergleich mit der Tabelle im Tempo-Plan).
- [ ] Ergebnis unten in diesen Plan, Journal und Projektzustand aktualisieren.

## Messung

2026-11-11, `scripts/dictation-e2e.ts`, Aufnahme 183 s (Sprachausgabe), Pausen-Regel, Upload-Takt 2 s, Load 15–18 durch fremde Jobs.

| Lauf | Stopp → Text | Wortfehler | Wörterbuch |
|---|---|---|---|
| ohne Wörterbuch | 629 ms | 2 von 434 („Stopp“ zweimal als „Stock“ gehört) | — |
| `--fix=Stock:Stopp` | 544 ms | 0 von 434 | Stock → Stopp, 2× ersetzt |

Das Wörterbuch wirkt Ende zu Ende (Prompt an Whisper + Ersetzen je Stück) und kostet keine messbare Zeit.

Seite: 9 neue Headless-Tests gegen die gebaute Seite (`mobile/scripts/webview-dictionary.test.mjs`), 34 bestehende (`webview-bund`) grün; Bilder bei 412×915 und 840 breit angesehen.
