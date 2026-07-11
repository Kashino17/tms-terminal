# Season 2 in der echten App — Phase-3-Spec (umschaltbare zweite UI)

**Date:** 2026-07-11 · **Status:** User-directed (Rollout: schrittweise; Basis: Live-Branch)
**Code-Target:** `~/Desktop/tms-terminal` (lowercase worktree), Branch `feat/manager-chat-redesign` — der Stand, der auf dem Fold 7 läuft.
**Design-Referenz:** das fertige Liquid-Deck-Mockup (`mockups/season2/liquid-deck/index.html` im uppercase Worktree) — Farben, Metriken, Icons, Motion, Interaktionen sind DORT definiert und werden nach React Native portiert, nicht neu erfunden.

## Ziel

Die Season-2-UI (Liquid Deck) wird als **zweite, vollständig getrennte UI-Version** in die bestehende App eingebaut. In den Einstellungen gibt es einen Umschalter „UI-Version: Klassisch ⇄ Season 2". Die klassische UI bleibt **1:1 unverändert** — strukturell garantiert, nicht nur versprochen.

## Isolations-Garantie (die wichtigste Regel)

- ALLER neuer Code lebt unter `mobile/src/season2/` (Screens, Komponenten, Theme, Icons, Motion).
- Bestehender Code wird an exakt DREI additiven Stellen berührt:
  1. `src/store/settingsStore.ts`: neues persistiertes Flag `seasonTwoEnabled` + Setter (Muster: `managerChatRedesignEnabled`, Zeilen 27-29/80-83).
  2. `src/screens/SettingsScreen.tsx`: neue „Design"-Sektion mit dem Toggle (Markup-Klon der Beta-Sektion, Zeilen 400-427).
  3. `src/App.tsx:116`: Root-Branch `seasonTwoEnabled ? <SeasonTwoRoot/> : <AppNavigator/>` innerhalb desselben `NavigationContainer` (Muster: `ManagerChatRouter`, `AppNavigator.tsx:32-38`).
- Neue native Dependencies (reanimated ~3.6, gesture-handler ~2.14, svg ~14.1, expo-blur ~12.9 — SDK-50-kompatibel via `npx expo install`) sind additiv; babel.config.js bekommt das Reanimated-Plugin (als letztes Plugin), Root bekommt `GestureHandlerRootView` (umschließt BEIDE UI-Trees, verhält sich für die klassische UI neutral).
- Default: `seasonTwoEnabled = false` — nach dem Update sieht der User exakt die alte App, bis er umschaltet.

## Daten-Layer: wiederverwendet, nicht dupliziert

Season 2 ist NUR eine neue Darstellungsschicht über den bestehenden Services:
- Verbindung/Latenz: `getConnection(serverId)` → `WebSocketService` (`state`, `getRtt()`, `getQuality()`, `addMessageListener`).
- Sessions/PTY: bestehendes Wire-Protokoll (`terminal:create/reattach/input/resize/close`), Tabs via `useTerminalStore` (`tabs`, `addTab`, `updateTab`, …) — „Terminal benennen" = `updateTab(title)`, persistiert wie bisher.
- Terminal-Rendering: bestehende `<TerminalView sessionId wsService visible … />` (standalone-fähig, Ref-API `injectText/scrollToBottom/focusKeyboard`).
- Server-Profile: `storageService.getServers()` + SecureStore-Tokens.

## Schrittweiser Rollout (Meilensteine)

- **M1 (dieser Plan):** Deps + Toggle + Root-Branch; Season2-Foundation (Theme-Tokens Kindle-Dunkel/Hell-Outdoor, SVG-Icon-Set, GlassSurface, Motion-Springs); Shell (Dock mit slidender Pille, Dynamic Island mit Morph, Screen-Gerüst); Terminal-Kern (Server verbinden, Session-LISTE mit benannten Karten — eine aktiv/expandiert mit echtem TerminalView, Eingabezeile + Senden, Dreifach-Tipp-Umbenennen, Latenz in der Island). Übrige Dock-Punkte (Manager, Cloud, Browser, Einstellungen) öffnen übergangsweise die klassischen Screens via `navigation.navigate` (Routen bleiben registriert).
- **M2+:** Stack-Ansicht + ⊞ Übersicht, Orbs/Tasten-Panel, Auto-Approve/Rückfrage-Sheets (an echte Prompt-Detektion angebunden), Manager/Cloud/Browser nativ in Season-2-Optik, Wurzelfixes (Rendering-Duplikate, Transkription) — jeweils eigene Pläne, per App-Update iterativ zum User.

## Nicht-Ziele (M1)

Keine Änderungen an Server/Protokoll; keine Migration klassischer Screens; kein Light-Mode für die klassische UI (Season 2 bringt sein eigenes Theme-System mit, intern umschaltbar); keine iOS-Pflege über das Mitkompilieren hinaus.

## Erfolgskriterien (M1)

1. Nach App-Update: klassische UI unverändert (Default), `git diff` außerhalb `season2/` + der drei Berührpunkte + Dep-Dateien ist leer.
2. Einstellungen → Design → „Season 2" AN → App zeigt Season2-Shell mit Island + Dock; ZURÜCK-Schalten jederzeit (auch aus Season 2 heraus, via Season2-Settings-Bridge oder Island-Detail).
3. Im Season2-Terminal: echten Server verbinden, Sessions sehen/erstellen/benennen (3×-Tipp), Befehle senden, Live-Output im TerminalView, Latenz live in der Island.
4. `npx tsc --noEmit` sauber; `./deploy.sh` baut ein installierbares APK (arm64).
