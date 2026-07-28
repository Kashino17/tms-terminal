# Manager-Agent Überarbeitung — Stufe 1: Fundament & Erinnerungen

**Datum:** 2026-07-28
**Branch:** `feat/manager-chat-redesign` (der Live-/Deploy-Branch — dort liegt der Manager-Code)
**Scope:** Server `server/src/manager/`, Protokoll `shared/protocol.ts`, App `mockups/season2/liquid-deck/index.html` + `mobile/src/season2/web/bridge.js`

## Ziel

Der Manager-Agent soll dabei helfen, die Kontrolle und den Überblick über mehrere
parallel laufende Projekte zu behalten — und dafür von sich aus aktiv werden: an
Termine erinnern, offene Dinge im Blick behalten, bei festgefahrenen Problemen
Lösungswege vorschlagen.

Stufe 1 baut das Fundament, auf dem alle weiteren Stufen aufsetzen: einen
strukturierten Faktenspeicher, einen deterministischen Signal-Sammler, einen echten
Kalender und den proaktiven Kanal zum Nutzer.

## Warum der heutige Manager nicht hilft — Befunde

Untersucht am 2026-07-28 im Live-Worktree `~/Desktop/tms-terminal`.

1. **Es gibt keinen Kalender.** `cronToMs()` in `cron.manager.ts` rechnet einen
   Cron-Ausdruck in eine **relative** Millisekunden-Dauer um; `scheduleJob()` macht
   daraus ein `setTimeout(…, intervalMs)`. `0 9 * * *` bedeutet damit nicht „täglich um
   9 Uhr", sondern „in 24 Stunden ab jetzt". Einzeltermine mit Datum, jährliche
   Wiederholung und Vorlauf-Erinnerungen sind damit nicht abbildbar.

2. **Der Agent hat kein Weltmodell.** `MemoryProject` ist `{name, path, type, notes}` —
   kein Status, kein Bezug zu laufender Arbeit, kein Verlauf. `insights[]` ist eine bei
   200 Einträgen gekappte Textliste. Es existiert nichts, worin ein Überblick *steht*;
   er wird bei jeder Antwort aus Chat-Fragmenten neu erraten.

3. **Er schreibt nie von sich aus.** Proaktivität existiert nur als Reaktion auf
   delegierte Tasks (`notifyTaskEvent`). Es gibt keinen Kanal für ungelesene Nachrichten
   und keine Anzeige dafür.

4. **Verfügbare Information wird weggeworfen.** `ANSI_STRIP` (`manager.service.ts:27`)
   enthält das OSC-Muster `\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`. Terminal-Titel fließen
   durch node-pty in den Server und werden gelöscht, bevor jemand hinsieht.

5. **Auf der Platte liegt ein ungenutzter Wissensschatz.** `~/.claude/projects/` enthält
   55 Projektordner. Jede Transkriptzeile trägt `cwd`, `gitBranch`, `timestamp` und
   `version`. Zusätzlich existiert je Sitzung ein `ai-title` (ein stabiles Themen-Etikett
   pro Sitzung, vielfach wiederholt geschrieben — **kein** Fortschrittsindikator
   innerhalb einer Sitzung), sowie `last-prompt`- und `file-history-snapshot`-Einträge.

## Getroffene Entscheidungen

| Frage | Entscheidung |
|---|---|
| Umfang | Stufe 1: Fundament + Erinnerungen. Projekt-Radar und Cockpit-Screen folgen als eigene Stufen mit eigenen Specs. |
| Kalender | Eigener Kalender im Manager, lokal. Kein OAuth, keine Google-Anbindung. |
| Proaktivität | Bei konkretem Anlass **plus** zwei feste Tages-Check-ins. |
| Oberfläche | Manager-Tabs werden Chat / Agenda / Notizen. Artifacts + Memory ins ⋮-Menü. |
| Notizen/To-Dos | **Ein** Eintragstyp: Text, optional abhakbar, optional Frist, optional Projekt. |
| Modell-Takt | Ereignisgesteuert (Auslöser) **und** auf Zuruf (Werkzeuge im Gespräch). Kein Dauerbetrieb. |
| Faktenspeicher | JSON-Dateien unter `~/.tms-terminal/manager/`, atomar geschrieben. Kein SQLite. |
| Dosierung von Vorschlägen | Erst still untersuchen, dann **einmal** melden. Deckel + Themen-Gedächtnis. |

