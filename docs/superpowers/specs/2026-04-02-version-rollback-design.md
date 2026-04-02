# Version Rollback — Design Spec

## Zusammenfassung

Nutzer kann in den Settings auf die vorherige App-Version zuruecksetzen. Die App holt alle GitHub Releases, findet die Version direkt vor der aktuellen, und bietet den Download an.

## Anforderungen

- **Ort:** Settings-Screen, neuer "Version" Bereich
- **Umfang:** Nur die eine Version direkt vor der aktuellen (nicht beliebig alte Versionen)
- **Mechanismus:** Gleicher Download-Flow wie beim Update (`Linking.openURL(apkUrl)`)
- **Bestaetigung:** Alert-Dialog vor dem Download ("Wirklich auf vX.Y.Z zuruecksetzen?")

## Implementierung

### 1. updater.service.ts — Neue Funktion

`checkForPreviousVersion()` — fetcht `https://api.github.com/repos/Kashino17/tms-terminal/releases` (alle Releases), filtert nach Releases mit APK-Asset, sortiert nach Semver absteigend, und gibt das erste Release zurueck dessen Version kleiner als die aktuelle ist.

### 2. SettingsScreen.tsx — Neuer Bereich

Am Ende des Settings-Screens ein "Version" Bereich:
- Zeigt aktuelle Version
- Button "Vorherige Version wiederherstellen" mit Versions-Info und Groesse
- Button ausgegraut wenn keine vorherige Version verfuegbar
- Tap → Alert-Bestaetigung → Download via Linking.openURL

## Dateien

| Datei | Aenderung |
|---|---|
| `mobile/src/services/updater.service.ts` | Neue Funktion `checkForPreviousVersion()` |
| `mobile/src/screens/SettingsScreen.tsx` | Neuer "Version" Bereich mit Rollback-Button |
