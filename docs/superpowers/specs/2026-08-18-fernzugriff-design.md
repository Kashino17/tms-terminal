# Fernzugriff (Remote Desktop) — Design

**Datum:** 2026-08-18
**Status:** abgestimmt, bereit für den Umsetzungsplan

## 1. Ziel

Vom Handy aus den Bildschirm des verbundenen Rechners sehen und ihn bedienen — unterwegs
über Tailscale, ohne fremde Fernwartungssoftware. Einstieg auf der Gerätekarte in der
Verbindungsliste. Oben das gespiegelte Bild, darunter eine Leiste, die zwischen Trackpad
und Tastatur umschaltet. Hängen Tastatur und Maus am Handy, füllt das Bild auf Knopfdruck
den ganzen Schirm.

## 2. Festgelegte Rahmenbedingungen

| Frage | Entscheidung |
|---|---|
| Zielplattformen | macOS **und** Windows, beide von Anfang an |
| Anspruch | „richtig arbeiten“ — ~25–30 fps, unter 150 ms Verzögerung |
| Monitore | nur der Hauptbildschirm, kein Umschalter |
| Externe Hardware | Vollbild-Modus wird **manuell** umgeschaltet, keine Automatik |
| Layout | Variante C: Bild oben, darunter **eine** Leiste, umschaltbar Trackpad ↔ Tastatur |
| Technikweg | eigener Stack: H.264 vom PC über eine eigene WebSocket-Verbindung, eigene Eingabe-Übersetzung |

Linux ist nicht im Umfang. Die Plattform-Schnittstellen sind so geschnitten, dass eine
dritte Umsetzung später ohne Umbau danebenpasst.

## 3. Architektur

Der Bildstrom umgeht React Native vollständig.

Die App ist der Liquid-Deck-Mockup in einem WebView. Die Brücke zwischen React Native und
WebView überträgt nur Text — Videodaten müssten also base64-kodiert werden (ein Drittel
mehr Daten, 30-mal pro Sekunde durch zwei JavaScript-Laufzeiten). Deshalb öffnet **die
Seite im WebView ihre eigene WebSocket-Verbindung** direkt zum Server.

```
PC (Server)                                  Fold (App)
┌──────────────────────────┐                 ┌───────────────────────────┐
│ ScreenCaptureKit/ddagrab │                 │  WebView (Liquid Deck)    │
│         ↓                │                 │                           │
│   H.264-Encoder (GPU)    │                 │   WebCodecs-Decoder       │
│         ↓                │  ws:///remote   │         ↓                 │
│   Access-Unit-Zerteiler ─┼───binär────────►│   Canvas                  │
│                          │                 │         ↓                 │
│   Eingabe-Injektor  ◄────┼───JSON──────────┤   Trackpad / Tastatur     │
│   (CGEvent / SendInput)  │                 └───────────────────────────┘
└──────────────────────────┘
```

React Native reicht der Seite nur Host, Port und Token — dieselben Werte, die es heute
schon für den In-App-Browser und die Server-Umschaltung durchgibt — und meldet ihr, wenn die
App in den Hintergrund geht oder zurückkommt (`AppState`; das browserseitige
`visibilitychange` ist im Android-WebView dafür unzuverlässig). Bilddaten sieht es nie, und
den Sitzungszustand führt allein die Seite.

**Die gesamte Fernzugriffs-Sitzung liegt auf der `/remote`-Verbindung**, nicht auf der
bestehenden. Grund: die Videoverbindung braucht ohnehin eine eigene Wiederverbindungs-Logik;
Start und Stop zusätzlich über die Hauptverbindung zu führen, hielte denselben Zustand an
zwei Orten. Authentifiziert wird identisch — `authenticateWebSocket` prüft den Token schon
am HTTP-Upgrade, der Server bekommt lediglich eine Pfad-Weiche davor: `/remote` geht in den
neuen Handler, alles andere weiter in `handleConnection`.

**Dekodiert wird mit WebCodecs, nicht mit MediaSource.** MediaSource puffert, um
ruckelfrei abzuspielen — beim Fernzugriff ist genau dieser Puffer der Feind. WebCodecs
nimmt einzelne Access Units entgegen und liefert das Bild sofort.

