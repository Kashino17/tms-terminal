# Diktat-Bubble 2.0 — Tempo, Wörterbuch, Denkpausen, Flüstern

Stand: 2026-11-11 · Branch `feat/fernzugriff` · Vorgänger: `2026-11-07-dictation-streaming-design.md`, `2026-11-07-dictation-bubble-design.md`

Vorschau zum Antippen (maßgeblich für Aussehen und Bedienung): `mockups/diktat-plan/app/liquid-deck/index.html?view=diktat` (Server: `node mockups/diktat-plan/serve.js`, Tailscale `:8541`). Rückmeldungen des Nutzers: `mockups/diktat-plan/v1/feedback.json` (erste Runde), `mockups/diktat-plan/feedback.json` (zweite Runde).

## Warum

Diktieren ist das Hauptwerkzeug des Nutzers: 508 Diktate in vier Tagen, 6 h 11 min Ton, typische Länge 32 s, längstes 6:32 min. Er will Wispr-Flow-Gefühl: **Text steht unter 0,7 s nach dem Stopp da**, und Fachbegriffe stimmen.

Ausgangswunsch war „Umformulieren wie Wispr“ (perfekter Prompt, E-Mail, WhatsApp). Nach Messung und zwei Rückmelde-Runden hat der Nutzer das **gestrichen**: Der vorhandene „KI-Prompt-Modus“ verlor an seinem eigenen 534-Wörter-Diktat 48 % des Inhalts und erfand Dinge; das will er nicht riskieren. Übrig bleibt, was bei der Arbeit hilft.

## Befund (gemessen / im Code belegt)

- **Nur 16 % der Diktate kommen heute unter 0,7 s an**, Mitte 1,5 s, 90 % unter 3,3 s (Server-Log 7.–11.11., ohne jede Umformulierung). Nach Länge: bis 10 s → 0,5 s; 10–30 s → 1,0 s; 30–60 s → 2,0 s; länger → 2,2–2,4 s.
- **Ursache:** `dictation.segment.ts` schneidet erst ab 72 s gepuffertem Ton (`CHUNK_SECS = 60`, Faktor 1,2). Alles darunter wird erst nach dem Stopp transkribiert. Kosten je Whisper-Aufruf (large-v3, MLX): rund 0,25 s fest plus 0,036 s je Sekunde Ton (3,4 s → 0,36 s; 14,5 s → 0,72 s; 43 s → 1,78 s; 60 s → 2,4 s).
- **Hochladen im 2-s-Takt:** `PUMP_INTERVAL_MS = 2000` (`useDictation.ts`) und `PUMP_MS = 2000` (`DictationBubbleService.kt`). Die letzten bis zu 2 s Ton erreichen den Server erst mit dem Stopp.
- **Jeder Durchlauf dekodiert alles neu:** `transcribeReady` ruft `decode(Buffer.concat(s.parts))` auf die gesamte Aufnahme. Heute selten (ein Durchlauf je 60 s), bei kurzen Stücken wäre das teuer.
- **Whisper-Sidecar arbeitet seriell** (ein Auftrag nach dem anderen).
- **Wörterbuch heute:** fester `INITIAL_PROMPT` in `whisper_sidecar_mlx.py`, dazu eine feste Hörfehler-Liste im Prompt des Rewriters. Nichts davon ist für den Nutzer sichtbar oder änderbar. In seinem Diktat stand „Whisperflow“ und „Vispa Flow“.
- **Leise Sprache:** `trim_silence` (Schwelle RMS 0,003) verwirft sehr leises Sprechen als Stille; `normalize_level` hebt danach an.
- **KI-Prompt-Modus:** in 583 gestarteten Diktaten nie benutzt (`enhance` stand nie im Log). Der Sidecar lädt Llama 3.2 3B, weil die Pfade in `LOCAL_CANDIDATES` nicht mehr existieren.
- **Bubble-Bedienungshilfe** hört nur auf `typeViewFocused|typeWindowStateChanged|typeWindowsChanged|typeViewClicked` — Textänderungen bekommt sie nicht gemeldet. Die Bubble läuft im eigenen Prozess `:bubble`; jede zusätzliche Dauerlast dort kostet Akku (siehe v1.129.1 und v1.147.0).

## Ziele

