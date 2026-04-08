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
- Started via `tms-terminal` CLI command (npm global install from `server/`)
- Default port: 8767
- Config stored at `~/.tms-terminal/config.json`
- Firebase service account at `~/.tms-terminal/firebase-service-account.json`

## Key Technical Decisions
- **No TLS on server** — relies on Tailscale VPN for encryption. Server uses `http.createServer()`.
- **Protocol:** `http://` and `ws://` (not https/wss) because Tailscale handles encryption
- **Terminal rendering:** xterm.js in a WebView with Canvas renderer addon for performance
- **Responsive layout:** `useResponsive()` hook with Context Provider. Breakpoints: compact (<400dp), medium (400-699dp), expanded (≥700dp). Optimized for Samsung Galaxy Fold 7.
- **Push notifications:** Firebase Cloud Messaging (FCM). Server detects AI tool completion (Claude, Codex, Gemini) via prompt detector patterns + shell prompt return detection.

## Language
- UI strings are in **German** (user preference)
- Code comments and variable names in **English**

## Memory System
Das Projekt hat ein persistentes Gedächtnis in `memory/`. **Lies diese Dateien bei jeder Session.**

### Bei Session-Start
Lies alle Dateien in `memory/` bevor du mit der Arbeit beginnst:
- `memory/user.md` — Wer der User ist, Arbeitsstil, Präferenzen
- `memory/personality.md` — Wie du kommunizieren sollst
- `memory/project-state.md` — Aktueller Stand, aktive Arbeit, offene Punkte
- `memory/decisions.md` — Getroffene Entscheidungen und Begründungen
- `memory/journal.md` — Chronologisches Session-Protokoll

### Bei Session-Ende
Aktualisiere die relevanten Memory-Dateien bevor die Session endet:
- `memory/project-state.md` — **immer** aktualisieren (aktueller Stand, Version, offene Punkte)
- `memory/journal.md` — **immer** neuen Eintrag anhängen (Datum + was gemacht wurde)
- `memory/user.md` — nur wenn du etwas Neues über den User gelernt hast
- `memory/personality.md` — nur wenn sich Kommunikationsstil-Erkenntnisse ergeben
- `memory/decisions.md` — nur wenn wichtige Entscheidungen getroffen wurden

### Regeln
- Schreibstil: Knapp, stichpunktartig, auf Deutsch
- Keine Übertreibung: Nur relevante Dinge festhalten, nicht jede Kleinigkeit
- journal.md: Max 100 Einträge, danach älteste 50 in `memory/archive/` zusammenfassen
- Commit-Message für Memory-Updates: `memory: update session journal` o.ä.
