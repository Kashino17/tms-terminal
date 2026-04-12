# /cron — Cron Job System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 15-minute auto-poll with a persistent, interactive cron job system that the Manager Agent manages via native tools.

**Architecture:** New `CronManager` class handles scheduling and persistence (`~/.tms-terminal/cron-jobs.json`). Four new tools (`create_cron_job`, `list_cron_jobs`, `toggle_cron_job`, `delete_cron_job`) are added to the Manager Agent. The `/cron` slash command triggers an interactive AI-driven setup flow. Simple jobs execute commands directly; complex jobs delegate to Claude via terminal creation.

**Tech Stack:** TypeScript, node-pty (existing), WebSocket protocol (existing), React Native (existing)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `server/src/manager/cron.manager.ts` | Create | CronManager class: scheduling, CRUD, persistence, cron parsing |
| `server/src/manager/manager.service.ts` | Modify | Remove poll timer, add cron tools to MANAGER_TOOLS, add tool handlers |
| `server/src/websocket/ws.handler.ts` | Modify | Initialize CronManager, wire up cron execution callback |
| `mobile/src/screens/ManagerChatScreen.tsx` | Modify | Add `/cron` to SLASH_COMMANDS, add handler |

---

### Task 1: Create CronManager with persistence

**Files:**
- Create: `server/src/manager/cron.manager.ts`

- [ ] **Step 1: Create cron.manager.ts with types and CronManager class**

```typescript
// server/src/manager/cron.manager.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';

// ── Types ───────────────────────────────────────────────────────────────────

export interface CronJob {
  id: string;
  name: string;
  schedule: string;          // "*/30 * * * *", "0 */2 * * *", "0 0 * * *", "0 0 * * 1"
  type: 'simple' | 'claude';
  command: string;
  targetDir?: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastResult?: 'success' | 'error';
}

interface CronFile {
  jobs: CronJob[];
}

// ── Cron Expression Parsing ─────────────────────────────────────────────────

/** Parse a cron expression and return interval in milliseconds.
 *  Supports: *\/N * * * * (every N min), 0 *\/N * * * (every N hr),
 *  0 0 * * * (daily), 0 0 * * 1 (weekly Monday) */
function cronToMs(schedule: string): number {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron: ${schedule}`);
  const [min, hr] = parts;

  // */N * * * * → every N minutes
  if (min.startsWith('*/') && hr === '*') {
    const n = parseInt(min.slice(2), 10);
    if (n > 0) return n * 60_000;
  }
  // 0 */N * * * → every N hours
  if (min === '0' && hr.startsWith('*/')) {
    const n = parseInt(hr.slice(2), 10);
    if (n > 0) return n * 3600_000;
  }
  // 0 0 * * * → daily (24h)
  if (min === '0' && hr === '0' && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    return 24 * 3600_000;
  }
  // 0 0 * * N → weekly (168h)
  if (min === '0' && hr === '0' && parts[2] === '*' && parts[3] === '*' && /^[0-6]$/.test(parts[4])) {
    return 7 * 24 * 3600_000;
  }
  throw new Error(`Unsupported cron expression: ${schedule}`);
}

/** Format a cron schedule to a human-readable German string */
export function cronToLabel(schedule: string): string {
  try {
    const ms = cronToMs(schedule);
    if (ms < 3600_000) return `alle ${ms / 60_000} Minuten`;
    if (ms < 86400_000) return `alle ${ms / 3600_000} Stunden`;
    if (ms === 86400_000) return 'täglich';
    if (ms === 604800_000) return 'wöchentlich';
    return schedule;
  } catch {
    return schedule;
  }
}

// ── CronManager ─────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.tms-terminal');
const CRON_FILE = path.join(CONFIG_DIR, 'cron-jobs.json');

export class CronManager {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, NodeJS.Timeout>();
  private onExecute: ((job: CronJob) => Promise<void>) | null = null;

  /** Set the callback that fires when a job should execute */
  setExecuteCallback(cb: (job: CronJob) => Promise<void>): void {
    this.onExecute = cb;
  }

