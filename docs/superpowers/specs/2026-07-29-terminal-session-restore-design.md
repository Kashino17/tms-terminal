# Terminals und Claude-Sitzungen über einen Server-Neustart retten

**Datum:** 2026-07-29
**Branch:** `feat/manager-chat-redesign` (Live-/Deploy-Branch)
**Scope:** `server/src/terminal/` — App-Seite bleibt unverändert

## Ziel

Ein Server-Neustart — durch `tms-terminal update`, einen Absturz oder einen Neustart des
Macs — reißt heute **alle** Terminals weg. Offene Claude-Code-Sitzungen sind damit aus
der App verschwunden und müssen von Hand gesucht und fortgesetzt werden.

Nach diesem Feature kommen die Terminals mit denselben Namen, denselben IDs und denselben
Arbeitsverzeichnissen zurück, und wo eine Claude-Sitzung lief, wird sie über
`claude --resume <sessionId>` fortgesetzt.

## Ist-Zustand (geprüft am 2026-07-29)

- `TerminalManager` hält Sessions ausschließlich im Arbeitsspeicher (`private sessions =
  new Map<string, TerminalSession>()`). Es gibt **keinerlei** Persistenz; ein Neustart
  verliert alles.
- `createSession()` vergibt die ID hart per `uuidv4()` — eine ID lässt sich nicht vorgeben.
- `createPty()` startet jede Shell hart in `os.homedir()` — ein Arbeitsverzeichnis lässt
  sich nicht vorgeben.
- `readForegroundProcess()` (`cwd.utils.ts:56`) ermittelt bereits das Kind der Shell über
  `pgrep -P` und `ps -o comm=`, mit 1-Sekunde-Timeout. Das Muster existiert also schon.
- Die App bindet ihre Reiter an die Session-ID und schickt nach dem Reconnect
  `terminal:reattach`.

## Der Fund, auf dem alles aufbaut

**Claude Code führt selbst Buch.** In `~/.claude/sessions/<pid>.json` steht:

```json
{"pid":90832,"sessionId":"2e38c333-c60e-4a5e-822a-8bab6d3f739f",
 "cwd":"/Users/ayysir/Desktop/TMS Terminal","status":"busy",
 "kind":"interactive","version":"2.1.220","startedAt":1785219546136}
```

Damit ist die Kette **Terminal → Shell-PID → Claude-PID → Session-ID** eindeutig.

Geprüfte Alternativen, die **nicht** taugen:
- **Neueste Transkriptdatei im cwd-Slug.** Mehrdeutig: Zum Messzeitpunkt liefen sechs
  Claude-Sitzungen, davon **drei im selben Ordner** (`TMS Shops`).
- **`lsof` auf den Claude-Prozess.** Claude Code hält die `.jsonl` nicht offen, sondern
  hängt an und schließt wieder — es taucht keine Transkriptdatei auf.
- **Umgebungsvariable des Prozesses.** `ps -Eww` zeigt keine Session-ID.
- **Kommandozeile.** `ps -o command=` liefert nur `claude`, ohne Argumente.

## Getroffene Entscheidungen

| Frage | Entscheidung |
|---|---|
| Auslöser | Bei **jedem** Server-Start, sofern die Aufnahme höchstens **30 Minuten** alt ist. Deckt damit auch Absturz und Stromausfall ab, bleibt aber nach einem gewollten Über-Nacht-Aus still. |
| Umfang | **Alle** Terminals (Name + Arbeitsverzeichnis), Claude zusätzlich dort, wo es lief. |
| Rückmeldung | Hinweiszeile im jeweiligen Terminal **plus** eine zusammenfassende Manager-Nachricht über den Kanal aus Stufe 1. |
| Aufnahmezeitpunkt | Laufend (bei create/close, plus 30-Sekunden-Takt) und ein letztes Mal beim geordneten Herunterfahren. |

Ansatz „nur beim geordneten Stop" wurde verworfen, weil bei einem Absturz kein
Signal-Handler mehr läuft — genau der Fall, der abgedeckt sein soll. Ansatz „Aufnahme im
Bash-Update-Skript" wurde verworfen, weil er nur das Update abdeckt und die PID-Kette in
Bash nachbauen müsste, die in TypeScript bereits existiert.

## Datenmodell

`~/.tms-terminal/terminals.json`, atomar geschrieben (tmp + rename, Modus 0600).

```ts
interface SnapshotEntry {
  /** TMS-Session-ID. Wird beim Wiederherstellen WIEDERVERWENDET — sonst findet
   *  die App ihre Reiter nicht mehr, die daran hängen. */
  id: string;
  /** Nur für Log und Manager-Nachricht ("Shell 1 wiederhergestellt"), aus
   *  managerService.sessionLabels. NICHT der Kartenname in der App — den hält
   *  die App selbst und verliert ihn bei einem Server-Neustart gar nicht.
   *  TerminalSession trägt kein Label. */
  label?: string;
  cwd: string;
  cols: number;
  rows: number;
  claude?: {
    sessionId: string;
    /** 'busy' = die Sitzung wurde mitten in der Arbeit abgeschnitten. */
    status: 'busy' | 'idle' | 'shell';
  };
}

interface Snapshot {
  capturedAt: number;
  /** Schutz davor, Terminals zu übernehmen, während ein anderer Server läuft. */
  serverPid: number;
  entries: SnapshotEntry[];
}
```

