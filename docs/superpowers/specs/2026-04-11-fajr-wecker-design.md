# Fajr Wecker-Modus

## Zusammenfassung

Neuer Toggle "Fajr Wecker" im Azan-Settings-Bereich. Wenn aktiv, wird das Morgengebet automatisch laut abgespielt. Der Fullscreen zeigt nur Hintergrundbild + Gebetsinfo, keine Buttons. Sobald der Adhan fertig ist, schliesst sich der Fullscreen automatisch.

## Betroffene Dateien

| Datei | Aenderung |
|---|---|
| `mobile/src/services/adhan.service.ts` | Neuer Storage-Key `tms-fajr-wecker` + getter/setter, isWecker-Parameter in Scheduling |
| `mobile/src/screens/PrayerTimesScreen.tsx` | Neuer Toggle-Switch unter dem Adhan-Toggle |
| `mobile/android/.../AdhanFullscreenActivity.kt` | Wecker-Extra auswerten: keine Buttons, sofort Adhan abspielen, auto-finish bei Playback-Ende |
| `mobile/android/.../AdhanAlarmReceiver.kt` | isWecker-Extra an die Activity weitergeben |
| `mobile/src/components/AdhanAlert.tsx` | Wecker-Modus: keine Buttons, auto-play, auto-dismiss bei Playback-Ende |

## Flow

```
Fajr-Zeit erreicht
  -> AdhanAlarmReceiver: liest isWecker aus Intent-Extra
    -> isWecker=true:
      -> AdhanFullscreenActivity bekommt extra "wecker"=true
      -> Kein Button-Row gerendert
      -> Adhan startet sofort (liest adhan-ID aus AsyncStorage/SQLite)
      -> MediaPlayer.onCompletion -> finish()
    -> isWecker=false:
      -> Normaler Flow mit Stumm/Laut Buttons
```

## Storage

- AsyncStorage Key: `tms-fajr-wecker`
- Default: `false`
- Getter: `getFajrWecker(): Promise<boolean>`
- Setter: `setFajrWecker(enabled: boolean): Promise<void>`

## UI (PrayerTimesScreen)

Neuer Toggle im Azan-Settings-Bereich, nur sichtbar wenn Adhan aktiviert ist. Platziert direkt unter dem bestehenden "Azan Benachrichtigung"-Toggle:

```
+-------------------------------------------+
| (clock-icon)  Fajr Wecker           [ON]  |
|     Morgengebet spielt automatisch laut   |
+-------------------------------------------+
```

Gleicher Stil wie der bestehende Adhan-Toggle (adhanToggleRow).

## AdhanFullscreenActivity (Kotlin)

- Neues Intent-Extra: `"wecker"` (Boolean, default false)
- Wenn `wecker == true`:
  - Button-Row (silentBtn + loudBtn) wird NICHT erstellt
  - Adhan startet sofort (gleiche Logik wie `playAdhanAndDismiss()`, aber ohne finish)
  - `MediaPlayer.setOnCompletionListener` -> `finish()`
  - `moveTaskToBack`-Timer (2s) wird NICHT gestartet
  - Vibration: kurzer Burst (einmalig, kein Repeat)

## AdhanAlarmReceiver (Kotlin)

- Neues Intent-Extra `"wecker"` wird vom scheduling durchgereicht
- Wird an `AdhanFullscreenActivity` und an die Notification-FullscreenIntent weitergegeben

## adhan.service.ts (Scheduling)

- `scheduleTestAdhan()`: neuer Parameter `isWecker: boolean = false`
- `scheduleAdhanForPrayer()`: liest `getFajrWecker()`, setzt `isWecker = true` wenn prayerName === "Fajr" und Wecker aktiv
- `AdhanModule.scheduleAlarm()`: neuer Parameter `isWecker` wird als Intent-Extra weitergereicht

## AdhanAlert (React Native Modal)

- Neue Prop: `wecker: boolean`
- Wenn `wecker == true`:
  - Buttons-Row (Stumm/Laut) wird nicht gerendert
  - `playAdhan()` wird sofort in useEffect aufgerufen
  - Sound-Completion -> ruft `onSilent()` auf (dismiss)

## Nicht im Scope

- Wecker fuer andere Gebete (nur Fajr)
- Snooze-Funktion
- Lautstaerke-Regelung