## Architektur

Leitprinzip: **Sammeln ist deterministisch und läuft dauernd. Urteilen kostet ein Modell
und passiert nur bei Anlass.** Diese Trennung ist zugleich die Ausfallsicherung — der
deterministische Teil funktioniert weiter, wenn kein Modell erreichbar ist.

Neue Module unter `server/src/manager/`:

| Modul | Aufgabe | Modell? |
|---|---|---|
| `store.ts` | Atomares Lesen/Schreiben der JSON-Dateien (`tmp` + `rename`, Modus 0600) — dasselbe Muster wie `saveMemory()` und `CronManager.save()`. | nein |
| `context/collector.ts` | Projektordner, Git-Stand, Dateizeiten, Sitzungstitel → hält `projects.json` frisch. | nein |
| `context/osc.ts` | OSC-Titel aus dem PTY-Strom abgreifen, **bevor** `ANSI_STRIP` greift. | nein |
| `context/stuck.ts` | Fehlersignaturen normalisieren und zählen, Fortschritts-Stillstand erkennen. | nein |
| `agenda/agenda.store.ts` | Termine, Wiederholung, Vorlauf-Erinnerungen, Wecker. | nein |
| `entries/entries.store.ts` | Einträge (Notizen/To-Dos). | nein |
| `outbox/outbox.ts` | Proaktive Nachrichten, Dosierung, Themen-Unterdrückung, Ungelesen-Zähler, Push. | nein |
| `tools/definitions.ts` | Aus `manager.service.ts` herausgezogene `MANAGER_TOOLS` (~470 Zeilen) plus die neuen Definitionen. | — |
| `tools/system-prompt.ts` | Aus `manager.service.ts` herausgezogenes `buildSystemPrompt`. | — |

### Umgang mit `manager.service.ts` (198 KB)

Nicht umbauen, aber auch nicht weiter aufblähen. Genau zwei Blöcke werden herausgezogen
— beides reines Verschieben ohne Verhaltensänderung: `MANAGER_TOOLS` und
`buildSystemPrompt`. Der Rest (Delegated Tasks, Terminal-Orchestrierung, Distillation,
`toolCallsToActions`, die mehrrundige Tool-Schleife in `handleChat`) bleibt unangetastet.

**Anschlussstelle für die neuen Lese-Werkzeuge:** `handleChat` besitzt bereits eine
funktionierende mehrrundige Tool-Schleife (Zeilen ~1896–1977): Tool-Aufruf → Ergebnis
zurück ins Gespräch → Modell denkt weiter. Diese Schleife wird genutzt, nicht neu gebaut.

### Ausdrücklich nicht angefasst

Delegated Tasks, `cron.manager.ts` (Intervall-Jobs bleiben, was sie sind — die Agenda ist
etwas anderes), `manager.memory.ts`, Terminal-Orchestrierung, Autopilot.

## Datenmodell

Vier Dateien unter `~/.tms-terminal/manager/`.

### `agenda.json`

```ts
interface AgendaItem {
  id: string;
  title: string;
  note?: string;                    // Wortlaut des Nutzers
  at: string;                       // "2026-08-04T14:00" — lokale Wanduhrzeit, OHNE Zeitzone
  allDay: boolean;
  repeat: 'none' | 'yearly' | 'monthly' | 'weekly' | 'daily';
  reminders: Array<{ id: string; offsetMinutes: number; firedFor?: number }>;
  source: 'user' | 'agent';
  createdAt: number;
}
```

`at` ist bewusst ein Zeitstring ohne Zeitzone, kein Unix-Timestamp: Termine und
Geburtstage sind Wanduhr-Ereignisse. „14 Uhr" muss über die Zeitumstellung hinweg 14 Uhr
bleiben; ein Ganztages-Eintrag um Mitternacht darf nicht auf den Vortag rutschen.

