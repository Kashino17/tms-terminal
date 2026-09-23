# TMS Terminal — Project Instructions

## Repository
- **GitHub:** https://github.com/Kashino17/tms-terminal (private)
- **Owner:** Kashino17 (ayysir)

## Project Structure
```
TMS Terminal/
├── server/     # Node.js + TypeScript + node-pty + ws (runs on PC)
├── mobile/     # React Native + Expo (Android app for Samsung Galaxy Fold 7)
├── shared/     # Shared WebSocket protocol types
```

## Mobile App — Release & Update Workflow

### Building a Release APK
```bash
cd mobile
./release.sh          # patch bump: 1.0.0 → 1.0.1
./release.sh minor    # minor bump: 1.0.0 → 1.1.0
./release.sh major    # major bump: 1.0.0 → 2.0.0
```

The `release.sh` script:
1. Bumps version in `app.json` + `android/app/build.gradle` (versionName + versionCode)
2. Runs `./gradlew clean` + `./gradlew assembleRelease`
3. Copies APK to `~/Desktop/TMS-Terminal-vX.Y.Z.apk`
4. Asks to create a Git tag + GitHub Release with the APK attached (uses `gh` CLI)

### Auto-Update System (GitHub Releases)
- The app checks `https://api.github.com/repos/Kashino17/tms-terminal/releases/latest` on startup
- If a newer version exists (semver comparison), an **UpdateBanner** appears on the server list screen
- User taps "Jetzt updaten" → APK downloads → Android installer opens → installs over existing app
- **No deinstall needed** — the release signing key (`android/app/tms-release.keystore`) is stable
- Config: `src/services/updater.service.ts` → `GITHUB_REPO` constant

### Quick Deploy (no version bump, no GitHub release)
```bash
cd mobile
./deploy.sh           # builds APK to ~/Desktop/TMS-Terminal.apk
./deploy.sh adb       # builds + installs directly via USB
```

### Signing Key
- **Release keystore:** `mobile/android/app/tms-release.keystore`
- **DO NOT delete or regenerate** — changing the key requires users to uninstall and reinstall
- Alias: `tms-terminal`, Password: `tmsTerminal2026`

## Server
- Started via `tms-terminal` CLI command (npm global install from `server/`) — `tms-terminal help` lists all
  commands (status, restart, logs -f, doctor, debug, keeper stop, …)
- **Server log:** `~/.tms-terminal/logs/server.log` (`tms-terminal logs`), keeper log `~/.tms-terminal/ptyd.log`,
  update log `~/.tms-terminal/update.log`. Timestamps are local time.
- Default port: 8767
- Config stored at `~/.tms-terminal/config.json`
- Firebase service account at `~/.tms-terminal/firebase-service-account.json`

## Fernzugriff (Remote Desktop)
Bildschirm des PCs live aufs Handy, mit Trackpad/Tastatur/Vollbild-Bedienung. Spezifikation:
`docs/superpowers/specs/2026-08-18-fernzugriff-design.md`.

- **Bausteine:** `server/src/remote/` (Sitzungslogik, Aufnahme/Eingabe je Plattform), macOS-Helfer
  `server/src/remote/helpers/mac/TmsRemoteHelper.swift` (kompiliert nach `server/bin/tms-remote-helper`),
  Windows-Skript `server/src/remote/helpers/win/input-helper.ps1`, Oberfläche im Mockup
  `mockups/season2/liquid-deck/index.html` + `mobile/src/season2/web/bridge.js`.
- **macOS-Helfer bauen** läuft automatisch beim Server-Setup (`server/src/setup.ts` →
  `buildRemoteHelper()`, ruft `server/src/remote/helpers/mac/build.sh` mit `swiftc`). Schlägt
  das fehl, läuft der Server normal weiter, nur Fernzugriff bleibt aus. Nachholen:
  `bash server/src/remote/helpers/mac/build.sh`.
- **Zwei Mac-Berechtigungen**, beide für die Binärdatei `server/bin/tms-remote-helper` — **nicht**
  fürs Terminal, das den Server startet: Bildschirmaufnahme (sonst liefert ScreenCaptureKit
  nichts) und Bedienungshilfen (sonst wirkungslose CGEvents).
- **Windows setzt ffmpeg ≥ Version 6 voraus** (wegen `ddagrab`) — sonst nichts, die Eingabe läuft
  über ein PowerShell-Bordmittel-Skript ohne Installation.
- **Schalter:** `remoteEnabled` in `~/.tms-terminal/config.json`, Vorgabe an.