**Kompression aus.** Die bestehende Verbindung komprimiert Nachrichten ab 128 Byte
(`perMessageDeflate`). H.264-Daten sind bereits komprimiert; ein zweiter Durchgang kostet
nur Rechenzeit. Die `/remote`-Verbindung sendet mit `compress: false`.

**Erwartete Verzögerung:** 16–30 ms Aufnahme und Kodierung, 20–60 ms Netz über Tailscale,
~16 ms Dekodieren und Zeichnen → **60–120 ms**.

## 4. Protokoll

Neue Typen in `shared/protocol.ts` als eigene Union `RemoteClientMessage` /
`RemoteServerMessage` — sie gehören zur `/remote`-Verbindung und **nicht** in
`ClientMessage` / `ServerMessage` der Hauptverbindung.

### Steuerung (JSON, Text-Frames)

App → Server:

```ts
{ type: 'remote:start',   payload: { maxWidth: number; fps: number; bitrateKbps: number } }
{ type: 'remote:stop' }
{ type: 'remote:quality', payload: { preset: 'auto' | 'sparsam' | 'scharf' } }
{ type: 'remote:keyframe' }          // Vollbild anfordern (nach Wiederverbinden)
```

Server → App:

```ts
{ type: 'remote:started', payload: { width, height, scale, fps, codec: 'avc1' } }
{ type: 'remote:stopped', payload: { reason: string } }
{ type: 'remote:error',   payload: { code: RemoteErrorCode; message: string } }
{ type: 'remote:status',  payload: { fps, kbps, rttMs, dropped } }   // 1× pro Sekunde
```

```ts
type RemoteErrorCode =
  | 'permission_screen'      // macOS: Bildschirmaufnahme nicht freigegeben
  | 'permission_input'       // macOS: Bedienungshilfen nicht freigegeben
  | 'capture_unavailable'    // Windows: ffmpeg fehlt / kein Encoder
  | 'helper_crashed'         // Helfer dreimal hintereinander gestorben
  | 'disabled'               // remote.enabled = false
  | 'unsupported_platform';
```

`width`/`height` sind die **Pixelmaße des aufgenommenen Bildes**, `scale` der Faktor zur
logischen Auflösung des Systems (auf Retina-Macs typisch 2). Die App braucht beides für die
Beschleunigungskurve des Trackpads.

**Verhältnis von `remote:start` zu `remote:quality`:** die Werte in `remote:start` sind der
Ausgangspunkt, `remote:quality` setzt sie zur Laufzeit neu. Die Stufen sind fest:

| Stufe | maxWidth | fps | bitrateKbps |
|---|---|---|---|
| `sparsam` | 1280 | 24 | 800 |
| `auto` (Vorgabe) | 1600 | 30 | 1500 |
| `scharf` | 1920 | 30 | 3000 |

Die Rückstau-Regelung aus `bitrate.ts` arbeitet in **allen** Stufen und darf die Bitrate
vorübergehend unter den Stufenwert drücken; sie steigt danach nur bis zu diesem Wert zurück.

### Bild (binär)

Ein Frame pro WebSocket-Nachricht:

```
Byte 0      : 0x01 = Video-Access-Unit; Bit 0x80 gesetzt = Vollbild (IDR)
Byte 1..4   : Zeitstempel in Millisekunden seit Sitzungsbeginn (uint32, big endian)
Byte 5..    : H.264 Annex-B-Nutzdaten (SPS/PPS stehen vor jedem Vollbild)
```

SPS/PPS werden vor **jedem** Vollbild wiederholt. Dadurch kann der Decoder im
Annex-B-Modus arbeiten (WebCodecs ohne `description`), und ein Wiedereinstieg mitten im
Strom funktioniert ohne Sonderbehandlung.

### Eingaben (JSON, Text-Frames, App → Server)

Kurze Schlüssel, weil bei Zeigerbewegung bis zu 60 Nachrichten pro Sekunde anfallen:

