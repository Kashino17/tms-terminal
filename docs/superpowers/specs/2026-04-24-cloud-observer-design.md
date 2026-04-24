# Cloud — Autonomous Terminal Observer

**Status:** Design approved · 2026-04-24
**Author:** ayysir (via Claude)
**Scope:** Server-side only (Mobile shows existing FCM push with a new sender-badge).

---

## Kontext & Motivation

Der Manager Agent (Rem) läuft heute event-driven (~3s pro Terminal-Output-Chunk) mit einem 45s-Heartbeat-Safety-Net. Bei mehreren aktiven Terminals muss Rem jeden Chunk selbst auswerten — das blockiert Rems Hauptrolle (Tool-Calls, Reasoning, Antworten an den User) und führt zu schlechter Reaktionslatenz, wenn Rem gerade mit einem langen lokalen Generation-Zyklus (Qwen 3 35B, bis zu mehrere Minuten) beschäftigt ist.

**Cloud** ist ein neues Subsystem — keine Persona, kein sichtbarer Agent — das Terminal-Output parallel zu Rem beobachtet, deterministisch filtert, und proaktiv Ereignisse meldet:
- **Urgent** (interaktive Prompts, Errors) → direkt Push ans Handy, bypasses Rem
- **Info** (Job fertig, Build durchgelaufen) → als `cloud:report` an Rem, Rem entscheidet weiter

Ergebnis: Rem bleibt fokussiert auf strategische Arbeit, der User kriegt trotzdem in <2s eine Push wenn ein Claude-CLI in einer Shell auf Antwort wartet.

---

## Goals

- **G1** — Terminal-Events werden in <2s auf dem Handy sichtbar (Pattern-Trigger), auch wenn Rem gerade generiert.
- **G2** — Cloud arbeitet autark von Rems Verfügbarkeit (kein Bottleneck am lokalen LLM).
- **G3** — Kein Duplicate-Spam: wenn Cloud pusht UND Rem später kommentiert, erscheinen das für den User als klar getrennte Absender (Icon-Badge), nicht als zwei identische Pushes.
- **G4** — Rem kriegt alle Cloud-Events in ihren Context (als system-role message), sodass sie strategisch reagieren kann, ohne selbst jeden Chunk zu lesen.
- **G5** — Offline-fähig: wenn Cloud-API nicht erreichbar ist, fällt Cloud auf Template-Summaries zurück, pusht weiterhin.

## Non-Goals

- Kein Multi-Device-Support (single FCM token pro Installation).
- Cloud erzeugt keine eigene Persona / keine eigene Voice / keinen eigenen Chat — nur Reports.
- Cloud führt keine Tools aus, schreibt nicht ins Terminal zurück.
- Cloud hat keine eigene Memory / kein Lernen — nur kurzlebiger State (Dedup, Rate-Limiting).
- Keine Änderungen am Mobile-Code außer: FCM-payload schon heute `data`-kompatibel, Mobile rendert `sender: "cloud"` mit eigenem Badge (separater kleiner UI-Task, ist Teil der Plan-Phase).

---

## Architektur — Datenfluss

```
ws.handler: terminal:output
     │
     ├──► manager.service.feedOutput()        [bestehend, unverändert]
     │
     └──► cloudObserver.feed(sessionId, data) [NEU]
                │
                ├──► Dedup-Check  (SHA 200 chars, 60s-Fenster)
                ├──► Cooldown-Check (3s seit letztem Rem-Write auf diese Session?)
                ├──► Rate-Limit-Check (max 5 Reports/Session/2min)
                │
                ├──► PatternMatcher.match(chunk)
                │       │   (wartender Prompt / Error / [Y/n] / password / stack-trace)
                │       │
                │       └─► fires IMMEDIATELY
                │             ├─► TemplateSummarizer.format(event)  [synchron, 0ms]
                │             │
                │             ├─► fcm.service.sendBig({ sender: "cloud", urgency: "urgent", ... })
                │             │
                │             └─► managerService.ingestCloudReport(report)
                │                   │  (system-role message in Rem's tab context)
                │
                └──► SilenceDebouncer.push(sessionId, chunk)
                        │   (1500ms quiet → fire; buffer accumulated chunks)
                        │
                        └─► fires AFTER silence
                              ├─► LLMSummarizer.summarize(buffer, label)  [~500ms, Haiku via API]
                              │     └─ Fallback bei API-Fehler: TemplateSummarizer mit kind="info"
                              │
                              └─► managerService.ingestCloudReport(report)
                                    │
                                    └─► Rem's ManagerPushDecider entscheidet (screen-state, debounce, stale)
                                          └─► evtl. fcm.service.sendBig({ sender: "rem", ... })
```

