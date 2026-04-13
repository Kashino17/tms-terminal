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
      description: 'Sendet Text an ein Terminal. WICHTIG: Prüfe vorher ob Claude in dem Terminal läuft (Tool-Status in der Terminal-Übersicht)! In Claude-Sessions: Sende Aufträge/Fragen als natürlichen Text (z.B. "Analysiere die Sicherheitslücken"). In Shell-Sessions (kein AI-Tool aktiv): Sende Shell-Befehle (z.B. "git status"). NIEMALS Shell-Befehle wie "cd", "git", "npm" an ein Terminal mit laufender Claude-Session senden — Claude versteht diese als Textprompt, nicht als Befehl.',
      parameters: {
        type: 'object',
        properties: {
          session_label: { type: 'string', description: 'Terminal-Name oder Shell-Nummer, z.B. "Shell 1", "ayysir", "TMS Terminal"' },
          command: { type: 'string', description: 'Shell-Befehl (für Shell-Sessions) ODER Auftrag/Frage (für Claude-Sessions)' },
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
      description: 'Erstellt ein neues Shell-Terminal und führt optional sofort einen Befehl darin aus. Nutze dies wenn der User ein neues Terminal braucht, z.B. "Öffne ein Terminal im Desktop Ordner" → create_terminal mit initial_command="cd ~/Desktop". Wenn du Claude startest (initial_command enthält "claude"), nutze pending_prompt um den Auftrag zu definieren, der an Claude gesendet wird sobald er bereit ist.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Optionaler Name für das neue Terminal, z.B. "Build", "Desktop". Wenn leer, wird automatisch "Shell N" vergeben.' },
          initial_command: { type: 'string', description: 'Optionaler Befehl der sofort nach dem Erstellen ausgeführt wird, z.B. "cd ~/Desktop", "cd ~/Projects && git status". Mehrere Befehle mit && verketten.' },
          pending_prompt: { type: 'string', description: 'Optionaler Auftrag der automatisch an Claude gesendet wird sobald er bereit ist. NUR nutzen wenn initial_command Claude startet. Beispiel: "Analysiere das Projekt und finde Schwächen"' },
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

## Wer du bist
Du bist der Terminal-Manager — ein Koordinator, der Aufgaben an Claude Code delegiert.

## So arbeitest du

Wenn der User eine Aufgabe hat:
1. Erstelle die nötigen Terminals: create_terminal(label, initial_command="cd /pfad && claude", pending_prompt="Dein Auftrag an Claude")
2. Erstelle ALLE Terminals auf einmal — nicht eins nach dem anderen warten
3. Das System sendet den pending_prompt automatisch an Claude wenn er bereit ist
4. Das System überwacht den Fortschritt automatisch (Heartbeat alle 15s)
5. Wenn Claude fertig ist, wirst du geweckt und bekommst die Ergebnisse

Optional kannst du mit update_task(set_steps) einen Plan im UI anzeigen. Das System trackt den Fortschritt dann automatisch — du musst Schritte NICHT manuell abhaken.

Beispiel — User will 3 Projekte analysieren:
→ create_terminal("TMS Shops", initial_command="cd ~/Desktop/'TMS Shops' && claude", pending_prompt="Analysiere das Projekt: Finde Bugs, Schwächen, Sicherheitslücken")
→ create_terminal("TMS Terminal", initial_command="cd ~/Desktop/'TMS Terminal' && claude", pending_prompt="Analysiere das Projekt: Finde Bugs, Schwächen, Sicherheitslücken")
→ create_terminal("TMS Banking", initial_command="cd ~/Desktop/'TMS Banking' && claude", pending_prompt="Analysiere das Projekt: Finde Bugs, Schwächen, Sicherheitslücken")
→ "Alle 3 Analysen gestartet! Ich melde mich wenn die Ergebnisse da sind."

NICHT write_to_terminal direkt nach create_terminal — Claude braucht Zeit zum Starten. Der pending_prompt wird automatisch gesendet.

## Terminal-Typen — WICHTIG

Es gibt zwei Arten von Terminals:

1. 💻 SHELL — normales Terminal ohne AI. Hier kannst du Shell-Befehle senden: git status, npm run build, ls, cd etc.

2. 🤖 CLAUDE SESSION — Terminal in dem Claude Code läuft. Hier sendest du AUFTRÄGE als natürlichen Text: "Analysiere die Sicherheitslücken", "Finde alle TODO-Kommentare", "Erkläre mir die Auth-Logik".

NIEMALS Shell-Befehle (cd, git, npm, ls, cat, grep...) an ein Claude-Terminal senden! Claude interpretiert das als Textprompt, nicht als Befehl. Wenn du einen Shell-Befehl ausführen willst, nutze ein Shell-Terminal oder erstelle ein neues mit create_terminal OHNE "claude" im initial_command.

Die Terminal-Übersicht zeigt dir bei jedem Terminal ob es eine Shell oder Claude Session ist.

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

## Aufgaben-Tracking (optional)

Mit update_task(set_steps) kannst du einen Plan im UI anzeigen. Das System hakt Schritte automatisch ab wenn du die passenden Tools aufrufst. Du musst complete_step NICHT manuell aufrufen — das System erkennt automatisch wenn ein Schritt erledigt ist.

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
  private chatQueue: Array<{ text: string; targetSessionId?: string; onboarding?: boolean }> = [];
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
    logger.info('Manager: started (heartbeat every 15s)');
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
      const sessionType = ctx.tool ? `🤖 CLAUDE SESSION (${ctx.tool})` : '💻 SHELL';
      block += `### ${emoji} ${ctx.label} — ${sessionType} — ${statusLabel}${staleNote}\n`;
      if (ctx.tool) block += `⚠️ Dies ist eine AI-Session — sende Aufträge als Text, KEINE Shell-Befehle!\n`;
      if (ctx.cwd) block += `📁 ${ctx.cwd}\n`;
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

      // Only clear buffers for sessions WITHOUT active delegated tasks
      const activeTaskSessionIds = new Set(
        this.getActiveTasks().map(t => t.sessionId).filter(Boolean),
      );
      for (const s of activeContexts) {
        this.lastSummaryAt.set(s.sessionId, now);
        if (!activeTaskSessionIds.has(s.sessionId)) {
          this.outputBuffers.set(s.sessionId, { data: '', lastUpdated: Date.now() });
        }
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
        // Pack label, initial_command and pending_prompt into detail as JSON
        const createInfo = JSON.stringify({
          label: tc.arguments.label ?? '',
          initialCommand: tc.arguments.initial_command ?? '',
          pendingPrompt: tc.arguments.pending_prompt ?? '',
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

  async handleChat(text: string, targetSessionId?: string, onboarding?: boolean): Promise<boolean> {
    if (!this.enabled) {
      throw new Error('Manager ist nicht aktiv — bitte zuerst aktivieren (grüner Punkt)');
    }

    // Queue messages while processing — don't block or error
    if (this.isProcessing) {
      this.chatQueue.push({ text, targetSessionId, onboarding });
      logger.info(`Manager: queued chat message (${this.chatQueue.length} in queue)`);
      return false;
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
        const MAX_TOOL_ROUNDS = 10;
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

          // Auto-correlate successful tool executions with task steps.
          // Compensates for Gemma 4 saying "Ich hake ab ✅" in text instead
          // of actually calling update_task(complete_step).
          if (executedActions.length > 0) {
            this.autoCompleteStepsFromToolExecution(executedActions);
          }

          // NOTE: We no longer break the tool loop on terminal delegation.
          // The old code killed the loop after the first create_terminal, which
          // prevented the AI from creating multiple terminals or doing follow-up
          // work in the same turn. This was the ROOT CAUSE of multi-step workflow
          // failures with both GLM and Gemma 4.
          //
          // The tool loop continues naturally (up to MAX_TOOL_ROUNDS).
          // The pending_prompt mechanism handles delayed writes to Claude.
          // The AI is already instructed not to spam write_to_terminal after
          // create_terminal (via system prompt).

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

      // Parse AI text for step-completion signals that weren't tool calls.
      // Gemma 4 often writes "Ich hake den Schritt X ab ✅" instead of calling
      // update_task(complete_step). Detect this and auto-complete the step.
      this.autoCompleteStepsFromText(cleanReply);

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
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Manager: chat failed — ${msg}`);
      this.onError?.(`Fehler: ${msg}`);
      return true; // Did attempt work, even if it failed
    } finally {
      this.isProcessing = false;
      // Drain chat queue — process next queued message
      if (this.chatQueue.length > 0) {
        const next = this.chatQueue.shift()!;
        logger.info(`Manager: processing queued chat (${this.chatQueue.length} remaining)`);
        setTimeout(() => this.handleChat(next.text, next.targetSessionId, next.onboarding).catch(err =>
          logger.warn(`Manager: queued chat failed — ${err}`)
        ), 300);
      }
      // Drain review queue after processing completes (prevents 15s delay)
      else if (this.reviewQueue.length > 0) {
        setTimeout(() => this.processReviewQueue(), 500);
      }
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
        // Wait for Enter key to be sent before returning
        await new Promise<void>(resolve => setTimeout(() => {
          globalManager.write(action.sessionId, '\r');
          resolve();
        }, 200));
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
        const validKeys: string[] = [];
        for (const key of keys) {
          const seq = KEY_MAP[key];
          if (!seq) {
            logger.warn(`Manager: unknown key "${key}", skipping`);
            continue;
          }
          validKeys.push(seq);
        }
        // Send keys sequentially with delays, wait for all to complete
        if (validKeys.length > 0) {
          await new Promise<void>(resolve => {
            validKeys.forEach((seq, i) => {
              setTimeout(() => {
                globalManager.write(action.sessionId, seq);
                if (i === validKeys.length - 1) resolve();
              }, i * 100);
            });
          });
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
        const list = [...this.sessionLabels.entries()].map(([id, lbl]) => {
          const buf = this.outputBuffers.get(id);
          const analysis = buf?.data ? analyzeTerminalOutput(buf.data) : { tool: undefined, status: 'idle' as const };
          const type = analysis.tool ? `🤖 ${analysis.tool}` : '💻 Shell';
          const status = STATUS_LABEL[analysis.status] ?? 'Unbekannt';
          return `${lbl} — ${type} (${status})`;
        });
        logger.info(`Manager: list_terminals — ${list.length} sessions`);
        return { text: list.length > 0
          ? `Aktive Terminals (${list.length}):\n${list.map((l, i) => `${i + 1}. ${l}`).join('\n')}`
          : 'Keine Terminals offen.' };
      }
      case 'create_terminal': {
        let label: string | undefined;
        let initialCommand: string | undefined;
        let pendingPrompt: string | undefined;
        try {
          const info = JSON.parse(action.detail);
          label = info.label || undefined;
          initialCommand = info.initialCommand || undefined;
          pendingPrompt = info.pendingPrompt || undefined;
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
              // Attach to existing chat task (from update_task) — strict matching
              const labelLower = (label ?? '').toLowerCase().trim();
              const labelWords = new Set(labelLower.split(/\s+/).filter(w => w.length > 1));
              let existingTask: DelegatedTask | undefined;
              if (labelLower) {
                // 1st: exact match on description
                existingTask = this.getActiveTasks().find(t =>
                  !t.sessionId && t.description.toLowerCase().trim() === labelLower
                );
                // 2nd: description contains full label (e.g., "TMS Shops" in "TMS Shops Analyse")
                if (!existingTask) {
                  existingTask = this.getActiveTasks().find(t =>
                    !t.sessionId && t.description.toLowerCase().includes(labelLower)
                  );
                }
                // 3rd: word-overlap ≥60% (strict to prevent cross-matching)
                if (!existingTask) {
                  let bestScore = 0;
                  for (const t of this.getActiveTasks()) {
                    if (t.sessionId) continue;
                    const descWords = new Set(t.description.toLowerCase().split(/\s+/).filter(w => w.length > 1));
                    let overlap = 0;
                    for (const w of labelWords) { if (descWords.has(w)) overlap++; }
                    const score = overlap / Math.max(labelWords.size, descWords.size);
                    if (score > bestScore && score >= 0.6) {
                      bestScore = score;
                      existingTask = t;
                    }
                  }
                }
              }
              // Last resort: first unattached task (only if no label provided)
              if (!existingTask && !labelLower) {
                existingTask = this.getActiveTasks().find(t => !t.sessionId);
              }
              if (existingTask) {
                existingTask.sessionId = newSessionId;
                existingTask.sessionLabel = this.sessionLabels.get(newSessionId) ?? newSessionId.slice(0, 8);
                existingTask.updatedAt = Date.now();
                // Use explicit pendingPrompt from tool call (NOT step labels)
                if (pendingPrompt) {
                  existingTask.pendingPrompt = pendingPrompt;
                  logger.info(`Manager: set explicit pendingPrompt for "${existingTask.description}" → "${pendingPrompt.slice(0, 60)}…"`);
                }
                this.broadcastTasks();
              } else if (pendingPrompt) {
                // Explicit pending prompt → create task so heartbeat delivers it when ready
                this.addDelegatedTask(label || initialCommand, newSessionId, pendingPrompt);
              } else if (/claude/i.test(initialCommand || '')) {
                // Claude is starting without explicit pending_prompt — create a monitoring task
                // with NO steps so the heartbeat tracks this terminal for prompt delivery.
                // Empty steps = heartbeat will mark it done when Claude is idle (no review loop).
                const monitorTask = this.addDelegatedTask(label || 'Claude Session', newSessionId, undefined, []);
                monitorTask.steps = []; // Ensure no steps — heartbeat marks done on idle
                logger.info(`Manager: created monitoring task for Claude session "${label}" (no steps, no pending_prompt)`);
              } else {
                logger.info(`Manager: no matching task for "${label}" — skipping delegated task`);
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

          // Find task by name — exact match first, then strict word-overlap
          let task: DelegatedTask | undefined;
          if (taskName) {
            const activeTasks = this.getActiveTasks();
            const nameLower = taskName.toLowerCase().trim();

            // 1st pass: exact description match
            task = activeTasks.find(t => t.description.toLowerCase().trim() === nameLower);

            // 2nd pass: description contains full query OR query contains full description
            if (!task) {
              task = activeTasks.find(t => {
                const desc = t.description.toLowerCase().trim();
                return desc === nameLower || desc.includes(nameLower) || nameLower.includes(desc);
              });
            }

            // 3rd pass: word-overlap scoring (strict: ≥60% to prevent cross-matching)
            if (!task) {
              const queryWords = new Set(nameLower.split(/\s+/).filter(w => w.length > 2));
              let bestScore = 0;
              for (const t of activeTasks) {
                const descWords = new Set(t.description.toLowerCase().split(/\s+/).filter(w => w.length > 2));
                let overlap = 0;
                for (const w of queryWords) { if (descWords.has(w)) overlap++; }
                const score = overlap / Math.max(queryWords.size, descWords.size);
                if (score > bestScore && score >= 0.6) { // 60% — prevents "TMS Terminal" matching "TMS Shops"
                  bestScore = score;
                  task = t;
                }
              }
            }

            if (!task) {
              logger.warn(`Manager: no task matched "${taskName}" — ${activeTasks.length} active tasks`);
            }
          }
          // Only fall back to first active task for set_steps (creating), not for updates
          if (!task && info.action === 'set_steps') {
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
            if (isNaN(idx) || idx < 0 || idx >= task.steps.length) {
              return { text: `Fehler: step_index ${info.stepIndex} ungültig (Task "${task.description}" hat ${task.steps.length} Schritte, Index 0-${task.steps.length - 1}). Verfügbare Schritte: ${task.steps.map((s, i) => `${i}: "${s.label}" (${s.status})`).join(', ')}` };
            }
            task.steps[idx].status = 'done';
            const nextPending = task.steps.find(s => s.status === 'pending');
            if (nextPending && !task.steps.some(s => s.status === 'running')) {
              nextPending.status = 'running';
            }
            if (task.steps.every(s => s.status === 'done')) {
              task.status = 'done';
            }
            task.updatedAt = Date.now();
            this.broadcastTasks();
            return { text: `[${task.description}] Schritt "${task.steps[idx].label}" abgehakt.` };
          }
          if (info.action === 'fail_step') {
            const idx = parseInt(info.stepIndex, 10);
            if (isNaN(idx) || idx < 0 || idx >= task.steps.length) {
              return { text: `Fehler: step_index ${info.stepIndex} ungültig (Task hat ${task.steps.length} Schritte).` };
            }
            task.steps[idx].status = 'failed';
            task.updatedAt = Date.now();
            this.broadcastTasks();
            return { text: `[${task.description}] Schritt "${task.steps[idx].label}" fehlgeschlagen.` };
          }
          return { text: `Unbekannte update_task Aktion: "${info.action}". Erlaubt: set_steps, complete_step, fail_step.` };
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

  private static readonly TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes max per task
  private stableOutputCounts = new Map<string, number>(); // track consecutive unchanged outputs
  private reviewQueue: string[] = []; // task IDs waiting for AI review
  private reviewInFlight = new Set<string>(); // task IDs currently being reviewed (prevents duplicates)

  /** Heartbeat: check ALL delegated tasks every cycle.
   *  Phase 1: Timeout checks (always runs, even during isProcessing)
   *  Phase 2: Stability detection + pending prompt delivery (lightweight, no AI)
   *  Phase 3: Queue idle tasks for AI review
   *  Phase 4: Kick off review processing (one at a time, chained) */
  private static readonly TASK_CLEANUP_AGE_MS = 5 * 60 * 1000; // 5 minutes

  private async heartbeat(): Promise<void> {
    // ── Phase 0: Cleanup completed/failed tasks older than 5 minutes ──
    const now = Date.now();
    const beforeCount = this.delegatedTasks.length;
    this.delegatedTasks = this.delegatedTasks.filter(t => {
      if ((t.status === 'done' || t.status === 'failed') && (now - t.updatedAt) > ManagerService.TASK_CLEANUP_AGE_MS) {
        this.stableOutputCounts.delete(t.id);
        return false; // remove
      }
      return true;
    });
    if (this.delegatedTasks.length < beforeCount) {
      logger.info(`Manager: cleaned up ${beforeCount - this.delegatedTasks.length} finished tasks (${this.delegatedTasks.length} remaining)`);
      this.broadcastTasks();
    }

    const activeTasks = this.getActiveTasks();
    if (activeTasks.length === 0) return;

    let actionsTaken = 0; // Only log when something happens (#7)

    for (const task of activeTasks) {
      // Skip tasks without a terminal (standalone chat tasks)
      if (!task.sessionId) continue;

      // ── Phase 1: Stuck task timeout (always runs) ──────────────────
      const taskAge = Date.now() - task.updatedAt;
      if (taskAge > ManagerService.TASK_TIMEOUT_MS) {
        logger.warn(`Manager: task "${task.sessionLabel}" timed out after ${Math.round(taskAge / 60000)}min`);
        this.updateTaskStatus(task.id, 'failed');
        this.onError?.(`Aufgabe "${task.sessionLabel}" nach ${Math.round(taskAge / 60000)} Minuten abgebrochen (Timeout).`);
        actionsTaken++;
        continue;
      }

      // ── Phase 1b: Session liveness check ─────────────────────────
      if (!globalManager.getSession(task.sessionId)) {
        logger.warn(`Manager: task "${task.sessionLabel}" — terminal session dead, marking failed`);
        this.updateTaskStatus(task.id, 'failed');
        this.onError?.(`Terminal "${task.sessionLabel}" existiert nicht mehr — Aufgabe abgebrochen.`);
        actionsTaken++;
        continue;
      }

      // ── Phase 1c: Auto-complete if ALL steps are done ────────────
      if (task.steps.length > 0 && task.steps.every(s => s.status === 'done')) {
        logger.info(`Manager: auto-completing "${task.sessionLabel}" — all ${task.steps.length} steps done`);
        this.updateTaskStatus(task.id, 'done');
        actionsTaken++;
        continue;
      }

      // ── Phase 2: Output stability check ────────────────────────────
      const buffer = this.outputBuffers.get(task.sessionId);
      if (!buffer || !buffer.data || buffer.data.length === 0) continue; // No output yet, wait silently

      const currentOutput = buffer.data.replace(ANSI_STRIP, '').slice(-2000);

      // Grace period: 10s after task creation (Claude boots in ~5s)
      const age = Date.now() - task.createdAt;
      if (age < 10_000) continue;

      // ── Claude readiness detection ─────────────────────────────────
      const lastChunk = currentOutput.slice(-1000);
      const isClaudeReady =
        /for\s*shortcuts/i.test(lastChunk) ||
        /shells?\s*.*\s*esc/i.test(lastChunk) ||
        /waiting\s*for\s*input/i.test(lastChunk) ||
        (/claude\s*code/i.test(lastChunk.slice(-200)) && /[>❯›]\s*$/.test(lastChunk.slice(-40)));
      const isShellPrompt = /[$%>#❯→›]\s*$/.test(lastChunk.slice(-80));
      const isComplete = isClaudeReady || isShellPrompt;

      // ── Stability check: adaptive based on what we detect ──────────
      // If Claude is clearly ready ("for shortcuts"), only 1 stable cycle needed (15s).
      // For ambiguous shell prompts, require 2 stable cycles (30s) to avoid false positives.
      const requiredStableCycles = isClaudeReady ? 1 : 2;

      if (currentOutput === task.lastCheckedOutput) {
        const stableCount = (this.stableOutputCounts.get(task.id) ?? 0) + 1;
        this.stableOutputCounts.set(task.id, stableCount);
        if (stableCount < requiredStableCycles) continue;
      } else {
        task.lastCheckedOutput = currentOutput;
        task.updatedAt = Date.now();
        this.stableOutputCounts.set(task.id, 0);
        continue;
      }

      if (!isComplete) continue;

      // Reset stability counter after processing
      this.stableOutputCounts.delete(task.id);

      // ── Phase 3a: Send pending prompt when terminal is ready ───────
      // Send on BOTH isClaudeReady AND isShellPrompt with Claude detection.
      // Claude's prompt may appear as ❯ or > which matches isShellPrompt.
      const hasClaudeProcess = /claude/i.test(currentOutput.slice(-3000));
      if (task.pendingPrompt && (isClaudeReady || (isShellPrompt && hasClaudeProcess))) {
        logger.info(`Manager: heartbeat — terminal ready in "${task.sessionLabel}", sending pending prompt`);
        globalManager.write(task.sessionId, task.pendingPrompt);
        setTimeout(() => globalManager.write(task.sessionId, '\r'), 200);
        task.pendingPrompt = undefined;
        task.lastCheckedOutput = undefined;
        task.updatedAt = Date.now();
        // Don't reset createdAt — that would re-trigger the 10s grace period.
        // The task age is only used for the initial boot grace, not for subsequent checks.
        this.broadcastTasks();
        actionsTaken++;
        continue;
      }

      // ── Phase 3b: Auto-complete monitoring tasks (0 steps, no prompt) ──
      // These are lightweight tracking tasks — mark done when idle, don't wake AI.
      if (task.steps.length === 0 && !task.pendingPrompt && isComplete) {
        logger.info(`Manager: monitoring task "${task.sessionLabel}" idle — marking done (no steps to review)`);
        this.updateTaskStatus(task.id, 'done');
        actionsTaken++;
        continue;
      }

      // ── Phase 3c: Queue for AI review ──────────────────────────────
      if (task.status === 'running' && !task.pendingPrompt) {
        const alreadyQueued = this.reviewQueue.includes(task.id);
        const isInFlight = this.reviewInFlight.has(task.id);
        const hasWork = task.steps.some(s => s.status !== 'done');
        if (!alreadyQueued && !isInFlight && hasWork) {
          logger.info(`Manager: heartbeat — queuing "${task.sessionLabel}" for review`);
          this.reviewQueue.push(task.id);
          actionsTaken++;
        }
      }
    }

    // Only log when something happened (#7 — reduce log noise)
    if (actionsTaken > 0) {
      logger.info(`Manager: heartbeat cycle — ${actionsTaken} action(s) on ${activeTasks.length} task(s)`);
    }

    // ── Phase 4: Kick off review processing (if not already busy) ──
    this.processReviewQueue();
  }

  /** Process queued task reviews one at a time, chaining the next review
   *  after each completion to ensure all tasks get attention. */
  private async processReviewQueue(): Promise<void> {
    if (this.isProcessing) return;
    if (this.reviewQueue.length === 0) return;

    // Find next valid task to review (skip completed/failed tasks)
    let task: DelegatedTask | undefined;
    while (this.reviewQueue.length > 0 && !task) {
      const taskId = this.reviewQueue.shift()!;
      const candidate = this.delegatedTasks.find(t => t.id === taskId);
      if (candidate && (candidate.status === 'running' || candidate.status === 'waiting')) {
        task = candidate;
      }
    }
    if (!task) return;

    logger.info(`Manager: reviewing "${task.sessionLabel}" (${this.reviewQueue.length} more in queue)`);
    this.reviewInFlight.add(task.id);

    try {
    // ── Smart heartbeat: analyze state BEFORE waking the AI ────────
    // Check if there's actually something actionable to do
    const pendingSteps = task.steps.filter(s => s.status === 'pending' || s.status === 'running');
    const doneSteps = task.steps.filter(s => s.status === 'done');
    const currentStep = task.steps.find(s => s.status === 'running');

    // If all steps done → just mark complete, don't wake AI
    if (task.steps.length > 0 && pendingSteps.length === 0) {
      logger.info(`Manager: smart heartbeat — all steps done for "${task.sessionLabel}", auto-completing without AI call`);
      this.updateTaskStatus(task.id, 'done');
      if (this.reviewQueue.length > 0) {
        setTimeout(() => this.processReviewQueue(), 500);
      }
      return;
    }

    // Analyze terminal output to give AI specific context
    const buffer = this.outputBuffers.get(task.sessionId);
    const recentOutput = buffer?.data?.replace(ANSI_STRIP, '').slice(-1500) ?? '';
    const lastChunk = recentOutput.slice(-500);

    // Detect what happened in the terminal — use same patterns as heartbeat
    const claudeFinished =
      /for\s*shortcuts/i.test(lastChunk) ||
      /shells?\s*.*\s*esc/i.test(lastChunk) ||
      /waiting\s*for\s*input/i.test(lastChunk) ||
      (/claude\s*code/i.test(lastChunk.slice(-200)) && /[>❯›]\s*$/.test(lastChunk.slice(-40)));
    const hasError = /error|Error|ERR!|FAIL|failed/i.test(lastChunk.slice(-300));
    // Only detect "working" at the VERY end of output (last 50 chars) to avoid
    // matching past-tense text like "I finished working on it"
    const tail50 = lastChunk.slice(-50).toLowerCase();
    const claudeWorking = /\b(thinking|reading|writing|searching|analyzing)\b/.test(tail50)
      || /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(tail50)  // spinner chars
      || /\.{3}\s*$/.test(tail50);            // ends with "..."

    // If Claude is actively working (spinner/progress at very end) → wait
    if (claudeWorking && !claudeFinished) {
      logger.info(`Manager: smart heartbeat — Claude still working in "${task.sessionLabel}", skipping`);
      task.status = 'running';
      this.broadcastTasks();
      if (this.reviewQueue.length > 0) {
        setTimeout(() => this.processReviewQueue(), 2000);
      }
      return;
    }

    task.status = 'waiting';
    task.updatedAt = Date.now();
    this.broadcastTasks();

    const outputBefore = buffer?.data?.length ?? 0;

    // Build a SIMPLE heartbeat prompt — just tell the AI what happened
    let heartbeatPrompt: string;

    if (claudeFinished) {
      // Get a snippet of Claude's output for context
      const outputSnippet = recentOutput.slice(-800).trim();
      if (pendingSteps.length > 0 && currentStep) {
        heartbeatPrompt = `[HEARTBEAT] Claude ist fertig in "${task.sessionLabel}". Hier ist der Output:\n\n${outputSnippet}\n\nWas ist der nächste Schritt? Wenn du einen Befehl an ein Terminal senden willst, nutze write_to_terminal. Wenn du ein neues Terminal brauchst, nutze create_terminal.`;
      } else {
        heartbeatPrompt = `[HEARTBEAT] Claude ist fertig in "${task.sessionLabel}". Hier ist der Output:\n\n${outputSnippet}\n\nBerichte dem User die Ergebnisse.`;
      }
    } else if (hasError) {
      const errorSnippet = recentOutput.slice(-500).trim();
      heartbeatPrompt = `[HEARTBEAT] Fehler in "${task.sessionLabel}":\n\n${errorSnippet}\n\nInformiere den User über den Fehler.`;
    } else {
      heartbeatPrompt = `[HEARTBEAT] Terminal "${task.sessionLabel}" ist idle. Prüfe ob noch etwas zu tun ist oder berichte dem User.`;
    }

    try {
      const didProcess = await this.handleChat(heartbeatPrompt);

      if (!didProcess) {
        // handleChat queued the message — it will be processed when current work finishes.
        // Don't re-queue the task; the chatQueue already has the heartbeat message.
        // The next heartbeat cycle will re-evaluate this task if still active.
        logger.info(`Manager: review of "${task.sessionLabel}" queued (busy) — will process when free`);
        task.status = 'running';
        this.broadcastTasks();
        return;
      }

      const outputAfter = this.outputBuffers.get(task.sessionId)?.data?.length ?? 0;
      const hasOpenSteps = task.steps.some(s => s.status === 'pending' || s.status === 'running');
      const outputChanged = outputAfter !== outputBefore;

      // Priority 1: If ALL steps are done → task is DONE, regardless of output changes.
      // This prevents the critical loop where new terminal output resurrects completed tasks.
      if (!hasOpenSteps && task.steps.length > 0) {
        this.updateTaskStatus(task.id, 'done');
        logger.info(`Manager: task "${task.sessionLabel}" completed — all ${task.steps.length} steps done`);
      }
      // Priority 2: AI sent new commands to terminal → keep alive for next review cycle
      else if (outputChanged) {
        logger.info(`Manager: review sent new commands to "${task.sessionLabel}" — keeping task alive`);
        task.status = 'running';
        task.lastCheckedOutput = undefined;
        task.updatedAt = Date.now();
        this.broadcastTasks();
      }
      // Priority 3: Open steps remain but no output change → keep running
      else if (hasOpenSteps) {
        logger.info(`Manager: task "${task.sessionLabel}" still has ${task.steps.filter(s => s.status !== 'done').length} open steps — keeping alive`);
        task.status = 'running';
        this.broadcastTasks();
      }
      // Priority 4: No steps defined (standalone task) and no output change → done
      else {
        this.updateTaskStatus(task.id, 'done');
        logger.info(`Manager: task "${task.sessionLabel}" completed — no follow-up actions`);
      }
    } catch (err) {
      logger.warn(`Manager: heartbeat review failed — ${err instanceof Error ? err.message : err}`);
      task.status = 'running';
      this.broadcastTasks();
    }

    // Chain: process next queued review after a brief pause
    if (this.reviewQueue.length > 0) {
      setTimeout(() => this.processReviewQueue(), 2000);
    }
    } finally {
      this.reviewInFlight.delete(task.id);
    }
  }

  /** Parse AI text response for step-completion signals.
   *  Gemma 4 writes "Ich hake Schritt X ab ✅" as text instead of calling
   *  update_task(complete_step). Detect these patterns and auto-mark steps. */
  private autoCompleteStepsFromText(text: string): void {
    if (!text) return;
    const activeTasks = this.getActiveTasks();
    if (activeTasks.length === 0) return;

    // Patterns that signal the AI thinks a step is done
    const completionPatterns = [
      /hake?\s+(?:den\s+)?(?:schritt|step)\s*["„]?([^""\n]+?)[""\n]?\s*(?:ab|sofort\s+ab|direkt\s+ab)/gi,
      /(?:schritt|step)\s*["„]([^""]+)[""].*?(?:erledigt|abgehakt|✅|fertig|done|abgeschlossen)/gi,
      /(?:erledigt|abgehakt|✅|fertig|done).*?(?:schritt|step)\s*["„]([^""]+)[""]/gi,
    ];

    for (const pattern of completionPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const mentionedStep = match[1]?.trim().toLowerCase();
        if (!mentionedStep || mentionedStep.length < 5) continue;

        for (const task of activeTasks) {
          for (let i = 0; i < task.steps.length; i++) {
            const step = task.steps[i];
            if (step.status !== 'running' && step.status !== 'pending') continue;

            const stepLower = step.label.toLowerCase();
            // Check if the mentioned step is a substantial match
            const mentionedWords = mentionedStep.split(/\s+/).filter(w => w.length > 2);
            const matchCount = mentionedWords.filter(w => stepLower.includes(w)).length;
            const matchRatio = matchCount / Math.max(mentionedWords.length, 1);

            if (matchRatio >= 0.5) {
              logger.info(`Manager: auto-completing step "${step.label}" from AI text (mentioned "${mentionedStep}", ratio=${matchRatio.toFixed(2)})`);
              step.status = 'done';
              // Advance next pending step
              const nextPending = task.steps.find(s => s.status === 'pending');
              if (nextPending && !task.steps.some(s => s.status === 'running')) {
                nextPending.status = 'running';
              }
              if (task.steps.every(s => s.status === 'done')) {
                task.status = 'done';
              }
              task.updatedAt = Date.now();
              this.broadcastTasks();
              break;
            }
          }
        }
      }
    }
  }

  /** Auto-correlate successful tool executions with task steps.
   *  Gemma 4 often DESCRIBES completing a step in text ("Ich hake ab ✅")
   *  instead of actually calling update_task(complete_step). This compensates
   *  by matching tool actions to step labels and auto-marking them done. */
  private autoCompleteStepsFromToolExecution(actions: ManagerAction[]): void {
    const activeTasks = this.getActiveTasks();
    if (activeTasks.length === 0) return;

    for (const action of actions) {
      let matchTerms: string[] = [];
      let terminalLabel = '';

      if (action.type === 'create_terminal') {
        try {
          const info = JSON.parse(action.detail);
          terminalLabel = (info.label || '').toLowerCase();
          // "Terminal X erstellen/starten" steps
          matchTerms = ['terminal', 'erstellen', 'starten', 'öffnen', 'aufmachen', 'claude'];
        } catch {}
      } else if (action.type === 'write_to_terminal') {
        terminalLabel = (this.sessionLabels.get(action.sessionId) || '').toLowerCase();
        const cmdLower = (action.detail || '').toLowerCase();
        // Detect what kind of command was sent
        if (/analys|untersu|prüf|check|audit/i.test(cmdLower)) {
          matchTerms = ['analyse', 'analysieren', 'untersuchen', 'prüfen', 'auftrag', 'senden'];
        } else if (/frage|q&a|frag/i.test(cmdLower)) {
          matchTerms = ['frage', 'q&a', 'runde', 'stellen'];
        } else {
          matchTerms = ['senden', 'schreiben', 'ausführen', 'befehl'];
        }
      } else {
        continue; // Only auto-complete for terminal actions
      }

      if (!terminalLabel && matchTerms.length === 0) continue;

      for (const task of activeTasks) {
        // Scan ALL non-done steps (not just running) — handles out-of-order tool calls
        // e.g., create_terminal("TMS Banking") fires before step 2 is "running"
        let bestStep: TaskStep | undefined;
        let bestStepScore = 0;

        for (const step of task.steps) {
          if (step.status === 'done' || step.status === 'failed') continue;
          const stepLower = step.label.toLowerCase();

          const hasTerminalMatch = terminalLabel && stepLower.includes(terminalLabel);
          const actionMatchCount = matchTerms.filter(t => stepLower.includes(t)).length;

          if (hasTerminalMatch && actionMatchCount >= 1) {
            // Prefer running step, then pending — with higher action match count
            const statusBonus = step.status === 'running' ? 10 : 0;
            const score = actionMatchCount + statusBonus;
            if (score > bestStepScore) {
              bestStepScore = score;
              bestStep = step;
            }
          }
        }

        if (bestStep) {
          logger.info(`Manager: auto-completing step "${bestStep.label}" (matched tool ${action.type} for "${terminalLabel}")`);
          bestStep.status = 'done';
          // Ensure exactly one step is "running" — advance if needed
          if (!task.steps.some(s => s.status === 'running')) {
            const nextPending = task.steps.find(s => s.status === 'pending');
            if (nextPending) {
              nextPending.status = 'running';
              logger.info(`Manager: auto-advanced to next step → "${nextPending.label}"`);
            }
          }
          if (task.steps.every(s => s.status === 'done')) {
            task.status = 'done';
            logger.info(`Manager: task "${task.description}" auto-completed — all steps done`);
          }
          task.updatedAt = Date.now();
          this.broadcastTasks();
          break; // One action matches one step
        }
      }
    }
  }

  /** Advance the next pending step in a task workflow.
   *  Only advances step statuses — does NOT auto-set pendingPrompt.
   *  The AI controls what gets sent to terminals via update_task(complete_step). */
  private advanceTaskStep(task: DelegatedTask): void {
    const runningStep = task.steps.find(s => s.status === 'running');
    if (runningStep) {
      runningStep.status = 'done';
    }
    const nextStep = task.steps.find(s => s.status === 'pending');
    if (nextStep) {
      nextStep.status = 'running';
      logger.info(`Manager: next step → "${nextStep.label}"`);
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
