# Quality of Life in V1 und V2 — und die Gebetszeiten in V2

**Datum:** 2026-10-01
**Branch:** `feat/fernzugriff`
**Betrifft:** `mobile/src/services/prayer.service.ts`, `mobile/src/services/adhan.service.ts`,
`mobile/src/components/AdhanAlert.tsx`, `mobile/src/season2/`,
`mobile/android/app/src/main/java/com/tms/terminal/Adhan*.kt`,
`mobile/src/screens/TerminalScreen.tsx`, `mobile/src/components/ToolMenu.tsx`

## Ziel

Die App hat zwei Oberflächen: die klassische (`seasonTwoEnabled = false`) und die neue Liquid-Glass-Oberfläche
(`seasonTwoEnabled = true`, Route `SeasonTwo`, gerendert als WebView über
`mobile/src/season2/SeasonTwoWebRoot.tsx`). Die neue ist inzwischen der Haupteinstieg, aber sie kennt die
Gebetszeiten nur als Attrappe: die Zeiten stehen im Mockup, der Adhan-Knopf öffnet einen Ring mit „Stopp".

Diese Spec macht drei Dinge:

1. **Die Gebetszeiten kommen als echtes Feature in V2** — inklusive **Schalter, mit dem sich der Adhan
   aktivieren lässt**, inklusive der Berechtigungen und inklusive der Regeln, was passiert, wenn das Handy
   gesperrt ist oder gar nicht läuft.
2. **Vier Befunde werden behoben**, die heute Funktionen stumm schalten: die Alarme werden in V2 nie
   geplant, `cancelAllAlarms()` trifft nie, Werkzeuge verschwinden endgültig, und es gibt keinen einzigen
   Test für Gebetszeiten.
3. **Eine geordnete Liste von Use Cases und QoL-Features**, die in dieser App noch Nutzen bringen, nach
   Aufwand und Nutzen in drei Wellen sortiert.

Der Kern der Aussage: **das Adhan-Feature hängt an genau einem `useEffect` im `HomeScreen`.**
`mobile/src/screens/HomeScreen.tsx:47-63` plant die Alarme. In V2 wird `HomeScreen` nie gerendert, also
existiert in V2 kein einziger geplanter Alarm — der Bildschirm zeigt die Uhrzeit, aber es klingelt nie.
Das ist der Grund, warum es „nur bei V1" funktioniert, und es ist kein Layout-Problem, sondern ein
Ort-Problem: Der Scheduler hängt an einem Bildschirm.

---

## Wie dieser Stand ermittelt wurde

- Gelesen im Live-Worktree `~/Desktop/tms-terminal`, Stand `896b65e` = **v1.121.1**.
- **Achtung, dieser Punkt betrifft jede Änderung an der V2-Oberfläche:**
  `mobile/scripts/build-season2-html.js:16` hat `MOCKUP_DIR` fest auf
  `/Users/ayysir/Desktop/TMS Terminal/mockups/season2` verdrahtet. Gebaut wird im Live-Worktree,
  bearbeitet wird die Oberfläche im **anderen** Worktree. Eine Änderung an
  `~/Desktop/tms-terminal/mockups/season2/liquid-deck/index.html` hat **keine Wirkung**, und umgekehrt ist
  die Kopie im Live-Worktree eine ältere, abweichende Fassung (dort fehlen `data-screen="remote"`, der
  Fernzugriff, `TMS-TEST-EXPORT` und die gemeinsame Zwischenablage).
- Es gibt **kein** `mobile/src/season2` im Worktree `~/Desktop/TMS Terminal`. Wer in die falsche Kopie
  schaut, findet das Feature nicht und glaubt, es gebe es nicht.

---

## Ist-Zustand: die beiden Oberflächen

|  | **V1 (klassisch)** | **V2 (Liquid Glass)** |
|---|---|---|
| Einstieg | `HomeScreen` | `SeasonTwo` → `SeasonTwoWebRoot` |
| Rendern | native React-Native-Screens | **eine WebView** über `LIQUID_DECK_HTML` (`baseUrl: 'https://tms.local'` — nur im sicheren Kontext gibt Chrome WebCodecs frei) |
| Schalter | — | `seasonTwoEnabled`, Default `false`, Einziger Ort: V1-Einstellungen → „Design" |
| Umschalten | `App.tsx:120` setzt `key` auf dem `NavigationContainer` → ganzer Remount | Rückweg aus V2: Brücken-Message `nav:classic` |
| Werkzeug-Welt | `ToolMenu` + Orb-Layer + Panels | `#toolSheetBody` + Sheets in `useSheetBridges.ts` |
| Einstellungen | **echt**, alle Schalter | fast alles **Attrappe**; die Bridge hängt nur eine Gruppe „Oberfläche" dran (`bridge.js:2453-2477`) |
| App-Sperre | **echt** (`useLockStore`, `LockScreen`) | Demo-PIN `1234` aus dem Mockup, ohne Bezug zur echten Sperre |

**Inhaltlich fehlt in V2 gegenüber V1** (hart belegt, kein Ermessen):

- **Gebetszeiten** — nur Liste + Countdown-Karte + Demo-Button, kein Alarm, keine Einstellungen
- Zeichnen-Screen · Autopilot · Split-View · Hydra · Dashboard
- SQL-Ausführung (V2 zeigt nur erkannte Statements, lesend)
- Prozesse beenden, Watcher anlegen/testen, Port-Forwarding bearbeiten (in V2 nur Listen)
- `client:app_state` und `client:active_tab` — V2 sendet sie nie, damit fehlt der KI in V2 jedes
  Vorder-/Hintergrund-Signal
- Persistierter Scrollback wird geschrieben (`scrollbackStore`), aber nie zurückgespielt — `getScrollback` ist
  in `SeasonTwoWebRoot.tsx:42` importiert und wird nirgands aufgerufen
- Server hinzufügen: die HTML-Seite kann es nicht, es gibt nur ein natives Onboarding-Overlay