---

## Komponenten

### Neu: `server/src/manager/cloud/`

| Datei | Verantwortung |
|---|---|
| `cloud.observer.ts` | Top-level orchestrator. Öffentliche API: `feed(sessionId, chunk)`, `pauseSession(sessionId, durationMs)`, `start()`, `stop()`, `getState()`. Hält SilenceDebouncer-Timer pro Session, ruft PatternMatcher synchron auf, verdrahtet Dedup/Cooldown/Rate-Limit. Emittiert `cloud:report` via Callback an `manager.service`. |
| `cloud.patterns.ts` | Regex-Katalog + `match(chunk, sessionContext): PatternMatch \| null`. Return-Typ enthält `kind`, `urgency`, `matchedLine`, `templateVars`. Erweiterbar — jedes Pattern ist eigenes Objekt `{ id, regex, kind, urgency, extractVars }`. |
| `cloud.summarizer.ts` | Zwei reine Funktionen: `templateSummary(event: PatternMatch, sessionLabel: string): string` (synchron), `llmSummary(buffer: string, sessionLabel: string, provider: AiProvider): Promise<string>` (async). Bei LLM-Fehler wirft die Funktion — Caller entscheidet Fallback. |
| `cloud.dedup.ts` | `DedupGuard` class mit: `hasSeen(sessionId, content): boolean`, `isInCooldown(sessionId): boolean`, `setCooldown(sessionId, ms)`, `isRateLimited(sessionId): boolean`, `recordReport(sessionId)`. Internes State ist der `cloudState`-Slot in ManagerMemory (in-memory + persisted). |
| `cloud.types.ts` | `CloudReport`, `CloudTrigger = "pattern" \| "silence"`, `CloudUrgency = "urgent" \| "info"`, `PatternMatch`, `CloudConfig`. |
| `cloud.config.ts` | Lädt `cloud`-Block aus `~/.tms-terminal/config.json` mit Defaults. Reload-fähig. |

### Modifikationen

| Datei | Change |
|---|---|
| `server/src/manager/manager.service.ts` | (a) `feedOutput()` ruft zusätzlich `cloudObserver.feed()` auf. (b) Neuer Handler `ingestCloudReport(report: CloudReport)` hängt Report als system-role message in den passenden Tab-Context-Bucket (`chatHistoriesByTab`). (c) Tool-Handler für `write_to_terminal` / `send_enter` / `send_keys` rufen zusätzlich `cloudObserver.pauseSession(sessionId, cooldownMs)`. (d) In `start()`: `cloudObserver.start()` mitstarten. (e) In `stop()`: `cloudObserver.stop()`. |
| `server/src/manager/manager.memory.ts` | Neuer persistierter Slot `cloudState: { lastReportAt: Record<string, number>, dedupHashes: Array<{hash: string, ts: number}>, rateLimitWindows: Record<string, number[]> }`. Schema-Migration: falls Feld fehlt in alter Datei → default-leer anlegen. Slot wird **nicht** in `insights`/`userFacts` gemischt. |
| `server/src/notifications/fcm.service.ts` | `sendBig()` kriegt neues optionales Feld `sender: "rem" \| "cloud"` in data-payload. Default `"rem"`. Mobile rendert anderes Icon-tint, aber das ist Mobile-Task (separater Plan-Eintrag). |
| `server/src/config.ts` | Lädt `cloud`-Block beim Start mit. |
| `shared/protocol.ts` | Neuer WS-Message-Type `manager:cloud_report` (server → mobile, optional fürs debugging — nicht für Push, Push geht direkt via FCM). |

---

## Trigger-Strategie

### Pattern-Trigger (sofort, Template-Summary)

Pattern-Matcher läuft synchron bei jedem `feed()`-Aufruf. Regex-Katalog:

