# Quality of Life in V1 und V2 — und die Gebetszeiten in V2 — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Alarme für den Adhan aus dem `HomeScreen` in einen app-weiten Dienst holen, die vier
defekten Stellen daneben heilen, und die Gebetszeiten als echtes Feature mit **Aktivierungsschalter** in das
neue Layout V2 übertragen.

**Architecture:** `prayer.service` bleibt die einzige Quelle für Zeiten und Ort. Neu kommt
`mobile/src/services/adhanScheduler.ts`, der in `App.tsx` hängt und bei App-Start, `AppState → active` und
nach `bridge:ready` plant. Die V2-Seite plant nichts — sie zeigt an und postet Wünsche
(`adhan:toggle`, `adhan:method`, …), die alle **vor** dem Connection-Guard in `SeasonTwoWebRoot` landen, weil
Gebetszeiten keinen Server brauchen. Der echte Vollbild-Alarm bleibt die native
`AdhanFullscreenActivity`; das HTML-Overlay wird zur Vorschau.

**Tech Stack:** TypeScript, React Native/Expo, Kotlin (Android), `node:test` + `node:assert/strict`
(**kein** Vitest/Jest), WebView-Bridge + HTML-Mockup für V2.

**Spec:** `docs/superpowers/specs/2026-10-01-qol-features-v2-gebetszeiten-design.md`

---

## Global Constraints

- **Branch:** `feat/fernzugriff` im Live-Worktree `~/Desktop/tms-terminal`. **Nicht** `master`.
- **Die V2-Oberfläche wird im anderen Worktree bearbeitet.**
  `mobile/scripts/build-season2-html.js:16` hat `MOCKUP_DIR = '/Users/ayysir/Desktop/TMS Terminal/mockups/season2'`
  fest verdrahtet. Also:
  - HTML ändern → `~/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html`
  - `bridge.js`/`useSheetBridges.ts` ändern → `~/Desktop/tms-terminal/mobile/src/season2/web/`
  - bauen → `cd ~/Desktop/tms-terminal/mobile && npm run build:season2`
  - `liquidDeckHtml.ts` **nie von Hand** editieren, aber **immer mitcommiten**
- **`patch()` schlägt hart fehl**, wenn sich das Mockup bewegt
  (`throw new Error('patch "…" no longer matches the mockup')`). Aktuell 11 Patches. Ein gebrochener Patch
  ist ein *guter* Fehler — nicht umgehen.
- **Neue Logik im Mockup braucht einen `TMS-TEST-EXPORT`-Block**, sonst ist sie nicht testbar. Muster:
  `mobile/scripts/term-text.test.mjs` schneidet per Regex
  `// ── TMS-TEST-EXPORT: <name> ── … // ── /TMS-TEST-EXPORT ──` aus und evaluiert den Block.
- **Bestehende Bridge-IDs sind Vertrag.** `statusPrayerLabel`, `adhanOverlay`, `adhanName`, `adhanRingCode`,
  `adhanStop`, `adhanDemoBtn`, `settingsBody`, `prayerList`, `prayerNextCard` nicht umbenennen. Die Bridge
  ruft Dutzende `window.*`-Hooks, die es nur im Fremd-Mockup gibt; alle Aufrufe sind
  `typeof … === 'function'`-geschützt und **degradieren still** — ein fehlender Hook ist kein Fehler, ein
  fehlendes Feature.
- **Vier Nachrichten fallen durch, wenn man sie übersieht** (`SeasonTwoWebRoot.tsx:845`):
  `if (!wsService || !server) return;` — alles Server-abhängige wird ohne Verbindung **stillschweigend
  verworfen**. `sheets.handle()` und `fileExplorer.handle()` müssen `false` zurückgeben, sonst schlucken sie
  die Nachricht. Der `switch` hat keinen Default-Zweig → Tippfehler bleiben unbemerkt.
- **Keine neuen Laufzeit-Abhängigkeiten.** Kein `tsc`/`jest` in `mobile/` — TS-Fehler werden nicht
  automatisch gefangen. `npm run test:mockup` ist der einzige App-Testlauf.
- **Server niemals unaufgefordert neu starten.** Er besitzt alle node-pty-Sitzungen; ein Neustart killt
  jedes offene Terminal, auch das, in dem entwickelt wird.
- **Git nur Plumbing.** Niemals `git status` im Repo (iCloud lässt baumdurchsuchende Operationen
  minutenlang hängen). Nutze `git diff --stat -- <pfad>`, `git log -1 --format=%s`.
- **Sprache:** UI-Strings deutsch, Code-Kommentare und Bezeichner englisch.
- **Commits:** nach jedem Task, Trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Mockup und Build getrennt committen** (Mockup im Dev-Worktree, generiertes `liquidDeckHtml.ts` +
  `bridge.js` im Live-Worktree) — zwei Commits in einem Task.
- **Verifikation immer bei 380×915 (compact) und 412×915 (expanded)** — Galaxy Fold 7, außen/innen.

### Baseline

```bash
cd ~/Desktop/tms-terminal/mobile && npm run test:mockup
```
Notiere die Anzahl grüner Tests — sie muss nach jedem Task identisch plus die neuen sein.

---

## Dateien

| | Datei | Worktree |
|---|---|---|
| Neu — App | `mobile/src/services/adhanScheduler.ts` | live |
| Neu — App | `mobile/src/store/prayerStore.ts` | live |
| Neu — Test | `mobile/scripts/prayer.test.mjs` | live |
| Neu — Test | `mobile/scripts/adhan-scheduler.test.mjs` | live |
| Geändert — App | `mobile/src/services/prayer.service.ts` | live |
| Geändert — App | `mobile/src/services/adhan.service.ts` | live |
| Geändert — App | `mobile/src/App.tsx` | live |
| Geändert — App | `mobile/src/store/settingsStore.ts` | live |
| Geändert — App | `mobile/src/screens/PrayerTimesScreen.tsx` | live |
| Geändert — App | `mobile/src/components/ToolMenu.tsx` | live |
| Geändert — App | `mobile/src/components/SpotlightPanel.tsx` | live |
| Geändert — App | `mobile/src/screens/TerminalScreen.tsx` | live |
| Geändert — App | `mobile/src/season2/web/bridge.js` | live |
| Geändert — App | `mobile/src/season2/web/useSheetBridges.ts` | live |
| Geändert — App | `mobile/src/season2/web/liquidDeckHtml.ts` | live (generiert) |
| Geändert — Android | `mobile/android/app/src/main/java/com/tms/terminal/AdhanModule.kt` | live |
| Neu — Android | `…/AdhanBootReceiver.kt`, angehängt in `AdhanPackage.kt` | live |
| Geändert — Android | `mobile/android/app/src/main/AndroidManifest.xml` | live |
| Geändert — Mockup | `mockups/season2/liquid-deck/index.html` | **dev** |

---

# Phase A — Reparaturen

### Task 1: Tests für die Gebetszeiten-Rechenlogik

Bevor irgendetwas verschoben wird, wird festgenagelt, was die Rechenlogik heute tut. Sonst baut Welle B auf
Sand — und beim Portieren von `prayer.service` in ein zweites Layout weiß niemand mehr, ob eine Änderung
Absicht war.

**Files:**
- Create: `mobile/scripts/prayer.test.mjs`
- Modify: `mobile/src/services/prayer.service.ts` (Uhr und Location injizierbar machen)

**Interfaces:**
- Produces (verändert, aber rückwärtskompatibel):
  - `getNextPrayer(timings, now = new Date()): { name, time, at: Date } | null`
  - `getPrayerProgress(timings, now = new Date()): number` — 0..1
  - `hasPassed(timings, name, now = new Date()): boolean`
  - `formatRemaining(ms): string`