---

## Befunde, die vor dem Featurebau weg müssen

### B1 — Der Adhan-Scheduler hängt am `HomeScreen`

`mobile/src/screens/HomeScreen.tsx:47-63` — ein `useEffect` auf `prayerData`, der
`cancelAllAdhanNotifications()` aufruft und dann `scheduleAdhanForPrayer()` für Fajr, Dhuhr, Asr, Maghrib,
Isha absetzt. Das ist der einzige Ort in der App, der Alarme plant.

Konsequenzen:

- In V2: **kein Alarm**, Punkt.
- Es gibt **keinen** `AppState`-Listener, der beim Zurückkehren in die App neu plant. Wer die App schließt
  und um 20 Uhr wieder öffnet, hat für den Rest des Tages keine Alarme mehr.
- Der 30-Sekunden-`setInterval` in `HomeScreen.tsx:40-43` und `PrayerTimesScreen.tsx:62-65` setzt einen
  `now`-State, der im JSX nirgends gelesen wird. Er ist eine tote Uhr, kein Taktgeber.

**Beschluss:** Planen gehört in einen Dienst, der einmal in `App.tsx` hängt und bei
`AppState → active`, nach `bridge:ready` und nach jedem Serverwechsel neu plant. Nicht in einen Bildschirm.

### B2 — `cancelAllAlarms()` trifft nie

`mobile/android/app/src/main/java/com/tms/terminal/AdhanModule.kt:57-76` bildet den Request-Code als
`(name + "00:00").hashCode()`, `scheduleAlarm()` (`:31`) dagegen als `(name + prayerTime).hashCode()`.
Die Codes können nicht übereinstimmen — `HomeScreen.tsx:54` bricht also **keinen** alten Alarm ab.
Umgekehrt heißt das: Jedes Umplanen legt zusätzliche Alarme an, deren `PendingIntent`s beim nächsten
`FLAG_UPDATE_CURRENT`-Aufruf mit gleichem Namen **überschrieben** werden — aber nur bei gleicher Uhrzeit.
Nach einem Methoden- oder Zeitzonenwechsel bleiben die alten stehen.

**Beschluss:** Request-Code aus dem Gebetsnamen allein bilden (`name.hashCode()`), damit Planen und
Abbrechen dieselbe Identität benutzen. Vorher eine Absicherung: der Hash-Algorithmus ändert sich zwischen
Kotlin-Versionen — statt `hashCode()` ein festes Schema (`PRAYER_SLOT_FAJR = 0` … `ISHA = 4`).

### B3 — Nach dem Neustart des Handys sind alle Alarme weg

`RECEIVE_BOOT_COMPLETED` ist im Manifest deklariert (`AndroidManifest.xml:20`), es gibt aber keinen
Receiver. `AlarmManager`-Alarme überleben keinen Neustart. Wer das Handy über Nacht lädt, bekommt am
Morgen keinen Fajr-Wecker.

**Beschluss:** Ein `AdhanBootReceiver` startet nach `BOOT_COMPLETED` **nicht** die Activity, sondern meldet
sich bei React Native; das Neoplanen passiert dann im Dienst aus B1. Zusätzlich wird geprüft, ob nach einem
App-Update (Prozess-Kill) die Termine noch stehen — das ist der Fall, in dem das Handy nie neu gestartet,
sondern nur die App beendet wurde.

### B4 — Es gibt keinen einzigen Test für Gebetszeiten

`mobile/**/*.{test,spec}.{ts,tsx}`: keine Treffer. `mobile/package.json` kennt nur `test:mockup`
(`node --test scripts/*.test.mjs`), und in keinem der fünf Tests kommt `prayer` oder `adhan` vor.

Getestet werden könnte sofort und ohne Gerät: `getNextPrayer()`, `getPrayerProgress()`, `hasPassed()`,
`formatRemaining()` sind reine Funktionen. `scheduleAdhanForPrayer()` hat eine reine
`diffSec`-Berechnung, die man mit injizierter Uhr testen kann.

**Beschluss:** `mobile/scripts/prayer.test.mjs` entsteht **vor** dem V2-Umbau, nicht danach. Wer die
Gebetszeiten in ein zweites Layout überträgt, ohne die Rechenlogik vorher festzunageln, baut auf Sand.

### B5 — Werkzeuge verschwinden endgültig, zwei sind tot

- `mobile/src/components/ToolMenu.tsx:166-175` kann Sektionen anlegen, umbenennen, löschen — aber es gibt
  kein „Werkzeug hinzufügen". Ein entferntes Werkzeug ist für die Sitzung weg.
- `mobile/src/screens/TerminalScreen.tsx:880` führt `supabase` in `panelTools` auf,
  `renderPanelContent` (`:904-948`) hat aber keinen `case 'supabase'` → **leeres 50-%-Sheet**.
- `ToolMenu.tsx:32` definiert `drawing`, `SpotlightPanel.tsx:51` benutzt `draw` → über Spotlight passiert
  beim Zeichnen **nichts** (`return false`).
- `processes` existiert in `ToolRail.tsx:21`, nicht in `TOOL_ICON_MAP` (`ToolMenu.tsx:19-34`) → über das
  Werkzeugmenü nicht erreichbar.
- `ToolRail` (`:6-7` importiert, nie gerendert), `TerminalTabs`, `NotesPanel` (kein einziger Import),
  `SplitViewPanel` (nirgends importiert) sowie die komplette native Season-2-Variante
  (`mobile/src/season2/SeasonTwoRoot.tsx` + `season2/components/*` + `season2/screens/*`) sind toter Code,
  aber gepflegt.

**Beschluss:** Toter Code wird entweder verdrahtet oder gelöscht — nicht liegen gelassen. Ein totes
Werkzeug, das man nicht zurückholen kann, ist schlimmer als ein fehlendes.

### B6 — Zwei Adhan-Dialoge, ein Notification-Handler

