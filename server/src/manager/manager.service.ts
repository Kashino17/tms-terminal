import { AiProviderRegistry, ChatMessage, ProviderConfig, ToolDefinition, StreamResult, RawToolCall, ToolCallingProvider } from './ai-provider';
import { globalManager } from '../terminal/terminal.manager';
import { logger } from '../utils/logger';
import type { PhaseInfo } from '../../../shared/protocol';
import {
  loadMemory, saveMemory, ManagerMemory,
  parseMemoryUpdate, applyMemoryUpdate, stripMemoryTags,
  buildMemoryContext, MEMORY_UPDATE_INSTRUCTION, MAX_RECENT_CHAT,
  buildDistillationPrompt, finalizeDistillation,
} from './manager.memory';
import { generateImage } from './image-generator';
import {
  SkillDefinition, TestResult,
  loadSkills, saveSkill, findSkillByName, getApprovedSkills, getAllSkills,
  createSkillId, writeSkillScript, updateSkillStatus, buildSkillsSummary,
} from './skills/skill-registry';
import { executeSkillScript, checkDependencies } from './skills/skill-executor';
import { CronManager, CronJob, cronToLabel } from './cron.manager';
import { buildPresentationHTML } from './presentation.template';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ANSI_STRIP = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b\]8;[^\x07]*\x07[^\x1b]*\x1b\]8;;\x07|\x1b[>=<#]/g;
const OUTPUT_BUFFER_MAX = 50_000; // 50 KB per session
const MAX_CONTEXT_PER_SESSION = 8_000; // chars sent to AI per session per summary

// ── Native Tool Definitions (for GLM) ──────────────────────────────────────

const MANAGER_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'write_to_terminal',
      description: 'Schreibt einen Shell-Befehl in ein Terminal und führt ihn aus. NUR nutzen wenn der User EXPLIZIT einen konkreten Befehl ausführen will (z.B. "schreib git status in Shell 1"). NICHT nutzen bei normalen Gesprächen.',
      parameters: {
        type: 'object',
        properties: {
          session_label: { type: 'string', description: 'Terminal-Name oder Shell-Nummer, z.B. "Shell 1", "ayysir", "TMS Terminal"' },
          command: { type: 'string', description: 'Der auszuführende Befehl, z.B. "git status", "npm run build"' },
        },
        required: ['session_label', 'command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_enter',
      description: 'Drückt Enter in einem Terminal. Nutze dies um wartende Prompts zu bestätigen.',
      parameters: {
        type: 'object',
        properties: {
          session_label: { type: 'string', description: 'Das Terminal-Label, z.B. "Shell 1"' },
        },
        required: ['session_label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_keys',
      description: 'Sendet Tastenanschläge an ein Terminal. Nutze dies für interaktive CLI-Menüs (z.B. Pfeiltasten zum Navigieren, Enter zum Bestätigen, Tab für Autovervollständigung). Mehrere Tasten werden der Reihe nach gesendet mit kurzer Pause dazwischen.',
      parameters: {
        type: 'object',
        properties: {
          session_label: { type: 'string', description: 'Terminal-Name oder Shell-Nummer, z.B. "Shell 1"' },
          keys: {
            type: 'string',
            description: 'Komma-getrennte Liste der Tasten: arrow_up, arrow_down, arrow_left, arrow_right, enter, tab, escape, space, backspace, ctrl_c, ctrl_d, ctrl_z. Beispiel: "arrow_down,arrow_down,enter" um zwei Einträge nach unten zu navigieren und zu bestätigen.',
          },
        },
        required: ['session_label', 'keys'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_terminal',
      description: 'Erstellt ein neues Shell-Terminal und führt optional sofort einen Befehl darin aus. Nutze dies wenn der User ein neues Terminal braucht, z.B. "Öffne ein Terminal im Desktop Ordner" → create_terminal mit initial_command="cd ~/Desktop".',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Optionaler Name für das neue Terminal, z.B. "Build", "Desktop". Wenn leer, wird automatisch "Shell N" vergeben.' },
          initial_command: { type: 'string', description: 'Optionaler Befehl der sofort nach dem Erstellen ausgeführt wird, z.B. "cd ~/Desktop", "cd ~/Projects && git status". Mehrere Befehle mit && verketten.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_terminal',
      description: 'Schließt ein Terminal/Shell. Nutze dies wenn der User ein Terminal schließen will, z.B. "Schließe Shell 2" oder "Schließe alle Terminals außer Shell 1".',
      parameters: {
        type: 'object',
        properties: {
          session_label: { type: 'string', description: 'Terminal-Name oder Shell-Nummer, z.B. "Shell 1", "Shell 2", "TMS Banking"' },
        },
        required: ['session_label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_terminals',
      description: 'Zeigt alle aktuell offenen Terminals mit ihren Namen und Status. Nutze dies IMMER bevor du Befehle in Terminals schreibst oder Terminals schließt, um die aktuelle Übersicht zu bekommen.',
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
      name: 'generate_image',
      description: 'Generiert ein Bild mit OpenAI gpt-image-1 (DALL-E). Nutze dieses Tool wenn der User ein Bild erstellen, generieren, designen oder illustrieren will. Das Bild wird auf dem Desktop gespeichert.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detaillierte Bildbeschreibung auf Englisch, z.B. "A serene sunset over the ocean with golden light reflecting on calm waves"' },
          size: { type: 'string', description: 'Bildgröße: 1024x1024 (Quadrat), 1536x1024 (Landscape), 1024x1536 (Portrait). Standard: 1024x1024' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'self_education',
      description: 'Erstellt, testet oder listet Skills für den Agent. Nutze dieses Tool wenn du eine neue Fähigkeit brauchst die du noch nicht hast, oder wenn der User dich bittet einen Skill zu erstellen. Actions: check (prüfe ob Skill existiert), create (erstelle neuen Skill mit Script), test (teste existierenden Skill), list (alle Skills auflisten), execute (führe approved Skill aus).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'check, create, test, list oder execute' },
          skill_name: { type: 'string', description: 'Name des Skills, z.B. "video-editing", "png-to-webp"' },
          skill_description: { type: 'string', description: 'Was der Skill können soll' },
          category: { type: 'string', description: 'Kategorie: media, dev, data, system, utility' },
          script_code: { type: 'string', description: 'Der Script-Code (Bash/Python/Node) für den Skill' },
          script_type: { type: 'string', description: 'Script-Typ: sh, py, js. Standard: sh' },
          dependencies: { type: 'string', description: 'Komma-getrennte System-Dependencies, z.B. "ffmpeg,imagemagick"' },
          execute_args: { type: 'string', description: 'Argumente für execute, komma-getrennt' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Erstellt und aktualisiert Aufgaben-Listen im Chat. PFLICHT bei jeder mehrstufigen Anfrage! Mehrere Tasks können parallel laufen — jeder braucht einen eigenen task_name. Actions: set_steps (neuen Task erstellen oder Schritte setzen), complete_step (Schritt abhaken), fail_step (Schritt als fehlgeschlagen markieren).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'set_steps, complete_step, oder fail_step' },
          task_name: { type: 'string', description: 'Eindeutiger Name der Aufgabe, z.B. "TMS Shops Brainstorming", "Logo Design", "Bug Fix". PFLICHT — jede Aufgabe braucht ihren eigenen Namen damit mehrere Tasks parallel laufen können.' },
          steps: { type: 'string', description: 'Komma-getrennte Liste der Aufgaben-Schritte für set_steps, z.B. "Terminal erstellen,Claude starten,Frage 1 stellen,Antwort notieren,Frage 2 stellen,Antwort notieren,Fazit erstellen"' },
          step_index: { type: 'string', description: 'Index des Schritts (0-basiert) für complete_step/fail_step' },
        },
        required: ['action', 'task_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_cron_job',
      description: 'Erstellt einen wiederkehrenden Cron Job. Typ "simple" führt einen Shell-Befehl aus, Typ "claude" startet Claude Code mit einem Auftrag.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name des Cron Jobs, z.B. "Git Status Check"' },
          schedule: { type: 'string', description: 'Cron-Ausdruck, z.B. "*/30 * * * *" (alle 30 Min), "0 */2 * * *" (alle 2h), "0 0 * * *" (täglich)' },
          type: { type: 'string', description: '"simple" (Shell-Befehl) oder "claude" (Claude Code Auftrag)' },
          command: { type: 'string', description: 'Der Befehl oder Claude-Auftrag' },
          target_dir: { type: 'string', description: 'Arbeitsverzeichnis, z.B. "~/Desktop/TMS Terminal"' },
        },
        required: ['name', 'schedule', 'type', 'command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_cron_jobs',
      description: 'Listet alle konfigurierten Cron Jobs mit Status, Zeitplan und letzter Ausführung.',
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
          job_id: { type: 'string', description: 'Die ID des Cron Jobs' },
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
      description: 'Löscht einen Cron Job dauerhaft.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Die ID des Cron Jobs' },
        },
        required: ['job_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_presentation',
      description: 'Erstellt eine Präsentation mit bis zu 8 Slides. Jede Slide ist HTML mit CSS-Klassen (card, grid-2, gradient-blue, stat, badge, fade-in etc.). Chart.js und Mermaid sind verfügbar. JEDEN Slide als separaten Parameter (slide_1, slide_2, ...) übergeben — KEIN JSON-Array!',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Titel der Präsentation' },
          slide_1: { type: 'string', description: 'HTML der ersten Slide (Titel-Slide)' },
          slide_2: { type: 'string', description: 'HTML der zweiten Slide' },
          slide_3: { type: 'string', description: 'HTML der dritten Slide' },
          slide_4: { type: 'string', description: 'HTML der vierten Slide' },
          slide_5: { type: 'string', description: 'HTML der fünften Slide' },
          slide_6: { type: 'string', description: 'HTML der sechsten Slide' },
          slide_7: { type: 'string', description: 'HTML der siebten Slide' },
          slide_8: { type: 'string', description: 'HTML der achten Slide' },
        },
        required: ['title', 'slide_1'],
      },
    },
  },
];

// ── Types ───────────────────────────────────────────────────────────────────

export interface ManagerAction {
  type: 'write_to_terminal' | 'send_enter' | 'send_keys' | 'create_terminal' | 'close_terminal' | 'list_terminals' | 'generate_image' | 'self_education' | 'update_task' | 'create_cron_job' | 'list_cron_jobs' | 'toggle_cron_job' | 'delete_cron_job' | 'create_presentation';
  sessionId: string;
  detail: string;
}

export interface ManagerSummary {
  text: string;
  sessions: Array<{ sessionId: string; label: string; hasActivity: boolean }>;
  timestamp: number;
}

export interface ManagerResponse {
  text: string;
  actions: ManagerAction[];
}

// ── Delegated Task Tracking ─────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed';

export interface TaskStep {
  label: string;
  status: TaskStatus;
}

export interface DelegatedTask {
  id: string;
  description: string;
  sessionId: string;
  sessionLabel: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  lastCheckedOutput?: string;
  pendingPrompt?: string;
  /** Human-readable steps for this task workflow */
  steps: TaskStep[];
}

const HEARTBEAT_INTERVAL_MS = 15_000; // 15 seconds — check delegated tasks

type SummaryCallback = (summary: ManagerSummary) => void;
type ResponseCallback = (response: ManagerResponse) => void;
type ErrorCallback = (error: string) => void;
type ThinkingCallback = (phase: string, detail?: string, elapsed?: number) => void;
type StreamChunkCallback = (token: string, tokenStats?: { completionTokens: number; tps: number }) => void;
type StreamEndCallback = (text: string, actions: ManagerAction[], phases: PhaseInfo[], images?: string[], presentations?: string[]) => void;

// ── Personality Types ────────────────────────────────────────────────────────

interface PersonalityConfig {
  agentName: string;
  tone: string;
  detail: string;
  emojis: boolean;
  proactive: boolean;
  customInstruction: string;
}

const DEFAULT_PERSONALITY: PersonalityConfig = {
  agentName: 'Manager',
  tone: 'chill',
  detail: 'balanced',
  emojis: true,
  proactive: true,
  customInstruction: '',
};

// ── Terminal Context Analysis ────────────────────────────────────────────────

interface TerminalContext {
  sessionId: string;
  label: string;
  cwd?: string;
  process?: string;
  project?: string;
  tool?: string;
  status: 'idle' | 'active' | 'ai_running' | 'building' | 'error';
  recentOutput: string;
}

function analyzeTerminalOutput(raw: string): Pick<TerminalContext, 'project' | 'tool' | 'status'> {
  const lower = raw.toLowerCase();
  const last2k = raw.slice(-2000);

  // Detect active tool
  let tool: string | undefined;
  if (/claude|anthropic/i.test(last2k)) tool = 'Claude';
  else if (/codex|openai/i.test(last2k)) tool = 'Codex';
  else if (/gemini|google/i.test(last2k)) tool = 'Gemini';
  else if (/cursor/i.test(last2k)) tool = 'Cursor';
  else if (/npm run|yarn |pnpm |bun run/i.test(last2k)) tool = 'npm/build';
  else if (/docker|compose/i.test(last2k)) tool = 'Docker';
  else if (/git (push|pull|commit|merge|rebase)/i.test(last2k)) tool = 'Git';
  else if (/pytest|jest|vitest|mocha/i.test(last2k)) tool = 'Tests';
  else if (/python |pip /i.test(last2k)) tool = 'Python';

  // Detect project type from output
  let project: string | undefined;
  const packageMatch = last2k.match(/(?:name|project)["']?\s*[:=]\s*["']([^"']+)/);
  if (packageMatch) project = packageMatch[1];
  else if (/next\.js|nextjs|next dev/i.test(last2k)) project = 'Next.js App';
  else if (/react-native|expo/i.test(last2k)) project = 'React Native';
  else if (/flask|django|fastapi/i.test(last2k)) project = 'Python Backend';
  else if (/vite|webpack/i.test(last2k)) project = 'Frontend Build';

  // Detect status
  let status: TerminalContext['status'] = 'idle';
  if (/error|Error|ERR!|FAIL|failed|exception/i.test(last2k.slice(-500))) status = 'error';
  else if (tool === 'Claude' || tool === 'Codex' || tool === 'Gemini' || tool === 'Cursor') status = 'ai_running';
  else if (/compiling|building|bundling|downloading/i.test(last2k.slice(-300))) status = 'building';
  else if (raw.length > 100) status = 'active';

  return { project, tool, status };
}

const STATUS_EMOJI: Record<TerminalContext['status'], string> = {
  idle: '💤', active: '🟢', ai_running: '🤖', building: '🔨', error: '🔴',
};

const STATUS_LABEL: Record<TerminalContext['status'], string> = {
  idle: 'Idle', active: 'Aktiv', ai_running: 'AI läuft', building: 'Baut', error: 'Fehler',
};

// ── Dynamic System Prompt ───────────────────────────────────────────────────

function buildSystemPrompt(p: PersonalityConfig): string {
  const toneMap: Record<string, string> = {
    chill: 'Du redest wie ein guter Kumpel — locker, natürlich, mit Umgangssprache. Nicht gestellt, nicht förmlich.',
    professional: 'Du bist sachlich und klar. Kein Gelaber, aber auch nicht kalt.',
    technical: 'Du bist präzise und direkt. Fachbegriffe ja, Floskeln nein.',
    friendly: 'Du bist warm und ermutigend. Du feierst Fortschritte und hilfst geduldig.',
    minimal: 'So wenig Worte wie möglich. Nur das Nötigste.',
  };

  const detailMap: Record<string, string> = {
    brief: 'Max 2-3 Sätze pro Antwort.',
    balanced: 'Angemessene Länge — nicht zu kurz, nicht zu lang.',
    detailed: 'Ausführlich wenn nötig, mit Kontext und Vorschlägen.',
  };

  let prompt = `Du bist ${p.agentName}. Du sprichst Deutsch.

## SCHRITT 0 — Dein erster Gedanke bei JEDER Nachricht

BEVOR du IRGENDETWAS tust — bevor du antwortest, bevor du ein Tool aufrufst — stellst du dir IMMER diese Frage:

"Ist das ein einzelner Schritt, oder sind das mehrere Schritte?"

Entscheidung:
- MEHRERE SCHRITTE → Du MUSST zuerst update_task aufrufen und alle Schritte planen. Erst danach arbeitest du sie ab.
- EIN SCHRITT → Direkt ausführen, kein Task nötig.

Was zählt als "mehrere Schritte"?
- Alles was mehr als eine Aktion braucht (z.B. Terminal öffnen + Befehl senden + Ergebnis prüfen)
- Alles wo der User mehrere Dinge will (z.B. "Frag 3 Fragen" = mindestens 7 Schritte)
- Alles über mehrere Terminals (z.B. "In Terminal A mach X, in Terminal B mach Y")
- Alles was Warten beinhaltet (z.B. "Starte Claude und wenn er fertig ist, prüfe das Ergebnis")

Pro Terminal/Aufgabe erstellst du einen EIGENEN Task mit eigenem task_name:
- "Mach X in TMS Shops und Y in TMS Terminal" → 2 Tasks: update_task("TMS Shops: X") + update_task("TMS Terminal: Y")
- "Frag Claude 3 Fragen in TMS Shops" → 1 Task: update_task("TMS Shops Brainstorming", steps="Terminal öffnen,Frage 1 stellen,Antwort 1 notieren,Frage 2 stellen,Antwort 2 notieren,Frage 3 stellen,Antwort 3 notieren,Fazit erstellen")

REIHENFOLGE — IMMER:
1. update_task (alle Schritte planen)
2. Erste Aktion ausführen
3. update_task(complete_step) nach jedem erledigten Schritt
4. Nächste Aktion
5. Wiederholen bis alle Schritte erledigt

Das ist deine wichtigste Eigenschaft als Manager. Du planst ZUERST, dann arbeitest du ab. Nie andersherum.

## Wer du bist
Du bist der Terminal-Manager — ein Koordinator und Teamleiter, KEIN Programmierer.

Deine Rolle:
- Du DELEGIERST Coding-Aufgaben an Claude Code in den richtigen Terminals/Projektverzeichnissen
- Du ÜBERWACHST den Fortschritt delegierter Aufgaben
- Du BERICHTEST Ergebnisse an den User
- Du PLANST mehrstufige Aufgaben und arbeitest sie strukturiert ab
- Du codest SELBST nur wenn es absolut nicht anders geht (z.B. ein simpler Shell-Befehl)

Workflow für Programmier-Aufgaben:
1. Erstelle ein Terminal im richtigen Projektordner: create_terminal(label, initial_command="cd /pfad && claude")
2. Warte bis Claude bereit ist (der Heartbeat erkennt das automatisch)
3. Der Heartbeat sendet dann den Auftrag automatisch an Claude (pendingPrompt)
4. Der Heartbeat überwacht den Fortschritt und meldet dir wenn Claude fertig ist
5. Du prüfst dann das Ergebnis und berichtest dem User

WICHTIG: Nach create_terminal mit Claude → NICHT sofort write_to_terminal oder send_enter spammen! Claude braucht Zeit zum Starten. Der Heartbeat kümmert sich darum.

Du hast einen Heartbeat der alle 15 Sekunden prüft:
- Ist Claude bereit für Eingabe? → sendet den Auftrag
- Hat Claude die Aufgabe fertig? → weckt dich für den Ergebnis-Bericht

## Wie du redest
${toneMap[p.tone] ?? toneMap.chill}
${detailMap[p.detail] ?? detailMap.balanced}
${p.emojis ? 'Emojis sind OK — aber dezent, nicht in jedem Satz.' : 'Keine Emojis.'}

WICHTIG: Du redest wie ein Mensch, nicht wie eine AI. Stell dir vor du bist ein Kollege der nebenbei auf die Terminals schaut — nicht ein Roboter der bei jeder Nachricht alles auflistet.
- Keine Aufzählungen oder Bullet-Points wenn es auch ein normaler Satz tut
- Keine Markdown-Überschriften in normalen Antworten
- Keine Code-Blöcke außer wenn der User explizit nach Code fragt
- Kein "Hier ist eine Zusammenfassung:" — einfach zusammenfassen
- Reagiere natürlich auf das was der User sagt — wie in einem echten Gespräch
- Sei witzig wenn es passt. Mach Scherze, Wortspiele, Anspielungen. Sei kein langweiliger Bot.
- ANTWORTE AUF DIE FRAGE, nicht auf den Terminal-Kontext! Der Terminal-Output wird dir automatisch mitgeliefert als Hintergrundinformation. Das heißt NICHT dass du immer darüber reden musst. Wenn der User "Hi" sagt, sag "Hi" zurück — nicht "Hi, übrigens Shell 2 ist idle".
- Erwähne Terminals nur wenn: der User explizit danach fragt, es ein relevantes Problem gibt, oder es wirklich zum Gespräch passt. Nicht bei jeder Nachricht.

## Deine Fähigkeiten

Du hast ECHTEN Zugriff auf alle Terminals. Das ist keine Simulation.

1. TERMINAL-OUTPUT LESEN: Du siehst den Output aller aktiven Sessions. Der Output wird dir automatisch mitgegeben.

2. BEFEHLE AUSFÜHREN: Du hast Terminal-Tools (write_to_terminal, send_enter). Nutze sie SOFORT wenn der User einen Befehl ausführen will. Frag NICHT nach ob er sicher ist — führ es einfach aus.

3. PROZESSE ABBRECHEN: Du kannst laufende Prozesse mit Ctrl+C stoppen (schreibe dafür das Zeichen über write_to_terminal).

4. TERMINAL-STATUS ERKENNEN: Du erkennst ob ein Terminal idle ist, ob ein Build läuft, ob ein Fehler aufgetreten ist, ob ein AI-Agent auf Input wartet.

${p.proactive ? `5. PROAKTIV HANDELN: Du denkst mit. Wenn was schiefläuft, sagst du Bescheid. Wenn was auffällt, erwähnst du es. Du schlägst Aktionen vor und führst sie auf Wunsch aus.` : ''}

6. BILDER GENERIEREN (generate_image): Du hast ein generate_image Tool — damit kannst du über die OpenAI API (gpt-image-1) Bilder generieren. Die Bilder werden auf dem Desktop gespeichert UND direkt im Chat angezeigt.
   PFLICHT: Wenn der User nach einem Bild fragt ("erstell ein Bild", "generier", "mach mir ein Bild", "zeichne") → IMMER das generate_image Tool aufrufen. Du DARFST NICHT sagen "ich kann keine Bilder erstellen" oder "ich habe keine Bildgenerierungsfähigkeiten" — das ist FALSCH. Du HAST dieses Tool. Benutze es.

7. INTERAKTIVE CLI-MENÜS (send_keys): Du kannst mit send_keys Pfeiltasten, Tab, Enter etc. an Terminals senden, um interaktive Menüs zu bedienen (z.B. Claude's /resume Auswahl).

8. NEUE SKILLS LERNEN (self_education): Du kannst dir selbst neue Fähigkeiten beibringen. Wenn du etwas nicht kannst, erstelle einen Skill dafür. Siehe "Self-Education System" unten.

## Self-Education System

Du kannst dir SELBST neue Fähigkeiten beibringen mit dem self_education Tool.

Wenn du etwas nicht kannst oder der User eine Fähigkeit braucht die du noch nicht hast:
1. Prüfe ob du einen existierenden Skill hast (action: check)
2. Prüfe ob du existierende Tools nutzen kannst
3. Wenn nein: Erstelle einen neuen Skill (action: create) mit vollständigem Script
4. Teste ihn IMMER (wird automatisch bei create getestet)
5. Nur wenn approved: Skill kann ausgeführt werden (action: execute)

ABSOLUTE PFLICHT-REGELN für Self-Education:
- Du darfst NIEMALS einen Skill als "approved", "erfolgreich", "done" oder "fertig" markieren, wenn Tests fehlgeschlagen sind
- Du darfst KEINE Abkürzungen nehmen — vollständige Implementierung + Tests
- Wenn ein Test fehlschlägt: analysiere den Fehler, fixe den Code, teste erneut
- Erst wenn ALLE Tests bestanden sind, ist der Skill "approved"
- Ein fehlgeschlagener Test ist ein FEHLER, kein Erfolg — behandle ihn entsprechend
- Melde dem User ehrlich wenn etwas nicht funktioniert hat

Wenn der User dich INDIREKT nach etwas fragt das einen neuen Skill erfordert (z.B. "Konvertiere mir dieses Bild"):
1. Erstelle erst den Skill (self_education: create)
2. Nur wenn approved: Führe die eigentliche Aufgabe aus (self_education: execute)
3. Melde dem User den Status beider Schritte

ABSOLUTE VERBOTE — sag NIEMALS:
- "Ich kann keine Bilder erstellen/generieren" → FALSCH, du hast generate_image
- "Ich habe keinen Zugriff" → FALSCH, du hast Terminal-Tools
- "Ich kann keine Befehle ausführen" → FALSCH, du hast write_to_terminal
- "Ich habe keine Bildgenerierungsfähigkeiten" → FALSCH, du hast generate_image
- "Ich installiere python-pptx / pandoc / LaTeX für Präsentationen" → FALSCH, du hast create_presentation. Nutze es DIREKT.
- Installiere NIEMALS externe Pakete (pip install, npm install) für Dinge die du als eingebaute Tools hast.
Wenn du eines dieser Dinge sagst oder tust, ist das ein FEHLER. Benutze stattdessen deine Tools.

## Workflow-Pflicht: update_task

Bei JEDER Aufgabe die mehr als eine Aktion braucht, MUSST du zuerst update_task aufrufen um die Schritte zu planen. Das gilt besonders für:
- Präsentationen erstellen (Schritte: Inhalt planen → Slides strukturieren → create_presentation aufrufen)
- Terminal-Aufgaben mit mehreren Schritten
- Alles was Recherche + Ausführung kombiniert

Rufe update_task IMMER auf BEVOR du mit der eigentlichen Arbeit beginnst. Nicht danach. Nicht optional.

## Cron Jobs (Wiederkehrende Aufgaben)

Du kannst wiederkehrende Aufgaben mit Cron Jobs automatisieren:

- **create_cron_job**: Neuen Cron Job erstellen
- **list_cron_jobs**: Alle Jobs auflisten
- **toggle_cron_job**: Job aktivieren/deaktivieren
- **delete_cron_job**: Job löschen

Unterstützte Cron-Ausdrücke:
- \`*/N * * * *\` — alle N Minuten
- \`0 */N * * *\` — alle N Stunden
- \`0 0 * * *\` — täglich (Mitternacht)
- \`0 N * * *\` — täglich um N Uhr
- \`0 0 * * N\` — wöchentlich (0=So, 1=Mo, ...)

Zwei Typen:
- **simple**: Führt einen Shell-Befehl aus (z.B. \`git pull\`, \`npm run build\`)
- **claude**: Startet Claude Code mit einem Auftrag (für komplexere Aufgaben)

Wenn der User /cron eingibt, frage interaktiv ab: Name, Zeitplan, Typ (simple/claude), Befehl, Arbeitsverzeichnis.

## Präsentationen (create_presentation) — PFLICHT-TOOL

WICHTIG: Du hast ein eingebautes create_presentation Tool. Wenn der User eine Präsentation will, rufst du SOFORT dieses Tool auf. NIEMALS python-pptx, PowerPoint, Scripts oder Terminals dafür nutzen!

So funktioniert es:
1. Du rufst create_presentation auf mit title + einzelnen slide_1, slide_2, slide_3... Parametern
2. JEDE Slide ist ein SEPARATER Parameter (slide_1, slide_2, ..., slide_8) — KEIN JSON-Array!
3. Die Präsentation erscheint direkt im Chat als klickbare Karte

Parameter:
- title: Titel der Präsentation (String)
- slide_1: HTML der ersten Slide (PFLICHT)
- slide_2: HTML der zweiten Slide (optional)
- slide_3 bis slide_8: weitere Slides (optional)

BEISPIEL-AUFRUF:
create_presentation(
  title: "Projekt-Status",
  slide_1: "<h1>Projekt-Status</h1><p>Stand: April 2026</p>",
  slide_2: "<h2>Tests</h2><div class='card gradient-blue'><div class='stat'><div class='stat-value accent-green'>42</div><div class='stat-label'>Passed</div></div></div>",
  slide_3: "<h2>Nächste Schritte</h2><ul><li>Feature X fertigstellen</li><li>Release vorbereiten</li></ul>"
)

CSS-Klassen: grid-2, grid-3, card, card-sm, gradient-blue/purple/green/orange/red/cyan, accent/accent-green/accent-red/accent-amber, badge badge-blue/green/red, stat > stat-value + stat-label, fade-in, slide-up, text-center, text-dim, mt-1/mt-2, divider

Charts: <canvas data-chart='pie' data-values='[30,70]' data-labels='["A","B"]'></canvas>
Mermaid: <div class='mermaid'>graph LR; A-->B</div>

MOBILE-DESIGN-REGELN (SEHR WICHTIG):
- Die Präsentation wird auf einem Smartphone angezeigt (ca. 380px breit)
- Verwende grid-2 nur für KURZE Inhalte (Stats, Badges). NICHT für lange Texte oder Listen
- Lange Texte, Listen, Details → IMMER volle Breite (kein Grid), einfach untereinander
- Charts maximal 200px hoch — nicht zu groß
- Pro Slide maximal 3-4 Elemente — nicht überladen
- Titel-Slide: nur Titel + 1-2 Zeilen Subtitle
- Text KURZ halten: Stichpunkte statt ganze Sätze

## Antwort-Format
Antworte natürlich und menschlich. Wenn du einen Befehl ausführst, sag kurz was du tust.`;

  if (p.customInstruction) {
    prompt += `\n\n## Zusätzliche Anweisung vom Nutzer\n${p.customInstruction}`;
  }

  return prompt;
}

// ── Onboarding Prompt ───────────────────────────────────────────────────────

const ONBOARDING_PROMPT = `Du bist ein neuer Terminal-Manager. Ihr lernt euch gerade kennen. Sprich Deutsch.

## So klingst du
Wie ein echter Mensch. Kurze Sätze. Natürliche Sprache. Kein Bot-Gelaber, keine Aufzählungen, kein Markdown.
Stell dir vor du schreibst eine WhatsApp-Nachricht an einen neuen Kollegen — so soll es klingen.

## Was du NICHT tust
- "Hey! 👋" oder "Lass uns loslegen" oder "Wie kann ich helfen?"
- Interne Dinge erwähnen (Memory, Onboarding, Konfiguration, System)
- Aufzählungen oder Bullet-Points — schreib normale Sätze
- Markdown-Formatierung (keine **, keine ##, keine Codeblöcke)

## Das Gespräch — 4 Nachrichten

NACHRICHT 1 (deine erste):
Sag in 2 Sätzen was du bist — Terminal-Manager, überwachst alles, gibst alle 15 Min Updates. Dann frag: Wie heißt du, und wie soll ich heißen?

NACHRICHT 2 (nachdem der User sich vorgestellt hat):
Nimm die Namen an, reagiere kurz darauf. Dann frag wie du reden sollst — locker mit Emojis oder eher sachlich und direkt?

NACHRICHT 3 (nachdem der User seinen Stil gesagt hat):
Übernimm ab jetzt diesen Stil in deiner Sprache. Frag was er so macht — Projekte, Tools, worauf du achten sollst.

NACHRICHT 4 (nachdem der User seine Projekte erklärt hat):
Fasse kurz zusammen was du dir gemerkt hast, in deinem neuen Stil. Sag dass du ab jetzt im Hintergrund mitläufst.
Hänge am Ende den CONFIG-Block an (siehe unten).

## Interne Tags (User sieht sie NICHT)

Am Ende JEDER Nachricht — NACH deinem sichtbaren Text — schreibst du:

[MEMORY_UPDATE]
learned: was du gelernt hast
trait: was du über den Kommunikationsstil weißt
journal: kurze Zusammenfassung der Nachricht
[/MEMORY_UPDATE]

Bei Nachricht 4 zusätzlich:

[PERSONALITY_CONFIG]
agentName: dein Name
tone: chill|professional|technical|friendly|minimal
detail: brief|balanced|detailed
emojis: true|false
proactive: true|false
customInstruction: was du über den User weißt
[/PERSONALITY_CONFIG]

## Regeln
- IMMER zuerst normaler, sichtbarer Text — dann die Tags
- NIEMALS nur Tags ohne Text davor
- Max 3 Sätze sichtbarer Text pro Nachricht
- Eine Frage pro Nachricht
- Keine Erwähnung von internen Vorgängen`;

function parsePersonalityConfig(text: string): PersonalityConfig | null {
  const match = text.match(/\[PERSONALITY_CONFIG\]([\s\S]*?)\[\/PERSONALITY_CONFIG\]/);
  if (!match) return null;

  const block = match[1];
  const get = (key: string, fallback: string) => {
    const m = block.match(new RegExp(`${key}:\\s*(.+)`));
    return m ? m[1].trim() : fallback;
  };

  return {
    agentName: get('agentName', 'Manager'),
    tone: get('tone', 'chill') as PersonalityConfig['tone'],
    detail: get('detail', 'balanced') as PersonalityConfig['detail'],
    emojis: get('emojis', 'true') === 'true',
    proactive: get('proactive', 'true') === 'true',
    customInstruction: get('customInstruction', ''),
  };
}

// ── Manager Service ─────────────────────────────────────────────────────────

export class ManagerService {
  private registry: AiProviderRegistry;
  private outputBuffers = new Map<string, { data: string; lastUpdated: number }>();
  private lastSummaryAt = new Map<string, number>();
  private sessionLabels = new Map<string, string>();
  private chatHistory: ChatMessage[] = [];
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cronManager = new CronManager();
  private delegatedTasks: DelegatedTask[] = [];
  private enabled = false;
  private isProcessing = false; // prevent overlapping heartbeat + chat
  private isDistilling = false; // prevent concurrent memory distillation
  private personality: PersonalityConfig = { ...DEFAULT_PERSONALITY };
  private memory: ManagerMemory;

  private onSummary: SummaryCallback | null = null;
  private onResponse: ResponseCallback | null = null;
  private onError: ErrorCallback | null = null;
  private onPersonalityConfigured: ((config: PersonalityConfig) => void) | null = null;
  private onThinking: ThinkingCallback | null = null;
  private onStreamChunk: StreamChunkCallback | null = null;
  private onStreamEnd: StreamEndCallback | null = null;
  private onCreateTerminal: ((label?: string) => string | null) | null = null;
  private onCloseTerminal: ((sessionId: string) => boolean) | null = null;
  private onTaskUpdate: ((tasks: DelegatedTask[]) => void) | null = null;

  constructor(providerConfig: ProviderConfig) {
    this.registry = new AiProviderRegistry(providerConfig);
    this.memory = loadMemory();
    // Sync personality from memory (survives server restarts)
    if (this.memory.personality.agentName !== 'Manager') {
      this.personality.agentName = this.memory.personality.agentName;
      this.personality.tone = this.memory.personality.tone as any;
      this.personality.detail = this.memory.personality.detail as any;
      this.personality.emojis = this.memory.personality.emojis;
      this.personality.proactive = this.memory.personality.proactive;
    }
    logger.info(`Manager: memory loaded (${this.memory.stats.totalSessions} sessions, ${this.memory.insights.length} insights, agent="${this.memory.personality.agentName}")`);
    this.cronManager.load();
    this.cronManager.setExecuteCallback((job) => this.executeCronJob(job));
  }

  setPersonality(config: Partial<PersonalityConfig>): void {
    this.personality = { ...this.personality, ...config };
    logger.info(`Manager: personality updated — name="${this.personality.agentName}", tone=${this.personality.tone}`);
  }

  // ── Callbacks ─────────────────────────────────────────────────────────────

  setCallbacks(
    onSummary: SummaryCallback,
    onResponse: ResponseCallback,
    onError: ErrorCallback,
    onPersonalityConfigured?: (config: PersonalityConfig) => void,
    onThinking?: ThinkingCallback,
    onStreamChunk?: StreamChunkCallback,
    onStreamEnd?: StreamEndCallback,
    onCreateTerminal?: (label?: string) => string | null,
    onCloseTerminal?: (sessionId: string) => boolean,
    onTaskUpdate?: (tasks: DelegatedTask[]) => void,
  ): void {
    this.onSummary = onSummary;
    this.onResponse = onResponse;
    this.onError = onError;
    if (onPersonalityConfigured) this.onPersonalityConfigured = onPersonalityConfigured;
    if (onThinking) this.onThinking = onThinking;
    if (onStreamChunk) this.onStreamChunk = onStreamChunk;
    if (onStreamEnd) this.onStreamEnd = onStreamEnd;
    if (onCreateTerminal) this.onCreateTerminal = onCreateTerminal;
    if (onCloseTerminal) this.onCloseTerminal = onCloseTerminal;
    if (onTaskUpdate) this.onTaskUpdate = onTaskUpdate;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    // Heartbeat: check delegated tasks every 60s
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
    logger.info('Manager: started (heartbeat every 60s)');
  }

  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.cronManager.stopAll();
    logger.info('Manager: stopped');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ── Output Collection ─────────────────────────────────────────────────────

  /** Called from ws.handler on every terminal:output event. */
  feedOutput(sessionId: string, data: string): void {
    if (!this.enabled) return;

    const clean = data.replace(ANSI_STRIP, '');
    if (!clean.trim()) return;

    const existing = this.outputBuffers.get(sessionId);
    const existingData = existing?.data ?? '';
    const combined = existingData + clean;

    // Cap buffer size — keep tail
    let finalData: string;
    if (combined.length > OUTPUT_BUFFER_MAX) {
      const sliced = combined.slice(combined.length - OUTPUT_BUFFER_MAX);
      const firstNl = sliced.indexOf('\n');
      finalData = firstNl >= 0 ? sliced.slice(firstNl + 1) : sliced;
    } else {
      finalData = combined;
    }

    this.outputBuffers.set(sessionId, { data: finalData, lastUpdated: Date.now() });
  }

  /** Register a session label (e.g. "Shell 1") for human-readable summaries. */
  setSessionLabel(sessionId: string, label: string): void {
    this.sessionLabels.set(sessionId, label);
  }

  /** Remove buffers when a session is closed. */
  clearSession(sessionId: string): void {
    this.outputBuffers.delete(sessionId);
    this.lastSummaryAt.delete(sessionId);
    this.sessionLabels.delete(sessionId);
  }

  // ── Periodic Summarization ────────────────────────────────────────────────

  /** Build structured context for all active sessions. */
  private buildTerminalContexts(): TerminalContext[] {
    const contexts: TerminalContext[] = [];
    const now = Date.now();
    for (const [sessionId, buf] of this.outputBuffers) {
      const label = this.sessionLabels.get(sessionId) ?? sessionId.slice(0, 8);
      const isStale = (now - buf.lastUpdated) > 60_000;
      const analysis = analyzeTerminalOutput(buf.data);
      const session = globalManager.getSession?.(sessionId);

      // Override status to idle if buffer is stale
      const status = isStale ? 'idle' : analysis.status;

      contexts.push({
        sessionId,
        label,
        cwd: session?.cwd,
        process: session?.processName,
        project: analysis.project,
        tool: analysis.tool,
        status,
        recentOutput: buf.data.length > MAX_CONTEXT_PER_SESSION
          ? '...' + buf.data.slice(-MAX_CONTEXT_PER_SESSION)
          : buf.data,
      });
    }
    return contexts;
  }

  /** Format terminal contexts into a structured overview for the AI. */
  private formatContextBlock(contexts: TerminalContext[]): string {
    let block = '## Terminal-Übersicht\n\n';
    const now = Date.now();
    for (const ctx of contexts) {
      const emoji = STATUS_EMOJI[ctx.status];
      const statusLabel = STATUS_LABEL[ctx.status];
      const buf = this.outputBuffers.get(ctx.sessionId);
      const staleSecs = buf ? Math.round((now - buf.lastUpdated) / 1000) : 0;
      const staleNote = staleSecs > 60 ? ` ⏳ Letzter Output vor ${staleSecs}s — wahrscheinlich idle` : '';
      block += `### ${emoji} ${ctx.label} — ${statusLabel}${staleNote}\n`;
      if (ctx.cwd) block += `📁 ${ctx.cwd}\n`;
      if (ctx.process) block += `⚡ Prozess: ${ctx.process}\n`;
      if (ctx.tool) block += `🔧 Tool: ${ctx.tool}\n`;
      if (ctx.project) block += `📦 Projekt: ${ctx.project}\n`;
      block += `\n\`\`\`\n${ctx.recentOutput.slice(-3000)}\n\`\`\`\n\n`;
    }
    return block;
  }

  /** Trigger a summary now (also called by the 15-min timer).
   *  @param manual — true when triggered by user (/sm), false for auto-poll timer */
  async poll(targetSessionId?: string, manual = false): Promise<void> {
    if (!this.enabled) {
      if (manual) this.onError?.('Manager ist deaktiviert. Aktiviere ihn zuerst.');
      return;
    }

    const allContexts = this.buildTerminalContexts();
    const contexts = targetSessionId
      ? allContexts.filter(c => c.sessionId === targetSessionId)
      : allContexts;
    const activeContexts = contexts.filter(c => c.recentOutput.length > 0);

    if (activeContexts.length === 0) {
      logger.info('Manager: no activity since last poll — skipping');
      if (manual) {
        const label = targetSessionId
          ? contexts.find(c => c.sessionId === targetSessionId)?.label ?? 'Ausgewähltes Terminal'
          : 'Alle Terminals';
        this.onError?.(`${label}: Keine neue Aktivität seit der letzten Zusammenfassung.`);
      }
      return;
    }

    const contextBlock = this.formatContextBlock(activeContexts);

    const prompt = `${contextBlock}

Erstelle eine strukturierte Zusammenfassung der Terminal-Aktivität. Ziel: Ich will in 30 Sekunden verstehen was läuft, was klemmt und was als nächstes dran ist.

FORMAT — halte diese Reihenfolge ein:

**Pro Terminal** einen Block mit dem vollen Namen (z.B. "Shell 1 · TMS Terminal") als Bold-Überschrift. Darunter:
- **Status:** Aktiv / Idle / Blockiert / Fertig
- **Was passiert:** In einfachen Worten, woran gearbeitet wird oder was gerade läuft
- **Erledigt:** Was konkret umgesetzt oder abgeschlossen wurde (weglassen wenn nichts)
- **Problem:** Fehler, Blocker oder Wartendes — mit Schweregrad: 🔴 KRITISCH / 🟡 WICHTIG / 🔵 INFO. Wenn alles glatt läuft: 🟢 Keine

Zwischen jedem Terminal eine Leerzeile.

Am Ende IMMER ein **Nächste Schritte**-Block. Hier denkst du richtig mit:
- Analysiere was in den Terminals passiert ist und leite daraus die logisch sinnvollsten nächsten Aktionen ab
- Berücksichtige Abhängigkeiten zwischen Terminals (z.B. "erst Build abwarten, dann deployen")
- Wenn etwas blockiert ist: schlage eine konkrete Lösung vor, nicht nur "Problem klären"
- Wenn etwas gerade fertig geworden ist: was ist der nächste logische Schritt danach?
- Priorisiere: Blocker zuerst lösen, dann Weiterarbeit
- 3–5 Punkte, jeder mit kurzer Begründung warum

REGELN:
- Sag WAS gemacht wird, nicht WIE — keine Roh-Logs, keine langen Befehlsketten
- Konkret und priorisiert, kein Gelaber
- Dateinamen/Befehle nur wenn sie der Kern der Arbeit sind
- Keine vagen Aussagen wie "einige Dinge wurden verbessert"
- Idle-Terminals: eine Zeile reicht ("Keine Aktivität")
- WICHTIG: Nutze großzügig Leerzeilen — zwischen jedem Terminal-Block, zwischen jedem Schritt, zwischen jedem Abschnitt. Die Ausgabe soll in klar getrennten Chunks lesbar sein, nicht als Textwand.

BEISPIEL:

**Shell 1 · TMS Terminal**
- **Status:** Aktiv
- **Was passiert:** React Native Release-Build wird erstellt
- **Erledigt:** Dependencies neu installiert, Gradle-Cache bereinigt
- **Problem:** 🟢 Keine

**Shell 2 · TMS Banking**
- **Status:** Blockiert
- **Was passiert:** Git Push hängt, wartet auf Authentifizierung
- **Problem:** 🔴 KRITISCH — Push kann nicht abgeschlossen werden

**Nächste Schritte**

1. **Git-Auth in Shell 2 fixen** — GIT_TERMINAL_PROMPT=0 setzen oder SSH-Key prüfen, sonst bleibt der Push dauerhaft hängen

2. **Build in Shell 1 abwarten, dann APK auf dem Handy testen** — der Build sollte in ca. 2 Min fertig sein, danach direkt via ADB installieren

3. **Veraltete Packages updaten** — nicht dringend, aber die Warnings deuten auf deprecated Dependencies hin die mittelfristig Probleme machen`;


    try {
      this.memory = loadMemory();
      const provider = this.registry.getActive();
      const basePrompt = buildSystemPrompt(this.personality);
      const memoryContext = buildMemoryContext(this.memory);
      const systemPrompt = `${basePrompt}\n\n${memoryContext}\n\n${MEMORY_UPDATE_INSTRUCTION}`;
      logger.info(`Manager: summarizing ${activeContexts.length} sessions via ${provider.name}`);

      const reply = await provider.chat(
        [{ role: 'user', content: prompt }],
        systemPrompt,
      );

      // Parse memory updates from summary
      const memUpdate = parseMemoryUpdate(reply);
      if (memUpdate) {
        applyMemoryUpdate(this.memory, memUpdate);
        saveMemory(this.memory);
      }

      // Mark as summarized and clear buffers
      const now = Date.now();
      const sessionInfo = activeContexts.map(s => ({
        sessionId: s.sessionId,
        label: s.label,
        hasActivity: true,
      }));

      for (const s of activeContexts) {
        this.lastSummaryAt.set(s.sessionId, now);
        this.outputBuffers.set(s.sessionId, { data: '', lastUpdated: Date.now() });
      }

      // Add to chat history
      this.chatHistory.push({ role: 'assistant', content: stripMemoryTags(reply) });
      if (this.chatHistory.length > 50) {
        this.chatHistory = this.chatHistory.slice(-40);
      }

      const summary: ManagerSummary = {
        text: stripMemoryTags(reply),
        sessions: sessionInfo,
        timestamp: now,
      };

      this.onSummary?.(summary);
      logger.info(`Manager: summary sent (${reply.length} chars)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Manager: summary failed — ${msg}`);
      this.onError?.(`Zusammenfassung fehlgeschlagen: ${msg}`);
    }
  }

  // ── User Chat ─────────────────────────────────────────────────────────────

  /** Resolve a terminal label like "Shell 2", "ayysir", or "Shell 2 · ayysir" to a sessionId. */
  private resolveLabel(label: string): string | null {
    const lower = label.toLowerCase();
    // Exact match
    for (const [id, lbl] of this.sessionLabels) {
      if (lbl.toLowerCase() === lower) return id;
    }
    // Starts-with match (e.g. "Shell 1" matches "Shell 1 · ayysir")
    for (const [id, lbl] of this.sessionLabels) {
      if (lbl.toLowerCase().startsWith(lower)) return id;
    }
    // Contains match (e.g. "ayysir" matches "Shell 1 · ayysir")
    for (const [id, lbl] of this.sessionLabels) {
      if (lbl.toLowerCase().includes(lower)) return id;
    }
    // Normalized match (e.g. "Shell2" without space)
    const normalized = label.replace(/\s+/g, '').toLowerCase();
    for (const [id, lbl] of this.sessionLabels) {
      if (lbl.replace(/\s+/g, '').toLowerCase().includes(normalized)) return id;
    }
    logger.warn(`Manager: could not resolve label "${label}"`);
    return null;
  }

  /** Convert native tool calls to ManagerActions. */
  private toolCallsToActions(toolCalls: Array<{ id?: string; name: string; arguments: Record<string, string> }>): ManagerAction[] {
    logger.info(`Manager: processing ${toolCalls.length} tool calls, known labels: ${[...this.sessionLabels.entries()].map(([id, l]) => `${l}=${id.slice(0, 8)}`).join(', ') || 'none'}`);
    const actions: ManagerAction[] = [];
    for (const tc of toolCalls) {
      logger.info(`Manager: tool call: ${tc.name}(${JSON.stringify(tc.arguments)})`);

      // Handle tools that don't need a sessionId
      if (tc.name === 'list_terminals') {
        actions.push({ type: 'list_terminals', sessionId: '', detail: '' });
        continue;
      }
      if (tc.name === 'create_terminal') {
        // Pack label and initial_command into detail as JSON
        const createInfo = JSON.stringify({
          label: tc.arguments.label ?? '',
          initialCommand: tc.arguments.initial_command ?? '',
        });
        actions.push({ type: 'create_terminal', sessionId: '', detail: createInfo });
        continue;
      }
      if (tc.name === 'generate_image') {
        const imageInfo = JSON.stringify({
          prompt: tc.arguments.prompt ?? '',
          size: tc.arguments.size ?? '1024x1024',
        });
        actions.push({ type: 'generate_image', sessionId: '', detail: imageInfo });
        continue;
      }
      if (tc.name === 'self_education') {
        const skillInfo = JSON.stringify({
          action: tc.arguments.action ?? 'list',
          skillName: tc.arguments.skill_name ?? '',
          skillDescription: tc.arguments.skill_description ?? '',
          category: tc.arguments.category ?? 'utility',
          scriptCode: tc.arguments.script_code ?? '',
          scriptType: tc.arguments.script_type ?? 'sh',
          dependencies: tc.arguments.dependencies ?? '',
          executeArgs: tc.arguments.execute_args ?? '',
        });
        actions.push({ type: 'self_education', sessionId: '', detail: skillInfo });
        continue;
      }
      if (tc.name === 'update_task') {
        const taskInfo = JSON.stringify({
          action: tc.arguments.action ?? 'set_steps',
          taskName: tc.arguments.task_name ?? '',
          steps: tc.arguments.steps ?? '',
          stepIndex: tc.arguments.step_index ?? '0',
        });
        actions.push({ type: 'update_task', sessionId: '', detail: taskInfo });
        continue;
      }
      if (tc.name === 'create_cron_job') {
        const cronInfo = JSON.stringify({
          name: tc.arguments.name ?? '',
          schedule: tc.arguments.schedule ?? '',
          type: tc.arguments.type ?? 'simple',
          command: tc.arguments.command ?? '',
          targetDir: tc.arguments.target_dir ?? '',
        });
        actions.push({ type: 'create_cron_job', sessionId: '', detail: cronInfo });
        continue;
      }
      if (tc.name === 'list_cron_jobs') {
        actions.push({ type: 'list_cron_jobs', sessionId: '', detail: '' });
        continue;
      }
      if (tc.name === 'toggle_cron_job') {
        const toggleInfo = JSON.stringify({
          jobId: tc.arguments.job_id ?? '',
          enabled: tc.arguments.enabled ?? 'true',
        });
        actions.push({ type: 'toggle_cron_job', sessionId: '', detail: toggleInfo });
        continue;
      }
      if (tc.name === 'delete_cron_job') {
        const deleteInfo = JSON.stringify({ jobId: tc.arguments.job_id ?? '' });
        actions.push({ type: 'delete_cron_job', sessionId: '', detail: deleteInfo });
        continue;
      }
      if (tc.name === 'create_presentation') {
        const title = tc.arguments.title ?? tc.arguments.name ?? 'Presentation';

        // Collect slides from individual slide_N parameters
        const slides: string[] = [];
        for (let i = 1; i <= 8; i++) {
          const slide = tc.arguments[`slide_${i}`];
          if (slide && slide.trim()) slides.push(slide);
        }

        // Fallback: check for legacy "slides" parameter (JSON array string)
        if (slides.length === 0 && tc.arguments.slides) {
          try {
            const parsed = JSON.parse(tc.arguments.slides);
            if (Array.isArray(parsed)) slides.push(...parsed.map(String));
          } catch {
            // Maybe it's a single slide as raw HTML
            if (tc.arguments.slides.includes('<')) slides.push(tc.arguments.slides);
          }
        }

        // Fallback: scan ALL params for anything that looks like HTML
        if (slides.length === 0) {
          for (const [key, val] of Object.entries(tc.arguments)) {
            if (key === 'title' || key === 'name') continue;
            const v = String(val);
            if (v.includes('<') || v.includes('class=')) {
              slides.push(v);
            }
          }
        }

        if (slides.length === 0) {
          logger.warn(`Manager: create_presentation called but no slides found in args: ${JSON.stringify(tc.arguments).slice(0, 200)}`);
          slides.push(`<h1 class="fade-in">${title}</h1><p class="text-muted slide-up delay-1">Keine Slide-Daten empfangen.</p>`);
        }

        logger.info(`Manager: create_presentation — "${title}", ${slides.length} slides collected`);
        const presInfo = JSON.stringify({ title, slides: JSON.stringify(slides) });
        actions.push({ type: 'create_presentation', sessionId: '', detail: presInfo });
        continue;
      }

      const label = tc.arguments.session_label;
      let sessionId = label ? this.resolveLabel(label) : null;

      // Fallback: if label resolution failed, try partial/fuzzy match
      if (!sessionId && label) {
        const labelLower = label.toLowerCase();
        // First: try matching by actual label content (e.g. "Shell 2" matches label "Shell 2")
        for (const [id, lbl] of this.sessionLabels) {
          if (lbl.toLowerCase().includes(labelLower) || labelLower.includes(lbl.toLowerCase())) {
            sessionId = id;
            logger.info(`Manager: resolved "${label}" via fuzzy label match → ${lbl}`);
            break;
          }
        }
        // Second: try "Shell X" number matching by finding label that contains "Shell X"
        if (!sessionId) {
          const shellMatch = label.match(/shell\s*(\d+)/i);
          if (shellMatch) {
            const shellPattern = `shell ${shellMatch[1]}`;
            for (const [id, lbl] of this.sessionLabels) {
              if (lbl.toLowerCase().includes(shellPattern)) {
                sessionId = id;
                logger.info(`Manager: resolved "${label}" via shell pattern match → ${lbl}`);
                break;
              }
            }
          }
        }
      }

      // Last resort: if only one session exists, use it
      if (!sessionId && this.sessionLabels.size === 1) {
        sessionId = [...this.sessionLabels.keys()][0];
        logger.info(`Manager: only one session available, using it as fallback`);
      }

      if (!sessionId) {
        logger.warn(`Manager: tool call ${tc.name} — could not resolve label "${label}", known: ${[...this.sessionLabels.entries()].map(([id, l]) => `${l}=${id.slice(0, 8)}`).join(', ')}`);
        continue;
      }
      if (tc.name === 'write_to_terminal') {
        actions.push({ type: 'write_to_terminal', sessionId, detail: tc.arguments.command ?? '' });
      } else if (tc.name === 'send_enter') {
        actions.push({ type: 'send_enter', sessionId, detail: '' });
      } else if (tc.name === 'send_keys') {
        // Keys come as comma-separated string, e.g. "arrow_down,arrow_down,enter"
        const keysRaw = tc.arguments.keys ?? '';
        const keysArr = keysRaw.split(',').map((k: string) => k.trim()).filter(Boolean);
        actions.push({ type: 'send_keys', sessionId, detail: JSON.stringify(keysArr) });
      } else if (tc.name === 'close_terminal') {
        actions.push({ type: 'close_terminal', sessionId, detail: '' });
      }
    }
    return actions;
  }

  private emitThinking(phase: string, startTime: number, detail?: string): void {
    const elapsed = Date.now() - startTime;
    this.onThinking?.(phase, detail, elapsed);
  }

  async handleChat(text: string, targetSessionId?: string, onboarding?: boolean): Promise<void> {
    if (!this.enabled) {
      throw new Error('Manager ist nicht aktiv — bitte zuerst aktivieren (grüner Punkt)');
    }

    // Prevent overlapping processing (heartbeat + manual chat)
    if (this.isProcessing) {
      logger.info('Manager: skipping chat — already processing');
      this.onError?.('Ich arbeite gerade noch an etwas — bitte kurz warten.');
      return;
    }
    this.isProcessing = true;

    const startTime = Date.now();
    const phases: PhaseInfo[] = [];
    let phaseStart = startTime;

    const recordPhase = (phase: string, label: string) => {
      const now = Date.now();
      if (phases.length > 0) {
        phases[phases.length - 1].duration = now - phaseStart;
      }
      phases.push({ phase, label, duration: 0 });
      phaseStart = now;
      this.emitThinking(phase, startTime);
    };

    // Phase 1: Analyze terminals
    recordPhase('analyzing_terminals', 'Terminals analysieren');

    const contexts = this.buildTerminalContexts();
    let contextBlock: string;

    if (targetSessionId) {
      const targetCtx = contexts.find(c => c.sessionId === targetSessionId);
      contextBlock = targetCtx
        ? this.formatContextBlock([targetCtx])
        : `(Terminal ${targetSessionId.slice(0, 8)} hat keinen Output)`;
    } else {
      contextBlock = this.formatContextBlock(contexts);
    }

    // Always include a session listing so the agent knows what's available
    const sessionListing = this.sessionLabels.size > 0
      ? `\n\n## Aktive Terminals (${this.sessionLabels.size})\n${[...this.sessionLabels.entries()].map(([id, lbl], i) => `${i + 1}. ${lbl} (ID: ${id.slice(0, 8)})`).join('\n')}`
      : '\n\n## Aktive Terminals\nKeine Terminals offen.';

    // Include delegated task status
    const activeTasks = this.getActiveTasks();
    const taskListing = activeTasks.length > 0
      ? `\n\n## Delegierte Aufgaben (${activeTasks.length})\n${activeTasks.map((t, i) => {
          const status = t.status === 'running' ? '⏳' : t.status === 'waiting' ? '✅?' : '⏸️';
          const age = Math.round((Date.now() - t.createdAt) / 1000);
          const ageStr = age > 60 ? `${Math.round(age / 60)}min` : `${age}s`;
          return `${i + 1}. ${status} [${t.status}] "${t.description}" → ${t.sessionLabel} (seit ${ageStr})`;
        }).join('\n')}`
      : '';

    const userMessage = `${text}\n\n---\n[HINTERGRUND-KONTEXT — Nur lesen, NICHT automatisch kommentieren. Nur erwähnen wenn relevant für die Frage des Users.]\n${contextBlock}${sessionListing}${taskListing}`;
    this.chatHistory.push({ role: 'user', content: text });

    // Phase 2: Build context
    recordPhase('building_context', 'Kontext vorbereiten');

    this.memory = loadMemory();
    const memoryIsEmpty = this.memory.user.learnedFacts.length === 0 && !this.memory.user.name;
    const isOnboarding = onboarding && memoryIsEmpty;
    const basePrompt = onboarding ? ONBOARDING_PROMPT : buildSystemPrompt(this.personality);
    const memoryContext = buildMemoryContext(this.memory);
    const systemPrompt = `${basePrompt}\n\n${memoryContext}\n\n${MEMORY_UPDATE_INSTRUCTION}`;

    // Phase 3: Call AI
    recordPhase('calling_ai', 'Sende an AI');

    try {
      const provider = this.registry.getActive();
      const toolProvider = this.registry.getActiveWithTools();
      const isLocalProvider = !!provider.isLocal; // LM Studio / Gemma 4
      logger.info(`Manager: streaming chat via ${provider.name}${toolProvider ? ' (with tools)' : ''}${isLocalProvider ? ' [local]' : ''}`);

      // Phase 4: Streaming
      recordPhase('streaming', 'Schreibt');

      let reply: string;
      let nativeToolCalls: Array<{ id: string; name: string; arguments: Record<string, string> }> = [];
      let rawToolCalls: RawToolCall[] = [];
      const actionResults: string[] = [];
      const actionImages: string[] = [];
      const actionPresentations: string[] = [];

      if (toolProvider) {
        // GLM: use native tool calling with multi-turn flow
        // Filter poisoned history: remove assistant messages claiming inability
        const cleanHistory = this.chatHistory.filter(m => {
          if (m.role !== 'assistant') return true;
          // Remove responses where the agent falsely claimed it can't use tools
          return !/kann (ich )?(leider )?(keine|nicht).*(?:bild|image|generier)/i.test(m.content ?? '')
            && !/habe keine.*fähigkeit/i.test(m.content ?? '');
        });
        const chatMessages = [...cleanHistory, { role: 'user' as const, content: onboarding ? text : userMessage }];

        logger.info(`Manager: sending ${MANAGER_TOOLS.length} tools to ${provider.name}: [${MANAGER_TOOLS.map(t => t.function.name).join(', ')}]`);
        logger.info(`Manager: chat history: ${chatMessages.length} messages (${cleanHistory.length} clean, ${this.chatHistory.length - cleanHistory.length} filtered)`);

        // Token counting for stream stats
        let streamTokenCount = 0;
        const streamStart = Date.now();

        const result = await toolProvider.chatStreamWithTools(
          chatMessages,
          systemPrompt,
          MANAGER_TOOLS,
          (token) => {
            streamTokenCount++;
            const elapsedSec = (Date.now() - streamStart) / 1000;
            const tps = elapsedSec > 0.5 ? Math.round((streamTokenCount / elapsedSec) * 10) / 10 : 0;
            this.onStreamChunk?.(token, { completionTokens: streamTokenCount, tps });
          },
        );
        reply = result.text;
        nativeToolCalls = result.toolCalls;
        rawToolCalls = result.rawToolCalls;

        logger.info(`Manager: GLM returned ${nativeToolCalls.length} tool calls, text: ${reply.slice(0, 100)}${reply.length > 100 ? '…' : ''}`);

        // ── Intent Detection: Force tool call if GLM ignores tools ──────
        // GLM sometimes refuses to use tools due to poisoned memory/history.
        // If the user's request clearly matches a tool, retry with forced tool_choice.
        if (nativeToolCalls.length === 0) {
          const userText = text.toLowerCase();
          let forcedTool: string | null = null;

          // Image generation intent
          if (/(?:erstell|generier|mach|erzeug|zeichne|design|paint|draw|create|generate)\b.*\b(?:bild|image|foto|picture|illustration|grafik)/i.test(text)
            || /\b(?:bild|image|foto|picture)\b.*(?:erstell|generier|mach|erzeug|von|with|für)/i.test(text)) {
            forcedTool = 'generate_image';
          }
          // Presentation intent
          else if (/(?:erstell|mach|bau|generier|create)\b.*\b(?:präsentation|presentation|ppt|slides|folien)/i.test(text)
            || /\b(?:präsentation|presentation|ppt|slides)\b.*(?:erstell|mach|über|about|zu|von)/i.test(text)
            || text.startsWith('[PRÄSENTATION]')) {
            forcedTool = 'create_presentation';
          }
          // Self-education intent (explicit skill creation)
          else if (/(?:erstell|bau|mach).*(?:skill|fähigkeit)/i.test(text) || text.startsWith('[SKILL-ERSTELLUNG]')) {
            forcedTool = 'self_education';
          }

          if (forcedTool) {
            // Local providers (Gemma 4) don't reliably support forced tool_choice
            if (isLocalProvider) {
              logger.info(`Manager: intent detected for "${forcedTool}" but local provider doesn't support forced tool_choice — skipping retry`);
            } else {
            logger.info(`Manager: intent detected for "${forcedTool}" but AI didn't call it — retrying with forced tool_choice`);

            // Retry with forced tool_choice
            const forcedResult = await toolProvider.chatStreamWithTools(
              chatMessages,
              systemPrompt,
              MANAGER_TOOLS,
              () => {}, // Don't double-stream chunks — we already streamed the first attempt
              { type: 'function', function: { name: forcedTool } },
            );

            if (forcedResult.toolCalls.length > 0) {
              // Success — use the forced result
              reply = forcedResult.text;
              nativeToolCalls = forcedResult.toolCalls;
              rawToolCalls = forcedResult.rawToolCalls;
              logger.info(`Manager: forced retry succeeded — ${nativeToolCalls.length} tool calls`);
            } else {
              logger.warn(`Manager: forced retry also returned 0 tool calls`);
            }
          } // end else (non-local provider)
          }
        }

        // ── Multi-Turn Tool Calling Loop ─────────────────────────────────
        // GLM may need multiple rounds of tool calls (e.g. generate images,
        // THEN create terminal + run command). We loop until GLM returns no
        // more tool calls, up to MAX_TOOL_ROUNDS to prevent infinite loops.
        const MAX_TOOL_ROUNDS = 5;
        const TOOL_LOOP_TIMEOUT_MS = 120_000; // 2 minutes max for entire tool loop
        const toolLoopStart = Date.now();
        let round = 0;
        let turnMessages: Array<{ role: string; content?: string | null; tool_calls?: RawToolCall[]; tool_call_id?: string }> =
          chatMessages.map(m => ({ role: m.role, content: m.content }));

        while (nativeToolCalls.length > 0 && round < MAX_TOOL_ROUNDS && (Date.now() - toolLoopStart) < TOOL_LOOP_TIMEOUT_MS) {
          round++;
          logger.info(`Manager: tool round ${round} — ${nativeToolCalls.length} tool calls`);

          // Execute tools
          phaseStart = Date.now();
          recordPhase('executing_actions', `Tools (Runde ${round})...`);

          const toolResults: Array<{ toolCallId: string; result: string }> = [];
          const executedActions: ManagerAction[] = [];

          for (let i = 0; i < nativeToolCalls.length; i++) {
            const tc = nativeToolCalls[i];
            const toolCallId = tc.id ?? `call_${round}_${i}`;
            const mapped = this.toolCallsToActions([tc]);

            if (mapped.length > 0) {
              const action = mapped[0];
              const execResult = await this.executeAction(action);
              const resultText = execResult?.text ?? 'OK';
              if (execResult?.images) actionImages.push(...execResult.images);
              if (execResult?.presentations) actionPresentations.push(...execResult.presentations);
              toolResults.push({ toolCallId, result: resultText });
              actionResults.push(resultText);
              executedActions.push(action);
            } else {
              const label = tc.arguments?.session_label ?? 'unbekannt';
              const errorMsg = `Fehler: Terminal "${label}" nicht gefunden. Verfügbare Terminals: ${[...this.sessionLabels.values()].join(', ') || 'keine'}`;
              toolResults.push({ toolCallId, result: errorMsg });
            }
          }

          phases[phases.length - 1].duration = Date.now() - phaseStart;

          // If we delegated a task (create_terminal with non-empty command), stop the loop.
          // The heartbeat will monitor the terminal and wake the manager when done.
          const delegated = executedActions.some(a => {
            if (a.type !== 'create_terminal') return false;
            try { return !!JSON.parse(a.detail).initialCommand; } catch { return false; }
          });
          if (delegated) {
            logger.info(`Manager: task delegated — stopping tool loop, heartbeat will monitor`);
            const delegateNote = '\n\nWICHTIG: Die Aufgabe wurde delegiert. Du WARTEST jetzt — drücke NICHT Enter, sende KEINE weiteren Befehle. Der Heartbeat überwacht den Fortschritt und meldet sich automatisch wenn die Aufgabe fertig ist. Antworte dem User nur dass die Aufgabe delegiert wurde.';
            if (isLocalProvider) {
              const resultSummary = toolResults.map(tr => `[Tool-Ergebnis] ${tr.result}`).join('\n');
              turnMessages = [
                ...turnMessages,
                { role: 'assistant', content: reply || null },
                { role: 'user', content: resultSummary + delegateNote },
              ];
            } else {
              turnMessages = [
                ...turnMessages,
                { role: 'assistant', content: reply || null, tool_calls: rawToolCalls },
                ...toolResults.map(tr => ({
                  role: 'tool' as const,
                  content: tr.result + delegateNote,
                  tool_call_id: tr.toolCallId,
                })),
              ];
            }
            const delegateResult = await toolProvider.chatStreamWithTools(
              turnMessages as ChatMessage[],
              systemPrompt,
              MANAGER_TOOLS,
              (token) => this.onStreamChunk?.(token),
            );
            reply = delegateResult.text;
            nativeToolCalls = [];
            rawToolCalls = [];
            phases[phases.length - 1].duration = Date.now() - phaseStart;
            break;
          }

          // Build message history for next call
          if (isLocalProvider) {
            // Local providers (Gemma 4): Use simple user message format for tool results.
            // Gemma 4 doesn't reliably understand OpenAI's role:'tool' + tool_call_id format.
            const resultSummary = toolResults.map(tr => `[Tool-Ergebnis] ${tr.result}`).join('\n');
            turnMessages = [
              ...turnMessages,
              { role: 'assistant', content: reply || null },
              { role: 'user', content: resultSummary },
            ];
          } else {
            // Cloud providers (GLM): Use OpenAI multi-turn format with tool_calls + tool_call_id
            turnMessages = [
              ...turnMessages,
              { role: 'assistant', content: reply || null, tool_calls: rawToolCalls },
              ...toolResults.map(tr => ({
                role: 'tool' as const,
                content: tr.result,
                tool_call_id: tr.toolCallId,
              })),
            ];
          }

          // Next API call — AI may return more tool calls or a final text response
          recordPhase('tool_response', `Verarbeite (Runde ${round})...`);
          logger.info(`Manager: sending ${toolResults.length} tool results back to ${provider.name} (round ${round})`);

          const nextResult = await toolProvider.chatStreamWithTools(
            turnMessages as ChatMessage[],
            systemPrompt,
            MANAGER_TOOLS,
            (token) => this.onStreamChunk?.(token),
          );

          reply = nextResult.text;
          nativeToolCalls = nextResult.toolCalls;
          rawToolCalls = nextResult.rawToolCalls;

          phases[phases.length - 1].duration = Date.now() - phaseStart;

          logger.info(`Manager: round ${round} result — ${nativeToolCalls.length} more tool calls, text: ${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}`);
        }

        if (round >= MAX_TOOL_ROUNDS && nativeToolCalls.length > 0) {
          logger.warn(`Manager: hit max tool rounds (${MAX_TOOL_ROUNDS}), stopping`);
        }
        if ((Date.now() - toolLoopStart) >= TOOL_LOOP_TIMEOUT_MS) {
          logger.warn(`Manager: tool loop timed out after ${Math.round((Date.now() - toolLoopStart) / 1000)}s`);
        }

        // All tool calls have been executed across all rounds
        nativeToolCalls = [];
        rawToolCalls = [];
      } else {
        // Kimi: text-only streaming (tags parsed later)
        reply = await provider.chatStream(
          [...this.chatHistory, { role: 'user', content: onboarding ? text : userMessage }],
          systemPrompt,
          (token) => this.onStreamChunk?.(token),
        );
      }

      // Close last phase duration
      phases[phases.length - 1].duration = Date.now() - phaseStart;

      // Check for personality config (onboarding completion)
      const parsedConfig = parsePersonalityConfig(reply);
      if (parsedConfig) {
        this.personality = parsedConfig;
        this.memory.personality = {
          ...this.memory.personality,
          agentName: parsedConfig.agentName,
          tone: parsedConfig.tone,
          detail: parsedConfig.detail,
          emojis: parsedConfig.emojis,
          proactive: parsedConfig.proactive,
        };
        this.onPersonalityConfigured?.(parsedConfig);
        // Save personality immediately — don't risk losing it to a crash
        saveMemory(this.memory);
        logger.info(`Manager: onboarding complete — name="${parsedConfig.agentName}", tone=${parsedConfig.tone}`);
      }

      // Parse memory updates from reply
      const memUpdate = parseMemoryUpdate(reply);
      if (memUpdate) {
        if (!parsedConfig && isOnboarding) {
          for (const fact of memUpdate.learnedFacts) {
            const nameMatch = fact.match(/agent\s+(?:heißt|name|nennt?\s+sich)\s+["']?(\w+)/i)
              ?? fact.match(/(?:nenn|heiß)\w*\s+(?:dich|mich|sich)\s+["']?(\w+)/i);
            if (nameMatch) {
              const name = nameMatch[1];
              this.memory.personality.agentName = name;
              this.personality.agentName = name;
              this.onPersonalityConfigured?.({
                ...this.personality,
                agentName: name,
              });
              logger.info(`Manager: auto-detected agent name from memory: "${name}"`);
              break;
            }
          }
        }
        applyMemoryUpdate(this.memory, memUpdate);
        logger.info(`Manager: memory updated — ${memUpdate.learnedFacts.length} facts, ${memUpdate.insights.length} insights`);
      }

      this.memory.recentChat.push({ role: 'user', text, timestamp: Date.now() });
      this.memory.stats.totalMessages += 2;
      this.memory.stats.lastInteraction = new Date().toISOString().slice(0, 10);
      if (!this.memory.stats.firstInteraction) {
        this.memory.stats.firstInteraction = this.memory.stats.lastInteraction;
      }
      saveMemory(this.memory);

      // Collect actions: regex fallback only (native tool calls already executed in multi-turn flow)
      const tagActions = this.parseActions(reply);
      const actions = [...tagActions];

      // Phase 5: Execute tag-based actions (non-GLM fallback)
      if (actions.length > 0) {
        phaseStart = Date.now();
        recordPhase('executing_actions', 'Befehle ausführen');
        for (const action of actions) {
          const result = await this.executeAction(action);
          if (result) {
            actionResults.push(result.text);
            if (result.images) actionImages.push(...result.images);
            if (result.presentations) actionPresentations.push(...result.presentations);
          }
        }
        phases[phases.length - 1].duration = Date.now() - phaseStart;
      }

      // Clean reply + append action results (e.g. image generation paths)
      let cleanReply = stripMemoryTags(
        reply
          .replace(/\[WRITE_TO:[^\]]+\][^[]*\[\/WRITE_TO\]/g, '')
          .replace(/\[SEND_ENTER:[^\]]+\]/g, '')
          .replace(/\[PERSONALITY_CONFIG\][\s\S]*?\[\/PERSONALITY_CONFIG\]/g, '')
      );

      this.chatHistory.push({ role: 'assistant', content: cleanReply });
      if (this.chatHistory.length > 50) {
        // Trigger distillation before truncating so messages aren't lost
        if (!this.isDistilling) {
          this.distill().catch(err => logger.warn(`Manager: pre-truncation distill failed — ${err}`));
        }
        this.chatHistory = this.chatHistory.slice(-40);
      }

      this.memory.recentChat.push({ role: 'assistant', text: cleanReply.slice(0, 2000), timestamp: Date.now() });
      saveMemory(this.memory);

      if (this.memory.recentChat.length > MAX_RECENT_CHAT && !this.isDistilling) {
        this.distill().catch(err => logger.warn(`Manager: auto-distill failed — ${err}`));
      }

      let finalText = cleanReply;
      if (!finalText) {
        if (parsedConfig) {
          finalText = `${parsedConfig.agentName} ist eingerichtet und bereit.`;
        } else if (actions.length > 0) {
          // Auto-generate confirmation for tool-call-only responses
          const summaries = actions.map(a => {
            const lbl = this.sessionLabels.get(a.sessionId) ?? a.sessionId.slice(0, 8);
            return a.type === 'write_to_terminal'
              ? `\`${a.detail}\` in ${lbl}`
              : `Enter in ${lbl}`;
          });
          finalText = `Ausgeführt: ${summaries.join(', ')}`;
        } else {
          finalText = 'Verstanden — ich habe mir alles gemerkt.';
        }
      }

      // Send stream end with phases, images, presentations, and active tasks
      this.onStreamEnd?.(finalText, actions, phases, actionImages.length > 0 ? actionImages : undefined, actionPresentations.length > 0 ? actionPresentations : undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Manager: chat failed — ${msg}`);
      this.onError?.(`Fehler: ${msg}`);
    } finally {
      this.isProcessing = false;
    }
  }

  // ── Distillation ──────────────────────────────────────────────────────────

  async distill(): Promise<void> {
    if (this.memory.recentChat.length === 0) return;
    if (this.isDistilling) {
      logger.info('Manager: distill skipped — already distilling');
      return;
    }
    this.isDistilling = true;
    // Snapshot messages to distill — new messages added during distill are preserved
    const toDistill = [...this.memory.recentChat];
    logger.info(`Manager: distilling ${toDistill.length} messages...`);
    try {
      const provider = this.registry.getActive();
      const prompt = buildDistillationPrompt(toDistill);
      const reply = await provider.chat(
        [{ role: 'user', content: prompt }],
        'Du bist ein Gedächtnis-Assistent. Extrahiere die wichtigsten Erkenntnisse aus dem Chat-Verlauf.',
      );
      const update = parseMemoryUpdate(reply);
      if (update) {
        applyMemoryUpdate(this.memory, update);
        logger.info(`Manager: distilled — ${update.insights.length} insights, ${update.learnedFacts.length} facts`);
      }
      // Only remove the messages we actually distilled — preserve any added during distillation
      this.memory.recentChat = this.memory.recentChat.slice(toDistill.length);
      this.memory.stats.totalSessions++;
      saveMemory(this.memory);
      logger.info('Manager: distillation complete');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Manager: distillation failed — ${msg}`);
      saveMemory(this.memory);
    } finally {
      this.isDistilling = false;
    }
  }

  // ── Action Parsing & Execution ────────────────────────────────────────────

  private parseActions(text: string): ManagerAction[] {
    const actions: ManagerAction[] = [];

    // Parse [WRITE_TO:sessionId]command[/WRITE_TO]
    const writeRegex = /\[WRITE_TO:([^\]]+)\]([\s\S]*?)\[\/WRITE_TO\]/g;
    let match: RegExpExecArray | null;
    while ((match = writeRegex.exec(text)) !== null) {
      const sessionId = this.resolveSessionId(match[1].trim());
      if (sessionId) {
        actions.push({ type: 'write_to_terminal', sessionId, detail: match[2].trim() });
      }
    }

    // Parse [SEND_ENTER:sessionId]
    const enterRegex = /\[SEND_ENTER:([^\]]+)\]/g;
    while ((match = enterRegex.exec(text)) !== null) {
      const sessionId = this.resolveSessionId(match[1].trim());
      if (sessionId) {
        actions.push({ type: 'send_enter', sessionId, detail: '' });
      }
    }

    return actions;
  }

  /** Resolve a label or partial ID to a full session ID. */
  private resolveSessionId(ref: string): string | null {
    // Direct match
    if (this.sessionLabels.has(ref)) return ref;

    // Match by label (e.g. "Shell 1")
    for (const [id, label] of this.sessionLabels) {
      if (label.toLowerCase() === ref.toLowerCase()) return id;
    }

    // Match by partial ID
    for (const [id] of this.sessionLabels) {
      if (id.startsWith(ref)) return id;
    }

    logger.warn(`Manager: could not resolve session reference "${ref}"`);
    return null;
  }

  private async executeAction(action: ManagerAction): Promise<{ text: string; images?: string[]; presentations?: string[] } | null> {
    switch (action.type) {
      case 'write_to_terminal': {
        const label = this.sessionLabels.get(action.sessionId) ?? action.sessionId.slice(0, 8);
        logger.info(`Manager: writing to ${label} (${action.sessionId.slice(0, 8)}): "${action.detail.slice(0, 50)}"`);
        const ok = globalManager.write(action.sessionId, action.detail);
        if (!ok) {
          logger.warn(`Manager: write FAILED — session ${action.sessionId.slice(0, 8)} not found`);
          return { text: `Fehler: Terminal "${label}" nicht gefunden.` };
        }
        setTimeout(() => globalManager.write(action.sessionId, '\r'), 200);
        return { text: `Befehl "${action.detail.slice(0, 60)}" an "${label}" gesendet.` };
      }
      case 'send_enter': {
        const label = this.sessionLabels.get(action.sessionId) ?? action.sessionId.slice(0, 8);
        logger.info(`Manager: sending Enter to ${label}`);
        globalManager.write(action.sessionId, '\r');
        return { text: `Enter an "${label}" gesendet.` };
      }
      case 'send_keys': {
        const label = this.sessionLabels.get(action.sessionId) ?? action.sessionId.slice(0, 8);
        let keys: string[];
        try {
          keys = JSON.parse(action.detail);
        } catch {
          keys = [action.detail];
        }

        const KEY_MAP: Record<string, string> = {
          arrow_up: '\x1b[A',
          arrow_down: '\x1b[B',
          arrow_right: '\x1b[C',
          arrow_left: '\x1b[D',
          enter: '\r',
          tab: '\t',
          escape: '\x1b',
          space: ' ',
          backspace: '\x7f',
          ctrl_c: '\x03',
          ctrl_d: '\x04',
          ctrl_z: '\x1a',
        };

        logger.info(`Manager: sending keys to ${label}: [${keys.join(', ')}]`);
        let delay = 0;
        for (const key of keys) {
          const seq = KEY_MAP[key];
          if (!seq) {
            logger.warn(`Manager: unknown key "${key}", skipping`);
            continue;
          }
          setTimeout(() => globalManager.write(action.sessionId, seq), delay);
          delay += 100;
        }
        return { text: `Tasten [${keys.join(', ')}] an "${label}" gesendet.` };
      }
      case 'close_terminal': {
        const label = this.sessionLabels.get(action.sessionId) ?? action.sessionId.slice(0, 8);
        logger.info(`Manager: closing terminal ${label} (${action.sessionId.slice(0, 8)})`);
        if (this.onCloseTerminal) {
          const ok = this.onCloseTerminal(action.sessionId);
          if (ok) {
            this.clearSession(action.sessionId);
            logger.info(`Manager: terminal ${label} closed`);
            return { text: `Terminal "${label}" geschlossen.` };
          } else {
            return { text: `Fehler: Terminal "${label}" konnte nicht geschlossen werden.` };
          }
        }
        return { text: 'Fehler: close_terminal Callback nicht verfügbar.' };
      }
      case 'list_terminals': {
        const list = [...this.sessionLabels.entries()].map(([id, lbl]) => `${lbl} (${id.slice(0, 8)})`);
        logger.info(`Manager: list_terminals — ${list.length} sessions: ${list.join(', ')}`);
        return { text: list.length > 0
          ? `Aktive Terminals (${list.length}):\n${list.map((l, i) => `${i + 1}. ${l}`).join('\n')}`
          : 'Keine Terminals offen.' };
      }
      case 'create_terminal': {
        let label: string | undefined;
        let initialCommand: string | undefined;
        try {
          const info = JSON.parse(action.detail);
          label = info.label || undefined;
          initialCommand = info.initialCommand || undefined;
        } catch {
          label = action.detail || undefined;
        }

        logger.info(`Manager: creating new terminal${label ? ` "${label}"` : ''}${initialCommand ? ` with command "${initialCommand}"` : ''}`);

        if (this.onCreateTerminal) {
          const newSessionId = this.onCreateTerminal(label);
          if (newSessionId) {
            logger.info(`Manager: terminal created — ${newSessionId.slice(0, 8)}`);
            if (initialCommand) {
              setTimeout(() => {
                logger.info(`Manager: executing initial command in ${newSessionId.slice(0, 8)}: "${initialCommand}"`);
                globalManager.write(newSessionId, initialCommand + '\r');
              }, 800);
              // Attach to existing chat task (from update_task) — match by label or find first unattached
              const labelLower = (label ?? '').toLowerCase();
              const existingTask = this.getActiveTasks().find(t =>
                !t.sessionId && labelLower && t.description.toLowerCase().includes(labelLower)
              ) ?? this.getActiveTasks().find(t => !t.sessionId);
              if (existingTask) {
                existingTask.sessionId = newSessionId;
                existingTask.sessionLabel = this.sessionLabels.get(newSessionId) ?? newSessionId.slice(0, 8);
                existingTask.updatedAt = Date.now();
                this.broadcastTasks();
              } else {
                this.addDelegatedTask(initialCommand, newSessionId);
              }
            }
            return { text: `Terminal "${label || 'Shell'}" erstellt (${newSessionId.slice(0, 8)}).${initialCommand ? ` Befehl "${initialCommand}" wird ausgeführt. Aufgabe wird überwacht — ich melde mich wenn sie fertig ist.` : ''}` };
          } else {
            return { text: 'Fehler: Terminal konnte nicht erstellt werden.' };
          }
        }
        return { text: 'Fehler: create_terminal Callback nicht verfügbar.' };
      }
      case 'update_task': {
        try {
          const info = JSON.parse(action.detail);
          const taskName = (info.taskName as string) || '';

          // Find task by name (fuzzy match) or fall back to first active
          let task: DelegatedTask | undefined;
          if (taskName) {
            const nameLower = taskName.toLowerCase();
            task = this.delegatedTasks.find(t =>
              (t.status === 'running' || t.status === 'pending' || t.status === 'waiting') &&
              (t.description.toLowerCase().includes(nameLower) || nameLower.includes(t.description.toLowerCase()))
            );
          }
          if (!task) {
            task = this.getActiveTasks()[0];
          }

          if (info.action === 'set_steps') {
            const stepLabels = (info.steps as string).split(',').map((s: string) => s.trim()).filter(Boolean);

            if (!task) {
              // Create new task — multiple tasks can coexist
              task = this.addDelegatedTask(taskName || stepLabels[0] || 'Aufgabe', '', undefined, stepLabels);
              logger.info(`Manager: created new task "${task.description}" with ${stepLabels.length} steps`);
              return { text: `Task "${task.description}" erstellt: ${stepLabels.join(', ')}` };
            }

            // Update existing task steps
            task.steps = stepLabels.map((label: string, i: number) => ({
              label,
              status: (i === 0 ? 'running' : 'pending') as TaskStatus,
            }));
            task.description = taskName || stepLabels[0] || task.description;
            task.updatedAt = Date.now();
            this.broadcastTasks();
            return { text: `Task "${task.description}" aktualisiert: ${stepLabels.join(', ')}` };
          }

          if (!task) return { text: `Kein aktiver Task "${taskName}" gefunden.` };

          if (info.action === 'complete_step') {
            const idx = parseInt(info.stepIndex, 10);
            if (task.steps[idx]) {
              task.steps[idx].status = 'done';
              const nextPending = task.steps.find(s => s.status === 'pending');
              if (nextPending) {
                nextPending.status = 'running';
              }
              if (task.steps.every(s => s.status === 'done')) {
                task.status = 'done';
              }
              task.updatedAt = Date.now();
              this.broadcastTasks();
              return { text: `[${task.description}] Schritt "${task.steps[idx].label}" abgehakt.` };
            }
          }
          if (info.action === 'fail_step') {
            const idx = parseInt(info.stepIndex, 10);
            if (task.steps[idx]) {
              task.steps[idx].status = 'failed';
              task.updatedAt = Date.now();
              this.broadcastTasks();
              return { text: `[${task.description}] Schritt "${task.steps[idx].label}" fehlgeschlagen.` };
            }
          }
          return { text: 'Unbekannte update_task Aktion.' };
        } catch { return { text: 'Fehler beim Task-Update.' }; }
      }
      case 'self_education': {
        const seResult = await this.handleSelfEducation(action.detail);
        return { text: seResult };
      }
      case 'generate_image': {
        let prompt = '';
        let size = '1024x1024';
        try {
          const info = JSON.parse(action.detail);
          prompt = info.prompt || '';
          size = info.size || '1024x1024';
        } catch {
          prompt = action.detail || '';
        }

        if (!prompt) {
          return { text: '⚠️ Kein Bild-Prompt angegeben.' };
        }

        const apiKey = this.registry.getOpenaiApiKey();
        if (!apiKey) {
          return { text: '⚠️ OpenAI API Key nicht konfiguriert. Bitte in den Einstellungen hinterlegen.' };
        }

        logger.info(`Manager: generating image — "${prompt.slice(0, 60)}…"`);
        const result = await generateImage(prompt, apiKey, size);
        if (result.success && result.filePath) {
          // Extract filename for the HTTP serving route
          const filename = result.filePath.split('/').pop() ?? '';
          return {
            text: `🖼️ Bild generiert und gespeichert: ${result.filePath}`,
            images: [filename],
          };
        } else {
          return { text: `⚠️ Bildgenerierung fehlgeschlagen: ${result.error ?? 'Unbekannter Fehler'}` };
        }
      }
      case 'create_cron_job': {
        try {
          const info = JSON.parse(action.detail);
          const job: CronJob = {
            id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: info.name,
            schedule: info.schedule,
            type: info.type === 'claude' ? 'claude' : 'simple',
            command: info.command,
            targetDir: info.targetDir || undefined,
            enabled: true,
            createdAt: Date.now(),
          };
          this.cronManager.addJob(job);
          return { text: `✅ Cron Job "${job.name}" erstellt (${cronToLabel(job.schedule)}). ID: ${job.id}` };
        } catch (err) {
          return { text: `⚠️ Fehler beim Erstellen des Cron Jobs: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      case 'list_cron_jobs': {
        const jobs = this.cronManager.listJobs();
        if (jobs.length === 0) return { text: '📋 Keine Cron Jobs konfiguriert.' };
        const lines = jobs.map(j => {
          const status = j.enabled ? '🟢' : '⏸️';
          const lastRun = j.lastRunAt ? new Date(j.lastRunAt).toLocaleString('de-DE') : 'nie';
          return `${status} **${j.name}** (${cronToLabel(j.schedule)}) — Typ: ${j.type}, Letzter Lauf: ${lastRun}\n   ID: \`${j.id}\``;
        });
        return { text: `📋 Cron Jobs (${jobs.length}):\n\n${lines.join('\n\n')}` };
      }
      case 'toggle_cron_job': {
        try {
          const info = JSON.parse(action.detail);
          const enabled = info.enabled === 'true' || info.enabled === true;
          const job = this.cronManager.toggleJob(info.jobId, enabled);
          if (!job) return { text: `⚠️ Cron Job "${info.jobId}" nicht gefunden.` };
          return { text: `${enabled ? '🟢' : '⏸️'} Cron Job "${job.name}" ${enabled ? 'aktiviert' : 'deaktiviert'}.` };
        } catch { return { text: '⚠️ Fehler beim Toggle.' }; }
      }
      case 'delete_cron_job': {
        try {
          const info = JSON.parse(action.detail);
          const ok = this.cronManager.removeJob(info.jobId);
          return { text: ok ? `🗑️ Cron Job gelöscht.` : `⚠️ Cron Job "${info.jobId}" nicht gefunden.` };
        } catch { return { text: '⚠️ Fehler beim Löschen.' }; }
      }
      case 'create_presentation': {
        try {
          const info = JSON.parse(action.detail);
          const title = info.title || 'Presentation';
          let slides: string[];
          try {
            slides = JSON.parse(info.slides);
          } catch {
            slides = [info.slides];
          }
          if (!Array.isArray(slides) || slides.length === 0) {
            return { text: '⚠️ Keine Slides angegeben.' };
          }
          const html = buildPresentationHTML(title, slides);
          const presDir = path.join(__dirname, '..', '..', 'generated-presentations');
          if (!fs.existsSync(presDir)) {
            fs.mkdirSync(presDir, { recursive: true });
          }
          const filename = `pres_${Date.now()}.html`;
          fs.writeFileSync(path.join(presDir, filename), html, 'utf-8');
          logger.info(`Manager: presentation saved — ${filename} (${slides.length} slides)`);
          return {
            text: `📊 Präsentation "${title}" erstellt (${slides.length} Slides).`,
            presentations: [filename],
          };
        } catch (err) {
          return { text: `⚠️ Präsentation fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
    }
    return null;
  }

  // ── Self-Education ────────────────────────────────────────────────────────

  private async handleSelfEducation(detail: string): Promise<string> {
    let info: {
      action: string; skillName: string; skillDescription: string;
      category: string; scriptCode: string; scriptType: string;
      dependencies: string; executeArgs: string;
    };
    try {
      info = JSON.parse(detail);
    } catch {
      return '⚠️ Ungültige self_education Parameter.';
    }

    const { action, skillName, skillDescription, category, scriptCode, scriptType, dependencies, executeArgs } = info;

    switch (action) {
      case 'check': {
        if (!skillName) return '⚠️ skill_name wird für check benötigt.';
        const existing = findSkillByName(skillName);
        if (existing) {
          const lastTest = existing.testResults[existing.testResults.length - 1];
          return `✅ Skill gefunden: "${existing.name}" (${existing.status})${lastTest ? ` — Letzter Test: ${lastTest.passed ? 'bestanden' : 'FEHLGESCHLAGEN'}` : ''}. Script: ${existing.scriptPath}`;
        }
        return `❌ Kein Skill mit Name/Beschreibung "${skillName}" gefunden. Du kannst einen erstellen mit action: create.`;
      }

      case 'create': {
        if (!skillName || !scriptCode) {
          return '⚠️ skill_name und script_code werden für create benötigt.';
        }

        const id = createSkillId(skillName);
        const ext = scriptType === 'py' ? '.py' : scriptType === 'js' ? '.js' : '.sh';

        // Check dependencies first
        const deps = dependencies ? dependencies.split(',').map(d => d.trim()).filter(Boolean) : [];
        if (deps.length > 0) {
          const missing = await checkDependencies(deps);
          if (missing.length > 0) {
            return `⚠️ Fehlende Dependencies: ${missing.join(', ')}. Diese müssen installiert werden bevor der Skill funktioniert.`;
          }
        }

        // Write script file
        const scriptPath = writeSkillScript(id, scriptCode, ext);

        // Create skill definition
        const skill: SkillDefinition = {
          id,
          name: skillName,
          description: skillDescription || skillName,
          category: category || 'utility',
          scriptPath,
          dependencies: deps,
          status: 'draft',
          testResults: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        saveSkill(skill);

        logger.info(`Skills: created "${skillName}" (${id}) at ${scriptPath}`);

        // Automatically run test
        logger.info(`Skills: auto-testing "${skillName}"…`);
        const testResult = await executeSkillScript(scriptPath);
        const testEntry: TestResult = {
          date: new Date().toISOString(),
          passed: testResult.success,
          output: testResult.output.slice(0, 2000),
          error: testResult.error?.slice(0, 1000),
        };

        // CRITICAL: Only approve if test passed
        if (testResult.success) {
          updateSkillStatus(id, 'approved', testEntry);
          return `✅ Skill "${skillName}" erstellt und getestet — APPROVED.\nScript: ${scriptPath}\nTest-Output: ${testResult.output.slice(0, 500)}`;
        } else {
          updateSkillStatus(id, 'failed', testEntry);
          return `❌ Skill "${skillName}" erstellt aber Test FEHLGESCHLAGEN.\nScript: ${scriptPath}\nFehler: ${testResult.error?.slice(0, 500) || testResult.output.slice(0, 500)}\n\nDer Skill ist NICHT approved. Bitte den Code fixen und erneut testen.`;
        }
      }

      case 'test': {
        if (!skillName) return '⚠️ skill_name wird für test benötigt.';
        const skill = findSkillByName(skillName);
        if (!skill) return `❌ Skill "${skillName}" nicht gefunden.`;

        logger.info(`Skills: testing "${skill.name}"…`);
        const testResult = await executeSkillScript(skill.scriptPath);
        const testEntry: TestResult = {
          date: new Date().toISOString(),
          passed: testResult.success,
          output: testResult.output.slice(0, 2000),
          error: testResult.error?.slice(0, 1000),
        };

        // CRITICAL: Only approve if test passed — NEVER mark failed tests as approved
        if (testResult.success) {
          updateSkillStatus(skill.id, 'approved', testEntry);
          return `✅ Skill "${skill.name}" Test BESTANDEN — Status: approved.\nOutput: ${testResult.output.slice(0, 500)}`;
        } else {
          updateSkillStatus(skill.id, 'failed', testEntry);
          return `❌ Skill "${skill.name}" Test FEHLGESCHLAGEN — Status: failed.\nFehler: ${testResult.error?.slice(0, 500) || testResult.output.slice(0, 500)}\n\nDer Skill wurde NICHT als approved markiert. Fixe den Code und teste erneut.`;
        }
      }

      case 'list': {
        const skills = getAllSkills();
        if (skills.length === 0) return '📋 Keine Skills vorhanden. Erstelle einen mit action: create.';
        const lines = skills.map(s => {
          const icon = s.status === 'approved' ? '✅' : s.status === 'failed' ? '❌' : '⏳';
          return `${icon} ${s.name} (${s.status}) — ${s.description}`;
        });
        return `📋 Skills (${skills.length}):\n${lines.join('\n')}`;
      }

      case 'execute': {
        if (!skillName) return '⚠️ skill_name wird für execute benötigt.';
        const skill = findSkillByName(skillName);
        if (!skill) return `❌ Skill "${skillName}" nicht gefunden.`;

        // Only execute approved skills
        if (skill.status !== 'approved') {
          return `⚠️ Skill "${skill.name}" ist nicht approved (Status: ${skill.status}). Nur approved Skills können ausgeführt werden. Teste zuerst mit action: test.`;
        }

        const args = executeArgs ? executeArgs.split(',').map(a => a.trim()) : [];
        logger.info(`Skills: executing "${skill.name}" with args: [${args.join(', ')}]`);
        const result = await executeSkillScript(skill.scriptPath, args);

        if (result.success) {
          return `✅ Skill "${skill.name}" ausgeführt (${result.durationMs}ms):\n${result.output.slice(0, 2000)}`;
        } else {
          return `❌ Skill "${skill.name}" Ausführung fehlgeschlagen (${result.durationMs}ms):\n${result.error?.slice(0, 1000) || result.output.slice(0, 1000)}`;
        }
      }

      default:
        return `⚠️ Unbekannte action: "${action}". Verfügbar: check, create, test, list, execute.`;
    }
  }

  // ── Task Queue (for indirect skill requests) ─────────────────────────────

  private taskQueue: Array<{ task: string; requiredSkill: string; status: 'pending' | 'ready' | 'done' }> = [];

  queueTask(task: string, requiredSkill: string): void {
    this.taskQueue.push({ task, requiredSkill, status: 'pending' });
    logger.info(`Skills: queued task "${task}" (requires: ${requiredSkill})`);
  }

  getReadyTasks(): Array<{ task: string; requiredSkill: string }> {
    const approved = new Set(getApprovedSkills().map(s => s.id));
    return this.taskQueue
      .filter(t => t.status === 'pending' && approved.has(createSkillId(t.requiredSkill)))
      .map(t => { t.status = 'ready'; return { task: t.task, requiredSkill: t.requiredSkill }; });
  }

  // ── Delegated Task Tracking ──────────────────────────────────────────────

  /** Broadcast current task list to the mobile client */
  private broadcastTasks(): void {
    this.onTaskUpdate?.(this.delegatedTasks);
  }

  addDelegatedTask(description: string, sessionId: string, pendingPrompt?: string, steps?: string[]): DelegatedTask {
    const task: DelegatedTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      description,
      sessionId,
      sessionLabel: this.sessionLabels.get(sessionId) || (sessionId ? sessionId.slice(0, 8) : description),
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pendingPrompt,
      steps: (steps ?? [description]).map(s => ({ label: s, status: 'pending' as TaskStatus })),
    };
    // Mark first step as running
    if (task.steps.length > 0) task.steps[0].status = 'running';
    this.delegatedTasks.push(task);
    logger.info(`Manager: delegated task "${description}" to ${task.sessionLabel}`);
    this.broadcastTasks();
    return task;
  }

  getDelegatedTasks(): DelegatedTask[] {
    return this.delegatedTasks;
  }

  getActiveTasks(): DelegatedTask[] {
    return this.delegatedTasks.filter(t => t.status === 'running' || t.status === 'pending' || t.status === 'waiting');
  }

  private updateTaskStatus(taskId: string, status: TaskStatus): void {
    const task = this.delegatedTasks.find(t => t.id === taskId);
    if (task) {
      task.status = status;
      task.updatedAt = Date.now();
      this.broadcastTasks();
    }
  }

  private static readonly TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours max per task
  private stableOutputCounts = new Map<string, number>(); // track consecutive unchanged outputs

  /** Heartbeat: check delegated tasks. If a terminal has new output
   *  indicating Claude finished, auto-trigger the manager to review. */
  private async heartbeat(): Promise<void> {
    const activeTasks = this.getActiveTasks();
    if (activeTasks.length === 0) return;
    if (this.isProcessing) {
      logger.info(`Manager: heartbeat skipped — already processing (${activeTasks.length} active tasks)`);
      return;
    }
    logger.info(`Manager: heartbeat — checking ${activeTasks.length} active task(s)`);

    for (const task of activeTasks) {
      // Skip tasks without a terminal (standalone chat tasks)
      if (!task.sessionId) continue;

      // ── Stuck task timeout ─────────────────────────────────────────
      const taskAge = Date.now() - task.updatedAt;
      if (taskAge > ManagerService.TASK_TIMEOUT_MS) {
        logger.warn(`Manager: task "${task.sessionLabel}" timed out after ${Math.round(taskAge / 60000)}min`);
        this.updateTaskStatus(task.id, 'failed');
        this.onError?.(`Aufgabe "${task.sessionLabel}" nach ${Math.round(taskAge / 60000)} Minuten abgebrochen (Timeout).`);
        continue;
      }

      const buffer = this.outputBuffers.get(task.sessionId);
      if (!buffer || !buffer.data || buffer.data.length === 0) continue;

      const currentOutput = buffer.data.replace(ANSI_STRIP, '').slice(-2000);

      // Don't check in the first 15 seconds (give Claude time to start)
      const age = Date.now() - task.createdAt;
      if (age < 15_000) continue;

      // ── False-positive protection: require 2 consecutive stable reads ──
      if (currentOutput === task.lastCheckedOutput) {
        const stableCount = (this.stableOutputCounts.get(task.id) ?? 0) + 1;
        this.stableOutputCounts.set(task.id, stableCount);
        // Only proceed if output has been stable for 2+ cycles (30s)
        if (stableCount < 2) continue;
      } else {
        // Output changed — reset stability counter
        task.lastCheckedOutput = currentOutput;
        this.stableOutputCounts.set(task.id, 0);
        continue; // Wait for next cycle to confirm stability
      }

      // ── Claude readiness detection (expanded patterns) ─────────────
      const lastChunk = currentOutput.slice(-1000);
      const isClaudeReady =
        /for\s*shortcuts/i.test(lastChunk) ||
        /shells?\s*.*\s*esc/i.test(lastChunk) ||
        /waiting\s*for\s*input/i.test(lastChunk) ||
        /claude\s*code/i.test(lastChunk.slice(-200)) && />\s*$/.test(lastChunk.slice(-40));
      const isShellPrompt = /[$%>#❯→]\s*$/.test(lastChunk.slice(-80));
      const isComplete = isClaudeReady || isShellPrompt;

      logger.info(`Manager: heartbeat task "${task.sessionLabel}" — age=${Math.round(age / 1000)}s, stable=${this.stableOutputCounts.get(task.id)}, isClaudeReady=${isClaudeReady}, isShellPrompt=${isShellPrompt}`);

      if (!isComplete) continue;

      // Reset stability counter after processing
      this.stableOutputCounts.delete(task.id);

      // Case 1: Claude just started and is ready for a prompt
      if (task.pendingPrompt && isClaudeReady) {
        logger.info(`Manager: heartbeat — Claude ready in "${task.sessionLabel}", sending pending prompt`);
        globalManager.write(task.sessionId, task.pendingPrompt);
        setTimeout(() => globalManager.write(task.sessionId, '\r'), 200);
        task.pendingPrompt = undefined;
        task.lastCheckedOutput = undefined;
        task.updatedAt = Date.now();
        task.createdAt = Date.now(); // Reset age timer
        this.broadcastTasks();
        // Advance task step if available
        this.advanceTaskStep(task);
        break;
      }

      // Case 2: No pending prompt AND Claude is idle → review + continue workflow
      if (task.status === 'running' && !task.pendingPrompt) {
        logger.info(`Manager: heartbeat detected idle in "${task.sessionLabel}" — waking manager for review`);
        task.status = 'waiting';
        task.updatedAt = Date.now();
        this.broadcastTasks();

        const outputBefore = this.outputBuffers.get(task.sessionId)?.data?.length ?? 0;

        // Build heartbeat prompt with workflow context
        const pendingSteps = task.steps.filter(s => s.status === 'pending' || s.status === 'running');
        const doneSteps = task.steps.filter(s => s.status === 'done');
        const workflowCtx = task.steps.length > 0
          ? `\n\nWorkflow-Status für "${task.description}":\n- Erledigt: ${doneSteps.map(s => s.label).join(', ') || 'keine'}\n- Ausstehend: ${pendingSteps.map(s => s.label).join(', ') || 'keine'}\nWenn ausstehende Schritte vorhanden sind, arbeite den nächsten ab. Markiere erledigte Schritte mit update_task(complete_step).`
          : '';

        try {
          await this.handleChat(
            `[HEARTBEAT] Terminal "${task.sessionLabel}" ist idle. Prüfe den Output: Was hat Claude geliefert? Gibt es Folgeaufgaben?${workflowCtx}\n\nWenn alles erledigt ist, sage "Alle Aufgaben abgeschlossen".`,
          );

          const outputAfter = this.outputBuffers.get(task.sessionId)?.data?.length ?? 0;
          if (outputAfter !== outputBefore) {
            logger.info(`Manager: review sent new commands to "${task.sessionLabel}" — keeping task alive`);
            task.status = 'running';
            task.createdAt = Date.now();
            task.lastCheckedOutput = undefined;
            this.broadcastTasks();
          } else {
            this.updateTaskStatus(task.id, 'done');
            logger.info(`Manager: task "${task.sessionLabel}" completed — no follow-up actions`);
          }
        } catch (err) {
          logger.warn(`Manager: heartbeat review failed — ${err instanceof Error ? err.message : err}`);
          task.status = 'running';
          this.broadcastTasks();
        }
        break;
      }
    }
  }

  /** Advance the next pending step in a task workflow */
  private advanceTaskStep(task: DelegatedTask): void {
    const runningStep = task.steps.find(s => s.status === 'running');
    if (runningStep) {
      runningStep.status = 'done';
    }
    const nextStep = task.steps.find(s => s.status === 'pending');
    if (nextStep) {
      nextStep.status = 'running';
      task.description = nextStep.label;
    }
    if (task.steps.length > 0 && task.steps.every(s => s.status === 'done')) {
      task.status = 'done';
    }
    task.updatedAt = Date.now();
    this.broadcastTasks();
  }

  // ── Cron Job Execution ────────────────────────────────────────────────────

  private async executeCronJob(job: CronJob): Promise<void> {
    if (job.type === 'simple') {
      const dir = job.targetDir ? job.targetDir.replace('~', os.homedir()) : os.homedir();
      const sessionId = this.onCreateTerminal?.(`Cron: ${job.name}`);
      if (sessionId) {
        setTimeout(() => {
          const globalMgr = (global as any).__terminalManager;
          if (globalMgr) globalMgr.write(sessionId, `cd ${dir} && ${job.command}\r`);
        }, 800);
        setTimeout(() => {
          this.handleChat(`[CRON-ERGEBNIS] Der Cron Job "${job.name}" wurde ausgeführt. Prüfe den Terminal-Output und berichte kurz.`).catch(err =>
            logger.warn(`CronManager: review failed — ${err}`)
          );
        }, 8000);
      }
    } else {
      const dir = job.targetDir ? job.targetDir.replace('~', os.homedir()) : `${os.homedir()}/Desktop/TMS Terminal`;
      const sessionId = this.onCreateTerminal?.(`Cron: ${job.name}`);
      if (sessionId) {
        const globalMgr = (global as any).__terminalManager;
        if (globalMgr) {
          setTimeout(() => globalMgr.write(sessionId, `cd ${dir} && claude\r`), 800);
        }
        this.addDelegatedTask(job.command, sessionId, `Cron: ${job.name}`);
      }
    }
  }

  // ── Provider Management ───────────────────────────────────────────────────

  getProviders() {
    return {
      providers: this.registry.list(),
      active: this.registry.getActiveId(),
    };
  }

  setProvider(id: string): void {
    this.registry.setActive(id);
  }

  updateProviderConfig(updates: Partial<ProviderConfig>): void {
    this.registry.updateConfig(updates);
  }

  /** Get active sessions with labels for the client. */
  getSessionList(): Array<{ sessionId: string; label: string }> {
    return [...this.sessionLabels.entries()].map(([id, label]) => ({ sessionId: id, label }));
  }
}