  /** Load jobs from disk and schedule enabled ones */
  load(): void {
    if (!fs.existsSync(CRON_FILE)) {
      logger.info('CronManager: no cron-jobs.json found, starting empty');
      return;
    }
    try {
      const raw = fs.readFileSync(CRON_FILE, 'utf-8');
      const data = JSON.parse(raw) as CronFile;
      for (const job of data.jobs) {
        this.jobs.set(job.id, job);
        if (job.enabled) this.scheduleJob(job);
      }
      logger.info(`CronManager: loaded ${this.jobs.size} jobs (${[...this.jobs.values()].filter(j => j.enabled).length} active)`);
    } catch (err) {
      logger.warn(`CronManager: failed to load cron-jobs.json — ${err}`);
    }
  }

  /** Save current jobs to disk */
  private save(): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    const data: CronFile = { jobs: [...this.jobs.values()] };
    const tmp = CRON_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CRON_FILE);
  }

  /** Add a new job and start its timer if enabled */
  addJob(job: CronJob): void {
    this.jobs.set(job.id, job);
    if (job.enabled) this.scheduleJob(job);
    this.save();
    logger.info(`CronManager: added job "${job.name}" (${job.schedule}, type=${job.type})`);
  }

  /** Remove a job and stop its timer */
  removeJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.clearTimer(id);
    this.jobs.delete(id);
    this.save();
    logger.info(`CronManager: removed job "${job.name}"`);
    return true;
  }

  /** Toggle a job on/off */
  toggleJob(id: string, enabled: boolean): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.enabled = enabled;
    if (enabled) {
      this.scheduleJob(job);
    } else {
      this.clearTimer(id);
    }
    this.save();
    logger.info(`CronManager: ${enabled ? 'enabled' : 'disabled'} job "${job.name}"`);
    return true;
  }

  /** Get all jobs */
  listJobs(): CronJob[] {
    return [...this.jobs.values()];
  }

  /** Get a single job by ID */
  getJob(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  /** Update lastRunAt and lastResult after execution */
  updateJobResult(id: string, result: 'success' | 'error'): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.lastRunAt = Date.now();
    job.lastResult = result;
    this.save();
  }

  /** Stop all timers (for server shutdown) */
  stopAll(): void {
    for (const [id] of this.timers) {
      this.clearTimer(id);
    }
    logger.info('CronManager: stopped all timers');
  }

  /** Schedule a job using setTimeout (re-schedules after each run) */
  private scheduleJob(job: CronJob): void {
    this.clearTimer(job.id);
    try {
      const intervalMs = cronToMs(job.schedule);
      const timer = setTimeout(() => this.executeAndReschedule(job.id), intervalMs);
      timer.unref();
      this.timers.set(job.id, timer);
    } catch (err) {
      logger.warn(`CronManager: failed to schedule "${job.name}" — ${err}`);
    }
  }

  private async executeAndReschedule(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || !job.enabled) return;

    logger.info(`CronManager: executing job "${job.name}" (${job.type})`);
    try {
      if (this.onExecute) await this.onExecute(job);
      this.updateJobResult(id, 'success');
    } catch (err) {
      logger.warn(`CronManager: job "${job.name}" failed — ${err}`);
      this.updateJobResult(id, 'error');
    }

    // Re-schedule for next run
    if (job.enabled) this.scheduleJob(job);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/server" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/src/manager/cron.manager.ts
git commit -m "feat(manager): add CronManager with persistence and scheduling"
```

---

### Task 2: Remove 15-minute auto-poll from ManagerService

**Files:**
- Modify: `server/src/manager/manager.service.ts:19-20,527,594-603,605-617`

- [ ] **Step 1: Remove POLL_INTERVAL_MS constant**

In `server/src/manager/manager.service.ts`, delete line 20:
```typescript
const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
```

- [ ] **Step 2: Remove pollTimer property**

In `server/src/manager/manager.service.ts`, change line 527 from:
```typescript
  private pollTimer: NodeJS.Timeout | null = null;
```
to remove it entirely. (The `heartbeatTimer` on line 528 stays.)

- [ ] **Step 3: Remove pollTimer from start()**

In `server/src/manager/manager.service.ts`, change `start()` (lines 594-603) from:
```typescript
  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.pollTimer.unref();
    // Heartbeat: check delegated tasks every 60s
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
    logger.info('Manager: started (polling every 15 min, heartbeat every 60s)');
  }
```
to:
```typescript
  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
    logger.info('Manager: started (heartbeat every 15s)');
  }
```

- [ ] **Step 4: Remove pollTimer from stop()**

In `server/src/manager/manager.service.ts`, change `stop()` (lines 605-617) from:
```typescript
  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    logger.info('Manager: stopped');
  }
