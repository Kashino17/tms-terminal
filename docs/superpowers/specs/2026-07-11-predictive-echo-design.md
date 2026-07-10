# Predictive Echo (Lokales Tipp-Echo bei hoher Latenz) — Design Spec

## Zusammenfassung

Bei schlechter Verbindung (Tailscale-Ping 500ms–3s) fühlt sich Tippen im Terminal extrem verzögert an, weil jedes Zeichen erst zum Server muss (`pty.write`), bevor das Echo zurückkommt und in xterm.js angezeigt wird — ein reiner Round-Trip ohne jegliches lokales Feedback.

Fix: Client-seitiges "Predictive Echo" (Mosh-Prinzip) — getippte Zeichen und Backspace werden sofort lokal angezeigt (unterstrichen als "unbestätigt"), bis das echte Server-Echo eintrifft. Betrifft primär die Nutzung mit Claude Code / KI-CLI-Tools (Haupt-Use-Case dieser App), deren Input-Box bei jedem Tastendruck neu gezeichnet wird statt einfachem Zeilen-Echo.

## Anforderungen

- **Scope der Vorhersage:** Nur einzelne druckbare ASCII-Zeichen (Einfügen) und Backspace (Löschen). Pfeiltasten, Enter, Tab, Ctrl+Taste, Emoji/Mehrbyte-Zeichen bleiben reiner Round-Trip wie bisher.
- **Visueller Stil:** Vorhergesagte Zeichen unterstrichen (Mosh-Stil), bis bestätigt — danach normale Darstellung ohne Markierung.
- **Bestätigungs-Logik:** Zeitfenster-Queue (Ansatz A) — vorhergesagte Eingaben gelten als bestätigt, sobald ihr Sendezeitpunkt außerhalb der aktuell gemessenen RTT liegt und echter Server-Output eintrifft. Noch "in flight" befindliche Vorhersagen bleiben sichtbar und werden nach dem echten Output erneut angehängt (kein Geflacker bei durchgehendem Tippen unter 3s Lag).
- **Kein Server-Change, kein WS-Protokoll-Change** für Terminal-Input/-Output. Die bestehende Samsung-IME-Diff-Logik (`terminalHtml.ts:240–379`) bleibt unangetastet.

---

## 1. Betroffene Dateien

| Datei | Änderung |
|---|---|
| `mobile/src/components/terminalHtml.ts` | Prediction-Engine + Rendering (Hauptarbeit) |
| `mobile/src/components/TerminalView.tsx` | RTT-Wert per Bridge-Message in die WebView pushen |
| `mobile/src/services/websocket.service.ts` | RTT-Änderungen nach außen exponieren (Hook/Callback statt nur Getter) |

Prediction hakt sich **nach** `sendKey()` ein (`terminalHtml.ts:145`, der zentrale Funnel-Punkt für allen Input — physische Tastatur wie Soft-Keyboard-Diff) — als paralleler lokaler Render-Schritt, ohne die bestehende Sende-Logik zu verändern.

## 2. Prediction-Trigger

In `sendKey(seq)` klassifizieren, ob `seq` vorhersagbar ist:

- **Insert:** `seq` ist genau 1 Zeichen, druckbar (kein Steuerzeichen, kein Teil einer ANSI-Sequenz aus `SEQ`)
- **Delete:** `seq === SEQ.bs`
- Alles andere → kein Prediction-Pfad, unverändertes Verhalten

## 3. Rendering-Mechanik

Bei vorhersagbarem Tastendruck, **zusätzlich** zum bestehenden `sendToRN({type:'input', data:seq})`:

- **Insert:** Zeichen sofort mit Underline-SGR lokal in xterm schreiben: `term.write('\x1b[4m' + char + '\x1b[24m')`
- **Delete:** Optimistisches Backspace lokal ausführen (Cursor zurück, Zeichen löschen)
- Eintrag `{ char, op: 'insert'|'delete', sentAt: Date.now() }` an `predictionQueue` anhängen