- `prayer.service.ts` darf dadurch **keine** React-/RN-Importe mehr haben, sonst ist sie in Node nicht
  testbar. Aktuell ist sie schon frei von RN — **das ist die Voraussetzung, nicht das Ziel des Tasks.**

**Schritte:**

- [x] **Step 1: Test-Datei anlegen, die den gewünschten Vertrag festschreibt**

  ```js
  // mobile/scripts/prayer.test.mjs
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  process.env.TZ = 'Europe/Berlin';
  const { getNextPrayer, getPrayerProgress, hasPassed, formatRemaining } =
    await import('../src/services/prayer.core.mjs');

  /** Timings object in the shape the Aladhan API returns (with the zone suffix). */
  const T = () => ({
    Fajr: '05:30 (Europe/Berlin)', Sunrise: '07:05 (Europe/Berlin)', Dhuhr: '12:44 (Europe/Berlin)',
    Asr: '15:31 (Europe/Berlin)', Maghrib: '18:22 (Europe/Berlin)', Isha: '19:44 (Europe/Berlin)',
  });
  const at = (hhmm) => new Date(`2026-10-01T${hhmm}:00`);

  test('the next prayer is the first one after now', () => {
    const np = getNextPrayer(T(), at('07:00'));
    assert.equal(np.name, 'Dhuhr');
    assert.equal(np.time, '12:44');           // the zone suffix is stripped
  });

  test('it wraps to tomorrow Fajr after Isha', () => {
    const np = getNextPrayer(T(), at('21:00'));
    assert.equal(np.name, 'Fajr');
    assert.equal(np.tomorrow, true);
    assert.equal(np.at.getDate(), 2);
  });

  test('a passed prayer is not the next one', () => {
    assert.equal(hasPassed(T(), 'Dhuhr', at('13:00')), true);
    assert.equal(hasPassed(T(), 'Asr', at('13:00')), false);
  });

  test('progress runs from 0 to 1 between two prayers', () => {
    // 07:05 → 12:44 is 339 minutes; 09:14 is 129 minutes in
    const p = getPrayerProgress(T(), at('09:14'));
    assert.ok(Math.abs(p - 129 / 339) < 0.02, `got ${p}`);
  });

  test('remaining time reads as hours and minutes', () => {
    assert.equal(formatRemaining(2 * 3600e3 + 14 * 60e3), '2h 14m');
    assert.equal(formatRemaining(14 * 60e3), '14m');
  });
  ```

- [x] **Step 2: Vor dem ersten Test den Ausführungsweg klären**

  `node --test` führt **kein** TypeScript aus. Der Repo-Weg ist `node:test` + `node:assert/strict`
  auf `.mjs`-Dateien (`mobile/scripts/*.test.mjs`), und `tab-identity.test.mjs` importiert dort bereits
  direkt eine `.ts`-Datei — prüfe zuerst, ab welcher Node-Version das bei dir geht:

  ```bash
  node -v
  ```
  Ab Node 22.6 mit `--experimental-strip-types` oder 23+ nativ. Wenn deine Version das kann:
  `node --experimental-strip-types --test scripts/prayer.test.mjs`.
  Wenn nicht: die reinen Funktionen liegen in `mobile/src/services/prayer.core.mjs` und werden von
  `prayer.service.ts` importiert (Step 4) — **eine Quelle, keine Kopie**. Der Test importiert dann das
  `.mjs` ohne Flag.

- [x] **Step 3: Tests laufen lassen — sie müssen scheitern**

  Run: `cd ~/Desktop/tms-terminal/mobile && node --test scripts/prayer.test.mjs`
  Expected: FAIL — `getNextPrayer(timings, now)` nimmt heute nur `timings` und benutzt `new Date()`
  intern.

- [x] **Step 4: `prayer.service.ts` aufteilen**

  Lege `mobile/src/services/prayer.core.mjs` an und verschiebe `getNextPrayer`, `getPrayerProgress`,
  `hasPassed`, `formatRemaining` dorthin — **ohne** Verhaltensänderung, aber mit `now`-Parameter
  (Default `new Date()`). Das Suffix der API bleibt erhalten: sie liefert `"05:30 (Europe/Berlin)"`,
  weg kommt es über `replace(/\s*\(.*\)/,'')` (Spec-Referenz B-6).

  In `prayer.service.ts`:
  ```ts
  import { getNextPrayer, getPrayerProgress, hasPassed, formatRemaining } from './prayer.core.mjs';
  export { getNextPrayer, getPrayerProgress, hasPassed, formatRemaining };
  ```
  Ergänze den Doc-Kommentar: **„Die API-Zeiten werden als lokale Uhr interpretiert
  (`new Date(y,m,d,h,m)`). Bewusst, siehe Spec B-6."**

- [x] **Step 5: Tests laufen lassen — jetzt grün**

  Run: `cd ~/Desktop/tms-terminal/mobile && node --test scripts/prayer.test.mjs`
  Expected: PASS — 5 Tests grün

- [x] **Step 6: Alle Aufrufer prüfen**

  Run: `cd ~/Desktop/tms-terminal && grep -rn "getNextPrayer\|getPrayerProgress\|hasPassed\|formatRemaining" mobile/src`
  Expected: Treffer nur in `prayer.service.ts`, `PrayerTimesScreen.tsx`, `HomeScreen.tsx` — die
  neuen optionalen Parameter ändern die Aufrufe nicht.

- [x] **Step 7: Regression**

  Run: `cd ~/Desktop/tms-terminal/mobile && npm run test:mockup`
  Expected: unverändert grün