```ts
{ t:'d', dx: number, dy: number }                          // relativ, in PC-Pixeln
{ t:'m', x: number,  y: number }                           // absolut, normiert 0..1
{ t:'b', b:'l'|'r'|'m', d: boolean }                       // Maustaste
{ t:'s', dx: number, dy: number }                          // Scrollen
{ t:'k', c: string, d: boolean, mods:{s,c,a,m: boolean} }  // c = KeyboardEvent.code
{ t:'x', s: string }                                       // Text am Stück (Diktat, Einfügen)
```

Zeigerbewegungen werden auf einen Frame pro Animationsschritt zusammengefasst
(`requestAnimationFrame`), damit kein Nachrichtenstau entsteht.

**Die Beschleunigungskurve liegt in der App**, nicht im Server: sie braucht sofortige
Rückmeldung ohne Netzweg. Der Server bekommt fertige Pixel-Deltas.

**Warum absolute Bewegung normiert ist:** ändert sich die Auflösung mitten in der Sitzung,
bleiben 0..1-Koordinaten gültig.

## 5. Server-Module

```
server/src/remote/
  remote.manager.ts     Sitzungs-Lebenszyklus, eine Sitzung je Verbindung
  remote.socket.ts      /remote-Endpunkt: Nachrichten annehmen, Frames senden
  annexb.ts             H.264-Strom → Access Units, Vollbild-Erkennung   (rein)
  geometry.ts           Bildschirmmaße, Koordinaten-Umrechnung           (rein)
  bitrate.ts            Rückstau-Regelung                                (rein)
  capture/
    capture.types.ts    Schnittstelle ScreenCapture
    capture.darwin.ts   Swift-Helfer
    capture.win32.ts    ffmpeg + ddagrab
  input/
    input.types.ts      Schnittstelle InputInjector
    input.darwin.ts     Swift-Helfer im Eingabe-Modus
    input.win32.ts      dauerhafter PowerShell-Prozess
  helpers/
    mac/TmsRemoteHelper.swift
    win/input-helper.ps1
```

### Schnittstellen

```ts
export interface CaptureOptions { fps: number; maxWidth: number; bitrateKbps: number }

export interface ScreenCapture {
  start(opts: CaptureOptions): Promise<{ width: number; height: number; scale: number }>;
  onData(cb: (chunk: Buffer) => void): void;      // roher Annex-B-Strom
  onError(cb: (code: RemoteErrorCode, message: string) => void): void;
  requestKeyframe(): void;
  setBitrate(kbps: number): void;
  stop(): Promise<void>;
}

export interface InputInjector {
  moveRelative(dx: number, dy: number): void;
  moveAbsolute(nx: number, ny: number): void;     // normiert 0..1
  button(which: 'left' | 'right' | 'middle', down: boolean): void;
  scroll(dx: number, dy: number): void;
  key(code: string, down: boolean, mods: Mods): void;
  text(s: string): void;
  stop(): Promise<void>;
}
```

Beide Helfer laufen als dauerhafte Kindprozesse — pro Ereignis einen Prozess zu starten
würde 50–100 ms kosten und die Latenz zunichtemachen.

### Rückstau-Regelung (`bitrate.ts`)

Bricht das Netz ein, wächst `ws.bufferedAmount`. Statt weiter zu stapeln — und damit
sekundenlang veraltete Bilder zu zeigen:

1. über 512 KB im Puffer: Zwischenbilder verwerfen, nur Vollbilder durchlassen
2. über 1 MB: Bitrate auf die Hälfte, mindestens 300 kbit/s
3. drei Sekunden lang unter 128 KB: Bitrate um 25 % anheben, höchstens bis zum Sollwert

Reine Zustandsmaschine ohne Netz- oder Bildschirmzugriff, damit vollständig testbar.

## 6. Plattform-Umsetzungen

### macOS — eigener Swift-Helfer, kein ffmpeg

Auf macOS 26 sieht ffmpeg über AVFoundation keinen Bildschirm mehr; Apple hat den alten
Aufnahmeweg geschlossen. Der Helfer nutzt **ScreenCaptureKit** und kodiert über
**VideoToolbox** auf der GPU. Nebeneffekt: eine Abhängigkeit weniger — auf dem Mac wird
kein ffmpeg gebraucht.