- `App.tsx:125-138` rendert ein globales `<AdhanAlert>` **ohne** die `wecker`-Prop und
  `PrayerTimesScreen.tsx:381-399` ein zweites **mit**. Beide hängen am selben
  `addNotificationReceivedListener`. Ein Ereignis → zwei Modals.
- `notifications.service.ts:6-14` und `adhan.service.ts:160-170` setzen beide beim Import einen globalen
  `setNotificationHandler` mit unterschiedlichem `shouldShowAlert`. Wer zuletzt geladen wird, gewinnt —
  abhängig von der Importreihenfolge.

**Beschluss:** Genau ein Adhan-Dialog, genau ein Handler (Task 3 der Spec-Umsetzung).

---

## Use Cases, die die App wirklich tragen muss

Aus `memory/user.md` und dem tatsächlichen Bedienablauf abgeleitet, nicht aus einer Feature-Liste erfunden:

| # | Use Case | Wie er heute läuft | Wo es klemmt |
|---|---|---|---|
| U1 | **6–8 Terminals parallel**, jedes an einem Projekt | Tab-Leiste + Kategorien, Zwei-Finger-Wechsel | Umbenennen ist tot (B5), Kategoriewechsel nur über nicht gerenderte `TerminalTabs` |
| U2 | **Nach Stunden zurückkommen** und wissen, was gelaufen ist | Push-Nachricht, Zeitstempel auf der Karte | Kein Briefing: kein „3 Tasks fertig, 1 wartet auf Freigabe", kein Zeitverlauf |
| U3 | **Claude hängt an einer Berechtigungsfrage**, während das Handy in der Tasche ist | FCM + `type:'idle'` | Nur ein Ping; in V2 kommt kein `client:app_state`, die KI kennt den Zustand nicht |
| U4 | **Unterwegs, Handy liegt ab, Bildschirm aus** | `persistentConnection`, `ConnectionService` | Kein Fokus-Modus: Adhan, Manager-Push und IDLE-Ping kommen alle gleichzeitig |
| U5 | **Gebet**: Handy klingelt wie ein Wecker, bleibt Vollbild, bis „Laut"/„Stumm" oder 5 Minuten | V1: `AlarmManager` + `AdhanFullscreenActivity` | **In V2 existiert nichts** (B1). Und in V1: kein Boot-Receiver (B3), `cancel` defekt (B2) |
| U6 | **Mac fern bedienen** (Bildschirm, Maus, Tastatur) | V2: komplett im WebView, H.264 + WebCodecs | Kein Weg zurück in V1 nötig — funktioniert |
| U7 | **Deploy überwachen** (Vercel/Render) | Cloud-Screen mit Polling | Nur manuell aufrufen; kein Push bei „build failed" |
| U8 | **Eine Datei vom Mac holen**, ohne FTP/GUI | Datei-Explorer mit `cd` ins Terminal | Pfad-Links im Terminal sind tot (`toolRailRef` nie befüllt, `TerminalScreen.tsx:821`) |

Der Plan richtet sich an U1–U5. U6 ist fertig, U7/U8 sind Werkzeugpflege.

---

## Getroffene Entscheidungen

| Frage | Entscheidung | Warum |
|---|---|---|
| Wo plant der Adhan? | In einem app-weiten Dienst `adhanScheduler`, gestartet in `App.tsx` | Der Bildschirm darf nicht der Grund für einen Alarm sein. Löst V2 und V1 gleichzeitig. |
| Wird der Vollbild-Adhan in V2 nativ oder im HTML gemacht? | **Nativ**, unverändert `AdhanFullscreenActivity` | Kein WebView kann `FLAG_TURN_SCREEN_ON` und `DISMISS_KEYGUARD`. Der HTML-Ring bleibt eine Vorschau für den Testknopf. |
| Bekommt V2 einen echten Alarmschalter? | Ja — neue Settings-Gruppe „Gebetszeiten" in der V2-Einstellungsseite | Der Auftrag lautet „aktiviert werden kann". Der Schalter muss in V2 stehen, nicht versteckt in V1 bleiben. |
| Wie kommen die Daten in die Seite? | `setPrayer` wird **payload-rückwärtskompatibel** erweitert, nicht ersetzt | `bridge.js:2326` schreibt heute ein flaches Array. Der Mockup-Zähler liest `p.name`/`p.time` und muss unangetastet weiterlaufen. |
| Welche Berechnungsmethode? | Persistiert, Default MWL (3), in V1 **und** V2 wählbar | `PrayerTimesScreen.tsx:53` hält `method` nur in `useState`; alle anderen Aufrufer sind auf 3 festgenagelt (`HomeScreen.tsx:86`, `useSheetBridges.ts:271`, `SeasonTwoRoot.tsx:163`). |
| Stadt oder GPS? | GPS als Default, **manuelle Koordinate/Stadt als Fallback** | `prayer.service.ts:49-91` gibt bei verweigerter Permission `null` zurück und dann ist das ganze Feature tot — auch der Bildschirm. |
| Wie viele Datenpunkte? | 6 (inkl. Sunrise) + Datum/Hijri + Ort | V2 zeigt heute 5, ohne Sunrise (`useSheetBridges.ts:272-275`). V1 zeigt 6 plus Hijri. |
| Passwortmanager-Berechtigungen in V2? | Nicht | Klartext-Passwörter im ausgelieferten HTML (`BROWSER_PASSWORDS`) sind ein eigenes Thema, kein QoL. |
| Toter Code? | Delete, wo er nicht verdrahtet wird | Siehe B5. Ein toter Bildschirm, der gepflegt aussieht, kostet bei jeder Änderung Zeit. |

---

## Welle A — Reparaturen (B1–B6)

Kleine, abgeschlossene Vorarbeiten. Jede für sich auslieferbar, zusammen die Grundlage für Welle B.

### A1 — `adhanScheduler` (beseitigt B1)

Neue Datei `mobile/src/services/adhanScheduler.ts`:

