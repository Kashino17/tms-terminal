# /cron — Manager Agent Cron Job System

_Design Spec — 2026-04-12_

## Zusammenfassung

Ersetzt den automatischen 15-Minuten-Poll durch ein interaktives, persistentes Cron-Job-System. User richtet Jobs über `/cron` ein — der Manager Agent schlägt kontextbasiert 3 Jobs vor oder erstellt gemeinsam mit dem User einen Custom-Job über einen 3-Fragen-Brainstorming-Flow.

## Entscheidungen

| Entscheidung | Wahl | Begründung |
|---|---|---|
| Persistenz | Persistent in Config-Datei | Jobs überleben Server-Neustarts |
| Execution | Hybrid | Einfache Commands direkt, komplexe via Claude |
| Reporting | Smart + Push | Agent entscheidet: Text oder Präsentation. Push bei Problemen |
| Architektur | Eigener Cron Manager | Sauber getrennt vom alten Poll-System |

## Datenmodell

### CronJob

```typescript
interface CronJob {
  id: string;                          // nanoid
  name: string;                        // "Git Status Check"
  schedule: string;                    // Cron-Expression: "*/30 * * * *"
  type: 'simple' | 'claude';          // simple = write_to_terminal, claude = Terminal + Claude
  command: string;                     // simple: "git status", claude: Plan-Text
  targetDir?: string;                  // Arbeitsverzeichnis (default: ~/Desktop/TMS Terminal)
  enabled: boolean;                    // An/Aus Toggle
  createdAt: number;
  lastRunAt?: number;
  lastResult?: 'success' | 'error';
}
```

### Persistenz

Datei: `~/.tms-terminal/cron-jobs.json`

```json
{
  "jobs": [
    {
      "id": "abc123",
      "name": "Git Status Check",
      "schedule": "*/30 * * * *",
      "type": "simple",
      "command": "git status",
      "targetDir": "~/Desktop/TMS Terminal",
      "enabled": true,
      "createdAt": 1712937600000
    }
  ]
}
```

## Neue Dateien

| Datei | Zweck |
|---|---|
| `server/src/manager/cron.manager.ts` | Scheduler, Job-CRUD, Timer-Verwaltung |

## Architektur

### CronManager Klasse

```
CronManager
  ├── jobs: Map<string, CronJob>
  ├── timers: Map<string, NodeJS.Timeout>
  ├── load()           → Liest cron-jobs.json beim Start
  ├── save()           → Schreibt cron-jobs.json
  ├── addJob(job)      → Job anlegen + Timer starten
  ├── removeJob(id)    → Job löschen + Timer stoppen
  ├── toggleJob(id)    → enabled umschalten
  ├── listJobs()       → Alle Jobs zurückgeben
  ├── scheduleJob(job) → setInterval basierend auf Cron-Expression
  └── executeJob(job)  → Job ausführen (simple oder claude)
```

### Cron-Expression Parsing

Eigene simple Logik statt Dependency. Unterstützte Formate:

- `*/N * * * *` → alle N Minuten
- `0 */N * * *` → alle N Stunden
- `0 0 * * *` → täglich um Mitternacht
- `0 0 * * 1` → wöchentlich Montag

Berechnet nächste Ausführung, nutzt `setTimeout` statt `setInterval` (präziser bei langen Intervallen). Nach jeder Ausführung wird der nächste Timer gesetzt.

## Flow: `/cron` Command

### Phase 1: Interaktives Setup

```
User tippt /cron
  → Client fügt User-Nachricht "/cron" zum Chat hinzu
  → Client sendet manager:chat mit CRON_SETUP_PROMPT
  → CRON_SETUP_PROMPT instruiert den Agent:
      1. Analysiere aktuelle Terminal-Contexts und Memory
      2. Schlage 3 sinnvolle Cron Jobs vor, basierend auf dem was der User macht
      3. Biete Option 4 an: "Eigenen Cron Job definieren"
      4. Formatiere als nummerierte Liste
```

### Phase 2a: Vorgefertigter Job gewählt

```
User wählt Vorschlag 1/2/3
  → Agent ruft create_cron_job Tool auf
  → Job wird gespeichert und Timer gestartet
  → Agent bestätigt: "✓ Cron Job '{name}' eingerichtet — läuft {schedule}"
```