| Pattern ID | Regex / Heuristik | Urgency | Template |
|---|---|---|---|
| `claude-prompt-waiting` | Claude-CLI prompt-marker + 500ms still (reuses `prompt.detector.ts`) | urgent | `"🤖 Claude in {shell} wartet: {last_question}"` |
| `codex-prompt-waiting` | Codex prompt-marker (reuses `prompt.detector.ts`) | urgent | `"🤖 Codex in {shell} wartet: {last_question}"` |
| `gemini-prompt-waiting` | Gemini prompt-marker (reuses `prompt.detector.ts`) | urgent | `"🤖 Gemini in {shell} wartet: {last_question}"` |
| `shell-yesno-prompt` | `/\[Y\/n\]\\|\(y\/N\)\\|Are you sure\?/i` | urgent | `"⚠️ {shell} fragt: {prompt_line}"` |
| `password-prompt` | `/^(password\\|passphrase)[:\?]/im` | urgent | `"🔐 {shell} will Passwort"` |
| `error-signature` | `/^(Error\\|Fatal\\|TypeError\\|ReferenceError)[:\s]/m` + optional Stack-Trace-Detection | urgent | `"🔴 Error in {shell}: {error_line}"` |
| `test-failure` | `/^(FAIL\\|✖\\|×) /m` (jest, vitest, pytest signatures) | urgent | `"🧪 Test failed in {shell}: {fail_line}"` |
| `crash-signal` | `/Segmentation fault\\|Killed\\|core dumped/i` | urgent | `"💥 {shell} crashed"` |

Template-Summarizer extrahiert `last_question`/`prompt_line`/`error_line` über einfache Slicing-Logik auf dem letzten 500-char-Fenster des Chunks.

### Silence-Trigger (debounced, LLM-Summary)

- Debouncer hält pro Session einen Timer (`setTimeout`) mit **1500ms** Delay.
- Jeder neue Chunk resettet den Timer.
- Wenn Timer feuert UND Buffer seit letzter Summary **> 500 chars** gewachsen ist → `llmSummary()`.
- Buffer-Inhalt = Cleaned Output (ANSI stripped) seit letzter Silence-Summary, capped auf 3000 chars (tail-preserved).
- Progress-Bar-Heuristik: Wenn Buffer ≥50% aus `\r` oder Pattern `/\d+%|\[=+>/` besteht → skip (kein Summary wert).
- LLM-Aufruf: Haiku via AnthropicSDK mit Prompt:
  ```
  Fasse diesen Terminal-Output in 2-3 kurzen deutschen Sätzen zusammen.
  Nenne den Befehl/Tool wenn erkennbar. Sag NICHT "Der User hat...",
  sondern "Shell X: ...". Kein Prefix, keine Meta-Kommentare.

  Shell-Name: {sessionLabel}
  Output:
  {buffer}
  ```
- Bei API-Fehler / Timeout 5s → Fallback zu `templateSummary({kind: "info-generic", ...})` mit Text `"Shell {sessionLabel}: {chunk.length} chars neuer Output, letzte Zeile: {last_line}"`.

---

## Push-Flow

### Urgent (Pattern-Trigger)
- Cloud ruft `fcm.service.sendBig({ sender: "cloud", urgency: "urgent", title: templateTitle, body: templateBody, sessionId, messageId: hash })` **direkt**.
- Paralleler Call `managerService.ingestCloudReport()` damit Rem den Event im Context sieht.
- Rem wird **nicht** automatisch triggered — sie reagiert nur wenn User explizit fragt oder Rem selbst als nächstes dran ist.

### Info (Silence-Trigger)
- Cloud ruft `managerService.ingestCloudReport()` mit `urgency: "info"`.
- Rem's existing `ManagerPushDecider` (aus v1.20.0) entscheidet ob Push:
  - skip wenn User grad im Chat (screen-state "active")
  - 3s global debounce
  - stale-detection (15s)
- Wenn push: `sender: "rem"` (Rem hat den Report gesehen, ihre Stimme).

### Sender-Badge
- FCM-data-field `sender` = `"cloud"` oder `"rem"`.
- Mobile-side (separater Plan-Task): unterschiedliches Icon-tint, evtl. unterschiedlicher channel-name (Android notification channels).

---

## Loop-Prevention

Vier unabhängige Safeguards, **alle** müssen passieren damit Cloud feuert:

1. **Rem-Write-Cooldown** — Nach jedem Tool-Call von Rem (`write_to_terminal`, `send_enter`, `send_keys`): `cloudObserver.pauseSession(sessionId, config.remWriteCooldownMs)` (default 3000ms). Während Cooldown ignoriert Cloud alle `feed()`-Calls für diese Session komplett (weder Pattern noch Silence).