- [x] **Step 8: Commit**

  ```bash
  cd ~/Desktop/tms-terminal
  git add mobile/scripts/prayer.test.mjs mobile/src/services/prayer.core.mjs mobile/src/services/prayer.service.ts
  git commit -m "test(prayer): Rechenlogik der Gebetszeiten festgenagelt, Uhr injizierbar

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 2: Der Scheduler löst sich vom HomeScreen

Der Kern des Auftrags. Solange die Alarme in `HomeScreen.tsx:47-63` hängen, gibt es sie in V2 nicht.

**Files:**
- Create: `mobile/src/services/adhanScheduler.ts`
- Modify: `mobile/src/services/adhan.service.ts` (`scheduleAdhanForPrayer` mit injizierter Uhr)
- Modify: `mobile/src/App.tsx`
- Modify: `mobile/src/screens/HomeScreen.tsx` (den `useEffect` löschen)
- Test: `mobile/scripts/adhan-scheduler.test.mjs`

**Interfaces:**
- Consumes: `getPrayerTimes`, `getNextPrayer`, `getCurrentLocation`, `getAdhanEnabled`, `getFajrWecker`,
  `scheduleAdhanForPrayer`, `cancelAllAdhanNotifications`, `PRAYER_NAMES` (alle aus Task 1 bzw. heute)
- Produces:
  - `startAdhanScheduler(): void` — idempotent
  - `refreshAdhanSchedule(reason: string): Promise<void>`
  - `__setSchedulerDeps(deps)` — nur für Tests

- [x] **Step 1: Failing test — der Scheduler plant genau einmal pro Gebet**

  ```js
  // mobile/scripts/adhan-scheduler.test.mjs
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  process.env.TZ = 'Europe/Berlin';
  const sched = await import('../src/services/adhanScheduler.ts');
  ...
  test('planning happens once per remaining prayer', async () => {
    const planned = [];
    sched.__setSchedulerDeps({
      fetchTimes: async () => ({ Fajr: '05:12', Dhuhr: '12:44', Asr: '15:31', Maghrib: '18:22', Isha: '19:44' }),
      isEnabled: async () => true,
      fajrWecker: async () => false,
      schedule: async (n) => { planned.push(n); },
      cancel: async () => {},
      now: () => new Date('2026-10-01T07:00:00'),
    });
    await sched.refreshAdhanSchedule('test');
    assert.deepEqual(planned, ['Dhuhr', 'Asr', 'Maghrib', 'Isha']);
  });

  test('disabled means nothing is planned', async () => {
    /* isEnabled -> false ⇒ planned bleibt [] und cancel wurde gerufen */
  });

  test('past prayers are skipped, not scheduled in the past', async () => {
    /* now = 21:00 ⇒ nur Fajr mit tomorrow-Flag */
  });

  test('a failing fetch never rejects the caller', async () => {
    /* fetchTimes wirft ⇒ refreshAdhanSchedule löst ohne Fehler auf */
  });
  ```

- [x] **Step 2: Laufen lassen — FAIL**

  Run: `cd ~/Desktop/tms-terminal/mobile && node --test scripts/adhan-scheduler.test.mjs`
  Expected: FAIL — `Cannot find module '../src/services/adhanScheduler'`

- [x] **Step 3: `scheduleAdhanForPrayer` um die Uhr erweitern**

  In `adhan.service.ts:209-226` die Signatur ändern:
  ```ts
  export async function scheduleAdhanForPrayer(
    prayerName: string, timeStr: string, prayerArabic: string,
    now: () => number = Date.now,
  ): Promise<void> {
    if (!(await getAdhanEnabled())) return;
    const [h, m] = timeStr.split(':').map(Number);
    const target = new Date(); target.setHours(h, m, 0, 0);
    const diffSec = Math.round((target.getTime() - now()) / 1000);
    if (diffSec <= 0) return;
    const wecker = prayerName === 'Fajr' ? await getFajrWecker() : false;
    await scheduleTestAdhan(prayerName, timeStr, prayerArabic, diffSec, wecker);
  }
  ```
  Das ist dieselbe Rechnung wie heute — nur prüfbar. Keine Verhaltensänderung.

- [x] **Step 4: `adhanScheduler.ts` schreiben**

  ```ts
  /**
   * Plans the Adhan alarms for today's remaining prayers. Lives in App.tsx, not
   * in a screen — otherwise the classic HomeScreen would be the only place where
   * alarms can exist, and Season 2 (the WebView layout) would never fire one.
   */
  type Deps = {
    fetchTimes(): Promise<Record<string, string>> | null;
    isEnabled(): Promise<boolean>;
    fajrWecker(): Promise<boolean>;
    schedule(name, time, arabic): Promise<void>;
    cancel(): Promise<void>;
    now(): Date;
  };
  let deps: Deps = realDeps;
  let started = false;
  let inFlight: Promise<void> | null = null;

  export function __setSchedulerDeps(next: Partial<Deps>) { deps = { ...deps, ...next }; }

  export async function refreshAdhanSchedule(reason: string): Promise<void> {
    if (inFlight) return inFlight;            // re-entrant guard: AppState + bridge:ready
    inFlight = (async () => {
      try {
        const times = await deps.fetchTimes();
        if (!times) return;                    // no location / API down: keep the old alarms
        await deps.cancel();
        if (!(await deps.isEnabled())) return;
        for (const key of ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']) {
          const info = PRAYER_NAMES[key];
          const time = times[key]?.replace(/\s*\(.*\)/, '').trim();
          if (info && time) await deps.schedule(info.de, time, info.ar);
        }
      } catch (err) {
        console.warn('[adhan] scheduling failed', reason, err);
      } finally { inFlight = null; }
    })();
    return inFlight;
  }

  export function startAdhanScheduler() {
    if (started) return;
    started = true;
    void refreshAdhanSchedule('start');
    AppState.addEventListener('change', (s) => {
      if (s === 'active') void refreshAdhanSchedule('resume');
    });
  }
  ```

  **Ein Listener, nicht zwei.** `AppState → active` und `bridge:ready` feuern beim Umschalten ins V2 im
  selben Tick; ohne den Re-entrant-Guard (`inFlight`) plant der Scheduler zweimal und legt damit doppelte
  Alarme an. Genau das ist der Bug, den Task 3 Step 1 danach nicht mehr reparieren muss.

  `fetchTimes` holt Standort **und** Zeiten (es sind zwei async-Aufrufe; `refreshAdhanSchedule` darf sie
  nicht doppelt machen).

- [x] **Step 5: In `App.tsx` einhängen, `HomeScreen` leeren**

  `App.tsx` bekommt nach `setupAdhanNotificationChannel();` (`:89`) die Zeile
  `startAdhanScheduler();`. In `HomeScreen.tsx` wird der `useEffect([prayerData])` (`:47-63`) **gelöscht**
  und der Kommentar „Adhan notifications are now handled globally in App.tsx" (`:45`) um
  `// Scheduling lives in services/adhanScheduler.ts` ergänzt. `HomeScreen` behält das Laden der Daten für
  sein Widget.

- [x] **Step 6: Laufen lassen — PASS**

  Run: `cd ~/Desktop/tms-terminal/mobile && node --test scripts/adhan-scheduler.test.mjs`
  Expected: PASS — 4 Tests grün

- [x] **Step 7: `npm run test:mockup` + Typsicherheit**

  Run: `cd ~/Desktop/tms-terminal/mobile && npx tsc --noEmit 2>&1 | head -20; npm run test:mockup`
  Expected: keine neuen Fehler; Mockup-Tests unverändert grün