1. **Tempo:** Stopp → Text unter 0,7 s bei jeder Länge. Messbar gemacht: Mitte ≤ 0,5 s und mindestens 90 % der Diktate ≤ 0,7 s über die letzten 50 Diktate. Gemessen wird wie bisher im Server-Log: vom Eintreffen des Stopps bis zum fertigen Text (ohne Netzweg), damit die Zahlen mit dem Befund vergleichbar sind.
2. **Wörterbuch:** Begriffe und Hörfehler, die der Nutzer sieht, ändert und löscht. Lernt **von selbst** aus seinen Korrekturen. Wirkt ohne Wartezeit.
3. **Denkpausen:** Eine Sprechpause ab einer einstellbaren Länge steht als `...` im Text.
4. **Flüstermodus:** Leises Sprechen wird verstanden.
5. **Einstellungen:** Seite „Diktat & Sprache“ mit drei Reitern (Wörterbuch · Diktat · Bubble). Alle Einstellungsseiten matt statt Glas.
6. Der KI-Prompt-Modus verschwindet vollständig.

## Nicht-Ziele

- Kein Umformulieren, Kürzen, Gliedern. Keine Stufen „Gegliedert“, „Nachricht“, „E-Mail“.
- Keine Stile je App, keine App-Erkennung.
- Keine Cloud. Alles läuft auf dem Mac; nichts verlässt die Geräte.
- Kein „Aufräumen“ (Füllwörter entfernen). Gemessen möglich (Qwen 3.6 35B-A3B, 0,62 s je 30-Wörter-Stück, kein Inhaltsverlust), vom Nutzer abgewählt. Falls es je zurückkommt: Der Nutzer nannte das Modell „Flint“ (Recursive, 40B, laut Hersteller etwa 130 Tokens/s auf Apple-Chips) als Kandidaten; es denkt aber standardmäßig vor jeder Antwort — erst messen.
- Keine Liste „Letzte Diktate“, keine Markierung unsicherer Wörter, kein Verlauf.
- Keine Textbausteine, kein Befehlsmodus.

## Was auf keinen Fall passieren darf

- **Text geht verloren oder wird verändert**, außer durch einen Wörterbuch-Eintrag oder ein `...`. Das Wörterbuch ersetzt nur ganze Wörter beziehungsweise Wortfolgen, nie Wortteile.
- **Das Tempo wird schlechter als heute.** Jede Stufe wird gegen die heutigen Werte gemessen, bevor sie bleibt.
- **Die Erkennung wird ungenauer**, weil Stücke kürzer sind. Gegenprobe siehe „Prüfung“.
- **Die Bubble frisst wieder Akku.** Kein Dauer-Mithören von Textänderungen.
- **Das Wörterbuch lernt Unsinn** und verfälscht danach still Diktate. Alles automatisch Gelernte ist sichtbar und mit einem Tipp rückgängig.

## Teil A — Tempo

Prinzip wie bisher: arbeiten, während der Nutzer spricht. Neu ist, dass nach dem Stopp fast nichts mehr übrig ist.

**A1 · Kürzere Stücke (nur Server).** Ein Stück wird geschnitten, sobald seit dem letzten Schnitt mindestens `MIN_SEGMENT_SECS` Sprache gepuffert ist und danach eine Sprechpause liegt; spätestens nach `MAX_SEGMENT_SECS`. Startwerte: 8 s und 28 s (unter Whispers 30-s-Fenster), Pause = mindestens 0,3 s niedrige Energie. Die Werte sind Stellschrauben; maßgeblich ist die Prüfung unten. Geschnitten wird weiterhin in der Mitte der Pause.

**A2 · Vorauseilen (Server).** Endet der zuletzt angekommene Ton in einer Pause von mindestens 0,4 s und liegt davor noch nicht transkribierte Sprache, wird dieses Reststück sofort transkribiert und als Vorab-Ergebnis mit seiner End-Position gemerkt — auch wenn es kürzer ist als `MIN_SEGMENT_SECS`. Kommt danach der Stopp ohne neue Sprache, ist das Vorab-Ergebnis das Ergebnis. Kommt neue Sprache, gilt: war das Reststück lang genug für einen regulären Schnitt, wird es übernommen; sonst verworfen und später mit dem Folgenden zusammen transkribiert. Vorauseilen startet nur, wenn der Sidecar frei ist; läuft beim Stopp gerade ein passender Vorab-Auftrag, wird auf ihn gewartet statt neu zu rechnen.

**A3 · Schneller hochladen (App und Bubble).** Takt von 2000 ms auf 500 ms in `useDictation.ts` und `DictationBubbleService.kt`. Ohne das sieht der Server die letzte Sprechpause erst mit dem Stopp, und A2 greift selten. Der Bauende prüft, dass der `ConnectionRateLimiter` vier `dictation:chunk` je Sekunde durchlässt.