```
start(): void            // idempotent, App-Lebensdauer
refresh(reason): Promise<void>   // abbrechen + neu planen
stop(): void
```

Aufrufpunkte: `App.tsx` nach `loadLockConfig()`, ein `AppState`-Listener auf `active`, ein `Ticker` auf
`bridge:ready` (damit V2 nach dem Umschalten plant), und nach jedem Serverwechsel in `SeasonTwoWebRoot`.

Der Dienst liest die Einstellungen **selbst** aus dem AsyncStorage, statt den Zustand von einem Bildschirm
zu bekommen. `scheduleAdhanForPrayer()` wird um einen injizierbaren Zeitgeber erweitert
(`now: () => number = Date.now`), damit die `diffSec`-Rechnung testbar wird.

### A2 — Alarme abbrechen und exakt stellen (beseitigt B2, teilweise B3)

- Feste Request-Codes `0…4` statt `hashCode()` in `AdhanModule.kt`, identisch in `scheduleAlarm` und
  `cancelAllAlarms`.
- `canScheduleExactAlarms()` wird **vor** dem ersten Planen geprüft. Fehlt die Freigabe, wird in den
  Einstellungen eine Zeile „Exact Alarme fehlen — jetzt erlauben" mit Deep-Link auf
  `ACTION_REQUEST_SCHEDULE_EXACT_ALARM` eingeblendet. Heute fällt die App still auf
  `setAndAllowWhileIdle` zurück und der Wecker klingelt ein paar Minuten zu spät.
- `POST_NOTIFICATIONS` wird einmal beim ersten Aktivieren abgefragt statt nur im Expo-Fallback, der auf
  Android mit vorhandenem `AdhanModule` nie läuft.

### A3 — `AdhanBootReceiver` (beseitigt B3)

Broadcast-Empfänger auf `BOOT_COMPLETED` und `MY_PACKAGE_REPLACED`. Er zeigt **keine** Activity, sondern
schreibt ein Marker-Flag; `App.tsx` sieht das beim nächsten Start und plant einmal neu. Kein Vollbild beim
Booten — das wäre der falsche Moment.

### A4 — Ein Dialog, ein Handler (beseitigt B6)

`PrayerTimesScreen.tsx:381-399` lässt sein lokales `<AdhanAlert>` fallen und übergibt an `App.tsx`.
Der Notification-Handler wird **einmal** in `notifications.service.ts` gesetzt; `adhan.service.ts`
rührt ihn nicht mehr an.

### A5 — Werkzeuge heilen (beseitigt B5)

`supabase` bekommt ein Panel oder fliegt aus `panelTools` — die Wahl wird getroffen, nicht offengelassen
(Empfehlung: fliegt raus, `SQLPanel` kann die Supabase-Verbindung schon). Spotlight benutzt `drawing`.
`processes` kommt in `TOOL_ICON_MAP`. `ToolMenu` bekommt einen „Werkzeug hinzufügen"-Picker aus dem
vorhandenen Katalog. `toolRailRef` wird entweder befüllt oder `handlePathClick` entfernt.

### A6 — Tests für die Rechenlogik (beseitigt B4)

`mobile/scripts/prayer.test.mjs` für `getNextPrayer`, `getPrayerProgress`, `hasPassed`,
`formatRemaining`, `getFajrWecker`-Bedingung und die `diffSec`-Berechnung. Vorbereitung für Welle B,
weil dort dieselben Funktionen in zwei Layouts gebraucht werden.

---

## Welle B — Gebetszeiten in V2 (der Kern des Auftrags)

### B-1 Datenfluss

```
prayer.service ──► adhanScheduler ──► adhan.service ──► AlarmManager ──► AdhanAlarmReceiver
                                          │                                      │
                                          │                             AdhanFullscreenActivity
                                          │                             (Vollbild, Ton, Vibration)
                                          ▼
                        SeasonTwoWebRoot ──call('setPrayer', payload)──► HTML-Seite
                                                                       (Liste, Countdown-Karte, Insel)
```

Der Service bleibt die einzige Quelle. Die Seite **plant nichts** — sie zeigt nur an und kann Wünsche
posten. Das ist wichtig, weil die Seite jederzeit neu geladen werden kann und die WebView im Hintergrund
schon mal stundenlang JS ausführt (das ist beim Browser-Feffer dokumentiert und der Grund für dessen
`visible`/`onScreen`-Logik).

### B-2 Was in die Seite hineingeht

`window.TMSBridge.setPrayer(times, meta)` — Aufruf bleibt rückwärtskompatibel:

| Feld | heute | neu |
|---|---|---|
| `times[]` | `{name, time}` | `{name, de, ar, emoji, time}` |
| `times[].time` | `"HH:MM"` | `"HH:MM"` (+ roher API-Wert in `meta.raw`) |
| `meta.location` | — | `{label, lat, lon}` |
| `meta.date` | — | `{readable, hijri}` |
| `meta.method` | — | `{id, name}` |
| `meta.adhan` | — | `{enabled, wecker, selected}` |
| `meta.perms` | — | `{notifications, exactAlarms}` |

Fällt `meta` aus (Aufruf aus einem alten Pfad), bleibt das Verhalten exakt wie heute: Liste plus
Countdown-Karte. Der Mockup-Zähler `nextPrayer()` (`index.html:2564`) liest `p.time` und `p.name` und wird
nicht angefasst.

Neu in der Seite, sichtbar wenn `meta` da ist: Sunrise in der Liste, Datum und Hijri unter der Karte,
Ortszeile, Fortschrittsbalken zwischen letztem und nächstem Gebet, Berechnungsmethode als Umschalter.

### B-3 Was von der Seite zurückkommt