### Phase 2b: Custom Job — 3-Fragen-Brainstorming

```
User wählt Option 4 (Custom)
  → Agent fragt Frage 1: "Was soll der Job machen?"
  → User antwortet
  → Agent fragt Frage 2: "Wie oft soll er laufen?" (mit Vorschlägen)
  → User antwortet
  → Agent fragt Frage 3: "Braucht er Claude oder reicht ein einfacher Befehl?"
  → User antwortet
  → Agent erstellt Plan und ruft create_cron_job auf
  → Wenn type='claude': Agent erstellt Terminal, startet Claude, übergibt Plan
```

## Execution-Flow (bei Cron-Trigger)

### type='simple'

```
Timer feuert
  → CronManager ruft ManagerService.executeCronJob(job) auf
  → Manager schreibt Command via write_to_terminal in bestehendes oder neues Terminal
  → Wartet 5-10s auf Output
  → Agent bewertet Output:
      - Alles OK → Stiller Log im Chat (Text-Nachricht)
      - Probleme → Präsentation oder detaillierter Text + Push Notification
  → lastRunAt + lastResult aktualisieren
```

### type='claude'

```
Timer feuert
  → CronManager ruft ManagerService.executeCronJob(job) auf
  → Manager ruft create_terminal(label="Cron: {name}", initial_command="cd {dir} && claude")
  → pendingPrompt = job.command (der Plan)
  → Heartbeat überwacht wie bei normalen delegierten Tasks
  → Bei Completion: Agent reviewed Output, berichtet im Chat
  → Push Notification
  → Terminal wird nach Completion geschlossen
  → lastRunAt + lastResult aktualisieren
```

## Neue Tools für den Manager Agent

### create_cron_job

```typescript
{
  name: 'create_cron_job',
  description: 'Erstellt einen neuen Cron Job der automatisch nach Zeitplan läuft.',
  parameters: {
    name: string,          // "Git Status Check"
    schedule: string,      // "*/30 * * * *"
    type: 'simple' | 'claude',
    command: string,       // Shell-Befehl oder Plan-Text
    target_dir?: string    // Arbeitsverzeichnis
  }
}
```

### list_cron_jobs

```typescript
{
  name: 'list_cron_jobs',
  description: 'Zeigt alle eingerichteten Cron Jobs mit Status.',
  parameters: {}
}
```

### toggle_cron_job

```typescript
{
  name: 'toggle_cron_job',
  description: 'Aktiviert oder deaktiviert einen Cron Job.',
  parameters: {
    job_id: string,
    enabled: boolean
  }
}
```

### delete_cron_job

```typescript
{
  name: 'delete_cron_job',
  description: 'Löscht einen Cron Job permanent.',
  parameters: {
    job_id: string
  }
}
```

## Änderungen an bestehendem Code

### Entfernen: 15-Min Auto-Poll

In `manager.service.ts`:
- `POLL_INTERVAL_MS` Konstante löschen
- `pollTimer` aus `start()` entfernen (kein `setInterval` mehr)
- `pollTimer` aus `stop()` entfernen (kein `clearInterval` mehr)
- `poll()` Methode bleibt — wird weiterhin manuell via `/sm` ausgelöst

### Neue WebSocket-Messages

| Message | Richtung | Zweck |
|---|---|---|
| `manager:cron_jobs` | Server → Client | Liste aller Jobs (nach Änderung) |

### SLASH_COMMANDS Array

```typescript
{ cmd: '/cron', label: 'Scheduler', desc: 'Cron Jobs einrichten' }
```

### System Prompt Erweiterung

Dem Agent wird erklärt:
- Wie die Cron-Tools funktionieren
- Dass er beim `/cron` Setup kontextbasiert 3 Vorschläge machen soll
- Dass er beim Custom-Flow genau 3 Fragen stellen soll
- Cron-Expression-Beispiele die er nutzen kann

## Mobile App Änderungen

### ManagerChatScreen

- `/cron` zum SLASH_COMMANDS Array hinzufügen
- Handler: sendet `manager:chat` mit CRON_SETUP_PROMPT
- Kein neuer Screen nötig — alles läuft conversational im Chat

### managerStore

- Optional: `cronJobs` State für Anzeige der aktiven Jobs (nice-to-have)