`firedFor` sitzt **pro Erinnerung**, nicht pro Termin — sonst würde die
Eine-Stunde-vorher-Erinnerung unterdrückt, weil die Zwei-Tage-Erinnerung schon raus ist.

Der Wert ist der **Zeitpunkt des Vorkommens**, für das zuletzt gefeuert wurde, nicht der
Feuerzeitpunkt. Bei einem einmaligen Termin ist das gleichwertig; bei einem jährlichen
Geburtstag ist es der entscheidende Unterschied: ein bloßes „schon gefeuert"-Flag würde
den Geburtstag nach dem ersten Jahr für immer verstummen lassen.

Beispiele:
- Zahnarzt: `at: "2026-08-04T14:00"`, `repeat: 'none'`,
  `reminders: [{offsetMinutes: 2880}, {offsetMinutes: 1440}, {offsetMinutes: 60}]`
- Geburtstag: `at: "2026-07-30T00:00"`, `allDay: true`, `repeat: 'yearly'`

### `entries.json`

```ts
interface Entry {
  id: string;
  text: string;
  checkable: boolean;               // false = reine Notiz, zählt nie als "offen"
  done: boolean;
  due?: string;                     // optionale Frist, lokale Wanduhrzeit
  project?: string;                 // Projektschlüssel
  createdAt: number;
  updatedAt: number;
  source: 'user' | 'agent';
}
```

Der Agent entscheidet beim Anlegen aus dem Satzbau, ob `checkable` gesetzt wird
(„denk dran, X zu machen" → ja; „Idee: X" → nein). Der Nutzer kann es in der App ändern.

### `projects.json`

```ts
interface ProjectFacts {
  key: string;                      // Slug des Pfads
  path: string;
  name: string;
  lastActivityAt: number;           // aus mtime der neuesten Transkriptdatei
  gitBranch?: string;
  lastCommitAt?: number;
  lastCommitSubject?: string;
  recentSessions: Array<{
    sessionId: string;
    title: string;                  // ai-title
    startedAt: number;
    endedAt: number;
    promptCount: number;
  }>;
  claudeMdSummary?: string;         // Auszug der CLAUDE.md
  collectedAt: number;
}
```

Vollständig aus Dateien gelesen, kein Modell beteiligt. Das ist das eigentliche
„er weiß Bescheid".

### `outbox.json`

```ts
interface OutboxMessage {
  id: string;
  kind: 'reminder' | 'checkin' | 'stuck' | 'suggestion' | 'event';
  text: string;
  topicKey?: string;                // z.B. "stuck:<fehler-hash>"
  project?: string;
  sessionId?: string;
  createdAt: number;
  readAt?: number;
  pushedAt?: number;
  dismissed?: boolean;
}

interface OutboxFile {
  messages: OutboxMessage[];
  suppressedTopics: string[];       // abgelehnte topicKeys — kommen nie wieder
}
```

Ungelesen-Zähler = Anzahl Nachrichten ohne `readAt`. Das ist die Zahl auf der Island.

### Größenbegrenzungen

`agenda.json` und `entries.json` bekommen **keine** Obergrenze — das sind Eingaben des
Nutzers und dürfen nicht stillschweigend wegfallen. (`manager.memory.ts` kappt bei 200
Insights bzw. 20 Projekten; für maschinell erzeugte Notizen ist das richtig, für
anvertraute Termine wäre es ein Vertrauensbruch.) Die Outbox wird bei 500 Nachrichten
gedeckelt, gelesene zuerst.

## Der Sammler

Zwei Taktgeber, beide ohne Modell:

**Aus dem Strom.** `feedOutput()` erhält jedes PTY-Byte. Dort — vor `ANSI_STRIP` — wird
der OSC-Titel abgegriffen und die Fehlersignatur-Erkennung mitgeführt.

**Alle 2 Minuten.** Durchlauf über die Projektordner: Dateizeiten, Sitzungstitel aus den
neuesten Transkripten, Git-Stand. Nur für Projekte, deren Zeitstempel sich seit dem
letzten Durchlauf bewegt hat.

### Randbedingung Git