**A4 · Nicht alles neu dekodieren (Server).** Mit vielen Durchläufen darf `decode` nicht jedes Mal die ganze Aufnahme anfassen. Entweder nur die neuen Bytes ab einer ADTS-Rahmengrenze dekodieren und anhängen, oder ein gleichwertiger Weg — Entscheidung beim Bauenden. Format `file` (alter Weg ohne Streaming) bleibt, wie es ist.

**A5 · Messen.** Der Server schreibt je Diktat: Länge, Stopp→Ergebnis, Länge des Rests nach dem Stopp, ob das Vorab-Ergebnis getroffen hat. Die letzten 50 Werte liegen in `~/.tms-terminal/dictation-stats.json` und speisen die Tempo-Anzeige (Teil E). Nur Zahlen, kein Text. Die App holt sie zusammen mit dem Wörterbuch ab.

**Erwartung (gerechnet, nicht gemessen):** A1 + A4 allein, also nur Server-Neustart: etwa 0,5–0,7 s. Mit A2 + A3 (braucht App-Release): etwa 0,3 s, wenn zwischen letztem Wort und ✓ rund eine halbe Sekunde liegt. Die Planseite hatte „braucht nur einen Server-Neustart“ behauptet — das gilt nur für A1/A4/A5.

**Genauigkeit:** Whisper bekommt bei kurzen Stücken weniger Zusammenhang. Ausgleich: Jedes Stück bekommt als Prompt die Wörterbuch-Begriffe (Teil B). Ob zusätzlich das Ende des vorigen Stücks mitgegeben wird, entscheidet der Bauende anhand der Gegenprobe.

## Teil B — Wörterbuch

**Daten.** `~/.tms-terminal/dictionary.json` auf dem Rechner, der transkribiert. Ein Eintrag: richtige Schreibweise (`term`), Liste der Hörfehler (`heard`, kann leer sein), Herkunft (`manual` oder `learned`), Zähler `uses`, Zeitpunkte, und bei Gelerntem `fresh` bis zur Bestätigung oder bis sieben Tage vergangen sind. Beim ersten Start wird die Datei mit den Begriffen aus dem heutigen `INITIAL_PROMPT` und der Hörfehler-Liste des Rewriters gefüllt, damit nichts schlechter wird. Speichern nach dem Muster von `titles.store.ts`.

**Wirkung 1 — besser hören.** Der Whisper-Prompt wird je Auftrag aus den Begriffen gebaut statt aus der festen Konstante. Whispers Prompt ist begrenzt (rund 220 Tokens): Reihenfolge nach `uses`, frisch Angelegtes zuerst, auffüllen bis zur Grenze. Der Sidecar bekommt dafür ein Feld im Auftrag; fehlt es, gilt der heutige feste Prompt.

**Wirkung 2 — Hörfehler ersetzen.** Nach dem Transkribieren jedes Stücks: jedes `heard` → `term`, ohne Rücksicht auf Groß-/Kleinschreibung, nur an Wortgrenzen, längste Treffer zuerst. Reine Textersetzung in Node, keine messbare Wartezeit. Jeder Treffer erhöht `uses`.

**Lernen von selbst.** Nach dem Einfügen merkt sich der einfügende Teil (Bubble beziehungsweise App) den eingefügten Text. Er liest den Feldinhalt genau einmal wieder: wenn das nächste Diktat im selben Feld beginnt, oder wenn das Feld den Fokus verliert, höchstens aber zwei Minuten später. **Kein Abonnieren von Textänderungen.** Hat sich im eingefügten Abschnitt etwas geändert, schickt er das Paar (vorher, nachher) an den Server. Der Server vergleicht wortweise und lernt nur Ersetzungen von ein bis drei Wörtern durch ein bis drei Wörter, die eine Lernregel bestehen:

- das Neue klingt ähnlich wie das Alte (Buchstaben-Abstand relativ zur Länge unter einer Schwelle),
- das Neue ist kein gewöhnliches Alltagswort,
- es ist keine reine Änderung von Satzzeichen oder Groß-/Kleinschreibung am Satzanfang.

Beispiele, die die Regel treffen muss: „Vispa Flow“ → „Wispr Flow“ lernen; „Cloud Code“ → „Claude Code“ lernen; „morgen“ → „übermorgen“ **nicht** lernen; „drei“ → „vier“ **nicht** lernen; ein gelöschter oder neu geschriebener Satz → nichts lernen. Die genaue Regel (Schwelle, woher die Alltagswörter kommen) legt der Bauende fest und belegt sie mit diesen Fällen als Test. Der Nutzer arbeitet im Lern-Modus und kann diese eine Funktion selbst schreiben wollen — vorher anbieten.