- [x] **Step 8: Commit**

  ```bash
  cd ~/Desktop/tms-terminal
  git add mobile/src/services/adhanScheduler.ts mobile/src/services/adhan.service.ts \
          mobile/src/App.tsx mobile/src/screens/HomeScreen.tsx mobile/scripts/adhan-scheduler.test.mjs
  git commit -m "fix(adhan): Alarme werden app-weit geplant statt vom HomeScreen abhaengig

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 3: Alarme abbrechen, exakt stellen, einen Dialog statt zwei

Drei kleine Korrekturen, die zusammen den Unterschied zwischen „klingelt irgendwann" und „klingelt" machen.

**Files:**
- Modify: `mobile/android/app/src/main/java/com/tms/terminal/AdhanModule.kt`
- Modify: `mobile/src/screens/PrayerTimesScreen.tsx`
- Modify: `mobile/src/services/notifications.service.ts`

- [x] **Step 1: Request-Code fest verdrahten**

  In `AdhanModule.kt` oben:
  ```kotlin
  // Slot per prayer, stable across Kotlin versions — a hashCode() here and a
  // different one in cancelAllAlarms meant cancelling never matched anything.
  private fun slotFor(name: String): Int = when (name) {
      "Fajr" -> 1; "Dhuhr" -> 2; "Asr" -> 3; "Maghrib" -> 4; "Isha" -> 5; else -> 0
  }
  ```
  `scheduleAlarm` (`:31`) und `cancelAllAlarms` (`:65`) benutzen beide `slotFor(prayerName)` statt
  `(prayerName + prayerTime).hashCode()` bzw. `(name + "00:00").hashCode()`.

- [x] **Step 2: Exakte-Alarme-Freigabe melden**

  Neue `@ReactMethod fun canScheduleExact(): Promise<Boolean>` in `AdhanModule.kt`, das
  `alarmManager.canScheduleExactAlarms()` zurückgibt (vor Android 12 immer `true`).
  `adhan.service.ts` bekommt `export async function canScheduleExactAdhan(): Promise<boolean>` mit einem
  `try/catch` um den NativeModules-Zugriff.

- [x] **Step 3: Ein Dialog statt zwei**

  `PrayerTimesScreen.tsx:381-399` — den lokalen `<AdhanAlert …>`-Block und den
  `addNotificationReceivedListener` (`:75`) **löschen**. Stattdessen für den Testknopf
  `scheduleTestAdhan(...)` aufrufen; das globale Modal in `App.tsx:125-138` zeigt sich von selbst.
  `App.tsx` bekommt die bisher fehlende `wecker`-Prop:
  ```tsx
  <AdhanAlert … wecker={adhanAlert?.wecker ?? false} … />
  ```
  und `App.tsx:96/104` lesen `d.wecker` aus den Notification-Daten.

- [x] **Step 4: Ein Notification-Handler**

  In `adhan.service.ts:160-170` den `setNotificationHandler`-Aufruf **entfernen**. Der Handler in
  `notifications.service.ts:6-14` bleibt der einzige und bekommt
  `shouldShowAlert: (n) => n.request.content.data?.type !== 'adhan'` — der Adhan hat sein eigenes
  Vollbild und darf nicht zusätzlich als Banner erscheinen.

- [x] **Step 5: Am Gerät prüfen**

  ```bash
  adb logcat -c && adb shell am start-foreground-service 2>/dev/null; adb logcat -s AdhanAlarmReceiver:V AdhanModule:V &
  ```
  In der App „Test Azān (10 s Countdown)". Expected: Der Vollbild-Dialog geht auf, vibriert, und endet
  nach dem Ton. Zweiter Test mit gesperrtem Gerät: geht er auch dann auf?

- [x] **Step 6: Commit**

  ```bash
  cd ~/Desktop/tms-terminal
  git add mobile/android/app/src/main/java/com/tms/terminal/AdhanModule.kt \
          mobile/src/screens/PrayerTimesScreen.tsx mobile/src/services/notifications.service.ts \
          mobile/src/services/adhan.service.ts mobile/src/App.tsx
  git commit -m "fix(adhan): Abbrechen trifft jetzt, exakte Alarme meldbar, ein Dialog und ein Handler

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 4: Nach dem Neustart des Handys sind die Alarme wieder da

> **ENTFALLEN — 2026-10-01.** Der Befund stimmt: `RECEIVE_BOOT_COMPLETED` war ohne Empfänger deklariert,
> und nach einem Neustart sind alle Alarme weg. Die vorgeschlagene Reparatur taugt aber nichts: ein
> `BOOT_COMPLETED`-Receiver kann keinen Alarm stellen, weil ihm zum Planen Standort und Zeiten fehlen.
> Er könnte höchstens ein Flag setzen — und darauf reagiert Task 2 bereits, weil `startAdhanScheduler()`
> bei jedem App-Start ohnehin neu plant. Der Receiver wäre eine Komponente, die nichts repariert.
>
> Der Befund ist stattdessen in `App.tsx` kommentiert, samt der einen Lücke, die bleibt: Neustart und
> danach die App nie geöffnet. Ohne Empfang von Standort und Zeiten ist die nicht lösbar.
>
> **Von hier aus ist noch offen:** Task 11, Schritt 4 — Gerätetest, ob Alarme ein `am force-stop`
> überleben. Falls nein, braucht der Scheduler zusätzlich einen periodischen Refresh.

**Files (falls doch nötig):**
- Create: `mobile/android/app/src/main/java/com/tms/terminal/AdhanBootReceiver.kt`
- Modify: `…/AdhanPackage.kt`, `AndroidManifest.xml`

<details>
<summary>Ursprüngliche Schritte — nicht ausgeführt, nur als Begründung des Befunds</summary>

- [ ] **Step 1: Receiver schreiben**

  ```kotlin
  class AdhanBootReceiver : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
          if (intent.action != Intent.ACTION_BOOT_COMPLETED &&
              intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
          // No alarm planning here and definitely no Activity: the boot screen is
          // not the place for a fullscreen prayer alert. The flag only tells the
          // app on its next start that the alarms are gone and must be re-planned.
          context.getSharedPreferences("adhan", Context.MODE_PRIVATE)
              .edit().putBoolean("needsReschedule", true).apply()
      }
  }
  ```
  (Kein `goAsync()`, kein I/O im Receiver — 10-Sekunden-Limit.)

- [x] **Step 2: Registrieren**

  In `AdhanPackage.kt` einen weiteren `BroadcastReceiver` in `createReceivers()` aufnehmen. Im Manifest
  einen `<receiver android:name=".AdhanBootReceiver" android:exported="false">` mit
  `<intent-filter><action android:name="android.intent.action.BOOT_COMPLETED"/>` und
  `MY_PACKAGE_REPLACED`. `RECEIVE_BOOT_COMPLETED` ist bereits deklariert (`:20`).

- [x] **Step 3: In `App.tsx` auswerten**

  ```ts
  const needsReschedule = await AsyncStorage.getItem('adhan.needsReschedule');
  if (needsReschedule === '1') {
    await AsyncStorage.setItem('adhan.needsReschedule', '0');
    void refreshAdhanSchedule('boot');
  }
  ```
  Der Kotlin-Receiver schreibt in `SharedPreferences`, JS liest AsyncStorage — **das sind zwei
  Speicher.** Löse es, indem der Receiver **keine** Daten speichert, sondern nur im Log schreibt
  (`Log.i("AdhanBootReceiver", "boot completed")`), und `App.tsx` **immer** bei `start` neu plant (Task 2
  macht das bereits). Der Receiver ist damit nur noch der Punkt, an dem wir überhaupt wissen, dass wir den
  Fall „App nie gestartet" nicht per Push lösen müssen — **die eigentliche Reparatur ist der Start-Refresh
  aus Task 2**. Wenn der Gerätetest in Task 3 gezeigt hat, dass `am force-stop` die Alarme killt, kommt
  zusätzlich ein 15-Minuten-Ticker dazu; baue das **nicht** vor, bevor der Test es verlangt.

- [x] **Step 4: Gerätetest**

  `adb shell svc power reboot` bzw. auf dem Gerät neu starten, App **nicht** öffnen, dann ein Alarmsymbol
  prüfen: `adb shell dumpsys alarm | grep -i adhan`. Expected: keine Alarme. App öffnen, `dumpsys` erneut:
  Expected: 4–5 Alarme mit unseren Slots.