2. **Content-Dedup** — SHA-256 von `sessionId + " " + last 200 chars of buffer`. Vor jedem Report: `dedupGuard.hasSeen(hash)`. Wenn hash < 60s alt → skip. Ring-Buffer von max 200 Hashes.

3. **Rate-Limit** — `rateLimitWindows[sessionId]` hält Timestamps der letzten Reports. Vor jedem Report: prune Einträge älter 2min, check `length < 5`. Wenn voll → skip silently (kein Log-Spam).

4. **Rem-Generating-Gate** — Wenn `managerService.isProcessing === true` für den Tab der Session:
   - Pattern-Trigger (urgent): pusht trotzdem sofort (wichtig für User), aber skippt `ingestCloudReport()` (Rem kriegt's später beim nächsten Idle).
   - Silence-Trigger (info): queued (max 10s), dropped wenn Rem nach 10s noch generiert.

---

## Persistenz

Neuer Slot in `manager.memory.ts`:

```typescript
interface CloudState {
  // Zeitpunkt der letzten Summary pro Session — für "Buffer gewachsen seit"
  lastReportAt: Record<string, number>;

  // Ring-Buffer dedup-hashes mit Timestamp — 60s Fenster
  dedupHashes: Array<{ hash: string; ts: number }>;

  // Rate-Limit-Fenster pro Session — Array von Timestamps
  rateLimitWindows: Record<string, number[]>;
}
```

- Persistiert bei jedem Update (`saveMemory()` ist schon debounced).
- Bei Server-Restart: state wird geladen — Dedup/Rate-Limits bleiben über Restart bestehen (gewollt, sonst Duplicate-Push-Risiko nach Crash-Restart).
- Migration: Wenn Feld fehlt in alter memory-Datei → leer initialisieren, kein Crash.
- `cloudState` ist **nicht** Teil von `insights`/`userFacts`/`traits` — kein Vermischen mit Rem's persönlichem Gedächtnis.

---

## Konfiguration

Neuer Block in `~/.tms-terminal/config.json`:

```json
{
  "cloud": {
    "enabled": true,
    "silenceDebounceMs": 1500,
    "remWriteCooldownMs": 3000,
    "rateLimitMax": 5,
    "rateLimitWindowMs": 120000,
    "minBufferDeltaChars": 500,
    "llmProvider": "anthropic",
    "llmModel": "claude-haiku-4-5-20251001",
    "llmTimeoutMs": 5000,
    "templateOnly": false
  }
}
```

- `enabled: false` → Cloud läuft nicht, System verhält sich wie heute.
- `templateOnly: true` → keine LLM-Calls, auch Silence-Trigger nutzt Template-Summary. Fallback-Mode wenn kein API-Key oder offline-Anforderung.
- Defaults in `cloud.config.ts`. Config-Fehler (invalides JSON, fehlende Felder) → log warning, use defaults.

---

## Error Handling

| Fehlerfall | Verhalten |
|---|---|
| Haiku-API Timeout (>5s) | Fallback zu Template-Summary (info-generic). Log warning mit `sessionId, duration`. |
| Haiku-API 4xx/5xx | Fallback wie oben. Bei konsekutiven 3 Fehlern in 60s → `templateOnly`-Mode für 5min (circuit breaker). |
| Kein API-Key konfiguriert | Log warning beim Start, `templateOnly: true` enforcen. Cloud läuft weiterhin, alles Template-basiert. |
| `fcm.service.sendBig()` wirft | Log error. Kein retry (user kann nicht gepusht werden = akzeptierter Fehler für diese eine Nachricht). `ingestCloudReport()` trotzdem ausführen, damit Rem's Context nicht zu sehr divergiert. |
| `ingestCloudReport()` wirft | Log error. FCM-Push war schon raus — Rem kriegt's halt nicht. Kein user-facing Fehler. |
| Pattern-Regex matcht falsch / endlos | Regex-Compile-Time ist bei Startup geprüft. Runtime: Jeder Pattern-Match kriegt eine 50ms-Regex-Timeout-Wrapper (via `RegExp`+`AbortSignal`-Äquivalent oder einfacher: max. 1000 chars pro match-Call). |
| Memory-Save wirft bei cloudState-Update | Log error, in-memory state behalten. Beim nächsten erfolgreichen save wird's wieder persistiert. Kein user-facing Fehler. |

---

## Testing-Strategie

### Unit Tests (jest/vitest)
- `cloud.patterns.test.ts` — Jedes Pattern: positive match, negative (non-match), edge cases (ANSI-stripped vs raw, partial matches, multiple in one chunk).
- `cloud.dedup.test.ts` — Ring-Buffer-Verhalten, 60s-Fenster-Cleanup, Rate-Limit-Prune.
- `cloud.summarizer.test.ts` — Template-Slicing (last_line-Extraktion, edge cases: leer, nur whitespace, very long). LLM-Call mit mock-provider.
- `cloud.observer.test.ts` — End-to-end: feed() → trigger → (mock) fcm/ingest aufgerufen? Cooldown-Enforcement? Rate-Limit-Enforcement? Dedup?

### Integration
- `cloud.integration.test.ts` — Fake terminal-output stream → Observer → stub fcm + stub manager. Verifiziert komplette Kette pro Trigger-Typ.

### Manual Smoke
- `npm run start` im server → echte Shell, `npm install` in einer Session → Silence-Trigger feuert, Push kommt (wenn FCM+Mobile verbunden).
- Claude-CLI in einer Shell starten, Frage stellen und warten → Pattern-Trigger feuert, Push kommt innerhalb 2s.
- Rem manuell Befehl schreiben lassen (via chat) → während 3s Cooldown KEIN Cloud-Push.

---

## Implementation-Sequence (Hinweis für writing-plans)

Empfohlene Task-Reihenfolge:

1. **Types & Config-Layer** — `cloud.types.ts`, `cloud.config.ts`, Memory-Schema-Migration in `manager.memory.ts`. Ohne Runtime-Logik, nur Gerüst. Commit.
2. **Dedup-Guard** — `cloud.dedup.ts` + Unit-Tests. Reine Logik, keine Abhängigkeiten. Commit.
3. **Pattern-Matcher** — `cloud.patterns.ts` + Unit-Tests für alle Patterns. Commit.
4. **Summarizer (Template-Pfad)** — `cloud.summarizer.ts` mit `templateSummary()` + Tests. Noch ohne LLM. Commit.
5. **Observer-Skelett** — `cloud.observer.ts` mit `feed()`, `pauseSession()`, Debouncer. Template-only erstmal, LLM-Pfad wirft `NotImplemented`. Integration-Test. Commit.
6. **Wire-in in manager.service.ts** — `feedOutput()` + Tool-Handler-Cooldown + `ingestCloudReport()`. Commit.
7. **FCM-sender-badge** — `fcm.service.ts` `sender`-Feld. Commit.
8. **Manual Smoke mit Template-only** — Cloud läuft, Pattern-Pushes funktionieren end-to-end. Commit als `feat(cloud): template-only observer (v1.x.0)`.
9. **LLM-Summarizer** — `llmSummary()` mit Anthropic-Provider, Fallback-Logik, Circuit-Breaker. Tests. Commit.
10. **Silence-Trigger aktivieren** — Observer nutzt LLM-Pfad wenn `templateOnly: false`. Commit.
11. **Mobile-Sender-Badge** (optional, separater PR möglich) — Mobile zeigt Cloud-Pushes mit anderem Icon.
12. **Final Smoke + Release** — v1.22.0 `feat(cloud): autonomous terminal observer`.

Jeder Schritt ist für sich committbar und reversibel — wenn 9-10 nicht klappen, bleibt der Template-only Modus als Produktivstand.

---

## Offene Punkte

Keine. Alle Design-Entscheidungen sind getroffen (User-bestätigt im Brainstorming am 2026-04-24).

---

## Summary der Design-Entscheidungen

| Thema | Entscheidung |
|---|---|
| Identität | Subsystem, keine Persona, keine eigene Stimme |
| Trigger | Hybrid: Pattern (instant) + Silence 1.5s |
| Push | Hybrid: Urgent pusht Cloud direkt, Info geht über Rem |
| Summarizer | Template für urgent (0ms), Haiku API für info (~500ms) |
| Fallback | Template-only-Mode wenn API nicht verfügbar / konfiguriert |
| Persistenz | Neuer `cloudState`-Slot in ManagerMemory (SQLite via saveMemory) |
| Device | Single (Fold 7), kein Multi-Device-Sync |
| Loop-Prevention | Cooldown (3s nach Rem-Write) + Dedup (SHA 200c, 60s) + Rate-Limit (5/2min) + Rem-Generating-Gate |
| Konfiguration | `cloud`-Block in `~/.tms-terminal/config.json`, `enabled` + `templateOnly` als Kill-Switches |