```
to:
```typescript
  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    logger.info('Manager: stopped');
  }
```

- [ ] **Step 5: Verify it compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/server" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add server/src/manager/manager.service.ts
git commit -m "feat(manager): remove 15-minute auto-poll timer"
```

---

### Task 3: Add cron tools to MANAGER_TOOLS and ManagerAction type

**Files:**
- Modify: `server/src/manager/manager.service.ts:26-168,172-176`

- [ ] **Step 1: Add cron tool definitions to MANAGER_TOOLS array**

In `server/src/manager/manager.service.ts`, after the `update_task` tool definition (before the closing `];` on line 168), add:

```typescript
  {
    type: 'function',
    function: {
      name: 'create_cron_job',
      description: 'Erstellt einen neuen Cron Job der automatisch nach Zeitplan läuft. Nutze dies wenn der User einen wiederkehrenden Task einrichten will.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name des Jobs, z.B. "Git Status Check", "Build Monitor"' },
          schedule: { type: 'string', description: 'Cron-Expression: "*/30 * * * *" (alle 30 Min), "0 */2 * * *" (alle 2h), "0 0 * * *" (täglich), "0 0 * * 1" (wöchentlich Mo)' },
          type: { type: 'string', description: '"simple" für Shell-Befehle, "claude" für komplexe Aufgaben die Claude brauchen' },
          command: { type: 'string', description: 'Bei simple: Shell-Befehl. Bei claude: Detaillierter Plan/Auftrag für Claude.' },
          target_dir: { type: 'string', description: 'Arbeitsverzeichnis, z.B. "~/Desktop/TMS Terminal". Standard: Home-Verzeichnis.' },
        },
        required: ['name', 'schedule', 'type', 'command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_cron_jobs',
      description: 'Zeigt alle eingerichteten Cron Jobs mit Status, letzter Ausführung und Zeitplan.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'toggle_cron_job',
      description: 'Aktiviert oder deaktiviert einen Cron Job.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Die ID des Jobs' },
          enabled: { type: 'string', description: '"true" oder "false"' },
        },
        required: ['job_id', 'enabled'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_cron_job',
      description: 'Löscht einen Cron Job permanent.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Die ID des Jobs' },
        },
        required: ['job_id'],
      },
    },
  },
```

- [ ] **Step 2: Add cron types to ManagerAction union**

In `server/src/manager/manager.service.ts`, change line 173 from:
```typescript
  type: 'write_to_terminal' | 'send_enter' | 'send_keys' | 'create_terminal' | 'close_terminal' | 'list_terminals' | 'generate_image' | 'self_education' | 'update_task';
```
to:
```typescript
  type: 'write_to_terminal' | 'send_enter' | 'send_keys' | 'create_terminal' | 'close_terminal' | 'list_terminals' | 'generate_image' | 'self_education' | 'update_task' | 'create_cron_job' | 'list_cron_jobs' | 'toggle_cron_job' | 'delete_cron_job';
```

- [ ] **Step 3: Verify it compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/server" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add server/src/manager/manager.service.ts
git commit -m "feat(manager): add cron job tool definitions"
```

---

### Task 4: Add cron tool execution handlers in ManagerService

**Files:**
- Modify: `server/src/manager/manager.service.ts` (executeAction method + new CronManager integration)

- [ ] **Step 1: Import CronManager and add as property**

At the top of `server/src/manager/manager.service.ts`, add import:
```typescript
import { CronManager, CronJob, cronToLabel } from './cron.manager';
```

Add property to `ManagerService` class (after `private isDistilling` around line 532):
```typescript
  private cronManager = new CronManager();
```

- [ ] **Step 2: Initialize CronManager in constructor**

At the end of the constructor (after the logger.info line around 558), add:
```typescript
    this.cronManager.load();
    this.cronManager.setExecuteCallback((job) => this.executeCronJob(job));
```

- [ ] **Step 3: Stop CronManager in stop()**

In the `stop()` method, before `logger.info('Manager: stopped')`, add:
```typescript
    this.cronManager.stopAll();