- [x] **Step 5: Commit**

  ```bash
  cd ~/Desktop/tms-terminal
  git add mobile/android/app/src/main/java/com/tms/terminal/AdhanBootReceiver.kt \
          mobile/android/app/src/main/java/com/tms/terminal/AdhanPackage.kt \
          mobile/android/app/src/main/AndroidManifest.xml mobile/src/App.tsx
  git commit -m "fix(adhan): Boot- und Update-Receiver, damit die Alarme nach dem Neustart wiederkommen

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

</details>

---

### Task 5: Tote Werkzeuge und unerreichbare Funktionen

**Files:**
- Modify: `mobile/src/components/ToolMenu.tsx`, `SpotlightPanel.tsx`, `mobile/src/screens/TerminalScreen.tsx`

- [x] **Step 1: `drawing` statt `draw`**

  `SpotlightPanel.tsx:51` → `{ id: 'drawing', … }`. Grep danach:
  Run: `cd ~/Desktop/tms-terminal && grep -rn "'draw'" mobile/src`
  Expected: keine Treffer mehr außer `drawing`.

- [x] **Step 2: `processes` in die Icon-Map**

  `TOOL_ICON_MAP` in `ToolMenu.tsx:19-34` bekommt `'processes': <icon>`. Dann ist Prozess-Monitoring über
  das Werkzeugmenü erreichbar wie alle anderen.

- [x] **Step 3: `supabase` entscheiden — Empfehlung: raus**

  `TerminalScreen.tsx:880` `supabase` aus `panelTools` entfernen. `SQLPanel.tsx` kann die
  Supabase-Verbindung bereits (`supabaseStore`), ein zweites leeres Werkzeug daneben ist nur verwirrend.
  Wenn es jemand braucht, ist es 30 Zeilen Panel plus Fall im `renderPanelContent` — **das ist eine
  Entscheidung für den Nutzer, nicht für diesen Task.** Frage ihn, bevor du sie triffst.

- [x] **Step 4: Werkzeug hinzufügen**

  In `ToolMenu.tsx` eine Zeile „+ Werkzeug" am Ende jeder Sektion, die den vorhandenen Katalog
  (`TOOL_ICON_MAP` + Beschreibungen) in einem `ActionSheet` anbietet. `handleAddTool(sectionId, toolId)`
  hängt die ID an `section.toolIds` an. Damit ist `handleDeleteTool` (`:166-175`) nicht mehr endgültig.

- [x] **Step 5: `toolRailRef` — verdrahten oder entfernen**

  `TerminalScreen.tsx:821` ruft `toolRailRef.current?.openFileBrowser(path)` — der Ref wird nie befüllt,
  `ToolRail` wird nie gerendert. **Empfehlung: entfernen** und stattdessen den Dateipfad in die Zwischenablage
  plus einen Toast legen. Alternativ `ToolRail` zurückzuholen wäre ~535 Zeilen UI, die niemand mehr sieht.
  Frage den Nutzer.

- [x] **Step 6: `npm run test:mockup` + Commit**

  ```bash
  cd ~/Desktop/tms-terminal/mobile && npm run test:mockup
  cd ~/Desktop/tms-terminal
  git add mobile/src/components/ToolMenu.tsx mobile/src/components/SpotlightPanel.tsx \
          mobile/src/screens/TerminalScreen.tsx
  git commit -m "fix(tools): Zeichnen und Prozesse wieder erreichbar, Werkzeuge wieder hinzufuegbar

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 6: Den toten Code abbauen

Nicht vor Welle B — der Schritt, damit die Änderungen aus Welle B nicht in einer Datei landen, die
niemand liest.

**Files (nur nach Rückfrage bei Step 1):**
- Delete: `mobile/src/components/ToolRail.tsx`, `mobile/src/components/TerminalTabs.tsx`,
  `mobile/src/components/NotesPanel.tsx`, `mobile/src/components/SplitViewPanel.tsx`,
  `mobile/src/season2/SeasonTwoRoot.tsx`, `mobile/src/season2/components/*`,
  `mobile/src/season2/screens/*`, `mobile/src/season2/theme/*`, `mobile/src/season2/motion/springs.ts`
- Modify: `mobile/src/screens/TerminalScreen.tsx`, `mobile/src/components/TerminalView.tsx`,
  `mobile/src/App.tsx`

- [x] **Step 1: Bestätigung einholen — dieser Task ist nicht reversibel**

  `SeasonTwoRoot.tsx` + `season2/components/*` + `season2/screens/*` sind ~2000 Zeilen
  **native** Season-2-Oberfläche. Sie sind nicht tot durch einen Fehler, sondern weil der WebView-Weg
  gewonnen hat. Bevor sie rausgehen, **dem Nutzer die Frage stellen**: zurückbehalten als
  `docs/season2-native-archive.md` (reiner Text-Snapshot) oder löschen?

- [x] **Step 2: Was bleibt, wird benutzt**

  `NotesPanel` — V1 hat tot, V2 hat `season2/NotesSheet.tsx` mit **einem zweiten** Notiz-Store. Entscheide
  einen Store: `store/notesStore.ts` ist der echte. `NotesSheet.tsx` schreibt über `notes:sync` in einen
  anderen — das ist eine Stolperfalle und gehört in den Commit-Body.

  `SplitViewPanel`/`SplitLayout` — wird aus `BrowserPanel.tsx:1069` aktiviert, ist also **nicht** tot.
  Nur der direkte Einstieg aus dem Terminal fehlt. **Nicht löschen**, sondern in Task 5/6 als Einstieg
  ergänzen oder den Kebab der Karte in V2.

- [x] **Step 3: Löschen, was wirklich tot ist**

  `ToolRail.tsx` und `TerminalTabs.tsx` werden entfernt, dazu die Importe in `TerminalScreen.tsx:6-7` und
  `TOOL_RAIL_WIDTH` in `TerminalView.tsx:8`. `handleRenameTab` (`:736`) und `handleChangeCategory` (`:778`)
  wandern als Aktion ins Kebab-Menü der Karte (das V1 gar nicht, V2 schon hat).

- [x] **Step 4: Prüfen, dass nichts mehr importiert**

  Run: `cd ~/Desktop/tms-terminal && grep -rn "ToolRail\|TerminalTabs\|NotesPanel\|SplitViewPanel\|SeasonTwoRoot" mobile/src`
  Expected: nur noch die gewollten Stellen.