**Offene Verifikations-Annahme (erster Implementierungsschritt):** Claude Code CLI (Ink-basiert) löscht und zeichnet seine Input-Box vermutlich bei jedem Update komplett neu. Falls bestätigt, überschreibt der echte Server-Redraw unsere Vorhersage automatisch — keine manuelle Erase-Logik nötig. Falls nicht, muss vor dem Schreiben des echten Outputs die vorhergesagte Region gezielt gelöscht werden (Cursor um N Zellen zurück + `\x1b[K`). Diese Annahme wird als erster Schritt im Implementierungsplan mit einer echten Claude-Code-Session über die App verifiziert, bevor der Rest darauf aufbaut.

## 4. Reconciliation bei echtem Output

Im bestehenden `output`-Handler (`terminalHtml.ts:676`), vor dem bisherigen `term.write(msg.data, cb)`:

1. `rttEstimate` = zuletzt von RN gepushter RTT-Wert (Fallback: 1000ms, falls noch kein Wert empfangen wurde)
2. Alle `predictionQueue`-Einträge mit `sentAt <= Date.now() - rttEstimate` gelten als bestätigt → aus der Queue entfernen
3. Echten Output wie bisher schreiben (`term.write(msg.data, cb)`)
4. Verbleibende (noch nicht bestätigte) Queue-Einträge erneut rendern (Underline-SGR), damit während des Wartens getippter Text nicht verschwindet

## 5. RTT-Weitergabe an die WebView

`websocket.service.ts` berechnet bereits eine geglättete RTT (`getRtt()`, EMA-basiert) bei jedem Pong, aktuell nur als Getter exponiert. Ergänzung: ein einfacher Callback/Listener (z.B. `onRttChange(cb)`), den `TerminalView.tsx` abonniert und bei jeder Änderung per bestehendem RN→WebView-Bridge-Mechanismus (analog zu `sendToTerminal`) als neue Message in die WebView pusht:

```typescript
{ type: 'rtt', value: number }  // ms, geglättet
```

In `terminalHtml.ts`s `handleMsg` wird dieser Typ zusätzlich behandelt und in einer lokalen Variable für Schritt 4 gehalten.

## 6. Edge Cases

- **WS-Reconnect / Session-Resync:** `predictionQueue` wird geleert, sobald eine Reconnect/Resync-Message eintrifft (z.B. beim erneuten `get_last_lines`/Full-Refresh nach Verbindungsabbruch) — verhindert Ghost-Vorhersagen nach Reconnect.
- **Emoji/Mehrbyte-Zeichen:** Kein Prediction-Pfad (siehe Abschnitt 2) — vermeidet Breiten-Berechnungs-Sonderfälle in xterm.
- **Feld-Clear bei 60 Zeichen** (bestehender Samsung-Puffer-Schutz in `terminalHtml.ts:376`): Operiert auf dem Shadow-Input-Feld, nicht auf dem Terminal-Buffer — keine Interaktion mit Prediction nötig.

## 7. Out of Scope

- Keine Vorhersage für Pfeiltasten/History-Navigation, Enter, Tab, Ctrl+Kombinationen
- Keine eskalierende "stale"-Optik (z.B. rot nach 2s wie in Mosh) — reine Underline-Markierung genügt laut Anforderung; kann später ergänzt werden, falls gewünscht
- Kein Server- oder WS-Protokoll-Change für Input/Output

## 8. Testing

- **Primär manuell:** Verifikation mit künstlich verzögerter Verbindung (z.B. `tc`/Netzwerk-Throttling oder simulierte Latenz im Dev-Setup), Fokus auf durchgehendes Tippen über mehrere Sekunden Lag hinweg — kein sichtbares Verschwinden von bereits getipptem Text.
- **Unit-testbar:** Die Queue-Confirm/Prune-Logik aus Abschnitt 4 (reine Funktion: Liste `{sentAt}` + `rttEstimate` + `now` → bestätigt/pending-Split) wird als eigenständige, isolierte Funktion extrahiert und unit-getestet.