Git ist auf dem iCloud-Desktop pathologisch langsam; baumdurchsuchende Operationen hängen
minutenlang (siehe Projektgedächtnis `project_git_slow_use_plumbing`). Der Sammler
benutzt deshalb **ausschließlich Plumbing** (`git rev-parse`, `git log -1 --format=…`),
**niemals `git status`**, und jeder Aufruf bekommt einen Timeout von 3 Sekunden. Läuft er
ab, fehlt für diesen Durchlauf der Git-Stand; alles andere wird trotzdem gesammelt.
Ob „unsaubere Änderungen liegen an" billig erhebbar ist, wird im Plan geprüft — wenn
nicht, entfällt das Feld.

## Auslöser

| Auslöser | Bedingung (deterministisch) | Folge |
|---|---|---|
| Erinnerung fällig | Wecker (Minutentakt) | Text des Nutzers 1:1. Kein Modell. |
| Terminal wartet auf Eingabe | `prompt.detector` (existiert) | Kurze Meldung |
| Terminal fertig | war aktiv, jetzt >2 Min still, **und** kein Delegated Task auf dieser Sitzung | Kurze Meldung |
| Festgefahren | ≥3× dieselbe Fehlersignatur in 20 Min **oder** Sitzung >60 Min aktiv ohne Dateiänderung seit 30 Min | Modell untersucht → **ein** Vorschlag |
| Projekt liegt brach | >5 Tage keine Aktivität, aber offene Einträge | nur beim Check-in erwähnt, unterbricht nie |
| Tages-Check-in | 08:30 und 19:00 (einstellbar) | Modell fasst zusammen |

## Dosierung

- Höchstens **eine** terminalbezogene proaktive Nachricht pro Terminal pro Stunde. Die
  beiden Tages-Check-ins sind nicht terminalbezogen und fallen nicht unter diesen Deckel.
- **Ein** Festgefahren-Hinweis pro Fehlersignatur — überhaupt, nicht pro Tag.
- Ablehnen schreibt den `topicKey` in `suppressedTopics`; das Thema kommt nie wieder.
- Ruhezeit 23:00–07:00: **nur die Push unterbleibt.** Die Nachricht wird trotzdem erzeugt,
  landet im Chat und zählt im Badge — sie weckt bloß niemanden. **Ausgenommen**
  Erinnerungen, die der Nutzer selbst auf diese Zeit gelegt hat: die pushen auch nachts.
- Der Deckel gilt für **Einfälle des Agenten**, nie für **Aufträge des Nutzers**. Fünf
  Erinnerungen auf 14 Uhr ergeben um 14 Uhr fünf Erinnerungen.

## Ablauf „Festgefahren" (der teure Pfad)

1. Auslöser feuert — deterministisch, ohne Kosten.
2. Prüfung: Stundendeckel frei? `topicKey` nicht unterdrückt? Nicht in Ruhezeit?
   Scheitert eine Prüfung, endet der Vorgang hier, ohne Modellaufruf.
3. Modell wird geweckt mit: Fehlersignatur, Terminalauszug, Projektfakten,
   `CLAUDE.md`-Auszug.
4. Es darf nachschlagen — `read_terminal`, `read_file`, `git_info` existieren bereits.
5. Es formuliert **einen** Vorschlag — **oder gibt ausdrücklich „nichts Nützliches"
   zurück**, woraufhin keine Nachricht entsteht. Diese Erlaubnis zu schweigen ist
   verpflichtender Bestandteil des Prompts: ohne sie produzieren Modelle immer etwas,
   weil sie befragt wurden.
6. Nachricht → Outbox → Chat, Island-Badge, Push.

## Neue Werkzeuge

Der Manager hat bereits 24 Tools; jedes weitere erschwert die Auswahl. Deshalb gebündelt
nach dem im Projekt bestehenden Muster (`self_education`, `update_task` arbeiten mit einem
`action`-Parameter):