## Auflösung der Claude-Sitzung

Für eine gegebene Shell-PID:

1. Alle **Nachfahren** einsammeln, rekursiv über `pgrep -P`, maximal **drei Ebenen** tief.
   Bewusst nicht „Prozessname ist `claude`": Claude Code muss kein direktes Kind sein —
   über einen Wrapper, `npx` oder ein Shell-Alias hängt es tiefer.
2. Für jede Nachfahren-PID prüfen, ob `~/.claude/sessions/<pid>.json` existiert.
3. **Absicherung:** Das Feld `pid` in der Datei muss der geprüften PID entsprechen.
   PIDs werden vom System wiederverwendet; ohne diese Prüfung könnte eine alte Datei
   einem fremden Prozess zugeordnet werden.
4. Erster Treffer gewinnt.

Das Verzeichnis `~/.claude/sessions/` wird **nie als Ganzes durchsucht**. Nur PIDs, die
nachweislich unter einer lebenden TMS-Shell hängen, kommen infrage — so kann die verwaiste
Datei einer bewusst beendeten Sitzung nichts wiederbeleben.

Alle Prozessaufrufe mit 1-Sekunde-Timeout, wie im bestehenden `readForegroundProcess`.

## Ablauf beim Start

1. Aufnahme lesen; fehlt sie → fertig.
2. Älter als 30 Minuten → verwerfen, Log, fertig.
3. `serverPid` lebt noch → abbrechen (paralleler Server).
4. Aufnahme **sofort löschen**, bevor irgendetwas angelegt wird — der Inhalt liegt zu dem
   Zeitpunkt schon im Speicher. Sonst reißt ein Absturz mitten in der Wiederherstellung
   bei jedem Startversuch erneut Terminals auf. Der 30-Sekunden-Takt schreibt die Datei
   kurz darauf ohnehin neu, dann mit dem tatsächlich wiederhergestellten Stand.
5. Pro Eintrag: Session mit derselben ID, demselben cwd und denselben Maßen anlegen.
   Wo ein Claude-Vermerk vorliegt: `claude --resume <sessionId>` hinterlegen.

### Wann der Befehl geschickt werden darf

Eine frisch gestartete Shell ist nicht sofort bereit — zsh lädt `.zshrc`, Plugins,
Prompt-Themes. Zu früh geschrieben, geht der Befehl verloren oder wird halb verschluckt.
Ein fester Wartewert ist die falsche Antwort: warm reichen 200 ms, bei kaltem
Dateisystem-Cache können es Sekunden sein.

**Übernommenes Muster:** Delegierte Tasks legen einen `pendingPrompt` beiseite und
schicken ihn, wenn die Ausgabe prompt-artig aussieht (`isShellPrompt` in
`checkTerminalIdle`). Genauso hier — auf das Ereignis warten, nicht auf die Uhr, mit einer
**Notbremse nach 5 Sekunden**, damit eine exotische Shell die Wiederherstellung nicht
dauerhaft blockiert.

## Zusammenspiel mit der App

**Keine Änderung auf der App-Seite nötig.** Die App hält ihre Reiter samt Kartennamen im
eigenen, lokal persistierten Store und schickt nach dem Reconnect `terminal:reattach` mit
der gespeicherten Session-ID. Weil die Sitzungen unter denselben IDs wiederentstehen,
greift dieser Weg unverändert.

Daraus folgt zugleich: Die **Kartennamen kommen nicht zurück, weil der Server sie
wiederherstellt** — die App hat sie nie verloren. Der Server muss nur dafür sorgen, dass
hinter der bekannten ID wieder eine lebende PTY steht. Ist die App beim Neustart nicht
verbunden, warten die Terminals, bis sie sich meldet.

**Was nicht zurückkommt:** der bisherige Bildschirminhalt. Die PTYs sind tot, ihr
Scrollback ist weg. Bei Claude-Terminals fällt das kaum auf, weil `--resume` den Verlauf
selbst neu zeichnet; eine reine Shell startet leer, nur eben im richtigen Ordner.

## Rückmeldung an den Nutzer

- **Hinweiszeile** in den Ausgabestrom jedes wiederhergestellten Terminals (nicht in die
  Shell — sie soll nicht in der History landen), z.B.
  `— nach Neustart wiederhergestellt · Claude-Sitzung fortgesetzt —`.
- **Eine** Manager-Nachricht über den Outbox-Kanal aus Stufe 1, die zusammenfasst, was
  zurückkam, und ausdrücklich die Sitzungen benennt, die im Status `busy` unterbrochen
  wurden. Die warten jetzt auf eine Eingabe, statt weiterzuarbeiten — das muss gesagt
  werden, sonst wartet der Nutzer auf ein Ergebnis, das nie kommt.