| Nachricht | Richtung | Zweck |
|---|---|---|
| `adhan:toggle` | Seite → RN | `{enabled}` — schaltet die Alarmierung um, Dienst plant sofort neu |
| `adhan:method` | Seite → RN | `{method}` — persistiert, Zeiten neu laden, neu planen |
| `adhan:wecker` | Seite → RN | `{enabled}` — Fajr-Wecker |
| `adhan:reciter` | Seite → RN | `{id}` — Auswahl; die Seite ruft selbst `preview` auf |
| `adhan:preview` | Seite → RN | Ton 10 s an/aus |
| `adhan:test` | Seite → RN | `scheduleTestAdhan(..., 10, …)` — derselbe Weg wie der V1-Testknopf |
| `adhan:perms` | Seite → RN | Deep-Link für `POST_NOTIFICATIONS` / `ACTION_REQUEST_SCHEDULE_EXACT_ALARM` |

Alle sieben werden **vor** dem Guard `if (!wsService || !server) return;` in `SeasonTwoWebRoot.tsx:845`
abgehandelt: Gebetszeiten brauchen keinen Server. Genau das ist der Grund, warum das Feature heute in V2
stumm ist, obwohl eine Verbindung besteht.

### B-4 Die Einstellungen in V2

Die V2-Einstellungsseite bekommt eine Gruppe **„Gebetszeiten"**, gesetzt von der Bridge neben die
bestehende Gruppe „Oberfläche" (`bridge.js:2453-2477`):

- Zeile **Azān-Benachrichtigung** — Schalter, Untertitel „Klingelt bei Gebetszeit wie ein Anruf"
- Zeile **Fajr Wecker** — nur sichtbar, wenn Azān an
- Zeile **Rezitateur** — Wert „Mishary / Nafees / Mansour", tippen → Liste mit Preview-Knopf je Eintrag
- Zeile **Berechnung** — Wert „MWL / ISNA / Egypt / Makkah / Karachi", tippen → Liste
- Zeile **Ort** — Wert Stadt/„GPS aktiv", tippen → Liste gespeicherter Orte + „GPS verwenden"
- Zeile **Genauigkeit** — nur sichtbar, wenn `canScheduleExactAlarms()` fehlt, mit „Jetzt erlauben"

Der Schalter ist derselbe AsyncStorage-Schlüssel `tms-adhan-enabled`, den V1 liest. **Kein** neuer Store,
keine doppelte Wahrheit.

### B-5 Das Adhan-Overlay in V2

Das Mockup-Overlay (`index.html:2243-2249`, `openAdhanOverlay` `:9019`) wird von der Bridge zu einer
**Vorschau** ausgebaut: Gebets-Hintergrundbild, arabischer Name, Uhrzeit in Monospace, zwei Knöpfe
(„Stumm"/„Laut"), pulsierender Ring. Es wird **nur** aufgerufen, wenn die Seite selbst den Testknopf oder
eine Vorschau benutzt — nie von einem Alarme. Der echte Alarm bleibt `AdhanFullscreenActivity`.

Grund, im Plan festgehalten: Solange der echte Alarm nativ bleibt, ist der HTML-Dialog Deko. Eine
spätere Stufe könnte den Vordergrund-Alarm in die Seite legen (App im Vordergrund), aber nur als
Zweitsignal neben der nativen Activity, nie statt ihr.

**Ein Fund dabei:** `index.html:1733` blendet das Overlay per
`body.is-locked #adhanOverlay { display: none !important; }` aus. Richtig für die Demo — ein
Gebetsalarm darf bei gesperrtem Gerät aber **gerade** sichtbar sein. Die Regel bleibt für den Demo-PIN
Lock, wird für `adhan:preview` aber aufgehoben.

### B-6 Zustände und Fehler

| Ausfall | Verhalten |
|---|---|
| Keine Standort-Permission | Screen zeigt „Standort fehlt" mit „Erlauben"-Knopf; **der Adhan-Schalter bleibt bedienbar** ( manuelle Orte, B-4) |
| `api.aladhan.com` nicht erreichbar | Letzte erfolgreiche Zeiten bleiben stehen, mit „Stand: <Zeit>"-Hinweis; kein leerer Screen |
| `canScheduleExactAlarms()` fehlt | Einstellungenzeile „Genauigkeit"; Alarm klingelt ungenau, aber er klingelt |
| Kein `POST_NOTIFICATIONS` | Adhan läuft trotzdem — er kommt über `AlarmManager` und die Activity, nicht über FCM |
| App wurde beendet, Prozess-Kill | Beim nächsten Start plant A1 neu; bis dahin steht der letzte Stand |
| Handy neu gestartet | `AdhanBootReceiver` (A3) markiert, beim nächsten Start neu geplant |
| Uhrzeit/App-Zeitzone weicht von der API-Zone ab | `prayer.service.ts` interpretiert API-Zeiten als **lokale** Uhr (`new Date(y,m,d,h,m)`, `:126`). Bekannt, wird im Plan als bewusste Grenze festgehalten, nicht in dieser Stufe behoben — die Werte stammen vom Aladhan-Server in der Geräte-Zone, in der Regel stimmt das. |

### B-7 Was sich in V1 ändert

Nichts Sichtbares. `PrayerTimesScreen` behält Layout und Verhalten; die Methode wird persistiert
(`useSettingsStore`, AsyncStorage-Key `tms-prayer-method`), damit V1 und V2 dieselbe Auswahl teilen.
Der Testknopf bleibt. Das lokale `<AdhanAlert>` verschwindt zugunsten des globalen (A4).

---

## Welle C — QoL-Features mit den größten Nutzen

Nach Nutzen/Aufwand geordnet. Jeder Punkt nennt den Ort, damit er später direkt eingeplant werden kann.

### C1 — „Lage"-Briefing beim Zurückkommen (U2)

Ein Bildschirm bzw. eine Karte, die die Fragen beantwortet, die nach zwei Stunden Abwesenheit offenbleiben:
welche Sessions noch laufen, welche seitdem fertig wurden, was auf eine Freigabe wartet, welche Tasks im
Autopilot-Queue stehen, ob ein Deploy durch ist. Server-Daten, die heute schon fließen (`terminal:prompt_detected`,
`manager:activity`, `render:*_deploy_status`, Watcher-Treffer) — es ist eine Aggregation, kein neues Backend.
**Ort:** neue Karte im V2-Overview, in V1 als erste Kachel im `HomeScreen`.
**Aufwand:** mittel. **Nutzen:** hoch, weil es den häufigsten Moment der App adressiert.