```
TmsRemoteHelper --capture --fps 30 --max-width 1600 --bitrate 1500
  stdout : roher H.264-Annex-B-Strom
  stderr : je eine Zeile JSON — {"ready":{"width":..,"height":..,"scale":..}}
                                {"error":{"code":"permission_screen"}}

TmsRemoteHelper --input
  stdin  : je eine Zeile JSON, dieselben Formen wie im Protokoll oben
```

Übersetzt wird einmalig beim Einrichten mit dem vorhandenen `swiftc` (Xcode-Kommandozeilen-
werkzeuge sind auf der Zielmaschine vorhanden, Swift 6.3.1). Schlägt das fehl, meldet
`setup.ts` das mit dem nötigen Befehl.

Zwei Berechtigungen, beide auf dieselbe Binärdatei:

* **Bildschirmaufnahme** — ohne sie liefert ScreenCaptureKit keinen Inhalt → `permission_screen`
* **Bedienungshilfen** — ohne sie bleiben CGEvents wirkungslos, geprüft über
  `AXIsProcessTrusted()` → `permission_input`

### Windows — ffmpeg für das Bild, Bordmittel für die Eingabe

```
ffmpeg -f lavfi -i ddagrab=output_idx=0:framerate=30 \
       -vf "hwdownload,format=bgra,scale=1600:-2,format=nv12" \
       -c:v h264_nvenc -preset p1 -tune ll -b:v 1500k -g 60 \
       -bsf:v dump_extra -f h264 pipe:1
```

`ddagrab` ist die Desktop-Duplication-Schnittstelle und arbeitet auf der Grafikkarte.
Encoder-Reihenfolge: `h264_nvenc` → `h264_qsv` → `h264_amf` → `libx264`; der erste
verfügbare wird beim Start ermittelt und gemerkt.