```

- [ ] **Step 4: Add executeCronJob method**

Add this method to the ManagerService class (after the `stop()` method):

```typescript
  /** Execute a cron job — called by CronManager on schedule */
  private async executeCronJob(job: CronJob): Promise<void> {
    if (job.type === 'simple') {
      // Simple: send command to a terminal, then let the agent review output
      const prompt = `[CRON-ERGEBNIS] Der Cron Job "${job.name}" (${cronToLabel(job.schedule)}) wurde ausgeführt. Befehl: \`${job.command}\`. Prüfe den Terminal-Output und berichte das Ergebnis knapp im Chat. Bei Problemen: detaillierter berichten und Push-Notification auslösen.`;
      // Create a temporary terminal for the command
      const dir = job.targetDir ? job.targetDir.replace('~', os.homedir()) : os.homedir();
      const sessionId = this.onCreateTerminal?.(`Cron: ${job.name}`);
      if (sessionId) {
        // Write command after shell is ready
        setTimeout(() => {
          const globalManager = (global as any).__terminalManager;
          if (globalManager) {
            globalManager.write(sessionId, `cd ${dir} && ${job.command}\r`);
          }
        }, 800);
        // Wait for output, then let agent review
        setTimeout(() => {
          this.handleChat(prompt).catch(err =>
            logger.warn(`CronManager: review failed for "${job.name}" — ${err}`)
          );
        }, 8000);
      }
    } else {
      // Claude: create terminal with Claude and send plan
      const dir = job.targetDir ? job.targetDir.replace('~', os.homedir()) : `${os.homedir()}/Desktop/TMS Terminal`;
      const sessionId = this.onCreateTerminal?.(`Cron: ${job.name}`);
      if (sessionId) {
        const globalManager = (global as any).__terminalManager;
        if (globalManager) {
          setTimeout(() => {
            globalManager.write(sessionId, `cd ${dir} && claude\r`);
          }, 800);
        }
        // Add as delegated task with the plan as pending prompt
        this.addDelegatedTask(job.command, sessionId, `Cron: ${job.name}`);
      }
    }
  }
```

- [ ] **Step 5: Add cron tool handlers in toolCallsToActions()**

Find the `toolCallsToActions()` method (around line 872). In the switch/if block that maps tool call names to actions, add cases for the cron tools. The pattern follows existing tools — find where `generate_image`, `self_education`, etc. are handled and add after them:

```typescript
      case 'create_cron_job': {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const newJob: CronJob = {
          id,
          name: tc.arguments.name ?? 'Unnamed Job',
          schedule: tc.arguments.schedule ?? '0 */1 * * *',
          type: (tc.arguments.type as 'simple' | 'claude') ?? 'simple',
          command: tc.arguments.command ?? '',
          targetDir: tc.arguments.target_dir,
          enabled: true,
          createdAt: Date.now(),
        };
        this.cronManager.addJob(newJob);
        const label = cronToLabel(newJob.schedule);
        toolResults.push({ id: tc.id, result: `Cron Job "${newJob.name}" erstellt (${label}, type=${newJob.type}). ID: ${newJob.id}` });
        break;
      }
      case 'list_cron_jobs': {
        const jobs = this.cronManager.listJobs();
        if (jobs.length === 0) {
          toolResults.push({ id: tc.id, result: 'Keine Cron Jobs eingerichtet.' });
        } else {
          const list = jobs.map(j => {
            const status = j.enabled ? '✅' : '⏸️';
            const last = j.lastRunAt ? new Date(j.lastRunAt).toLocaleString('de-DE') : 'nie';
            return `${status} "${j.name}" — ${cronToLabel(j.schedule)} (${j.type}) | Letzter Lauf: ${last} | ID: ${j.id}`;
          }).join('\n');
          toolResults.push({ id: tc.id, result: `Cron Jobs (${jobs.length}):\n${list}` });
        }
        break;
      }
      case 'toggle_cron_job': {
        const enabled = tc.arguments.enabled === 'true';
        const ok = this.cronManager.toggleJob(tc.arguments.job_id, enabled);
        toolResults.push({ id: tc.id, result: ok ? `Job ${enabled ? 'aktiviert' : 'deaktiviert'}.` : 'Job nicht gefunden.' });
        break;
      }
      case 'delete_cron_job': {
        const ok = this.cronManager.removeJob(tc.arguments.job_id);
        toolResults.push({ id: tc.id, result: ok ? 'Job gelöscht.' : 'Job nicht gefunden.' });
        break;
      }
```

- [ ] **Step 6: Add os import if not present**

Check if `os` is already imported at the top of the file. If not, add:
```typescript
import * as os from 'os';
```

- [ ] **Step 7: Verify it compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/server" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add server/src/manager/manager.service.ts
git commit -m "feat(manager): add cron job execution handlers"
```