### C2 — Fokus-Modus (U4)

Ein Schalter, der alles stumm schaltet außer dem, was man wirklich braucht: IDLE-Push aus, Manager-Push aus,
Adhan bleibt (oder auch nicht), Bildschirm bleibt an (`expo-keep-awake`, im Terminal bereits beim Diktat
gemacht). Gerade für die Aufnahme-Situation aus dem September, in der das Display während der
Spracheingabe dunkel wurde. **Ort:** `settingsStore.focusMode`, Wächter in `App.tsx`.
**Aufwand:** klein. **Nutzen:** hoch.

### C3 — Terminal-Beschriftung wieder beleben (U1, B5)

`handleRenameTab` und `handleChangeCategory` existieren in `TerminalScreen.tsx:736,778` und hängen an
`TerminalTabs`, das nie gerendert wird. In V2 hat die Karte bereits ein Kebab-Menü — dort ist der Einstieg
eine Zeile. **Aufwand:** klein. **Nutzen:** mittel-hoch, weil 8 unbenannte Terminals nicht unterscheidbar sind.

### C4 — Automatische Benennung nach Projekt

Der Server kennt das Arbeitsverzeichnis jedes Terminals. Ein Vorschlag „3 Terminals in
`~/Desktop/tms-terminal` → gemeinsame Kategorie" mit einem Klick. Die Kategorien gibt es bereits
(`paneGroupsStore`), es fehlt die Zuordnung aus dem `cwd`. **Ort:** Server `terminal.manager.ts` +
Kebab-Menü der Karte in V2. **Aufwand:** mittel. **Nutzen:** hoch für den 6–8-Sessions-Alltag.

### C5 — „An den Manager schicken" aus jedem Output (U1, U3)

Im Kebab-Menü einer Terminal-Karte: die letzten N Zeilen plus Terminal-Name und Pfad als Kontext an den
Manager-Agenten. Der Kanal existiert (`manager:*`), es fehlt der Einstieg. Spart den Umweg
Kopieren → Manager → erklären, welches Terminal gemeint ist. **Aufwand:** klein.
**Nutzen:** hoch.

### C6 — `client:app_state` / `client:active_tab` in V2 nachziehen

V1 sendet beide, V2 nie. Die KI antwortet in V2 ohne zu wissen, ob der Nutzer das Handy gerade ansieht.
Reine Verdrahtung: `SeasonTwoWebRoot` → `wsService.send` bei `setAppActive` (`:1256-1262`, existiert
bereits) und bei Kartenwechsel. **Aufwand:** klein. **Nutzen:** mittel, aber es ist eine stille
Qualitätsverschlechterung, die mit der Zeit alle Antworten schlechter macht.

### C7 — Scrollback zurückholen

`scrollbackStore` schreibt, `getScrollback` wird nie gelesen. Nach einem Reconnect ist die Karte leer,
obwohl der Verlauf auf der Platte liegt. **Aufwand:** klein bis mittel. **Nutzen:** mittel-hoch — der
Moment „Reconnect und alles weg" ist ärgerlich.

### C8 — Werkzeug-Historie / Undo für gesendete Zeilen

Ein Verlauf der letzten ~50 `terminal:input`-Absendungen pro Sitzung mit „erneut senden". Gerade bei
Fehlbedienung im Falt-Handy: ein Tippfehler geht an Claude und wird ausgeführt. **Aufwand:** mittel.
**Nutzen:** mittel-hoch.

### C9 — Globale Snippets

`SnippetsPanel` ist pro Terminal. Wer 6–8 Sessions hat, will dieselben Befehle überall. Heute schon
naheliegend, weil die Liste in `SnippetsPanel.tsx:18-40` ohnehin global ist. **Aufwand:** klein.
**Nutzen:** mittel.

### C10 — Deploy-Push

Ein Cloud-Projekt mit laufendem Build bekommt „build failed"/„live" als Push, über die vorhandene
Manager-/FCM-Infrastruktur. **Ort:** `server/src/cloud/`, `fcm.service.send`. **Aufwand:** mittel.
**Nutzen:** mittel.

### C11 — Gebetszeiten der nächsten Tage

Der Aladhan-Endpunkt liefert den ganzen Tag. Ein kleiner „+ morgen"/3-Tage-Umblätter macht aus dem
Gebetszeiten-Screen einen brauchbaren Kalender. **Aufwand:** klein. **Nutzen:** mittel — und es ist die
natürliche Ergänzung zu B.

---

## Tests

| Ebene | Was | Wie |
|---|---|---|
| Rechenlogik | `getNextPrayer`, `getPrayerProgress`, `hasPassed`, `formatRemaining`, `diffSec`-Berechnung, Fajr-Wecker-Bedingung | `mobile/scripts/prayer.test.mjs`, `node:test` + `node:assert/strict`, Uhr injiziert |
| Scheduler | `refresh` plant genau einmal pro Gebet, `enabled = false` plant nichts, Vergangenes wird übersprungen, `AppState → active` löst `refresh` aus | `mobile/scripts/adhan-scheduler.test.mjs` mit gefälschtem AsyncStorage und gefälschtem `NativeModules.AdhanModule` |
| Bridge-Payload | `setPrayer` mit und ohne `meta`; alte Form rendert weiterhin Liste + Countdown | `mobile/scripts/prayer-bridge.test.mjs` — braucht einen `TMS-TEST-EXPORT`-Block im Mockup oder eine reine Funktion in `bridge.js` |
| Mockup-Zähler | `nextPrayer()` mit 5 Werten, mit 6 Werten, über Mitternacht | `TMS-TEST-EXPORT`-Block im Mockup, `term-text.test.mjs` als Vorbild |
| Regressionsschutz | V1 verhält sich unverändert | `npm run test:mockup` bleibt grün, `./release.sh` + Test auf dem Fold |