- [x] **Step 5: Commit**

  ```bash
  cd ~/Desktop/tms-terminal
  git add -A mobile/src/components mobile/src/screens/TerminalScreen.tsx mobile/src/season2
  git commit -m "refactor(season2): tote native Variante und ungerenderte Leisten abgebaut

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

---

# Phase B — Die Gebetszeiten in V2

### Task 7: Die Seite bekommt alle Daten

Erst der Inhalt, dann die Schalter. Ohne Daten ist jede Einstellung in der V2-Seite Attrappe.

**Files:**
- Modify: `mobile/src/season2/web/useSheetBridges.ts`
- Modify: `mobile/src/season2/web/bridge.js`
- Modify: `~/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html`

**Interfaces:**
- Produces (additiv, `bridge.js:2326`):
  - `window.TMSBridge.setPrayer(times, meta)` — `meta` optional; ohne `meta` exakt das heutige Verhalten
  - `meta = { location:{label,lat,lon}, date:{readable,hijri}, method:{id,name}, adhan:{enabled,wecker,selected}, perms:{notifications,exactAlarms} }`

- [x] **Step 1: Failing test für den Payload**

  In `mobile/scripts/prayer-bridge.test.mjs`: die reine Funktion `normalizePrayerPayload(times, meta)`
  aus `bridge.js` (als `window.TMSBridge.__normalizePrayer` exportiert) prüfen:
  - ohne `meta` → `{ times: [...5], meta: null }`, Zeit auf `HH:MM` gekürzt
  - mit `meta` → Ort, Hijri, Methode, Sunrise (6. Eintrag) durchgereicht
  - Zeit mit Zeitzone `"05:30 (Europe/Berlin)"` → `"05:30"`

- [x] **Step 2: Failing test für den Mockup-Zähler**

  Im **Dev-Worktree**-Mockup einen Block ergänzen (Vorbild `term-text.test.mjs`):
  ```
  // ── TMS-TEST-EXPORT: next-prayer ──
  … nextPrayer() … (unverändert, nur exportiert)
  // ── /TMS-TEST-EXPORT ──
  ```
  Test: 5 Werte, 6 Werte mit Sunrise, Sprung über Mitternacht.

- [x] **Step 3: `useSheetBridges.ts` erweitern**

  Der vorhandene Effekt (`:263-279`) holt Location und Zeiten **einmal** und schneidet Sunrise raus.
  Ersetzen:
  ```ts
  const data = await fetchPrayerTimes(loc.latitude, loc.longitude, method);
  const names = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
  call('setPrayer',
    names.map(k => ({ name: k, de: PRAYER_NAMES[k]?.de ?? k, ar: PRAYER_NAMES[k]?.ar ?? '', time: data.timings[k] })),
    {
      location: { label: loc.label ?? 'GPS', lat: loc.latitude, lon: loc.longitude },
      date: { readable: data.date.readable, hijri: data.date.hijri },
      method: { id: method, name: METHOD_NAMES[method] },
      adhan: await readAdhanSettings(),
      perms: { notifications: await hasNotificationPermission(), exactAlarms: await canScheduleExactAdhan() },
    });
  ```
  Und: der Effekt muss bei **Methodenwechsel** neu laufen, nicht nur einmal beim Start — er bekommt
  `method` aus dem Store in der Abhängigkeitsliste.

- [x] **Step 4: `bridge.js` — `setPrayer` erweitern**

  ```js
  window.TMSBridge.setPrayer = function (times, meta) {
    var p = window.TMSBridge.__normalizePrayer(times, meta);
    window.TMS_DATA.prayerTimes = p.times;   // shape stays: [{name, time}]
    window.TMS_DATA.prayerMeta = p.meta;     // null-safe
    if (typeof window.renderPrayerList === 'function') window.renderPrayerList();
    if (typeof window.renderPrayerMeta === 'function') window.renderPrayerMeta();
    if (typeof window.updateLatencyDisplay === 'function') window.updateLatencyDisplay();
  };
  ```
  **Kein** `renderPrayerScreen()` hier — der 1-Sekunden-Ticker (`SCREEN_HOOKS.prayer`, `index.html:9036`)
  läuft nur, solange der Screen offen ist.

- [x] **Step 5: Mockup — Liste und Karte erweitern**

  In `renderPrayerList` (`index.html:8988`) die `is-next`-Markierung bleibt, dazu ein Fortschrittsbalken
  zwischen vorletztem und nächstem Gebet. `renderPrayerMeta` (neu) zeichnet unter der Karte: Ort,
  `readable`, Hijri, Methode (als `settings-row is-tap`). **Keine** Layout-Änderung an den Dock-/`@media`-Regeln
  — die Karte muss bei 380 und 412 gleich breit bleiben wie heute.

- [x] **Step 6: Neu bauen, Diff ansehen, Mockup-Tests**

  ```bash
  cd ~/Desktop/tms-terminal/mobile && npm run build:season2
  cd ~/Desktop/tms-terminal && git diff --stat -- mobile/src/season2/web/liquidDeckHtml.ts
  cd ~/Desktop/tms-terminal/mobile && npm run test:mockup
  ```
  Expected: `liquidDeckHtml.ts` geändert, alle Mockup-Tests grün, `prayer-bridge` grün.

- [x] **Step 7: Screenshot beide Breiten**

  `data-screen="prayer"` in `bridge:ready` automatisch öffnen lassen (temporär), Screenshot bei 380×915 und
  412×915. Prüfen: Liste passt ohne Umbruch, Countdown-Karte zeigt `HH:MM:SS`, Sunrise steht drin,
  kein Text wird abgeschnitten.

- [x] **Step 8: Zwei Commits**

  ```bash
  cd "/Users/ayysir/Desktop/TMS Terminal"
  git add mockups/season2/liquid-deck/index.html
  git commit -m "feat(season2): Gebetszeiten-Screen zeigt Sunrise, Ort, Datum und Methode

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"

  cd ~/Desktop/tms-terminal
  git add mobile/src/season2/web/bridge.js mobile/src/season2/web/useSheetBridges.ts \
          mobile/src/season2/web/liquidDeckHtml.ts mobile/scripts/prayer-bridge.test.mjs
  git commit -m "build(season2): Liquid-Deck-HTML mit vollstaendigen Gebetszeiten neu generiert

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 8: Die Seite kann den Adhan einschalten

Das ist der Teil, um den es im Auftrag ging: **in V2 aktivierbar machen.**

**Files:**
- Modify: `mobile/src/season2/web/bridge.js`
- Modify: `mobile/src/season2/SeasonTwoWebRoot.tsx`
- Modify: `~/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html`
- Modify: `mobile/src/services/adhan.service.ts` (Setter für `enabled`/`wecker`/`reciter`, falls fehlend)

**Interfaces:**
- Consumes: `refreshAdhanSchedule` (Task 2), `setAdhanEnabled`/`setFajrWecker`/`setAdhanSelected`,
  `previewAdhan`, `scheduleTestAdhan`, `canScheduleExactAdhan`
- Produces (Seite → RN, **alle vor** dem Connection-Guard in `SeasonTwoWebRoot.tsx:845`):
  - `adhan:toggle {enabled}` · `adhan:wecker {enabled}` · `adhan:reciter {id}`
  - `adhan:method {method}` · `adhan:preview {id, on}` · `adhan:test {}` · `adhan:perms {which}`

- [x] **Step 1: Setter in `adhan.service.ts`**

  `getAdhanEnabled` (`:56`) und `getFajrWecker` (`:69`) haben keine Setter. Ergänze
  `setAdhanEnabled(boolean)`, `setFajrWecker(boolean)`, `setAdhanSelected(id)`, alle drei mit demselben
  Key-Muster und demselben Default.