### Fallstricke
1. Helferpfade nie relativ zum eigenen Verzeichnis bilden — der Server läuft aus `dist`, wohin
   `tsc` keine Nicht-TypeScript-Dateien kopiert. Alles läuft über `server/src/remote/paths.ts`.
   Wer eine neue Helferdatei einführt, prüft ihren Pfad **gegen `dist`**, nicht gegen die Quelle.
2. Der volle `npm test`-Lauf im Server ist **vorbestehend kaputt** (ein Terminal-Test hängt, ein
   zweiter schlägt fehl — nichts mit Fernzugriff zu tun). Für Fernzugriff gezielt testen:
   `node --require ts-node/register --test 'src/remote/**/*.test.ts'` (82 grün).

### Mockup
- Mockup bearbeiten (`mockups/season2/liquid-deck/index.html`) → `cd mobile && npm run
  build:season2` → die erzeugte `mobile/src/season2/web/liquidDeckHtml.ts` mit einchecken. Nie
  von Hand bearbeiten.
- Der Mockup-Code steckt in einer Kapsel — was `bridge.js` braucht, muss ausdrücklich auf
  `window` gelegt werden.
- `cd mobile && npm run test:mockup` prüft die reinen Rechenfunktionen aus dem markierten
  `TMS-TEST-EXPORT`-Block (27 grün).

## Gemeinsame Zwischenablage (Handy ⇄ Mac)
Verlauf der letzten 40 Kopien beider Geräte, Server ist die Quelle (`server/src/clipboard/`,
Datei `~/.tms-terminal/clipboard.json`, Schalter `clipboardSync` in der config, Vorgabe an).
- **Mac:** `tms-remote-helper --clipboard` pollt `NSPasteboard.changeCount` (0,5 s), meldet
  `{"clip":{"text":…}}`, nimmt `{"set":"…"}` auf stdin. Verborgene/flüchtige Einträge von
  Passwort-Managern (`org.nspasteboard.ConcealedType` u. a.) und eigene Schreibvorgänge werden nie gemeldet.
- **Handy:** Android lässt nur im Vordergrund lesen → gelesen wird beim Öffnen des Verlaufs
  (`clipboard:open`); In-App-Kopien gehen über `clipboard:write` direkt hin; Mac-Kopien legt die
  App sofort aufs Handy, solange sie vorne ist (`clipSynced` verhindert das Zurückspielen).
- **Nachrichten:** `clipboard:list|push|use|delete|clear` → `clipboard:history|added|removed`.
- Windows: noch kein Beobachter (nur Handy-Kopien im Verlauf).

## Terminal-Wächter (ptyd)
Terminals laufen NICHT mehr als Kinder des Servers, sondern in einem abgekoppelten Halteprozess
(`server/src/terminal/ptyd/daemon.ts`, Socket `~/.tms-terminal/ptyd.sock`, Log `~/.tms-terminal/ptyd.log`).
Ein Server-Neustart (Ctrl+C, Update, Absturz) lässt Shells und Claude weiterlaufen; der neue Server
übernimmt sie (`adoptSession`). Terminals enden nur per `terminal:close` — kein Idle-Timeout mehr.

- **Protokoll abwärtskompatibel halten** (`ptyd/wire.ts`): ein laufender Wächter überlebt Server-Updates,
  ein neuer Server spricht also mit einem alten Wächter. Änderungen an `daemon.ts` wirken erst, wenn der
  Wächter neu startet — das beendet alle Terminals (nur bei leerem Wächter oder Mac-Neustart tun).
- Eine Verbindung wird erst mit `{t:'attach'}` zum Server — ein bloßes Verbinden ist nur eine Probe.
- Windows nutzt weiter node-pty direkt. Die alte Wiederherstellung (`terminal/restore`) greift nur noch
  für Terminals, die wirklich weg sind (Mac-Neustart).
- Testen: `node --require ts-node/register --test src/terminal/ptyd/*.test.ts` (7 grün).

## Key Technical Decisions
- **No TLS on server** — relies on Tailscale VPN for encryption. Server uses `http.createServer()`.
- **Protocol:** `http://` and `ws://` (not https/wss) because Tailscale handles encryption
- **Terminal rendering:** xterm.js in a WebView with Canvas renderer addon for performance
- **Responsive layout:** `useResponsive()` hook with Context Provider. Breakpoints: compact (<400dp), medium (400-699dp), expanded (≥700dp). Optimized for Samsung Galaxy Fold 7.
- **Push notifications:** Firebase Cloud Messaging (FCM). Server detects AI tool completion (Claude, Codex, Gemini) via prompt detector patterns + shell prompt return detection.

## Language
- UI strings are in **German** (user preference)
- Code comments and variable names in **English**