Gelerntes wirkt sofort und erscheint unter „Neu gelernt“. In der App selbst (Eingabezeile der WebView) läuft es über die Bridge: verglichen wird in dem Moment, in dem die Eingabe abgeschickt oder geleert wird. In fremden Apps hängt das Wiederlesen davon ab, was die App der Bedienungshilfe zeigt; klappt es nicht, wird einfach nichts gelernt.

**Nachrichten.** Liste holen, Eintrag anlegen, ändern (Schreibweise, Hörfehler hinzufügen/entfernen), löschen, Gelerntes bestätigen oder rückgängig machen, Lern-Paar einreichen; der Server meldet Änderungen an alle verbundenen Apps. Das Lern-Paar muss auch über die schlanke Bubble-Verbindung (`?role=dictation`) gehen. Namen und Form der Nachrichten nach dem Muster der bestehenden `dictation:*`-Nachrichten, Typen in `shared/`.

**Mehrere Geräte (Bund).** Das Wörterbuch gehört zu dem Rechner, über den diktiert wird (heute das MacBook). Die Einstellungsseite spricht mit genau diesem Rechner. Kein Abgleich zwischen Rechnern.

## Teil C — Denkpausen

Beim Dekodieren werden Sprechpausen ohnehin gesucht. Ist eine Pause zwischen zwei Sprech-Abschnitten mindestens so lang wie die eingestellte Schwelle (1, 2 oder 3 s; Standard 2 s), wird an ihr geschnitten — auch vor `MIN_SEGMENT_SECS` — und die beiden Texte werden mit ` ... ` verbunden statt mit einem Leerzeichen. Stille am Anfang und am Ende der Aufnahme zählt nicht. Ist die Einstellung aus, ändert sich nichts.

Die Schwelle reist mit `dictation:start` (die Einstellung liegt auf dem Handy, App und Bubble kennen sie). Fehlt das Feld: keine Denkpausen.

Schreibweise: drei einzelne Punkte, davor und danach ein Leerzeichen. Hängt Whisper am Stück-Ende selbst einen Punkt an, bleibt es bei genau drei Punkten.

## Teil D — Flüstermodus

Schalter am Handy, reist mit `dictation:start`. Der Server senkt für diese Aufnahme die Stille-Schwelle von `trim_silence` und der Pausen-Erkennung und hebt den Pegel vor beidem an. Auf dem Handy bleibt die Aufnahme wie sie ist, solange der Gerätetest nichts anderes verlangt.

**Unbelegt:** Die richtigen Schwellen kennt niemand, bevor am Fold geflüstert wurde. Mehr Empfindlichkeit kann zu Hall-Wörtern („Vielen Dank.“) führen — der Halluzinations-Filter bleibt aktiv. Darum als Schalter, ab Werk aus, und als letzter Teil.

## Teil E — Einstellungen

Quelle ist das Mockup (`mockups/season2/liquid-deck/settings.js` + `settings.css`, danach `npm run build:season2`). Die Vorschau in `mockups/diktat-plan/app/liquid-deck/` zeigt den Zielzustand; ihr `DW`-Block und die `.dw-*`-Regeln sind die Vorlage, die Beispieldaten darin nicht.

- **Alle Einstellungsseiten matt:** Karten deckend (`--card-matte`), ohne Unschärfe — Startseite und alle Unterseiten.
- **„Diktat & Sprache“** bekommt drei Reiter, die beim Scrollen oben stehen bleiben. Standard-Reiter: Wörterbuch.
  - **Wörterbuch:** „Neu gelernt“ (Paar alt → neu, Herkunft, ✕ rückgängig, ✓ bestätigen; nur sichtbar, wenn es Neues gibt; der Reiter trägt die Anzahl als Abzeichen). Darunter „Alle Begriffe“: ein Feld, das beim Tippen die Liste filtert und mit „Hinzufügen“ einen neuen Begriff anlegt; Filter Alle / Von dir / Gelernt; je Zeile Begriff, bekannte Hörfehler, Zähler; Aufklappen zeigt die Hörfehler als entfernbare Schilder, die Herkunft und „Löschen“. Zusätzlich muss man im aufgeklappten Eintrag einen Hörfehler von Hand ergänzen können (fehlt in der Vorschau).
  - **Diktat:** Tempo-Karte (Mitte der letzten 50 Diktate, Anteil unter 0,7 s, kleine Balkenreihe mit Ziel-Linie; ohne Daten ein ruhiger Leerzustand). „Denkpausen als …“ mit Schwelle 1/2/3 s. „Flüstermodus“. „Aus Korrekturen lernen“ (ab Werk an).
  - **Bubble:** die heutigen Zeilen unverändert (Mikrofon in allen Apps, anzeigen, Pause, Hintergrund-Schutz, Fehlersuche). Bei Warnzustand trägt der Reiter einen gelben Punkt.