**Nicht testbar und deshalb nicht getestet:** ob der Ton auf dem Gerät klingt, ob der Lockscreen aufgeht,
ob die Vibration „genug" ist. Diese drei Punkte werden bei der Abnahme am Gerät geprüft, mit Log-Beleg
(`adb logcat -s AdhanAlarmReceiver`).

---

## Nicht Teil dieses Features

- **iOS-Pfad für den Adhan.** Es gibt kein `ios/`-Verzeichnis, `AdhanModule` ist reines Kotlin, und
  `expo-notifications` ist im Hintergrund unzuverlässig. Der V2-Screen funktioniert auf iOS (Daten), der
  Alarm nicht. Das ist eine eigene Spec.
- **Server-Push für den Adhan.** Der Weg über `AlarmManager` ist vorhanden und richtiger — er braucht kein
  Netz und funktioniert bei ausgeschaltetem Tailscale.
- **Kalender-Integration / ICS-Export.** Nett, aber eine eigene Baustelle (Berechtigungen, Sync, Duplikate).
- **Neue Berechnung der Gebetszeiten** (offline, ohne API). `prayer.service` ruft die API; das ist die
  richtige Entscheidung für Korrektheit.
- **Passwortmanager-Berechtigungen in V2.** Siehe oben.
- **Terminals aufteilen/schließen nach Projekt** (C4 konzentriert, nicht ausgebaut).
- **C10 und C11** sind Vorschläge, nicht beauftragt. Sie stehen in dieser Spec, damit sie nicht verloren
  gehen — der Plan umfasst Welle A und B.

---

## Verifiziert / noch zu verifizieren

**Verifiziert (2026-10-01, im Live-Worktree gelesen):**

- Der Scheduler sitzt ausschließlich in `HomeScreen.tsx:47-63`. **bestätigt.**
- In V2 gibt es kein `postMessage`, das einen Adhan-Termin anfordert. **bestätigt** (Suche über
  `bridge.js`, `useSheetBridges.ts`, `SeasonTwoWebRoot.tsx`).
- Der Mockup-Zähler `nextPrayer()` braucht nur `p.name`/`p.time` → `meta` ist additiv. **bestätigt**
  (`index.html:2554-2578`).
- `body.is-locked` blendet das Adhan-Overlay aus. **bestätigt** (`index.html:1733`).
- `cancelAllAlarms` und `scheduleAlarm` benutzen verschiedene Request-Codes. **bestätigt**
  (`AdhanModule.kt:31` und `:65`).
- `getScrollback` wird nicht aufgerufen. **bestätigt** (einzige Fundstelle ist der Import in
  `SeasonTwoWebRoot.tsx:42`).
- Für Gebetszeiten existiert kein Test. **bestätigt** (Suche über `mobile/**/*.test.*` und
  `scripts/*.test.mjs`).

## Verifiziert nach der Umsetzung (2026-10-01)

**Automatisch geprueft — 84 Tests in `npm run test:mockup` (83 gruen, 1 uebersprungen) plus 8 in
`npm run test:webview`, `tsc --noEmit` ohne Fehler.**

### Drei stumme Fehler, die nur der Browser gesehen hat

Alle drei lagen **ausserhalb jeder `.ts`-Datei** — `tsc` konnte sie nicht sehen, und keiner der fuenf
vorhandenen Mockup-Tests either. Jeder haette die Oberflaeche funktionierend aussehen lassen und
nichts getan:

1. **Doppelter `<script>`-Tag im Build.** `prayerBridge.js` bekam vom Build-Skript seine Tags noch
   einmal mit, obwohl das Template sie schon hatte. Die Seite startete mit einem `SyntaxError`,
   `window.__tmsNormalizePrayer` existierte nie, `bridge.js` fiel auf seinen Rueckfallzweig zurueck —
   **der `meta`-Anteil wurde stillschweigend verworfen**. Die Adhan-Gruppe waere nie erschienen,
   ohne eine einzige Fehlermeldung.
2. **`post()` zur falschen Zeit gebunden.** Das Mockup stand `var post = window.__tmsPost || function(){}`
   — ausgewertet beim Laden des Mockups, also **vor** der Bruecke. Fuer die ganze Seitenlaufzeit war
   `post` eine leere Funktion: **jeder** Schalter (Azān, Fajr-Wecker, Rezi, Methode, Ort, Test,
   Genauigkeit) waere Dekoration gewesen.
3. **Eine CSS-Regel, die sich selbst ausgehebelt hat.** `.adhan-overlay__sub, .adhan-overlay__stop {
   display: none }` sollte „in der Vorschau nicht zeigen" bedeuten — es verbarg aber **immer**,
   auch den Schliessen-Knopf und die Zeile „Vorschau".

Alle drei stehen jetzt in `mobile/scripts/webview-prayer.test.mjs`. Gegenprobe: jeder Fehler wurde
einzeln wieder eingebaut, alle drei schlagen an.

**Der Test braucht Playwright, das nicht im Repo liegt.** Er laeuft nur mit gesetztem `TMS_VIZ_PW` und
meldet sich sonst als uebersprungen, statt eine neue Abhaengigkeit zu ziehen. `npm run test:mockup`
bleibt download-frei und gruen.

### Nachgemessen (Screenshots bei 380x915 und 412x915)

- Gebetszeiten-Screen: sechs Zeilen inkl. Sunrise, Orts-/Datums-/Hijri-/Methodenzeile, Countdown
  `HH:MM:SS`, Fortschrittsbalken, Insel zeigt „Asr - 3:26h". **Kein abgeschnittenes Wort.**
- Einstellungen: die Gruppe „Gebetsruf (Azān)" steht mit **allen sieben Zeilen** vollstaendig im Bild,
  nachdem der `<section data-screen="settings">` (nicht `.screen-col`) in den Sichtbereich gescrollt
  wurde. **Kein abgeschnittenes Wort.**