| Werkzeug | Zweck |
|---|---|
| `get_overview` | Projektfakten, offene Einträge, anstehende Termine — kompakt. Antwort auf „wie laufen die Terminals?" |
| `get_project` | Ein Projekt im Detail, inkl. letzter Sitzungstitel und `CLAUDE.md`-Auszug |
| `agenda` | `list` / `add` / `update` / `delete` |
| `entries` | `list` / `add` / `complete` / `update` / `delete` |
| `notify_user` | Proaktiver Kanal als Werkzeug — für **Einfälle des Agenten**, unterliegt der Dosierung. Vom Nutzer beauftragte Erinnerungen laufen **nicht** hierüber, sondern über `agenda`. |

Für den Blick in ein einzelnes Terminal wird das **bestehende** `read_terminal` genutzt.

## App

### Manager-Tabs

Chat / Agenda / Notizen. Artifacts und Memory wandern ins bestehende ⋮-Menü
(`#mgrMenuBtn`). `wireManagerTabs` schaltet bei Chat auf die Dock-Eingabezeile
(`setDockPage('mgr')`), bei Agenda/Notizen auf die Navigation (`setDockPage('nav')`) —
Agenda und Notizen erben das bestehende Verhalten von Artifacts/Memory.

**Bridge-Randbedingung:** Die IDs `managerTextInput`, `managerMicBtn`, `mgrModelName`,
`managerAttachRow`, `managerAttachBtn` müssen erhalten bleiben, sonst bricht
`mobile/src/season2/web/bridge.js`.

### Island-Badge

Avatar plus Zahl, sichtbar in **jedem** Island-Modus, sobald ungelesene Nachrichten
vorliegen — der Zweck ist gerade die Sichtbarkeit während der Terminal-Arbeit. Antippen
springt in den Manager-Chat und markiert alles als gelesen.

**Platzproblem:** `.island-compact` ist im Terminal-Modus bereits voll (Latenz-Anzeige,
Aktivitäts-Punkt mit Text, vier Buttons: Neu/Stack/Liste/Übersicht). Auf dem
Fold-Außendisplay bei ~380 dp wird das eng. **Vorschlag:** Der Badge ersetzt bei
ungelesenen Nachrichten die Latenz-Anzeige (`.status-hd__metric--latency`), statt sich
danebenzudrängen. Das ist eine Layout-Entscheidung, die visuell verifiziert werden muss —
headless bei 412×915 und bei 380 dp; notfalls anders lösen.

### Proaktive Nachrichten

Erscheinen als normale Chat-Nachrichten im Manager-Chat. Damit bleibt das Gespräch
durchgehend und der Nutzer kann direkt antworten. Kein separater Meldungs-Posteingang.

### Protokoll

Neu in `shared/protocol.ts`, eingefügt in die bestehenden 17 `manager:*`-Nachrichten:

- Client → Server: `manager:agenda` (mit `action`), `manager:entries` (mit `action`),
  `manager:overview`, `manager:outbox_read`
- Server → Client: `manager:agenda_data`, `manager:entries_data`, `manager:proactive`,
  `manager:unread`

### Bauweg

Bearbeitet wird `mockups/season2/liquid-deck/index.html`, danach `npm run build:season2`,
was `liquidDeckHtml.ts` erzeugt. Die generierte Datei wird niemals direkt bearbeitet.

## Fehlerbehandlung

