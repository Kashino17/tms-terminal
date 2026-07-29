# Einheitliches Auto-Approve über alle AI-Harnesse

**Datum:** 2026-07-29
**Status:** Entwurf abgenommen
**Betrifft:** `server/src/notifications/prompt.detector.ts`, `server/src/websocket/approval.util.ts`,
`server/src/websocket/ws.handler.ts`, `server/src/terminal/emulator.mirror.ts`,
`server/src/terminal/restore/*`, `mobile/src/services/notifications.service.ts`,
`mobile/src/season2/SeasonTwoWebRoot.tsx`

## Problem

Auto-Approve zieht unzuverlässig. Bei einer ganz gewöhnlichen Claude-Code-Berechtigungsbox
(„Do you want to proceed?" mit drei nummerierten Optionen) drückt der Server oft kein Enter,
sondern meldet nur. Bei Codex und Gemini dasselbe Bild. Umfragen und Mehrfachauswahl-Fragen
sollen dagegen weiterhin unbeantwortet bleiben — dort fehlt aber jeder Hinweis ans Handy.

## Ursache (reproduziert, nicht vermutet)

Der Prompt-Detektor liest einen **Byte-Strom**, aus dem nur die ANSI-Sequenzen entfernt wurden.
Das ist nicht der Bildschirm. Aufzeichnung einer echten Claude-Code-Sitzung bei 40 Spalten
(`node-pty`, roher PTY-Strom als JSONL):

* Die Berechtigungsbox steht in Zeile **219 von 871** des bereinigten Stroms.
* Danach folgen **646 Zeilen, die nur einen Wagenrücklauf enthalten** — Cursor-Repaint-Frames,
  deren Steuerzeichen entfernt, deren Wirkung aber nie ausgeführt wurde.
* Die Zeilengrenzen stimmen nicht: Frage **und erste Option** kleben in *einer* Strom-Zeile,
  Option 2 und 3 stehen einzeln.
* Der Options-Parser in `chooseApprovalKey` findet deshalb nur Option 2 und 3. Die Regel
  „nur drücken, wenn Option 1 zustimmend ist" findet keine Option 1 → `null` → `NOTIFY-only`.
* Leerzeichen fehlen (`Yes,allowreadingfrometc/`), weil die Harnesse Abstände als
  Cursor-Sprünge malen. Daher die `\s*`-Krücken in allen bestehenden Mustern.

Das Server-Log bestätigt es: `Auto-approve: NOTIFY-only … lastLine-b64=` ist **leer** —
die letzte Strom-Zeile ist tatsächlich leer.

Derselbe Strom durch einen echten Terminal-Emulator ergibt:

```
22 |  Do you want to proceed?
23 |  ❯ 1. Yes                            ← Cursor: x=1, y=23
24 |    2. Yes, allow reading from etc/
25 |       during this session
26 |    3. No
28 |  Esc to cancel · Tab to amend
```

Saubere Zeilen, echte Leerzeichen, keine Geisterframes, und der Cursor steht beweisbar auf der
zustimmenden Option.

**Der Server hat diesen Emulator bereits:** `SessionMirror` (`@xterm/headless`) läuft pro Session
und wird in `terminal.manager.ts` bei jedem Byte gefüttert. Er wurde für Snapshot-Reattaches
gebaut; die Prompt-Erkennung benutzt ihn nur noch nicht.

## Nicht-Ziele

* Keine Änderung daran, **welche** Antwort gewählt wird: Enter nimmt die vorausgewählte erste
  Option („einmalig erlauben"). Kein Vorwählen von „immer erlauben".
* Kein Umbau der Harness-Aufrufe (Claude-Hooks, Codex-Approval-Policy). Kommt gegebenenfalls
  später als Ergänzung, nicht als Ersatz.
* Keine Push-Benachrichtigung für Berechtigungen. Nur Umfragen.

## Architektur

### 1. Der Spiegel wird die Quelle

`SessionMirror` bekommt einen Lesezugriff auf den gerenderten Bildschirm:

```ts
export interface ScreenView {
  rows: string[];      // sichtbare Zeilen, oben nach unten, ohne Steuerzeichen
  cursorX: number;
  cursorY: number;     // Index in rows
  cols: number;
}

screen(): ScreenView
```

Umsetzung: `buffer.active.getLine(viewportY + y).translateToString(true)` je Zeile.
`translateToString(true)` schneidet nachlaufende Leerzeichen ab.

`terminal.manager.ts` bekommt `getScreen(sessionId): ScreenView | null`, damit weder Detektor
noch Handler den Spiegel direkt kennen müssen.

### 2. Auslöser: sofort und selbstheilend

Zwei Wege, beide über denselben Klassifikator:

* **Sofort.** `SessionMirror.feed()` nutzt den Rückruf von `Terminal.write(data, cb)`. Erst
  wenn der Parser das Paket verarbeitet hat, ist der Bildschirm gültig. Der Detektor prüft
  dann, entprellt mit 50 ms (wie heute).
* **Wiederholung.** Solange eine Session als „Prompt wartet, noch nicht gelöst" markiert ist,
  läuft alle 500 ms eine erneute Bewertung, bis der Prompt beantwortet ist oder der
  Bildschirm sich ändert. Obergrenze wie heute ~30 s, dann eine laute Log-Zeile.

Damit fällt der heutige Einmal-Schuss weg. Bisher gilt: eine Box, die stehen bleibt, erzeugt
keine neue Ausgabe, also keinen neuen Hash, also nie einen zweiten Versuch. Genau das ist die
zweite Hälfte der Unzuverlässigkeit — die erste ist die falsche Datenquelle.

Entprellt wird über einen **Bildschirm-Fingerabdruck** (Hash der letzten Zeilen plus
Cursorposition) statt über Byte-Hashes. Ändert sich der Bildschirm nicht, ist es derselbe
Prompt; ändert er sich, ist der alte weg.

### 3. Ein Klassifikator für alle Harnesse

`classifyScreen(screen: ScreenView): PromptClass` in einer eigenen Datei
(`server/src/notifications/prompt.classifier.ts`), rein und ohne Seiteneffekte.

```ts
type PromptClass =
  | { kind: 'permission'; key: string; question: string; options: string[] }
  | { kind: 'confirm';    key: string; question: string }
  | { kind: 'question';   question: string; options: string[] }
  | { kind: 'none' };
```

Signale, alle auf echten Bildschirmzeilen:

1. **Optionsblock** — aufeinanderfolgende Zeilen der Form `N. Text` oder `N) Text` im unteren
   Bildschirmdrittel. Eingerückte Folgezeilen gehören zur vorherigen Option.
2. **Auswahlmarke** — `❯`, `>`, `●`, `◉` auf einer Optionszeile, **oder** der Cursor steht auf
   einer Optionszeile. Letzteres gibt es nur mit Emulator und ist das stärkste Signal.
3. **Fußzeile** — „Esc to cancel", „esc to cancel" (Codex), „Use arrow keys", „Enter to confirm",
   „Tab to amend", „↑↓".
4. **Fragekopf** — die letzte nichtleere Zeile über dem Optionsblock.

Entscheidungstabelle:

| Bildschirm | Klasse | Taste |
|---|---|---|
| Optionsblock + Marke/Cursor/Fußzeile, Option 1 zustimmend | `permission` | `\r` |
| Zeilenende mit Ja/Nein-Klammer, Cursor dahinter, Vorgabe Ja | `confirm` | `\r` |
| Zeilenende mit Ja/Nein-Klammer, Cursor dahinter, Vorgabe Nein | `confirm` | `y\r` |
| Optionsblock, Option 1 **nicht** zustimmend | `question` | — |
| Mehrere Optionsblöcke, „Frage 1 von 3", Codex-Formular („Answer required fields", „Type your answer") | `question` | — |
| Cursor sitzt in der Eingabezeile der TUI | `none` | — |
| sonst | `none` | — |

„Zustimmend" heißt: der Optionstext beginnt mit `Yes`, `Ja`, `Allow`, `Approve`, `Proceed`,
`Continue`, `Run`, `Accept` — mit Wortgrenze **oder** direkt gefolgt von Komma/Großbuchstabe.
Die Liste ist aus den installierten Harnessen belegt:

| Harness | Text der ersten Option |
|---|---|
| Claude Code | `Yes` |
| Codex | `Allow this request and continue` |
| Gemini CLI | `Yes, allow once` |
| Kimi | wird beim Aufnehmen des Korpus ergänzt |

Weil der Emulator echte Leerzeichen liefert, entfallen sämtliche `\s*`-Krücken, das
Footer-Abschneiden (`stripStatusFooter`) und das 6-Zeilen-Fenster. Die Task-Liste, die Claude
Code unter die Box rendert, ist auf dem echten Bildschirm einfach das, was sie ist: Zeilen
unterhalb des Optionsblocks, die die Blocksuche nicht stören.

### 4. Torwächter bleibt, Retry bleibt

`evaluateApprovalGate` behält seine Aufgabe (pausieren, solange der Nutzer tippt oder
ungesendeten Text in der Zeile hat) und bekommt statt eines Textfensters die `PromptClass`.
Die bestehende Retry-Kette in `ws.handler.ts` bleibt und stützt sich künftig auf den
Bildschirm-Fingerabdruck statt auf `promptDetector.tailHash`.

### 5. Umfrage → Push mit Sprung ins Terminal

Bei `kind === 'question'` schickt der Server eine FCM-Nachricht:

* Titel: `❓ Rückfrage · <Terminal-Label>`
* Text: der erkannte Fragekopf, gekürzt
* Daten: `{ type: 'prompt', kind: 'question', sessionId }`

Entprellt über den Bildschirm-Fingerabdruck: höchstens **ein** Push pro wartender Frage.
Verschwindet die Frage und kommt eine neue, wird erneut gepusht.

App-Seite, exakt der Weg der Browser-Brücke:

* `notifications.service.ts` — der vorhandene `addNotificationResponseReceivedListener` legt
  bei `data.type === 'prompt'` die `sessionId` ab; dazu ein `consumePendingPromptSessionId()`
  analog zu `consumePendingBrowserBridgeUrl()`.
* `SeasonTwoWebRoot.tsx` — konsumiert den Wert beim Start und beim Zurückkehren in den
  Vordergrund und ruft einen neuen Bridge-Befehl `focusSession(sessionId)`.
* `bridge.js` — `focusSession` schaltet auf die Karte dieser Session.

Zusätzlich sendet der Server die Klasse im WebSocket-Ereignis mit:
`terminal:prompt_detected` bekommt `payload.kind`. Damit hört `describePrompt` in
`SeasonTwoWebRoot.tsx` auf, dieselbe Einstufung ein zweites Mal aus dem Textschnipsel zu raten —
die Sonderregel „`kind === 'question'` → gar nichts anzeigen" bleibt inhaltlich unverändert.

### 6. Auto-Approve überlebt den Server-Neustart

Wiederhergestellte Terminals überleben einen Neustart, der Auto-Approve-Schalter bisher nicht —
er ist danach still aus, bis die App sich meldet. `SnapshotEntry` in
`server/src/terminal/restore/snapshot.types.ts` bekommt daher:

```ts
autoApprove?: boolean;
```

Der Snapshotter schreibt den aktuellen Wert aus `serverAutoApprove` mit; `restore.ts` füllt die
Map beim Wiederherstellen. Ein `client:set_auto_approve` der App überschreibt weiterhin sofort.

### 7. Aufnahme-Korpus als Regressionstest

Die aufgezeichneten PTY-Ströme werden Fixtures unter `server/test/fixtures/harness/`
(JSONL, je Zeile `{t, d}` mit base64-Nutzlast). Ein Replay-Test spielt sie in einen
`SessionMirror` und prüft die Klasse.

Aufzunehmen, je bei 40 Spalten (Handybreite) und 100 Spalten:

| Harness | Fälle |
|---|---|
| Claude Code | Berechtigung (vorhanden), Ordner-Vertrauen (vorhanden), Umfrage/`AskUserQuestion` |
| Codex | Befehlsfreigabe, Formular/„Question requested" |
| Gemini CLI | Befehlsausführung, Änderung übernehmen |
| Kimi | Berechtigung |

Ändert eine neue Harness-Version ihr Layout, fällt ein Test — statt dass es am Handy auffällt.

## Fehlerfälle

| Fall | Verhalten |
|---|---|
| Spiegel fehlt (Anlegen fehlgeschlagen) | Rückfall auf die heutige Byte-Strom-Erkennung, Warnung ins Log |
| Nutzer tippt / ungesendeter Text | wie heute: verschieben und bis ~30 s erneut versuchen |
| Prompt verschwindet während der Retry-Kette | Fingerabdruck stimmt nicht mehr → abbrechen, nie doppelt drücken |
| Auto-Approve aus | keine Taste; Umfragen pushen trotzdem, Berechtigungen wie heute nur im WebSocket melden |
| Kein FCM-Token registriert | Push wird übersprungen, eine Zeile ins Log |

## Prüfen

* Unit: `classifyScreen` gegen handgeschriebene Bildschirme je Klasse.
* Replay: Fixtures durch den Spiegel, erwartete Klasse je Aufnahme.
* Ende zu Ende, am Gerät: Berechtigung wird ohne Zutun bestätigt, während die App zu ist;
  Umfrage erzeugt einen Push, dessen Antippen genau dieses Terminal öffnet.

## Ausliefern

* Server-Teil nach `~/Desktop/tms-terminal`, Branch `feat/manager-chat-redesign` — dort läuft
  der Live-Server. Vor dem Schieben den Remote-Stand prüfen, der Branch bewegt sich.
* Der Server-Neustart beendet die Sitzung, die den Umbau gemacht hat. Er ist der letzte
  Schritt und wird vom Nutzer ausgelöst.
* App-Teil über den Tag-Push-Workflow (GitHub Actions), lokal baut das APK nicht durch.