- Overlay: Vorschau bei gesperrtem Bildschirm sichtbar, reine Anzeige versteckt; Stumm/Laut und
  Schliessen erscheinen wie gewollt, Uhrzeit und arabischer Name gefuellt.
- Alle acht `adhan:`-Nachrichten kommen bei der App an; ungueltige Koordinaten werden abgelehnt.

### Gepruefte Einzelbefunde

- Der Scheduler sitzt jetzt in `services/adhanScheduler.ts`, nicht mehr im `HomeScreen`. **geaendert.**
- Fuer die Gebetszeiten gibt es Tests: 9 Rechenlogik, 10 Planung, 7 Bridge-Vertrag, 5 Zaehler der
  Seite, 3 Nachrichtenreihenfolge, 8 im Browser. **vorher 0.**
- Die acht `adhan:`-Nachrichten liegen alle **vor** dem Verbindungs-Guard, und ein Test haelt das fest
  (`scripts/bridge-guard.test.mjs`). Ein zweiter haelt ausdruecklich fest, dass `server:switch` dort
  **bleibt** — damit beim naechsten Aufraeumen nicht beide gleichgezogen werden.
- `cancelAllAlarms` benutzt denselben festen Slot wie `scheduleAlarm` (1...5 statt zweier
  `hashCode()`-Formeln). **geaendert.**
- `setPrayer(times, meta)` ist additiv: ohne `meta` zeigt die Seite exakt wie vorher. **wie geplant.**
- Der Demo-Schalter `adhanNotif` ist weg; ohne `meta` erscheint die Gruppe nicht. **geaendert.**
- `body.is-locked` blendet das Overlay jetzt **nur ohne** `.is-preview` aus. **geaendert.**
- Die Berechnungsmethode liegt im Store `prayerStore` und wird von V1 und V2 geteilt.
- Ortswahl als Fallback zum GPS: ohne Berechtigung ist das Feature nicht mehr blind.
  **ergaenzt, in der Spec nicht geplant.**

**Zwei Punkte aus dem Plan sind bewusst anders gelaufen:**

- **Task 4 (Boot-Receiver) entfaellt.** `RECEIVE_BOOT_COMPLETED` ohne Empfaenger war ein echter Befund,
  aber ein Receiver haette nichts behoben: er kann keinen Alarm stellen, weil er zum Planen Standort
  und Zeiten braucht. Der Scheduler plant bei jedem App-Start und bei jedem Zurueckkehren in den
  Vordergrund neu — damit ist der Neustart abgedeckt, sobald die App das naechste Mal aufgeht. Der
  verbleibende Randfall (Neustart, App nie geoeffnet) ist ohne Empfang von Standort nicht loesbar und
  steht als Kommentar in `App.tsx`.
- **Zwei Notizspeicher heissen beide gleich.** `store/notesStore` (serverseitig) und
  `season2/store/notesStore` (pro Karte im HTML) exportierten `useNotesStore`. Der zweite heisst jetzt
  `useS2NotesStore` — er ist aber **nicht** der tote Code aus Task 6, sondern lebendig. In der Spec
  stand, einer der beiden solle weg; das waere eine Verhaltensaenderung gewesen.

**Nebenbei gefunden und mitbehoben:**

- **`nextPrayer()` im Mockup mischte zwei Zeitpunkte**: `parsePrayerTime` las gegen `new Date()`,
  waehrend der Vergleich gegen das uebergebene `now` lief. In der App dasselbe, also unauffaellig —
  aber testbar war die Funktion dadurch nicht. `parsePrayerTime` bekommt jetzt den Bezugstag.

**Noch am Geraet zu bestaetigen — dafuer gibt es hier keinen Ersatz:**

- Der Gradle-Build. Ohne Netz findet Gradle `foojay-resolver-convention` nicht, und es liegt auch
  nicht im Cache. Mit sauberem Arbeitsbaum tritt derselbe Fehler auf, er ist also vorbestehend.
- Kommt `AdhanFullscreenActivity` bei ausgeschaltetem Bildschirm und gesperrtem Geraet zuverlaessig
  hoch? (Im Code richtig. Auf Android 14 haengt es zusaetzlich an `USE_FULL_SCREEN_INTENT`.)
- Wie weit liegt `setAndAllowWhileIdle` zurueck, wenn keine exakten Alarme erlaubt sind?
- Ueberleben die geplanten Alarme ein `am force-stop`? Wenn nein, braucht der Scheduler zusaetzlich
  einen periodischen Refresh statt nur `AppState`.
- Die V1-Ansicht laesst sich nur auf dem Geraet beurteilen; hier gibt es kein Geraet.

## Selbstprüfung des Plans

| Spec-Abschnitt | Task | Stand |
|---|---|---|
| B1 Scheduler hängt am HomeScreen | 2 | erledigt |
| B2 `cancelAllAlarms` trifft nie | 3 | erledigt |
| B3 Nach Neustart keine Alarme | 4 | anders gelöst, s. o. |
| B4 Kein Test für Gebetszeiten | 1 | erledigt, 29 Tests |
| B5 Werkzeuge verschwinden / sind tot | 5, 6 | erledigt |
| B6 Zwei Dialoge, ein Handler | 3 | erledigt |
| B-1 Datenfluss | 2, 7 | erledigt |
| B-2 `setPrayer` additiv erweitern | 7 | erledigt |
| B-3 Nachrichten vor dem Guard | 8 | erledigt, 8 statt 7 |
| B-4 Einstellungen-Gruppe in V2 | 8 | erledigt |
| B-5 Overlay als Vorschau, `is-locked` | 9 | erledigt |
| B-6 Zustände und Fehler | 8, 10 | erledigt, Ortswahl kam dazu |
| B-7 V1 ändert sich nur minimal | 3, 10 | erledigt |
| Welle C (C1–C11) | — | nicht in diesem Plan, steht in der Spec |