- Zeile der Kategorie auf der Startseite: Bubble-Zustand · Anzahl Begriffe · Tempo.
- Ist der Diktat-Rechner nicht erreichbar, zeigt der Reiter Wörterbuch das statt einer leeren Liste.
- Texte auf Deutsch, Code und Kommentare auf Englisch, wie im Projekt üblich.

## Teil F — Entfernen

Schalter „KI-Prompt-Modus“ und alles dahinter: Einstellung `voicePromptEnhanceEnabled` (Store, `SeasonTwoWebRoot.tsx`, Seite), das Feld `enhance` beim Senden (App und `BubbleConfig`), auf dem Server `rewrite` in `DictationDeps`, `acceptRewrite`, der Zweig im alten `audio:transcribe`, `prompt-rewriter-sidecar.ts`, `prompt_rewriter_sidecar.py` samt Tests und Start/Stopp des Sidecars. Der Server muss ein `enhance` von einer alten App weiterhin klaglos annehmen und ignorieren. Auch die klassische Oberfläche auf einen solchen Schalter prüfen.

## Reihenfolge

Jeder Schritt ist für sich nutzbar und wird gemessen, bevor der nächste beginnt.

1. **Tempo, Server-Teil** (A1, A4, A5) — wirkt nach Server-Neustart.
2. **Tempo, Geräte-Teil** (A2, A3) — App-Release.
3. **Wörterbuch + neue Einstellungen + Entfernen** (B ohne Lernen, E, F).
4. **Lernen von selbst** (B, Lern-Teil).
5. **Denkpausen** (C).
6. **Flüstermodus** (D).

## Prüfung

- **Tempo:** `server/scripts/dictation-e2e.ts` um den neuen Takt erweitern; Aufnahmen von 10 s, 45 s, 3 min und 6 min, jeweils mit und ohne Pause vor dem Stopp. Vorher/nachher-Tabelle. Danach echte Nutzung über die Tempo-Anzeige gegen Ziel 1.
- **Genauigkeit:** dieselben Aufnahmen mit alter und neuer Stückelung transkribieren und die Texte wortweise vergleichen. Abweichungen ansehen; wird es spürbar schlechter, `MIN_SEGMENT_SECS` anheben oder Vortext mitgeben, bevor ausgeliefert wird.
- **Wörterbuch:** Ersetzen an Wortgrenzen (kein Treffer mitten im Wort), Groß-/Kleinschreibung, längster Treffer zuerst; Lernregel mit den Beispielen oben; Speichern übersteht einen Neustart; beschädigte Datei wird nicht still überschrieben.
- **Denkpausen:** Aufnahme mit bekannten Pausen von 1,5 s und 2,5 s bei Schwelle 2 s → genau ein `...`.
- **Bubble:** Akku-Gegenprobe nach dem Messrezept aus v1.129.1 (CPU-Zeit des `:bubble`-Prozesses über 60 s App-Wechsel) vor und nach dem Lern-Teil.
- **Einstellungen:** gebaute Seite headless bei 412×915 und aufgeklappt prüfen, wie bei den bisherigen Season-2-Änderungen.

## Dem Bauenden überlassen

Namen und genaue Form der Nachrichten; die Stellschrauben in Teil A; inkrementelles Dekodieren oder gleichwertig; die genaue Lernregel; die Flüster-Schwellen; Aufteilung in Dateien; ob Vortext an Whisper mitgegeben wird.

## Meine Entscheidungen (nicht vom Nutzer bestätigt)

- Wiederlesen des Feldes genau einmal statt Dauer-Mithören (Akku).
- Wörterbuch pro Diktat-Rechner, kein Abgleich im Bund.
- „Neu gelernt“ bleibt sieben Tage sichtbar und gilt danach als bestätigt.
- Erstbefüllung des Wörterbuchs aus den heutigen festen Listen.
- Hörfehler von Hand ergänzbar (in der Vorschau nicht gezeigt).
- Flüstermodus zuletzt und ab Werk aus.
- Reihenfolge: Tempo vor Wörterbuch, obwohl der Nutzer am Wörterbuch am meisten hängt — der Server-Teil ist klein und wirkt bei jedem Diktat.