## Eingriffe in bestehenden Code

Beide additiv, keine Verhaltensänderung für bestehende Aufrufer:

- `CreateSessionOptions` bekommt `id?: string`; `createSession()` nutzt sie statt
  `uuidv4()`, wenn gesetzt.
- `createPty()` bekommt einen optionalen `cwd`; Standard bleibt `os.homedir()`.

Das Arbeitsverzeichnis wird bewusst **beim Start der Shell** gesetzt statt über ein
nachträglich geschriebenes `cd`: kein Eintrag in der Shell-History, kein Wettlauf mit der
Shell-Initialisierung, und die Karte zeigt sofort den richtigen Pfad.

## Fehlerbehandlung

Leitgedanke: **Eine misslungene Wiederherstellung darf nie schlimmer sein als gar keine.**
Im Zweifel steht ein leeres Terminal im richtigen Ordner — immer noch besser als heute.

| Fall | Verhalten |
|---|---|
| Aufnahme fehlt oder beschädigt | Server startet leer wie bisher, eine Zeile ins Log. |
| Aufnahme älter als 30 Minuten | Verworfen. |
| `serverPid` lebt noch | Abbruch — die Terminals gehören dem anderen Server. |
| Ordner existiert nicht mehr | Shell startet im Home, Hinweiszeile nennt den verschwundenen Pfad. |
| `claude --resume` schlägt fehl | Terminal bleibt als Shell im richtigen Ordner; die Manager-Nachricht nennt die betroffene Sitzung. |
| Shell meldet sich nie als bereit | Notbremse nach 5 Sekunden, Befehl geht trotzdem raus. |
| Mehr als 50 Einträge (`MAX_SESSIONS`) | Die ersten 50 kommen zurück, der Rest wird benannt statt still verschluckt. |
| `pgrep`/`ps` hängen | 1-Sekunde-Timeout; dann fehlt für dieses Terminal der Claude-Vermerk. |
| Absturz während der Wiederherstellung | Aufnahme ist bereits als verbraucht markiert — kein Startversuch, der endlos Terminals aufreißt. |

## Tests

`node:test` + `node:assert/strict`, wie der Rest des Servers. Uhren und Prozessabfragen
werden injiziert, damit nichts echtes Warten braucht.

- **Frischefenster** — 29 Minuten wird wiederhergestellt, 31 Minuten verworfen.
- **Fremder Server** — lebende `serverPid` verhindert die Wiederherstellung.
- **PID-Kette** (der heikelste Teil): ein Claude-Prozess **zwei Ebenen tief** unter der
  Shell wird gefunden; eine Sitzungsdatei mit **nicht passendem `pid`-Feld** wird
  abgelehnt; fehlende Datei ergibt keinen Claude-Vermerk.
- **Befehlszeile** — `claude --resume <id>` korrekt gebildet, auch bei Leerzeichen im
  Pfad (`/Users/ayysir/Desktop/TMS Terminal` ist genau so ein Fall).
- **Verbraucht-Markierung** — ein zweiter Startversuch stellt nichts erneut her.
- **Bereitschafts-Erkennung** — der Befehl geht bei prompt-artiger Ausgabe raus; die
  Notbremse feuert, wenn diese Ausgabe nie kommt.
- **Aufnahme-Rundlauf** — schreiben/lesen, und eine beschädigte Datei löst den
  Rettungsweg aus.

Nicht automatisiert prüfbar und deshalb ehrlich als Live-Test ausgewiesen: dass die App
ihre Reiter nach dem Neustart wiederfindet. Das zeigt sich erst beim ersten echten
`tms-terminal update`.

## Nicht Teil dieses Features

- Scrollback über den Neustart retten. Das wäre ein eigenes, deutlich größeres Vorhaben
  (Mirror-Zustand persistieren) und steht in keinem Verhältnis zum Nutzen, solange
  `--resume` den Claude-Verlauf ohnehin neu zeichnet.
- Das automatische Wiederholen einer abgeschnittenen Aufgabe. Eine `busy`-Sitzung wird
  fortgesetzt und wartet dann — sie schickt den letzten Auftrag **nicht** erneut. Das wäre
  gefährlich: Der unterbrochene Schritt könnte eine schreibende Aktion gewesen sein.
- Änderungen an der App. Sie funktioniert unverändert, weil die IDs erhalten bleiben.

## Betriebshinweise

- Der Server besitzt alle node-pty-Sitzungen; ein Neustart killt jedes offene Terminal —
  auch die Claude-Sitzung, aus der heraus entwickelt wird. Genau dieser Schmerz ist der
  Anlass für dieses Feature.
- Server-Logs: `~/.tms-terminal/update.log` (der Nutzer sieht sie nicht).
- `feat/manager-chat-redesign` bewegt sich durch parallele Jobs — vor jedem Ship den
  Remote-Stand prüfen und patchen statt kopieren.