---

### Task 5: Add /cron slash command and CRON_SETUP_PROMPT

**Files:**
- Modify: `mobile/src/screens/ManagerChatScreen.tsx:82-89,426-448`

- [ ] **Step 1: Add /cron to SLASH_COMMANDS array**

In `mobile/src/screens/ManagerChatScreen.tsx`, add to the SLASH_COMMANDS array (line 82-89):

```typescript
  { cmd: '/cron', label: 'Scheduler', desc: 'Cron Jobs einrichten' },
```

- [ ] **Step 2: Add /cron handler in handleSend()**

In `handleSend()`, after the `/askill` handler block (around line 447), add:

```typescript
      if (cmd === '/cron') {
        const cronPrompt = `[CRON-SETUP] Der User möchte Cron Jobs einrichten. Analysiere den aktuellen Terminal-Kontext und die Memory, dann:

1. Schlage 3 sinnvolle Cron Jobs vor die zum aktuellen Workflow passen. Für jeden Vorschlag:
   - Name und was er tut
   - Vorgeschlagener Zeitplan
   - Ob simple (Shell-Befehl) oder claude (komplexer Task)
2. Biete als Option 4 an: "Eigenen Cron Job definieren"

Formatiere als nummerierte Liste. Warte auf die Auswahl des Users.

Wenn der User Option 4 wählt, stelle genau 3 Fragen nacheinander:
- Frage 1: Was soll der Job machen?
- Frage 2: Wie oft soll er laufen? (mit konkreten Vorschlägen)
- Frage 3: Reicht ein einfacher Shell-Befehl oder braucht es Claude?

Nach den 3 Antworten: Erstelle den Job mit create_cron_job.`;

        addMessage({ role: 'user', text: '/cron', targetSessionId: activeChat !== 'alle' ? activeChat : undefined }, activeChat);
        setLoading(true);
        wsService.send({
          type: 'manager:chat',
          payload: { text: cronPrompt, targetSessionId: activeChat !== 'alle' ? activeChat : undefined, onboarding: false },
        });
        setInput('');
        Keyboard.dismiss();
        return;
      }
```

- [ ] **Step 3: Add /cron to the slash picker handler**

In the slash command picker rendering (around line 1069-1107), find the `onPress` handler. Add a case for `/cron` in the direct-execute block, before the `Keyboard.dismiss()`:

```typescript
                  } else if (c.cmd === '/cron') {
                    setInput('/cron');
                    setTimeout(() => handleSend(), 0);
                    return;
```

- [ ] **Step 4: Verify mobile compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/mobile" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add mobile/src/screens/ManagerChatScreen.tsx
git commit -m "feat(manager): add /cron slash command with interactive setup prompt"
```

---

### Task 6: Add cron instructions to system prompt

**Files:**
- Modify: `server/src/manager/manager.service.ts` (buildSystemPrompt function, around line 299)

- [ ] **Step 1: Add cron section to system prompt**

In `buildSystemPrompt()`, find the capabilities section (around line 380). After the existing capabilities, add:

```typescript
## Cron Jobs

Du kannst wiederkehrende Aufgaben mit Cron Jobs automatisieren:
- create_cron_job: Neuen Job erstellen mit Name, Zeitplan, Typ und Befehl
- list_cron_jobs: Alle Jobs auflisten
- toggle_cron_job: Job aktivieren/deaktivieren
- delete_cron_job: Job löschen

### Cron-Expressions
- \`*/30 * * * *\` → alle 30 Minuten
- \`0 */2 * * *\` → alle 2 Stunden
- \`0 0 * * *\` → täglich um Mitternacht
- \`0 0 * * 1\` → wöchentlich Montag

### Typen
- simple: Shell-Befehl der direkt ausgeführt wird (z.B. "git status", "npm test")
- claude: Komplexer Task der Claude braucht — ein Terminal wird erstellt und Claude bekommt den Auftrag

### /cron Setup-Flow
Wenn der User /cron nutzt, analysiere seinen Workflow und schlage 3 passende Jobs vor + Option für eigenen Job. Beim eigenen Job: stelle genau 3 Fragen, dann erstelle den Job.
```

- [ ] **Step 2: Verify it compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/server" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/src/manager/manager.service.ts
git commit -m "feat(manager): add cron job instructions to system prompt"
```