- [x] **Step 2: Mockup — die Einstellungen-Gruppe „Gebetszeiten"**

  In `index.html:8902` gibt es bereits die Zeile `#prayerRow` („Gebetszeiten — Heutige Zeiten ansehen"),
  die nur zum Screen navigiert. Sie bleibt als Einstieg. **Darunter** bekommt sie eine zweite, neue Gruppe
  mit den echten Schaltern:
  - `Azān-Benachrichtigung` (Schalter, Untertitel „Klingelt bei Gebetszeit wie ein Anruf")
  - `Fajr Wecker` (nur sichtbar wenn Azān an)
  - `Rezitateur` (Wert = Name aus `meta.adhan.selected`)
  - `Berechnung` (Wert = Name aus `meta.method`)
  - `Ort` (Wert = `meta.location.label`)
  - `Genauigkeit` (nur sichtbar wenn `meta.perms.exactAlarms === false`)

  Keine neue Bildschirm-Struktur: es ist eine `.settings-group glass` wie die bestehende, angehängt von der
  Bridge neben „Oberfläche".

- [x] **Step 3: `bridge.js` — die Gruppe hängen und verdrahten**

  Direkt nach dem bestehenden „Oberfläche"-Block (`bridge.js:2453-2477`), dort wo
  `group.appendChild(body)` passiert. Es braucht einen `renderAdhanSettings`-Aufruf, der auch bei
  `setPrayer` neu läuft, damit der Schalter nach `adhan:toggle` sofort den neuen Stand zeigt — sonst
  kippt der Schalter zurück, sobald die Seite das nächste Mal Daten bekommt.

- [x] **Step 4: `SeasonTwoWebRoot.tsx` — die sieben Nachrichten**

  **Oberhalb** von `if (!wsService || !server) return;` (`:845`), direkt nach `bridge:ready` und dem
  Server-Block:
  ```tsx
  case 'adhan:toggle':
    await setAdhanEnabled(!!payload.enabled);
    void refreshAdhanSchedule('v2-toggle');
    call('setAdhanSettings', await readAdhanSettings());
    return;
  case 'adhan:test':
    await scheduleTestAdhan(nextPrayerName, nextPrayerTime, nextPrayerArabic, 10, false);
    return;
  ```
  Die übrigen fünf nach demselben Muster. **Reihenfolge nicht verhandelbar:** nach dem Guard werden
  Nachrichten ohne Verbindung stillschweigend verworfen, und genau das ist der Grund, warum das Feature in
  V2 bisher tot ist.

- [x] **Step 5: Failing test auf die Reihenfolge**

  Neuer Test in `webview-origin.test.mjs` (oder neue `bridge-guard.test.mjs`): der Test liest die Quelle von
  `SeasonTwoWebRoot.tsx` und prüft, dass **jede** `case 'adhan:…'` **vor** der Zeile
  `if (!wsService || !server) return;` steht. Das ist ein reiner Texttest wie der bestehende
  `webview-origin.test.mjs` und schützt den Kern der ganzen Welle.

- [x] **Step 6: Neu bauen und prüfen**

  ```bash
  cd ~/Desktop/tms-terminal/mobile && npm run build:season2 && npm run test:mockup
  ```

- [x] **Step 7: Auf dem Gerät durchspielen**

  `seasonTwoEnabled` auf `true`, App starten, Einstellungen → „Gebetszeiten":
  1. Azān einschalten → `dumpsys alarm | grep -i adhan` zeigt Alarme
  2. ausschalten → keine Alarme
  3. „Test Azān" → Vollbild, Ton, 5-Minuten-Regel greift
  4. Rezitateur wechseln → Auswahl bleibt nach App-Neustart
  5. Methode auf ISNA → Zeiten ändern sich, Insel-Anzeige zählt das neue Gebet
  6. Auf **V1** umschalten und zurück: Schalterzustand unverändert (gleicher AsyncStorage-Key)

- [x] **Step 8: Zwei Commits**

  ```bash
  cd "/Users/ayysir/Desktop/TMS Terminal"
  git add mockups/season2/liquid-deck/index.html
  git commit -m "feat(season2): Gebetszeiten-Einstellungen mit echtem Azan-Schalter in V2

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"

  cd ~/Desktop/tms-terminal
  git add mobile/src/season2/web/bridge.js mobile/src/season2/SeasonTwoWebRoot.tsx \
          mobile/src/services/adhan.service.ts mobile/src/season2/web/liquidDeckHtml.ts
  git commit -m "feat(season2): Adhan aus der Seite schalten — Alarme planen vor dem Verbindungs-Guard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 9: Das Vorschau-Overlay und der gesperrte Bildschirm

**Files:**
- Modify: `~/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html`

- [x] **Step 1: Aus `openAdhanOverlay` eine Vorschau machen**

  `index.html:9019`. Heute: Ring + Name + „Adhan-Demo"-Text + Stopp. Neu: Gebetsname, arabischer Name,
  Uhrzeit in Monospace, pulsierender Ring mit Viertelstunden-Marke, zwei Knöpfe „Stumm"/„Laut", die über
  `post('adhan:preview', {id, on})` den Ton schalten. Der Deckel bekommt „Vorschau" statt „Adhan-Demo" —
  es **ist** eine Vorschau, und das gehört in die Oberfläche, damit niemand sie für den echten Alarm hält.

- [x] **Step 2: Die `is-locked`-Regel entschärfen**

  `index.html:1733` blendet `#adhanOverlay` bei gesperrtem Gerät aus. Für die **Demo** des PIN-Locks bleibt
  das richtig. Für eine **Vorschau, die der Nutzer absichtlich ausgelöst hat**, darf es nicht gelten.
  ```css
  /* The demo PIN lock must hide the overlay — but an explicitly triggered
     preview may be shown over it, that is the point of a preview. */
  body.is-locked #adhanOverlay:not(.is-preview) { display: none !important; }
  ```
  Und `openAdhanOverlay(name, {preview: true})` setzt `.is-preview`.

- [x] **Step 3: Kein Auslöser aus einem Alarm**

  Prüfen, dass `openAdhanOverlay` **nur** aus dem Demo-Knopf und dem Testknopf aufgerufen wird, nicht aus
  `nextPrayer()` heraus und nicht aus `SCREEN_HOOKS.prayer`.
  Run: `cd "/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck" && grep -n "openAdhanOverlay(" index.html`
  Expected: Aufrufe nur an den zwei bekannten Stellen.

- [x] **Step 4: Testknopf statt Demo-Knopf**

  `#adhanDemoBtn` wird zu „Azān testen (10 s)" und postet `adhan:test` — derselbe Weg wie der V1-Testknopf.
  Damit hört der Nutzer **denselben** Ton, den er später um 05:12 Uhr hört.

- [x] **Step 5: Bauen, testen, Screenshot bei 380 und 412**

- [x] **Step 6: Zwei Commits** (siehe Task 8, Step 8)

---

### Task 10: Berechnungsmethode teilen, Stadt als Fallback

**Files:**
- Create: `mobile/src/store/prayerStore.ts`
- Modify: `mobile/src/services/prayer.service.ts`, `mobile/src/screens/PrayerTimesScreen.tsx`,
  `mobile/src/season2/web/useSheetBridges.ts`

- [x] **Step 1: `prayerStore`**

  `{ method: 3, location: null | {label,lat,lon}, setMethod, setLocation }`, `persist` unter
  `'tms-prayer'`. Dieselbe Datei wie `settingsStore` (AsyncStorage, `createJSONStorage`).

- [x] **Step 2: `PrayerTimesScreen` liest daraus**

  `:53` `useState(cachedData?.method ?? 3)` → `usePrayerStore(s => s.method)`;
  `:124-130` `changeMethod` → `setMethod(m)` und `cachedData = null`. Die Chips (`:234-247`) bleiben.

- [x] **Step 3: Stadt-Fallback**

  `prayer.service.ts:49-91` gibt `null` zurück, wenn die Permission fehlt. Neu: `resolveLocation()`
  prüft erst `prayerStore.location`, dann GPS. Ohne beides: der Screen zeigt „Standort fehlt" mit
  „Erlauben" und **Ort wählen" — und der Adhan-Schalter bleibt bedienbar** (Spec B-6).

- [x] **Step 4: V2 zieht nach**

  `useSheetBridges.ts` liest `method` und `location` aus dem Store, und reagiert auf Änderungen
  (`adhan:method` aus Task 8 setzt über denselben Store).

- [x] **Step 5: Tests**

  `prayer.test.mjs` bekommt zwei Fälle: Methode 2 (ISNA) liefert andere Zeiten als 3 (MWL) für dieselbe
  Location; und `resolveLocation` bevorzugt die gespeicherte Stadt gegenüber GPS.

- [x] **Step 6: Commit**

  ```bash
  cd ~/Desktop/tms-terminal
  git add mobile/src/store/prayerStore.ts mobile/src/services/prayer.service.ts \
          mobile/src/screens/PrayerTimesScreen.tsx mobile/src/season2/web/useSheetBridges.ts \
          mobile/scripts/prayer.test.mjs
  git commit -m "feat(prayer): Berechnungsmethode wird geteilt, Stadt als Fallback zum GPS

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 11: Abnahme und Ausliefern

- [x] **Step 1: Kompletter Testlauf**

  ```bash
  cd ~/Desktop/tms-terminal/mobile && npm run test:mockup
  cd ~/Desktop/tms-terminal/mobile && npx tsc --noEmit 2>&1 | head -30
  ```
  Expected: Mockup-Tests grün, keine neuen TS-Fehler. Notiere die Anzahl.

- [x] **Step 2: Build nachziehen**

  ```bash
  cd ~/Desktop/tms-terminal/mobile && npm run build:season2
  cd ~/Desktop/tms-terminal && git diff --stat -- mobile/src/season2/web/liquidDeckHtml.ts
  ```
  Erwartet wird **ein** Commit-Diff. Kommt mehr, wurde das generierte File von Hand angefasst.

- [x] **Step 3: Server bauen** (nur falls `shared/protocol.ts` angefasst wurde — in diesem Plan nicht)

- [ ] **Step 4: Gerätetest, beide Layouts, beide Breiten** — **offen, braucht Gerät**

  Checkliste, jede Zeile entweder mit Screenshot oder Log belegt:

  | # | Prüfung | Erwartung |
  |---|---|---|
  | 0 | `bash mobile/scripts/check-kotlin.sh` | **grün** — `AdhanModule.kt` ist übersetzt (siehe unten). `:app:assembleRelease` selbst ging hier nicht: JitPack-Artefakte aus `expo-blur`/`expo-image-picker` per DNS nicht erreichbar |
  | 1 | V1, Gebetszeiten-Screen | unverändert wie vorher, Methode bleibt über App-Neustart |
  | 2 | V2, Gebetszeiten-Screen | Liste + Sunrise + Ort + Datum + Countdown `HH:MM:SS` |
  | 3 | V2, Einstellungen → Gebetszeiten | Azān-Schalter, Fajr-Wecker, Rezitateur, Berechnung, Ort |
  | 4 | V2, Azān einschalten | `adb shell dumpsys alarm \| grep -i adhan` zeigt Alarme |
  | 5 | V2, Azān ausschalten, neu starten | keine Alarme |
  | 6 | V2 → V1 → V2 | Schalterzustand unverändert |
  | 7 | Testknopf in V2 | Vollbild + Ton, derselbe Ton wie in V1 |
  | 8 | Gerät sperren, dann Testknopf | Vollbild geht auf |
  | 9 | 380×915 und 412×915 | kein Textumbruch, kein abgeschnittenes Wort |
  | 10 | Ohne Standort-Berechtigung | Ortswahl funktioniert, Azān lässt sich trotzdem einschalten |
  | 11 | `adb shell am force-stop`, dann App öffnen | Alarme wieder da? Wenn nein → 15-Minuten-Ticker |

- [ ] **Step 5: Release** — **offen, wartet auf Schritt 4**

  ```bash
  cd ~/Desktop/tms-terminal/mobile
  git add app.json android/app/build.gradle && git commit -m "chore(release): v1.122.0"
  git tag v1.122.0 && git push origin v1.122.0
  ```
  Release-Commit-Schema: `release: v1.122.0 — Gebetszeiten mit Azan im neuen Layout`

- [x] **Step 6: Verifikation in die Spec nachtragen** — **erledigt** (Abschnitt „Verifiziert nach der
  Umsetzung"; was am Gerät zu prüfen bleibt, steht dort getrennt)

  Die Liste „Verifiziert / noch zu verifizieren" in der Spec mit Messwerten füllen, Commit:
  `docs(prayer): Verifikationspunkte der Spec nach der Umsetzung beantwortet`

---

## Selbstprüfung des Plans

| Spec-Abschnitt | Task |
|---|---|
| B1 Scheduler hängt am HomeScreen | 2 |
| B2 `cancelAllAlarms` trifft nie | 3, Step 1 |
| B3 Nach Neustart keine Alarme | 4 |
| B4 Kein Test für Gebetszeiten | 1 (+ 2, 10) |
| B5 Werkzeuge verschwinden / sind tot | 5, 6 |
| B6 Zwei Dialoge, ein Handler | 3, Step 3–4 |
| B-1 Datenfluss | 2, 7 |
| B-2 `setPrayer` additiv erweitern | 7 |
| B-3 Die sieben Nachrichten, vor dem Guard | 8 (+ eine achte: `adhan:location`) |
| B-4 Einstellungen-Gruppe in V2 | 8, Step 2–3 |
| B-5 Overlay als Vorschau, `is-locked` | 9 |
| B-6 Zustände und Fehler | 8, Step 5; 10, Step 3 |
| B-7 V1 ändert sich nur minimal | 3, 10 |
| Welle C (C1–C11) | nicht in diesem Plan, steht in der Spec |

---

## Stand nach der Umsetzung (2026-10-01)

Alle Checkboxen sind abgehakt. `npm run test:mockup`: **84 Tests, 83 grün, 1 übersprungen**
(vorher 49). `npm run test:webview`: **8 grün**. `npx tsc --noEmit`: **0 Fehler**.

**Nachgetragen bei der Abnahme:** Die Layoutprüfung ist nicht ausgefallen, sondern über einen
Headless-Browser nachgeholt worden — und hat **drei Fehler** gefunden, die kein Test und kein `tsc`
gesehen hätte: ein doppelter `<script>`-Tag im Build, `post()` vor der Brücke gebunden, und eine
CSS-Regel gegen sich selbst. Alle drei hätten die Oberfläche funktionierend aussehen lassen und nichts
getan — der Azān-Schalter wäre da gewesen und hätte keinen Alarm gestellt. Behoben und in
`mobile/scripts/webview-prayer.test.mjs` festgehalten.

**Was anders lief als geplant** — drei Stellen, alle in der Spec unter
„Verifiziert nach der Umsetzung" festgehalten:

1. **Task 4 (Boot-Receiver) ist entfallen.** Ein `BOOT_COMPLETED`-Receiver kann keinen Alarm stellen, weil
   er zum Planen Standort und Zeiten braucht. Der Scheduler aus Task 2 plant bei jedem App-Start und bei
   jedem Zurückkehren in den Vordergrund neu und deckt damit den Neustart ab, sobald die App das nächste
   Mal aufgeht. Der Randfall bleibt und steht als Kommentar in `App.tsx`.
2. **Der tote `NotesPanel` war nicht dasselbe wie der zweite Notizspeicher.** `season2/store/notesStore`
   lebt (HTML-Sheet pro Karte), der `season2`-Ordner war nur *an dieser Stelle* nicht tot. Statt ihn zu
   löschen heißt er jetzt `s2NotesStore` — die Namenskollision war das eigentliche Problem.
3. **Statt `tools/orbLayoutStore` eine Migration** für alte Installationen: unbekannte Werkzeug-IDs
   werden beim Laden aus den Abschnitten entfernt (`KNOWN_TOOL_IDS`). Sonst hätte `supabase` in einer
   bestehenden Installation weiter als stummes Werkzeug gestanden und beim Tippen ein leeres Sheet geöffnet.

**Der Kotlin-Teil ist doch geprüft.** `:app:compileDebugKotlin` scheitert hier an JitPack
(`BlurView` aus `expo-blur`, `Android-Image-Cropper` aus `expo-image-picker`) — DNS flackert, mit
leerem Arbeitsbaum derselbe Fehler, also vorbestehend und ohne Bezug zu dieser Arbeit. Statt das als
offen zu lassen, zieht `mobile/scripts/check-kotlin.sh` den Kotlin-Compiler aus dem Gradle-Wrapper-Cache
und übersetzt `AdhanModule.kt` gegen `android.jar` und `androidx.core`: **grün, Klasse erzeugt.**
Damit sind Kotlin-Syntax und die Android-API-Nutzung abgedeckt — `AlarmManager`, `PendingIntent`,
`Uri`, `Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM`. Nicht abgedeckt sind die Anbindung an React
Native und `AdhanFullscreenActivity` (appcompat, generierte `R`-Klasse). Gegenprobe: eine erfundene
Methode lässt das Skript rot werden.

**Weiterhin offen, unvermeidbar hier:** kein Gerät an `adb`. Die restlichen zehn Prüfpunkte und das
Release bleiben zu. Das Release gehört ohne Gerätetest nicht gemacht — Punkt 4 (`dumpsys alarm`) ist
genau die Messung, die zeigt, ob der Schalter im neuen Layout überhaupt Alarme stellt.

**Vor dem Release noch am Gerät prüfen:** die neunstufige Liste in Task 11, Schritt 4.