Die Eingabe braucht **keine Installation**: ein dauerhaft laufender PowerShell-Prozess
übersetzt Befehle über `SendInput` (`Add-Type` kompiliert das mitgelieferte C# beim Start).

Auf Windows wird also nur ffmpeg vorausgesetzt. Fehlt es, meldet der Server
`capture_unavailable` samt fertigem `winget install ffmpeg`.

## 7. Oberfläche

Gebaut wird im Mockup (`mockups/season2/liquid-deck/index.html`), angebunden über
`bridge.js` — der Mockup bleibt die Quelle für Aussehen, Layout und Gesten.

**Einstieg:** Knopf auf der Gerätekarte in der Verbindungsliste.

**Aufbau (Variante C):** Kopfzeile · Bild · Umschaltleiste · Trackpad *oder* Tastatur.

Kopfzeile: Gerätename, Verbindungsgüte (fps · ms), Vollbild-Knopf, Trennen.

### Gesten und Bedienung

| Element | Verhalten |
|---|---|
| Zeiger bewegen | Wischen auf dem Trackpad, mit Beschleunigungskurve: langsam pixelgenau, schnell über den ganzen Bildschirm |
| Klicken | Tippen = links · zwei Finger tippen = rechts · tippen-halten-ziehen = ziehen |
| Feste Knöpfe | Links- und Rechtsklick als Flächen unter dem Trackpad — für Ziehen und Rechtsklick ohne Fingerakrobatik |
| Scrollen | zwei Finger auf dem Trackpad, mit Nachlauf |
| Bild vergrößern | Aufziehen bis 3×, dann Verschieben; Doppeltipp springt auf 1:1 an die getippte Stelle |
| Zeiger versetzen | **langer Druck auf das Bild** setzt den Zeiger dorthin |
| Umschalten | Tippen auf die Segmentleiste oder Querwischen über der Leiste |

**Tippen auf das Bild bewegt den Zeiger bewusst nicht.** Sonst kollidiert jeder Zoom- und
Verschiebeversuch mit einem Klick; und auf einem 380dp breiten Abbild eines 1512px-Bild-
schirms trifft ein Finger ohnehin kein Ziel von vier Pixeln. Der lange Druck deckt den Fall
„Zeiger schnell weit bewegen“ ab.

### Tastatur

Deutsches QWERTZ. Sondertasten (⌘ ⌥ ctrl ⇧) **haften**: ein Tipp hält bis zum nächsten
Anschlag, zwei Tipps stellen fest — ohne das wäre ⌘+Tab einhändig nicht tippbar. Umschaltbare
Ebenen für Zahlen/Zeichen (`123`) und Funktionstasten (`F…`), dazu Pfeilblock, Enter,
Rücktaste, Esc, Tab.

Gesendet wird `KeyboardEvent.code` (also die *Position* der Taste), nicht das Zeichen — die
Belegung setzt das Zielsystem selbst. Für zusammenhängenden Text (Diktat, Einfügen) gibt es
`{t:'x'}`, das der Helfer als Unicode-Eingabe absetzt.

**Diktat-Knopf:** nutzt die vorhandene Transkription des Servers; erkannter Text geht als
`{t:'x'}` an den PC.

### Vollbild-Modus (externe Tastatur/Maus)

Manuell über den Knopf in der Kopfzeile. Kopfzeile und Leiste fahren weg, das Bild füllt die
Fläche; ein kleines Abzeichen oben rechts zeigt den Zustand und führt zurück, ebenso die
Zurück-Geste.

* **Tastatur:** `keydown`/`keyup` im WebView abfangen, Standardverhalten unterdrücken, als
  `{t:'k'}` weiterreichen — inklusive Sondertasten.
* **Maus:** **absolute** Abbildung. Der PC-Zeiger steht dort, wo der Android-Zeiger über dem
  Bild steht. Grund: Pointer Lock (relative Bewegung) ist im Android-WebView unzuverlässig,
  und mit sichtbarem Zeiger ist absolut ohnehin das Natürlichere. Scrollrad → `{t:'s'}`.

### Fold-Zustände

Zugeklappt (<400dp) wie beschrieben. Aufgeklappt (≥700dp) derselbe Aufbau in groß: die
Tastatur bekommt eine eigene Zahlenreihe und einen Pfeilblock, weil die Breite reicht. Es
gibt **keinen** zweiten Aufbau — nur andere Maße, über den vorhandenen `useResponsive()`-Weg.

## 8. Zustände und Fehlerfälle

| Fall | Verhalten |
|---|---|
| Berechtigung fehlt (macOS) | `permission_screen` / `permission_input` → geführter Schirm mit den konkreten Schritten und „erneut prüfen“ |
| ffmpeg fehlt (Windows) | `capture_unavailable` mit fertigem Installationsbefehl |
| Helfer stürzt ab | Neustart mit wachsender Wartezeit (0,5 s / 1 s / 2 s), danach `helper_crashed`; letztes Bild bleibt eingefroren |
| Netz bricht weg | letztes Bild einfrieren, Overlay „Verbindung …“, neu aufbauen, **Vollbild anfordern** |
| Auflösung ändert sich | Aufnahme neu starten, `remote:started` mit neuen Maßen |
| App im Hintergrund | React Native meldet den Wechsel über `AppState` an die Seite, die `remote:stop` schickt — schont PC-Prozessor und Handy-Akku; beim Zurückkehren wird neu gestartet |
| Rückstau | siehe `bitrate.ts` |
| Zweite Sitzung | die ältere wird beendet; nur eine Aufnahme je Server |

**Warum nach dem Wiederverbinden ausdrücklich ein Vollbild angefordert werden muss:** H.264
überträgt überwiegend Unterschiede zum vorherigen Bild. Wer mitten im Strom einsteigt, kann
diese Unterschiede nicht deuten — sichtbar als graue Klötze, bis zufällig ein Vollbild kommt.

## 9. Sicherheit

* Authentifizierung wie überall: Token am HTTP-Upgrade, geprüft von `authenticateWebSocket`.
* Ein Schalter in der Server-Konfiguration: `remote.enabled`, Vorgabe **an**. Er erlaubt,
  die Fernsteuerung abzuschalten, ohne den Terminal-Server zu verlieren — relevant, wenn
  das Handy abhandenkommt. Bei `false` antwortet der Endpunkt mit `disabled`.
* **Keine Bestätigung am PC.** Unterwegs sitzt niemand davor, der bestätigen könnte; eine
  Rückfrage würde den Zweck des Features aufheben.
* Sichtbarkeit stattdessen: die Aufnahme-Anzeige von macOS läuft, solange die Sitzung steht,
  und jeder Sitzungsstart wird protokolliert (Zeit, Quell-IP).
* Endet die Verbindung, werden Aufnahme- und Eingabe-Helfer beendet — kein verwaister
  Prozess, der weiter mitliest.
* Der Fernzugriff greift nicht auf die Zwischenablage des PCs zu (siehe Nicht-Ziele).

## 10. Tests

Der Großteil der kniffligen Logik ist reine Rechnerei und läuft im vorhandenen
`node --test`-Aufbau ohne Bildschirm:

* `annexb.ts` — Zerteilen in Access Units, Vollbild-Erkennung, gestückelte Eingaben über
  Puffergrenzen hinweg
* `bitrate.ts` — jede Stufe der Regelung, inklusive Wiederanstieg
* `geometry.ts` — normiert ↔ Pixel, Retina-Faktor, Seitenverhältnis-Anpassung
* Bau der Aufnahme-Argumente je Plattform und Encoder-Auswahl
* Übersetzung Eingabe-Ereignis → Plattformbefehl, für beide Plattformen

Dazu ein Integrationstest, der auf dem Mac zwei Sekunden aufnimmt und prüft, dass Access
Units mit einem Vollbild zu Beginn ankommen — wird übersprungen, wenn die Berechtigung
fehlt.

Oberfläche: Layout headless bei 412×915 und aufgeklappt prüfen (wie bei den bisherigen
Season-2-Arbeiten). Der Rest ist Handarbeit am Fold.

## 11. Nicht-Ziele

Bewusst draußen, alles später nachrüstbar: Ton vom PC · Zwischenablage-Abgleich Handy ↔ PC ·
mehrere Monitore · Dateien ziehen (kann die App an anderer Stelle bereits) · Mitschnitt ·
Wake-on-LAN · Linux.

## 12. Offene Risiken

1. **Der Aufnahmeweg auf macOS ist der einzige echte Unbekannte.** Vor dem Bau des Moduls
   entsteht ein Wegwerf-Test: Swift-Helfer, fünf Sekunden aufnehmen, Bilder zählen,
   Verzögerung messen. Erst wenn die Zahlen stimmen, wird gebaut. Das ist Schritt 1 des
   Umsetzungsplans.
2. **Die Windows-Seite ist von hier aus nicht verifizierbar.** Sie wird vollständig
   geschrieben und in den reinen Anteilen getestet; ob `ddagrab` und `SendInput` auf der
   Zielmaschine laufen, sieht erst jemand mit Zugriff darauf. Ohne solchen Zugriff wird sie
   ausdrücklich als ungetestet ausgeliefert.
3. **WebCodecs im Android-WebView** gilt als vorhanden (Chromium-Unterhau, Fold 7). Der
   Wegwerf-Test prüft es mit; fällt es aus, ist MediaSource mit fragmentiertem MP4 der
   Ersatzweg — mehr Verzögerung, aber tragfähig.

## 13. Ausliefern

Die Arbeit verteilt sich auf zwei Arbeitskopien:

* **Mockup und Spezifikation:** `~/Desktop/TMS Terminal` (Zweig `master`). Der Bauschritt
  `npm run build:season2` liest den Mockup **fest von hier**; das erzeugte
  `liquidDeckHtml.ts` muss mit eingecheckt werden.
* **Server- und App-Code:** `~/Desktop/tms-terminal` (Zweig `feat/manager-chat-redesign`) —
  dort läuft der ausgelieferte Server.

Die APK entsteht über den GitHub-Actions-Lauf beim Setzen eines Tags; ein lokaler Bau bleibt
am Metro-Schritt hängen.

**Der Server muss nach dem Einspielen neu gestartet werden — das macht der Nutzer**, weil
ein Neustart die laufende Sitzung auf dem PC beendet.