| Ausfall | Verhalten |
|---|---|
| Modell nicht erreichbar / Guthaben leer / LM Studio aus | **Erinnerungen feuern trotzdem** — sie brauchen kein Modell. Nur Check-ins und Vorschläge entfallen. |
| `agenda.json` / `entries.json` beschädigt | Datei wird als `.corrupt-<zeit>` beiseitegelegt, leer gestartet, **und der Nutzer wird benachrichtigt**. Niemals stillschweigend verlieren. |
| Sammler wirft einen Fehler | Nur dieses Signal fällt aus; kein Signal darf den Sammler töten. |
| Git-Aufruf hängt (iCloud) | Timeout nach 3 s, Projekt bekommt diesmal keinen Git-Stand. |
| Claude-Code-Format ändert sich (heute `version: 2.1.220`) | Betroffenes Feld entfällt, der Rest wird weiter gelesen. |
| Server war längere Zeit aus | Fällige Erinnerungen der letzten **12 Stunden** werden nachgeholt (mit Zusatz „verspätet"), ältere stumm als gefeuert markiert. |
| Kein Push-Token / Handy offline | Nachricht bleibt in der Outbox; der Badge zeigt sie beim nächsten Öffnen. |

## Tests

Der Server nutzt **Nodes eingebauten Test-Runner**, nicht Vitest:
`node --require ts-node/register --test 'src/**/*.test.ts'`. Tests importieren aus
`node:test` und `node:assert/strict`. Vorhandene Testdateien: `prompt.detector.test.ts`,
`approval.util.test.ts`, `ai-provider.test.ts`, `lmstudio.manager.test.ts`.

`prompt.detector.test.ts` injiziert bereits eine Uhr (`new PromptDetector(() => t)`) —
dieses Muster wird für Wecker und Dosierung übernommen, damit Zeitverhalten ohne echtes
Warten testbar ist.

- **Zeitrechnung:** Termin um 14 Uhr bleibt über die Zeitumstellung 14 Uhr; jährlicher
  Termin am **29. Februar** in Nicht-Schaltjahren; Erinnerung um 02:30 in der Nacht der
  Zeitumstellung darf den Wecker nicht blockieren.
- **Nachholfenster:** 11 h alt → nachgeholt; 13 h alt → stumm abgehakt; nichts feuert
  zweimal.
- **Dosierung:** Stundendeckel greift; unterdrückter `topicKey` kommt nie wieder;
  Erinnerungen umgehen den Deckel.
- **Fehlersignatur:** dieselbe Meldung mit anderen Zeilennummern, Pfaden und Zeitstempeln
  normalisiert auf denselben Hash; zwei verschiedene Fehler nicht.
- **Store:** Schreib-/Lese-Rundlauf; absichtlich beschädigte Datei löst den Rettungsweg
  aus.

Nicht testbar und deshalb nicht getestet: ob die Vorschläge des Modells gut sind. Genau
darum ist der Deckel streng — die Kosten eines schlechten Vorschlags müssen klein bleiben.

## Vor der Umsetzung zu verifizieren

1. **OSC-Titel im TMS-PTY.** Dass Claude Code seinen Titel per OSC-Sequenz auch in den
   TMS-PTY schreibt, ist plausibel, aber unbewiesen — die `.zshrc` des Nutzers setzt keine
   Titel, es käme allein von Claude Code. Erster Schritt des Plans: Mitschnitt des rohen
   PTY-Stroms, Suche nach `\x1b]0;` / `\x1b]2;`. Trägt es, kommt es rein; trägt es nicht,
   entfällt nur die Live-Aktualität — Sitzungstitel, `cwd` und `gitBranch` kommen
   garantiert aus den Transkriptdateien.
2. **Island-Layout bei 380 dp** (siehe oben).
3. **Erhebbarkeit des Git-Dirty-Status** ohne `git status`. `ProjectFacts` enthält das Feld
   bewusst **nicht**. Lässt es sich mit Plumbing innerhalb des 3-s-Timeouts zuverlässig
   ermitteln, wird `dirty?: boolean` ergänzt; andernfalls entfällt es ersatzlos.

## Nicht Teil dieser Stufe

- **Stufe 2 — Projekt-Radar:** regelmäßige Recaps je Projekt, tieferes Verständnis der
  `CLAUDE.md`, Vorschläge „was fehlt noch".
- **Stufe 3 — Cockpit-Screen:** eigener Deck-Screen mit Projektstatus, Terminen und
  offenen Einträgen.
- Google-Calendar-Anbindung, `.ics`-Export.
- Umbau von `manager.service.ts` über die zwei genannten Extraktionen hinaus.

## Betriebshinweise

- Der Server läuft als langlebiger Prozess und besitzt alle node-pty-Sitzungen. Ein
  Neustart killt **jede** aktive Terminal-Sitzung, möglicherweise einschließlich der
  Claude-Code-Sitzung, aus der heraus entwickelt wird. Nie unaufgefordert neu starten.
- Server-Logs liegen in `~/.tms-terminal/update.log`; der Nutzer sieht sie nicht.
- `feat/manager-chat-redesign` bewegt sich durch parallele Jobs. Vor jedem Ship den
  Remote-Stand prüfen und patchen statt kopieren.
