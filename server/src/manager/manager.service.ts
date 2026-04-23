import { AiProviderRegistry, ChatMessage, ProviderConfig, ToolDefinition, StreamResult, RawToolCall, ToolCallingProvider, RegistryModelStatusListener } from './ai-provider';
import { VoiceSessionController } from './voice.controller';
import type { VoiceEmitter } from './voice.types';
import { synthesizeChunked } from '../audio/tts-sidecar';
import { transcribe as whisperTranscribe } from '../audio/whisper-sidecar';
import { globalManager } from '../terminal/terminal.manager';
import { logger } from '../utils/logger';
import { fcmService } from '../notifications/fcm.service';
import type { PhaseInfo } from '../../../shared/protocol';
import {
  loadMemory, saveMemory, ManagerMemory, CONFIG_DIR,
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
      description: 'Definiert einen Aufgaben-Plan. Nutze set_steps um deinen Plan zu definieren — das System trackt den Fortschritt automatisch. Du musst Schritte NICHT manuell abhaken. Pro Terminal wird automatisch ein eigener Task erstellt wenn du create_terminal aufrufst.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'set_steps (Plan definieren), complete_step (optional — System macht das automatisch), fail_step (Schritt als fehlgeschlagen markieren)' },
          task_name: { type: 'string', description: 'Name der Aufgabe, z.B. "Projekt-Analyse", "Q&A Session"' },
          steps: { type: 'string', description: 'Komma-getrennte Schritte, z.B. "Terminals erstellen,Analyse starten,Q&A Runde 1,Q&A Runde 2,Präsentation"' },
          step_index: { type: 'string', description: 'Step-Index für complete_step/fail_step (0-basiert)' },
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
  // ── Phase 1: New capability tools ──────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'read_terminal',
      description: 'Liest den aktuellen Output eines Terminals. Nutze dies um zu sehen was in einem Terminal passiert ist, ohne auf den Heartbeat zu warten.',
      parameters: {
        type: 'object',
        properties: {
          session_label: { type: 'string', description: 'Terminal-Name oder Shell-Nummer' },
          max_chars: { type: 'string', description: 'Maximale Zeichen (Standard: 2000)' },
        },
        required: ['session_label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Liest eine Datei vom Dateisystem. Pfade relativ zum Home-Verzeichnis oder absolut. Beispiel: "~/Desktop/TMS Shops/package.json"',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Dateipfad, z.B. "~/Desktop/project/README.md"' },
          max_lines: { type: 'string', description: 'Maximale Zeilen (Standard: 100)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Schreibt Inhalt in eine Datei. Erstellt die Datei wenn sie nicht existiert. Überschreibt bestehenden Inhalt.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Dateipfad, z.B. "~/Desktop/notizen.txt"' },
          content: { type: 'string', description: 'Der Inhalt der geschrieben werden soll' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Ruft eine URL ab (HTTP GET/POST). Nutze dies für Web-Recherche, API-Abfragen oder das Lesen von Dokumentation.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Die URL, z.B. "https://api.github.com/repos/Kashino17/tms-terminal"' },
          method: { type: 'string', description: 'HTTP-Methode: GET (Standard) oder POST' },
          body: { type: 'string', description: 'Request-Body für POST (JSON-String)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_info',
      description: 'Gibt Systeminformationen zurück: OS, CPU, RAM, Disk, Hostname, Uptime.',
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
      name: 'clipboard',
      description: 'Liest oder schreibt die Zwischenablage. Action "read" gibt den aktuellen Inhalt zurück, "write" setzt neuen Inhalt.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"read" oder "write"' },
          text: { type: 'string', description: 'Text zum Schreiben (nur bei action=write)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Öffnet eine URL im Standard-Browser des Macs.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Die URL, z.B. "https://google.com"' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_info',
      description: 'Gibt Git-Informationen für ein Verzeichnis zurück. Actions: status, log, diff.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"status", "log" oder "diff"' },
          directory: { type: 'string', description: 'Git-Verzeichnis, z.B. "~/Desktop/TMS Terminal"' },
          count: { type: 'string', description: 'Anzahl Log-Einträge (Standard: 5, nur für action=log)' },
        },
        required: ['action', 'directory'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'undo_last',
      description: 'Zeigt die letzte Aktion und macht sie rückgängig wenn möglich. Nutze dies wenn der User sagt "mach das rückgängig" oder "undo".',
      parameters: {
        type: 'object',
        properties: {
          confirm: { type: 'string', description: '"yes" um die letzte Aktion rückgängig zu machen, oder leer um sie nur anzuzeigen' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_model',
      description: 'Wechselt das AI-Model für nachfolgende Anfragen. Nutze dies wenn ein anderes Model besser für die aktuelle Aufgabe geeignet ist.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Provider-ID: "glm", "kimi", "gemma-4", "qwen-27b", "qwen-35b"' },
          reason: { type: 'string', description: 'Warum der Wechsel (für Logging)' },
        },
        required: ['model'],
      },
    },
  },
];

// ── Types ───────────────────────────────────────────────────────────────────

export interface ManagerAction {
  type: 'write_to_terminal' | 'send_enter' | 'send_keys' | 'create_terminal' | 'close_terminal' | 'list_terminals' | 'generate_image' | 'self_education' | 'update_task' | 'create_cron_job' | 'list_cron_jobs' | 'toggle_cron_job' | 'delete_cron_job' | 'create_presentation' | 'read_terminal' | 'read_file' | 'write_file' | 'fetch_url' | 'system_info' | 'clipboard' | 'open_url' | 'git_info' | 'switch_model' | 'undo_last';
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

/** How a step gets completed — the system handles all of these automatically */
export type StepTrigger =
  | 'manual'         // AI must explicitly complete (default, legacy)
  | 'on_create'      // Done when terminal is created
  | 'on_prompt_sent' // Done when pending_prompt is delivered to Claude
  | 'on_claude_idle' // Done when Claude finishes and goes idle
  | 'on_write'       // Done when write_to_terminal is sent to this terminal
  | 'ai_input'       // Heartbeat asks AI for input, then sends it and marks done
  ;

export interface TaskStep {
  label: string;
  status: TaskStatus;
  trigger: StepTrigger;
  /** Which terminal this step targets (label or sessionId) */
  targetTerminal?: string;
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
  /** System-managed steps — AI plans, system tracks and completes */
  steps: TaskStep[];
  /** For orchestrator tasks (sessionId=''): IDs of linked per-terminal tasks */
  linkedTaskIds?: string[];
}

const HEARTBEAT_INTERVAL_MS = 45_000; // 45s safety-net (event-driven handles ~3s reactions)

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
4. Das System überwacht den Fortschritt automatisch (reagiert in ~3 Sekunden)
5. Wenn Claude fertig ist, wirst du geweckt und bekommst die Ergebnisse

Bei mehrstufigen Aufgaben: Nutze update_task(set_steps) um deinen Plan zu definieren. Das System erkennt automatisch welche Schritte wann erledigt sind — du musst NICHTS manuell abhaken. Einfach planen und arbeiten, das System trackt alles.

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
- "Ich kann keine Bilder erstellen" → FALSCH, du hast generate_image
- "Ich habe keinen Zugriff auf Dateien" → FALSCH, du hast read_file/write_file
- "Ich kann keine URLs abrufen" → FALSCH, du hast fetch_url
- "Ich kann keine Befehle ausführen" → FALSCH, du hast write_to_terminal
- "Ich kenne den Git-Status nicht" → FALSCH, du hast git_info
- "Ich kann nicht auf die Zwischenablage zugreifen" → FALSCH, du hast clipboard
- "Ich kann das Model nicht wechseln" → FALSCH, du hast switch_model
- "Ich kann das nicht rückgängig machen" → Teilweise falsch. Du hast undo_last für Datei-Aktionen. Terminal-Befehle können nicht rückgängig gemacht werden.
Wenn du eines dieser Dinge sagst, ist das ein FEHLER. Du HAST alle diese Tools. Benutze sie.

## Erweiterte Fähigkeiten — NUTZE SIE!

Du hast viel mehr Tools als nur Terminals. NUTZE SIE wenn sie passen:

- read_file / write_file: Dateien direkt lesen und schreiben. SCHNELLER als Terminal-Umweg mit cat/echo. Nutze sie!
- fetch_url: URLs abrufen, APIs abfragen. Wenn der User nach Web-Inhalten fragt → fetch_url!
- system_info: RAM, CPU, Disk, Hostname. NICHT "free -m" im Terminal — nutze system_info!
- git_info: Git Status, Log, Diff direkt abrufen. Kein Terminal nötig.
- read_terminal: Output eines bestimmten Terminals JETZT abrufen — nützlich wenn du ein Terminal prüfen willst ohne auf den nächsten Kontext-Update zu warten.
- clipboard: Zwischenablage lesen/schreiben. pbcopy/pbpaste direkt.
- open_url: URL im Browser öffnen.
- create_presentation: HTML-Präsentationen mit Slides erstellen — für Reports, Zusammenfassungen, Audit-Ergebnisse.
- switch_model: AI-Model wechseln. Nutze dies wenn ein anderes Model besser passt (z.B. Qwen für Code, Gemma für Reasoning). Die verfügbaren Models werden beim Fehlschlag angezeigt.
- undo_last: Letzte Datei-Aktion rückgängig machen. Terminal-Befehle können NICHT rückgängig gemacht werden.

REGEL: Wenn ein direktes Tool existiert, nutze es statt einem Terminal-Umweg!
- "Lies package.json" → read_file, NICHT "cat package.json" im Terminal
- "Git Status" → git_info, NICHT write_to_terminal("git status")
- "Wie viel RAM?" → system_info, NICHT write_to_terminal("free -m")

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

CSS-Klassen:
- Layout: grid-2, grid-3, card, card-sm, flex-row, flex-col, divider, w-full
- Farben: gradient-blue/purple/green/orange/red/cyan, accent/accent-green/accent-red/accent-amber
- Badges: badge badge-blue/green/red/amber
- Statistiken: stat > stat-value + stat-label
- Animation: fade-in, slide-up, slide-in-left, scale-in, delay-1 bis delay-5
- Severity: severity-critical, severity-warning, severity-info, severity-success
- Text: text-center, text-dim, text-muted, text-sm, text-xs, mt-1/mt-2/mt-3

Charts: <canvas data-chart='pie' data-values='[30,70]' data-labels='["A","B"]'></canvas>
Mermaid: <div class='mermaid'>graph LR; A-->B</div>

INHALT-REGELN (WICHTIGER ALS KÜRZE!):
- Jeder Punkt braucht KONTEXT — nicht "Auth fehlt" sondern "Backend hat keine Auth-Middleware → jeder kann ohne Login auf die API zugreifen"
- Jede Zahl braucht VERGLEICH — nicht "42 Tests" sondern "42/50 Tests bestanden (84%)"
- Nutze <details> für aufklappbare Details:
  <details><summary>Auth-Middleware fehlt (Kritisch)</summary><div class="detail-content">Das Backend hat keinen Auth-Layer. Fix: Express middleware mit JWT.</div></details>
- Nutze severity-Klassen für Priorität:
  <div class="severity-critical"><strong>Kritisch:</strong> SQL Injection in der User-Query — alle Eingaben unescaped</div>
  <div class="severity-warning"><strong>Warnung:</strong> API-Keys in .env.example committed</div>
- Info-Tooltips für Fachbegriffe:
  <span class="info-tip">RLS<span class="tip-text">Row Level Security — Datenbankregel die Zugriff pro User einschränkt</span></span>

MOBILE-DESIGN-REGELN:
- Smartphone-Display (ca. 380px breit)
- grid-2 nur für Stats/Badges, nicht für Texte
- Pro Slide maximal 4-5 Elemente
- Aufklappbare Details (<details>) erlauben mehr Inhalt ohne Überladen

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
Sag in 2 Sätzen was du bist — Terminal-Manager, überwachst alles automatisch und reagierst in Sekunden. Dann frag: Wie heißt du, und wie soll ich heißen?

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
  private fcmTokens: Set<string> = new Set();
  private isProcessing = false; // prevent overlapping calls within same slot
  private lastChatText: string | null = null; // ghost-touch dedup
  private lastChatTime: number | null = null;
  private isSystemProcessing = false; // separate slot for heartbeat/orchestrator reviews
  private abortController: AbortController | null = null; // Cancel running AI calls
  private chatQueue: Array<{ text: string; targetSessionId?: string; onboarding?: boolean }> = [];
  private isDistilling = false; // prevent concurrent memory distillation
  private saveTasksTimer: NodeJS.Timeout | null = null;
  private saveChatTimer: NodeJS.Timeout | null = null;
  private lastChatHadToolCalls = false; // Tracks if the last handleChat made tool calls
  private orchestratorRetryCount = new Map<string, number>(); // step retries per task
  private commandHistory: Array<{ action: string; target: string; detail: string; timestamp: number }> = [];
  private activeVoiceSession: VoiceSessionController | null = null;

  // ── Open-ended question auto-answer ─────────────────────────────
  private lastAnsweredQuestion = new Map<string, { text: string; answeredAt: number }>();
  private questionAnswerInFlight = new Set<string>(); // sessionIds currently being answered
  private managerLastUserInputAt = new Map<string, number>(); // user typing tracking
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

  /** Register a listener that receives LM Studio model-load status events. */
  setOnModelStatus(listener: RegistryModelStatusListener | null): void {
    this.registry.setOnModelStatus(listener);
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

    // Restore persisted state from last session
    this.loadTasks();
    this.loadChatHistory();

    // Heartbeat: check delegated tasks
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
    logger.info('Manager: started (event-driven ~3s + heartbeat safety-net 45s)');

    // Cleanup old presentations (>7 days)
    try {
      const presDir = path.join(__dirname, '..', '..', 'generated-presentations');
      if (fs.existsSync(presDir)) {
        const maxAge = 7 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        let cleaned = 0;
        for (const file of fs.readdirSync(presDir)) {
          const filePath = path.join(presDir, file);
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
            cleaned++;
          }
        }
        if (cleaned > 0) logger.info(`Manager: cleaned up ${cleaned} old presentation(s)`);
      }
    } catch {}

    // Cleanup old TTS audio (>7 days)
    try {
      const ttsDir = path.join(__dirname, '..', '..', 'generated-tts');
      if (fs.existsSync(ttsDir)) {
        const maxAge = 7 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        let cleaned = 0;
        for (const file of fs.readdirSync(ttsDir)) {
          const filePath = path.join(ttsDir, file);
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
            cleaned++;
          }
        }
        if (cleaned > 0) logger.info(`Manager: cleaned up ${cleaned} old TTS audio(s)`);
      }
    } catch {}
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

    // Event-driven heartbeat: after 3s of output silence, check if terminal is idle.
    // This reacts in ~3s instead of waiting for the 45s safety-net heartbeat.
    this.resetOutputDebounce(sessionId);
  }

  private outputDebounceTimers = new Map<string, NodeJS.Timeout>();

  private resetOutputDebounce(sessionId: string): void {
    const existing = this.outputDebounceTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    this.outputDebounceTimers.set(sessionId, setTimeout(() => {
      this.outputDebounceTimers.delete(sessionId);
      this.checkTerminalIdle(sessionId);
    }, 3000)); // 3s after last output chunk
  }

  /** Event-driven idle check for a single terminal. Mirrors heartbeat Phase 2+3 logic. */
  private checkTerminalIdle(sessionId: string): void {
    if (!this.enabled) return;

    // Find task for this terminal
    const task = this.delegatedTasks.find(t =>
      t.sessionId === sessionId && (t.status === 'running' || t.status === 'waiting')
    );
    if (!task) return;

    const buffer = this.outputBuffers.get(sessionId);
    if (!buffer?.data) return;

    const currentOutput = buffer.data.replace(ANSI_STRIP, '').slice(-2000);
    const lastChunk = currentOutput.slice(-1000);

    // Claude readiness detection
    const isClaudeReady =
      /for\s*shortcuts/i.test(lastChunk) ||
      /shells?\s*.*\s*esc/i.test(lastChunk) ||
      /waiting\s*for\s*input/i.test(lastChunk) ||
      (/claude\s*code/i.test(lastChunk.slice(-200)) && /[>❯›]\s*$/.test(lastChunk.slice(-40)));
    const isShellPrompt = /[$%>#❯→›]\s*$/.test(lastChunk.slice(-80));

    if (!isClaudeReady && !isShellPrompt) return; // Terminal still busy

    // Send pending prompt if available
    const hasClaudeProcess = /claude/i.test(currentOutput.slice(-3000));
    if (task.pendingPrompt && (isClaudeReady || (isShellPrompt && hasClaudeProcess))) {
      logger.info(`Manager: event-driven — terminal ready in "${task.sessionLabel}", sending pending prompt`);
      globalManager.write(task.sessionId, task.pendingPrompt);
      setTimeout(() => globalManager.write(task.sessionId, '\r'), 200);
      task.pendingPrompt = undefined;
      task.lastCheckedOutput = undefined;
      task.updatedAt = Date.now();

      const promptStep = task.steps.find(s => s.status === 'running' && s.trigger === 'on_prompt_sent');
      if (promptStep) {
        this.completeStepAndAdvance(task, promptStep);
      }
      this.broadcastTasks();
      return;
    }

    // Auto-complete on_claude_idle step (3s debounce = sufficient stability)
    if (isClaudeReady && task.status === 'running') {
      // Check for open question BEFORE completing idle step.
      // If Claude is asking a question, don't mark step as done — answer first.
      const questionText = this.detectOpenQuestion(lastChunk);
      if (questionText) {
        this.handleOpenQuestion(sessionId, task, questionText);
        return; // Don't auto-complete — Claude is waiting for an answer
      }

      const idleStep = task.steps.find(s => s.status === 'running' && s.trigger === 'on_claude_idle');
      if (idleStep && idleStep.status === 'running') { // Guard: only if still running (prevents double-completion with heartbeat)
        this.completeStepAndAdvance(task, idleStep);
        logger.info(`Manager: event-driven — auto-completed "${idleStep.label}" for "${task.sessionLabel}"`);
        this.broadcastTasks();
      }
    }
  }

  /** Register a session label (e.g. "Shell 1") for human-readable summaries. */
  setSessionLabel(sessionId: string, label: string): void {
    this.sessionLabels.set(sessionId, label);
  }

  /** Called from ws.handler on terminal:input — tracks user typing state. */
  trackUserInput(sessionId: string): void {
    this.managerLastUserInputAt.set(sessionId, Date.now());
  }

  /** Remove buffers when a session is closed. */
  clearSession(sessionId: string): void {
    this.outputBuffers.delete(sessionId);
    this.lastSummaryAt.delete(sessionId);
    this.sessionLabels.delete(sessionId);
    // Clean up event-driven debounce timer
    const debounce = this.outputDebounceTimers.get(sessionId);
    if (debounce) { clearTimeout(debounce); this.outputDebounceTimers.delete(sessionId); }
    // Clean up question auto-answer state
    this.lastAnsweredQuestion.delete(sessionId);
    this.questionAnswerInFlight.delete(sessionId);
    this.managerLastUserInputAt.delete(sessionId);
  }

  // ── Open Question Detection ──────────────────────────────────────────────

  /** Returns true if the line is Claude Code UI chrome (task list, status bar, etc.) */
  private static isClaudeUIChrome(line: string): boolean {
    return /^\d+ tasks?\s*\(/.test(line) ||                    // "9 tasks (1 done, ..."
      /^(Worked|Working) for\s+\d/.test(line) ||               // "Worked for 44s"
      /^ctrl\+\w+ to/i.test(line) ||                           // "ctrl+t to hide tasks"
      /^[✓✔✅☑■□☐◻●◆▶►⬛🟩🟧🔲⬜]\s/.test(line);              // Task list indicators
  }

  /**
   * Detects if Claude Code is asking an open-ended question (not Y/N).
   * Returns the question text or null if no question found.
   */
  private detectOpenQuestion(lastChunk: string): string | null {
    const lines = lastChunk.slice(-800).split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 3);

    if (lines.length === 0) return null;

    // Filter out Claude Code UI chrome (task lists, status bar) before scanning.
    // These appear AFTER the question and would push it out of the scan window.
    const contentLines = lines.filter(l => !ManagerService.isClaudeUIChrome(l));
    if (contentLines.length === 0) return null;

    const tailText = contentLines.slice(-6).join('\n');

    // EXCLUDE: Y/N patterns → auto-approve territory
    if (ManagerService.YN_EXCLUSION_PATTERNS.some(p => p.test(tailText))) return null;

    // EXCLUDE: Claude still working (spinner, "Thinking...")
    const tail50 = lastChunk.slice(-50).toLowerCase();
    if (/\b(thinking|reading|writing|searching|analyzing)\b/.test(tail50)) return null;
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(tail50)) return null;
    if (/\.{3}\s*$/.test(tail50)) return null;

    // Search last 5 content lines for a genuine question
    const scanLines = contentLines.slice(-5);
    for (const line of scanLines) {
      if (ManagerService.QUESTION_FALSE_POSITIVE.some(p => p.test(line))) continue;
      if (ManagerService.OPEN_QUESTION_PATTERNS.some(p => p.test(line))) {
        return line;
      }
    }

    return null;
  }

  /** Fuzzy comparison: are two question texts substantially the same? */
  private similarQuestion(a: string, b: string): boolean {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-zäöüß0-9\s]/g, '').trim();
    const na = normalize(a);
    const nb = normalize(b);
    if (na === nb) return true;
    if (na.includes(nb) || nb.includes(na)) return true;
    // Word overlap (Jaccard > 0.7)
    const wordsA = new Set(na.split(/\s+/).filter(w => w.length > 2));
    const wordsB = new Set(nb.split(/\s+/).filter(w => w.length > 2));
    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 && (intersection / union) > 0.7;
  }

  /**
   * Auto-answers an open-ended question from Claude Code.
   * Routes through handleChat() → Manager AI reasoning → write_to_terminal.
   */
  private handleOpenQuestion(sessionId: string, task: DelegatedTask, questionText: string): void {
    // Guard 1: Already answering for this session
    if (this.questionAnswerInFlight.has(sessionId)) return;

    // Guard 2: User is typing → human takes priority
    const lastInput = this.managerLastUserInputAt.get(sessionId) ?? 0;
    if (Date.now() - lastInput < ManagerService.USER_TYPING_PAUSE_MS) {
      logger.info(`Manager: question in "${task.sessionLabel}" but user typing — skipping`);
      return;
    }

    // Guard 3: Cooldown (prevent spam)
    const lastAnswer = this.lastAnsweredQuestion.get(sessionId);
    if (lastAnswer && Date.now() - lastAnswer.answeredAt < ManagerService.QUESTION_COOLDOWN_MS) return;

    // Guard 4: Same question as last time → don't answer again
    if (lastAnswer && this.similarQuestion(lastAnswer.text, questionText)) {
      logger.info(`Manager: duplicate question in "${task.sessionLabel}" — skipping`);
      return;
    }

    // Guard 5: Task still active?
    if (task.status !== 'running' && task.status !== 'waiting') return;

    logger.info(`Manager: open question in "${task.sessionLabel}": "${questionText.slice(0, 80)}"`);
    this.questionAnswerInFlight.add(sessionId);

    // Build terminal context for the prompt
    const buffer = this.outputBuffers.get(sessionId);
    const recentOutput = buffer?.data?.replace(ANSI_STRIP, '').slice(-1500) ?? '';

    const answerPrompt = `[AUTO-FRAGE] Claude Code in "${task.sessionLabel}" hat eine Rückfrage und wartet auf deine Antwort:

Aufgabe: "${task.description}"
Frage von Claude: "${questionText}"

Letzter Terminal-Output:
\`\`\`
${recentOutput.slice(-800)}
\`\`\`

ANWEISUNG: Beantworte Claudes Frage im Kontext der Aufgabe. Nutze write_to_terminal um deine Antwort an "${task.sessionLabel}" zu senden. Halte die Antwort kurz und präzise — Claude erwartet eine direkte Antwort. Wenn du unsicher bist, wähle die pragmatischste Option.`;

    this.handleChat(answerPrompt, sessionId)
      .catch(err => logger.warn(`Manager: auto-answer failed — ${err instanceof Error ? err.message : err}`))
      .finally(() => {
        this.questionAnswerInFlight.delete(sessionId);
        this.lastAnsweredQuestion.set(sessionId, { text: questionText, answeredAt: Date.now() });
      });
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
      this.debouncedSaveChatHistory();
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
      // ── New capability tools (no sessionId needed) ─────────────
      if (tc.name === 'read_terminal') {
        const info = JSON.stringify({ sessionLabel: tc.arguments.session_label ?? '', maxChars: tc.arguments.max_chars ?? '2000' });
        actions.push({ type: 'read_terminal', sessionId: '', detail: info });
        continue;
      }
      if (tc.name === 'read_file') {
        const info = JSON.stringify({ path: tc.arguments.path ?? '', maxLines: tc.arguments.max_lines ?? '100' });
        actions.push({ type: 'read_file', sessionId: '', detail: info });
        continue;
      }
      if (tc.name === 'write_file') {
        const info = JSON.stringify({ path: tc.arguments.path ?? '', content: tc.arguments.content ?? '' });
        actions.push({ type: 'write_file', sessionId: '', detail: info });
        continue;
      }
      if (tc.name === 'fetch_url') {
        const info = JSON.stringify({ url: tc.arguments.url ?? '', method: tc.arguments.method ?? 'GET', body: tc.arguments.body ?? '' });
        actions.push({ type: 'fetch_url', sessionId: '', detail: info });
        continue;
      }
      if (tc.name === 'system_info') {
        actions.push({ type: 'system_info', sessionId: '', detail: '' });
        continue;
      }
      if (tc.name === 'clipboard') {
        const info = JSON.stringify({ action: tc.arguments.action ?? 'read', text: tc.arguments.text ?? '' });
        actions.push({ type: 'clipboard', sessionId: '', detail: info });
        continue;
      }
      if (tc.name === 'open_url') {
        const info = JSON.stringify({ url: tc.arguments.url ?? '' });
        actions.push({ type: 'open_url', sessionId: '', detail: info });
        continue;
      }
      if (tc.name === 'git_info') {
        const info = JSON.stringify({ action: tc.arguments.action ?? 'status', directory: tc.arguments.directory ?? '', count: tc.arguments.count ?? '5' });
        actions.push({ type: 'git_info', sessionId: '', detail: info });
        continue;
      }
      if (tc.name === 'switch_model') {
        const info = JSON.stringify({ model: tc.arguments.model ?? '', reason: tc.arguments.reason ?? '' });
        actions.push({ type: 'switch_model', sessionId: '', detail: info });
        continue;
      }
      if (tc.name === 'undo_last') {
        actions.push({ type: 'undo_last', sessionId: '', detail: JSON.stringify({ confirm: tc.arguments.confirm ?? '' }) });
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

    // Dedup: drop identical messages within 2s window (ghost-touch protection)
    const now = Date.now();
    if (this.lastChatText === text && this.lastChatTime && now - this.lastChatTime < 2000) {
      logger.info(`Manager: dropped duplicate chat message (ghost-touch dedup)`);
      return false;
    }
    this.lastChatText = text;
    this.lastChatTime = now;

    // Queue messages while processing — don't block or error
    if (this.isProcessing) {
      this.chatQueue.push({ text, targetSessionId, onboarding });
      logger.info(`Manager: queued chat message (${this.chatQueue.length} in queue)`);
      return false;
    }
    this.isProcessing = true;
    this.abortController = new AbortController();

    const startTime = Date.now();
    const phases: PhaseInfo[] = [];
    let phaseStart = startTime;
    this.lastChatHadToolCalls = false;

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
    this.debouncedSaveChatHistory();

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

        if (this.abortController?.signal.aborted) throw new Error('Request cancelled');

        const result = await toolProvider.chatStreamWithTools(
          chatMessages,
          systemPrompt,
          MANAGER_TOOLS,
          (token) => {
            if (this.abortController?.signal.aborted) return;
            streamTokenCount++;
            const elapsedSec = (Date.now() - streamStart) / 1000;
            const tps = elapsedSec > 0.5 ? Math.round((streamTokenCount / elapsedSec) * 10) / 10 : 0;
            this.onStreamChunk?.(token, { completionTokens: streamTokenCount, tps });
          },
          undefined,
          this.abortController?.signal,
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
              () => {},
              { type: 'function', function: { name: forcedTool } },
              this.abortController?.signal,
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
        const TOOL_LOOP_TIMEOUT_MS = 3_000_000; // 50 minutes — long-running workflows on local LLM
        const toolLoopStart = Date.now();
        let round = 0;
        let turnMessages: Array<{ role: string; content?: string | null; tool_calls?: RawToolCall[]; tool_call_id?: string }> =
          chatMessages.map(m => ({ role: m.role, content: m.content }));

        while (nativeToolCalls.length > 0 && round < MAX_TOOL_ROUNDS && (Date.now() - toolLoopStart) < TOOL_LOOP_TIMEOUT_MS && !this.abortController?.signal.aborted) {
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
              this.lastChatHadToolCalls = true;
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
            undefined,
            this.abortController?.signal,
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
      this.debouncedSaveChatHistory();
      if (this.chatHistory.length > 12) {
        // Aggressive truncation — Gemma 4 degrades beyond ~10K tokens of history.
        // Keep first message (user request) + last 6 messages (most recent conversation).
        // This keeps prompts under ~16K tokens total even with orchestrator outputs.
        // Defer distillation — don't run during active processing to avoid
        // LM Studio KV-cache eviction (concurrent requests kill performance)
        if (!this.isDistilling) {
          setTimeout(() => {
            if (!this.isProcessing && !this.isDistilling) {
              this.distill().catch(err => logger.warn(`Manager: deferred distill failed — ${err}`));
            }
          }, 5000); // Wait 5s for current processing to finish
        }
        this.chatHistory = [this.chatHistory[0], ...this.chatHistory.slice(-6)];
        logger.info(`Manager: truncated chat history to ${this.chatHistory.length} messages`);
      }

      this.memory.recentChat.push({ role: 'assistant', text: cleanReply.slice(0, 2000), timestamp: Date.now() });
      saveMemory(this.memory);

      if (this.memory.recentChat.length > MAX_RECENT_CHAT && !this.isDistilling) {
        setTimeout(() => {
          if (!this.isProcessing && !this.isDistilling) {
            this.distill().catch(err => logger.warn(`Manager: deferred auto-distill failed — ${err}`));
          }
        }, 5000);
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
        } else if (memUpdate) {
          // AI only produced a MEMORY_UPDATE block — surface what was learned
          // instead of a generic acknowledgment so the user knows something happened.
          const first =
            memUpdate.learnedFacts[0]
              ?? memUpdate.insights[0]
              ?? memUpdate.traits[0]
              ?? memUpdate.journalEntries[0];
          finalText = first
            ? `📝 Notiert: ${first}`
            : 'Ich hab mir das gemerkt.';
        } else {
          // Model generated nothing usable — tell the user instead of faking a response.
          finalText = '🤔 Ich hab keine Antwort formuliert — frag mich nochmal.';
        }
      }

      // Send stream end with phases, images, presentations, and active tasks
      this.onStreamEnd?.(finalText, actions, phases, actionImages.length > 0 ? actionImages : undefined, actionPresentations.length > 0 ? actionPresentations : undefined);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Manager: chat failed — ${msg}`);
      // Send stream end to clear the "Schreibt..." thinking bubble in the UI
      this.onStreamEnd?.(`⚠️ ${msg}`, [], [], undefined, undefined);
      return true; // Did attempt work, even if it failed
    } finally {
      this.isProcessing = false;
      this.abortController = null;
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
    if (this.isProcessing || this.isSystemProcessing) {
      logger.info('Manager: distill deferred — AI is processing (avoids LM Studio cache eviction)');
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

        // Confirmation-Gate: block dangerous commands (unless it's a Claude session)
        const ctx = this.buildTerminalContexts().find(c => c.sessionId === action.sessionId);
        const isShellSession = !ctx?.tool; // No AI tool detected = shell
        if (isShellSession) {
          const DANGEROUS = [
            /\brm\b[^|;&\n]*-[a-zA-Z]*r/i, // rm with -r flag anywhere (catches rm -f -r, rm -rf, etc.)
            /\bsudo\b/i,
            /\bgit\s+push\s+.*--force\b/i, /\bgit\s+push\s+-f\b/i,
            /\bgit\s+reset\s+--hard\b/i,
            /\bdrop\s+(table|database)\b/i,
            /\bdd\s+if=/i, /\bchmod\s+777\b/i, /\bmkfs\b/i,
            /:\(\)\s*\{/, // fork bomb
            /\bkillall\b/i, /\bpkill\s+-9/i,
          ];
          const isDangerous = DANGEROUS.some(p => p.test(action.detail));
          if (isDangerous) {
            logger.warn(`Manager: BLOCKED dangerous command "${action.detail.slice(0, 80)}" to shell "${label}"`);
            return { text: `⛔ Befehl blockiert — "${action.detail.slice(0, 60)}" wurde als potenziell gefährlich erkannt. Bitte den User um explizite Bestätigung.` };
          }
        }

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
        this.commandHistory.push({ action: 'write_to_terminal', target: label, detail: action.detail.slice(0, 200), timestamp: Date.now() });
        if (this.commandHistory.length > 50) this.commandHistory.shift();
        return { text: `Befehl vollständig an "${label}" gesendet (${action.detail.length} Zeichen). Der komplette Text wurde übertragen.` };
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

              // Auto-create a per-terminal task with system-managed steps.
              // Each terminal gets its OWN task — solves the multi-terminal problem.
              const isClaudeSession = /claude/i.test(initialCommand);
              const termLabel = label || this.sessionLabels.get(newSessionId) || newSessionId.slice(0, 8);

              if (isClaudeSession) {
                // Find the NEWEST active orchestrator (last created, not first)
                const activeOrchestrators = this.delegatedTasks.filter(t =>
                  t.sessionId === '' && t.status !== 'done' && t.status !== 'failed'
                );
                const orchestrator = activeOrchestrators.length > 0
                  ? activeOrchestrators[activeOrchestrators.length - 1]
                  : undefined;
                const isOrchestrated = !!orchestrator;

                const steps: TaskStep[] = [
                  { label: `Terminal "${termLabel}" erstellen`, status: 'done', trigger: 'on_create' },
                  { label: 'Claude starten', status: 'done', trigger: 'on_create' },
                ];
                if (pendingPrompt) {
                  steps.push({ label: 'Auftrag senden', status: 'running', trigger: 'on_prompt_sent' });
                  steps.push({ label: 'Claude arbeitet...', status: 'pending', trigger: 'on_claude_idle' });
                  // Only add ai_input if NOT orchestrated — orchestrator handles AI review
                  if (!isOrchestrated) {
                    steps.push({ label: 'Ergebnis bereit', status: 'pending', trigger: 'ai_input' });
                  }
                }
                const task = this.addDelegatedTask(termLabel, newSessionId, pendingPrompt, []);
                task.steps = steps;

                // Link to orchestrator task
                if (orchestrator) {
                  if (!orchestrator.linkedTaskIds) orchestrator.linkedTaskIds = [];
                  orchestrator.linkedTaskIds.push(task.id);
                  logger.info(`Manager: linked "${termLabel}" to orchestrator "${orchestrator.description}"`);
                }

                logger.info(`Manager: created per-terminal task "${termLabel}" with ${steps.length} steps${isOrchestrated ? ' (orchestrated)' : ''}`);
                this.broadcastTasks();
              } else {
                // Non-Claude terminal (shell) — create lightweight task if orchestrator exists
                const shellOrchestrator = this.delegatedTasks.filter(t =>
                  t.sessionId === '' && t.status !== 'done' && t.status !== 'failed'
                );
                const orch = shellOrchestrator.length > 0 ? shellOrchestrator[shellOrchestrator.length - 1] : undefined;
                if (orch) {
                  const shellTask = this.addDelegatedTask(termLabel, newSessionId, undefined, []);
                  shellTask.steps = [
                    { label: `Terminal "${termLabel}" erstellen`, status: 'done', trigger: 'on_create' as StepTrigger },
                    { label: 'Befehl ausführen', status: 'running', trigger: 'on_claude_idle' as StepTrigger },
                  ];
                  if (!orch.linkedTaskIds) orch.linkedTaskIds = [];
                  orch.linkedTaskIds.push(shellTask.id);
                  logger.info(`Manager: linked shell terminal "${termLabel}" to orchestrator "${orch.description}"`);
                  this.broadcastTasks();
                } else {
                  logger.info(`Manager: terminal "${termLabel}" created with command (no orchestrator)`);
                }
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

            // System auto-assigns triggers based on step label content
            const classifiedSteps: TaskStep[] = stepLabels.map((label, i) => {
              const lower = label.toLowerCase();
              let trigger: StepTrigger = 'ai_input'; // Default: needs AI input

              const hasTerminalKeyword = /terminal.*(?:erstell|start|öffn)|(?:erstell|start|öffn).*terminal/i.test(lower);
              const hasClaudeStart = /claude.*(?:start|öffn)|(?:start|öffn).*claude/i.test(lower);
              // Work that Claude/Shell does IN A TERMINAL — we wait for it to finish
              const hasClaudeWorkKeyword = /analys|untersu|prüf|scan|audit|check|bewert|fix|bug|implement|einbau|umbau|deploy|migrat|refactor|compil|lassen|test/i.test(lower);
              // General action words — usually AI-initiated (creating files, installing, building)
              const hasGeneralAction = /erstell|schreib|install|build|mach|konfigurier|setz.*auf/i.test(lower);
              // Interactive steps — the AI must provide input or call specific tools
              const hasInteractiveKeyword = /frag|q&a|runde|präsentation|zusammenfass|bericht|send|bild|generier|beantwort|cron|job|auswert|commit|push|merge|speicher/i.test(lower);

              if ((hasTerminalKeyword || hasClaudeStart) && (hasClaudeWorkKeyword || hasGeneralAction)) {
                // Combined: "Terminal erstellen & Analyse starten" or "Claude starten & Bugs fixen"
                trigger = 'on_claude_idle';
              } else if (hasTerminalKeyword || hasClaudeStart) {
                trigger = 'on_create';
              } else if (/auftrag.*send|analyse.*send|send.*auftrag|prompt.*send|aufgabe.*send/i.test(lower)) {
                trigger = 'on_prompt_sent';
              } else if (hasClaudeWorkKeyword && !hasInteractiveKeyword) {
                // Pure Claude work: "Bugs fixen", "Analyse durchführen", "Code refactoren"
                // Only classified as on_claude_idle if Claude is actually doing the work
                trigger = 'on_claude_idle';
              } else if (/wart|abwart|ergebnis.*abwart/i.test(lower)) {
                trigger = 'on_claude_idle';
              }
              // Everything else (Q&A, Präsentation, Bild generieren, Cron-Job, Auswertung) = 'ai_input'

              return {
                label,
                status: (i === 0 ? 'running' : 'pending') as TaskStatus,
                trigger,
              };
            });

            if (!task) {
              task = this.addDelegatedTask(taskName || stepLabels[0] || 'Aufgabe', '', undefined, []);
              task.steps = classifiedSteps;
              if (task.steps.length > 0) task.steps[0].status = 'running';
              logger.info(`Manager: created task "${task.description}" — ${classifiedSteps.map(s => `${s.label}[${s.trigger}]`).join(', ')}`);
              this.broadcastTasks();
              return { text: `Task "${task.description}" erstellt (${stepLabels.length} Schritte). Das System trackt den Fortschritt automatisch.` };
            }

            task.steps = classifiedSteps;
            task.description = taskName || stepLabels[0] || task.description;
            task.updatedAt = Date.now();
            this.broadcastTasks();
            return { text: `Task "${task.description}" aktualisiert (${stepLabels.length} Schritte).` };
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
      // ── New capability tool handlers ───────────────────────────────
      case 'read_terminal': {
        try {
          const info = JSON.parse(action.detail);
          const sessionId = this.resolveLabel(info.sessionLabel);
          if (!sessionId) return { text: `Terminal "${info.sessionLabel}" nicht gefunden.` };
          const buf = this.outputBuffers.get(sessionId);
          if (!buf?.data) return { text: `Terminal "${info.sessionLabel}" hat keinen Output.` };
          const maxChars = parseInt(info.maxChars, 10) || 2000;
          const clean = buf.data.replace(ANSI_STRIP, '').slice(-maxChars);
          return { text: clean || '(leer)' };
        } catch (err) { return { text: `Fehler: ${err}` }; }
      }
      case 'read_file': {
        try {
          const info = JSON.parse(action.detail);
          let filePath = (info.path || '').replace(/^~/, os.homedir());
          if (!path.isAbsolute(filePath)) filePath = path.join(os.homedir(), filePath);
          filePath = path.resolve(filePath);
          if (!filePath.startsWith(os.homedir())) return { text: `⛔ Zugriff verweigert: Pfad außerhalb des Home-Verzeichnisses.` };
          if (!fs.existsSync(filePath)) return { text: `Datei nicht gefunden: ${filePath}` };
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) return { text: `"${filePath}" ist ein Verzeichnis, keine Datei.` };
          if (stat.size > 500_000) return { text: `Datei zu groß (${(stat.size / 1024).toFixed(0)} KB). Max 500 KB.` };
          const ext = path.extname(filePath).toLowerCase();
          const BINARY_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.zip', '.gz', '.tar', '.exe', '.bin', '.dylib', '.so', '.a', '.o', '.woff', '.woff2', '.ttf', '.ico', '.apk', '.ipa'];
          if (BINARY_EXT.includes(ext)) return { text: `Binärdatei (${ext}) — kein Text-Inhalt lesbar. Größe: ${(stat.size / 1024).toFixed(0)} KB` };
          const content = fs.readFileSync(filePath, 'utf-8');
          const maxLines = parseInt(info.maxLines, 10) || 100;
          const lines = content.split('\n');
          const truncated = lines.length > maxLines;
          return { text: `📄 ${filePath} (${lines.length} Zeilen):\n${lines.slice(0, maxLines).join('\n')}${truncated ? `\n... (${lines.length - maxLines} weitere Zeilen)` : ''}` };
        } catch (err) { return { text: `Fehler beim Lesen: ${err instanceof Error ? err.message : String(err)}` }; }
      }
      case 'write_file': {
        try {
          const info = JSON.parse(action.detail);
          let filePath = (info.path || '').replace(/^~/, os.homedir());
          if (!path.isAbsolute(filePath)) filePath = path.join(os.homedir(), filePath);
          filePath = path.resolve(filePath);
          if (!filePath.startsWith(os.homedir())) return { text: `⛔ Zugriff verweigert: Pfad außerhalb des Home-Verzeichnisses.` };
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(filePath, info.content || '', 'utf-8');
          this.commandHistory.push({ action: 'write_file', target: filePath, detail: `${(info.content || '').length} Zeichen`, timestamp: Date.now() });
          if (this.commandHistory.length > 50) this.commandHistory.shift();
          return { text: `✅ Datei geschrieben: ${filePath} (${(info.content || '').length} Zeichen)` };
        } catch (err) { return { text: `Fehler beim Schreiben: ${err instanceof Error ? err.message : String(err)}` }; }
      }
      case 'fetch_url': {
        try {
          const info = JSON.parse(action.detail);
          const url = info.url;
          if (!url) return { text: 'Keine URL angegeben.' };
          try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
              return { text: `⛔ Nur HTTP/HTTPS-URLs erlaubt (nicht ${parsed.protocol}).` };
            }
          } catch { return { text: `Ungültige URL: ${url}` }; }
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30_000);
          try {
            const resp = await fetch(url, {
              method: (info.method || 'GET').toUpperCase(),
              body: info.body || undefined,
              headers: info.body ? { 'Content-Type': 'application/json' } : undefined,
              signal: controller.signal,
            });
            clearTimeout(timeout);
            const text = await resp.text();
            const truncated = text.length > 50_000 ? text.slice(0, 50_000) + '\n... (abgeschnitten)' : text;
            return { text: `🌐 ${resp.status} ${resp.statusText} — ${url}\n\n${truncated}` };
          } catch (fetchErr) {
            clearTimeout(timeout);
            return { text: `Fetch fehlgeschlagen: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}` };
          }
        } catch (err) { return { text: `Fetch fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` }; }
      }
      case 'system_info': {
        try {
          const { execSync } = require('child_process');
          const cpus = os.cpus();
          const disk = execSync('df -h / 2>/dev/null | tail -1', { encoding: 'utf-8' }).trim();
          const info = [
            `🖥️ ${os.hostname()} — ${os.platform()} ${os.arch()} ${os.release()}`,
            `💻 CPU: ${cpus[0]?.model ?? 'unknown'} (${cpus.length} Kerne)`,
            `🧠 RAM: ${(os.freemem() / 1e9).toFixed(1)} GB frei / ${(os.totalmem() / 1e9).toFixed(1)} GB total`,
            `💾 Disk: ${disk}`,
            `⏱️ Uptime: ${(os.uptime() / 3600).toFixed(1)} Stunden`,
          ];
          return { text: info.join('\n') };
        } catch (err) { return { text: `Fehler: ${err}` }; }
      }
      case 'clipboard': {
        try {
          const { spawnSync, execSync } = require('child_process');
          const info = JSON.parse(action.detail);
          if (info.action === 'write') {
            // Use spawnSync to avoid shell injection (no shell metachar processing)
            spawnSync('pbcopy', [], { input: info.text || '', encoding: 'utf-8' });
            return { text: `📋 In Zwischenablage kopiert (${(info.text || '').length} Zeichen).` };
          }
          if (info.action === 'read') {
            const content = execSync('pbpaste', { encoding: 'utf-8' });
            return { text: `📋 Zwischenablage:\n${content.slice(0, 5000)}` };
          }
          return { text: `Unbekannte Clipboard-Action: "${info.action}". Erlaubt: read, write.` };
        } catch (err) { return { text: `Clipboard-Fehler: ${err}` }; }
      }
      case 'open_url': {
        try {
          const { execFileSync } = require('child_process');
          const info = JSON.parse(action.detail);
          if (!info.url) return { text: 'Keine URL angegeben.' };
          // execFileSync passes URL as argument, no shell interpretation → no injection
          execFileSync('open', [info.url]);
          return { text: `🌐 Geöffnet: ${info.url}` };
        } catch (err) { return { text: `Fehler: ${err}` }; }
      }
      case 'git_info': {
        try {
          const { execFileSync } = require('child_process');
          const info = JSON.parse(action.detail);
          let dir = (info.directory || '').replace(/^~/, os.homedir());
          if (!path.isAbsolute(dir)) dir = path.join(os.homedir(), dir);
          if (!fs.existsSync(path.join(dir, '.git'))) return { text: `"${dir}" ist kein Git-Repository.` };
          // execFileSync with argument array — no shell injection possible
          const gitCmd = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 10_000 }).trim();
          if (info.action === 'status') {
            const status = gitCmd('status', '--short');
            const branch = gitCmd('branch', '--show-current');
            return { text: `📦 Git Status — ${dir}\nBranch: ${branch}\n${status || '(clean, keine Änderungen)'}` };
          }
          if (info.action === 'log') {
            const count = parseInt(info.count, 10) || 5;
            const log = gitCmd('log', '--oneline', `-${count}`);
            return { text: `📜 Git Log — ${dir} (letzte ${count}):\n${log}` };
          }
          if (info.action === 'diff') {
            const diff = gitCmd('diff', '--stat');
            return { text: `📝 Git Diff — ${dir}:\n${diff || '(keine Änderungen)'}` };
          }
          return { text: `Unbekannte Git-Action: "${info.action}". Erlaubt: status, log, diff.` };
        } catch (err) { return { text: `Git-Fehler: ${err instanceof Error ? err.message : String(err)}` }; }
      }
      case 'undo_last': {
        if (this.commandHistory.length === 0) return { text: 'Keine Aktionen zum Rückgängigmachen vorhanden.' };
        const last = this.commandHistory[this.commandHistory.length - 1];
        const info = JSON.parse(action.detail);
        const ago = Math.round((Date.now() - last.timestamp) / 1000);
        if (info.confirm !== 'yes') {
          return { text: `↩️ Letzte Aktion (vor ${ago}s): ${last.action} → "${last.target}"\nDetail: ${last.detail}\n\nRufe undo_last(confirm="yes") auf um sie rückgängig zu machen.` };
        }
        this.commandHistory.pop();
        if (last.action === 'write_to_terminal') {
          return { text: `↩️ Letzte Terminal-Eingabe an "${last.target}" kann nicht rückgängig gemacht werden (bereits ausgeführt). Schicke einen korrigierenden Befehl stattdessen.` };
        }
        if (last.action === 'write_file') {
          try {
            const filePath = last.target;
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              return { text: `↩️ Datei gelöscht: ${filePath}` };
            }
          } catch {}
        }
        return { text: `↩️ Aktion "${last.action}" wurde aus der History entfernt.` };
      }
      case 'switch_model': {
        try {
          const info = JSON.parse(action.detail);
          const modelName = info.model || '';
          if (!modelName) return { text: 'Kein Model angegeben.' };
          // Try to find and switch to the model by partial name match
          // Try to switch by matching provider ID
          const providersList = this.registry.list();
          const nameLower = modelName.toLowerCase();
          const match = providersList.find((p: any) =>
            (p.id || '').toLowerCase().includes(nameLower) ||
            (p.name || '').toLowerCase().includes(nameLower)
          );
          if (match) {
            this.registry.setActive(match.id);
            logger.info(`Manager: model switched to "${match.name}" (reason: ${info.reason || 'none'})`);
            return { text: `🔄 Model gewechselt zu "${match.name}".${info.reason ? ` Grund: ${info.reason}` : ''}` };
          }
          const available = providersList.map((p: any) => p.id).join(', ');
          return { text: `Model "${modelName}" nicht gefunden. Verfügbare: ${available}` };
        } catch (err) { return { text: `Model-Wechsel fehlgeschlagen: ${err}` }; }
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
    this.debouncedSaveTasks();
  }

  // ── State Persistence ───────────────────────────────────────────────

  private static readonly TASKS_FILE = path.join(CONFIG_DIR, 'tasks.json');
  private static readonly CHAT_FILE = path.join(CONFIG_DIR, 'chat-history.json');

  private saveTasks(): void {
    try {
      const tmpFile = ManagerService.TASKS_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(this.delegatedTasks, null, 2), { mode: 0o600 });
      fs.renameSync(tmpFile, ManagerService.TASKS_FILE);
    } catch (err) {
      logger.warn(`Manager: failed to save tasks — ${err}`);
    }
  }

  private loadTasks(): void {
    try {
      if (!fs.existsSync(ManagerService.TASKS_FILE)) return;
      const raw = fs.readFileSync(ManagerService.TASKS_FILE, 'utf-8');
      const tasks: DelegatedTask[] = JSON.parse(raw);

      // Check if all tasks are old and done/failed — discard
      const allFinished = tasks.every(t => t.status === 'done' || t.status === 'failed');
      const oldestUpdate = Math.min(...tasks.map(t => t.updatedAt));
      if (allFinished && (Date.now() - oldestUpdate) > 60 * 60 * 1000) {
        fs.unlinkSync(ManagerService.TASKS_FILE);
        logger.info('Manager: discarded stale task file (all tasks finished > 1h ago)');
        return;
      }

      // Mark interrupted tasks as failed — terminals are gone after restart
      for (const t of tasks) {
        if (t.status === 'running' || t.status === 'waiting' || t.status === 'pending') {
          t.status = 'failed';
          for (const s of t.steps) {
            if (s.status === 'running' || s.status === 'pending') {
              s.status = 'failed';
            }
          }
        }
      }

      this.delegatedTasks = tasks;
      logger.info(`Manager: restored ${tasks.length} tasks from disk (interrupted tasks marked failed)`);
    } catch (err) {
      logger.warn(`Manager: failed to load tasks — ${err}`);
    }
  }

  private saveChatHistory(): void {
    try {
      const tmpFile = ManagerService.CHAT_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(this.chatHistory), { mode: 0o600 });
      fs.renameSync(tmpFile, ManagerService.CHAT_FILE);
    } catch (err) {
      logger.warn(`Manager: failed to save chat history — ${err}`);
    }
  }

  private loadChatHistory(): void {
    try {
      if (!fs.existsSync(ManagerService.CHAT_FILE)) return;
      this.chatHistory = JSON.parse(fs.readFileSync(ManagerService.CHAT_FILE, 'utf-8'));
      // Cap restored history to prevent context overflow on first AI call
      if (this.chatHistory.length > 12) {
        this.chatHistory = [this.chatHistory[0], ...this.chatHistory.slice(-6)];
      }
      logger.info(`Manager: restored ${this.chatHistory.length} chat messages from disk`);
    } catch (err) {
      logger.warn(`Manager: failed to load chat history — ${err}`);
      this.chatHistory = [];
    }
  }

  private debouncedSaveTasks(): void {
    if (this.saveTasksTimer) clearTimeout(this.saveTasksTimer); // trailing-edge: reset on each call
    this.saveTasksTimer = setTimeout(() => {
      this.saveTasks();
      this.saveTasksTimer = null;
    }, 1000);
  }

  private debouncedSaveChatHistory(): void {
    if (this.saveChatTimer) clearTimeout(this.saveChatTimer); // trailing-edge: reset on each call
    this.saveChatTimer = setTimeout(() => {
      this.saveChatHistory();
      this.saveChatTimer = null;
    }, 2000);
  }

  /** Called from index.ts on SIGINT/SIGTERM — save everything immediately */
  /** Cancel the current AI request (called from WS handler on manager:cancel) */
  cancelCurrentRequest(): void {
    if (this.abortController) {
      this.abortController.abort();
      logger.info('Manager: AI request cancelled by user');
    }
    // Also clear the chat queue so queued heartbeats don't fire
    this.chatQueue.length = 0;
  }

  saveStateOnShutdown(): void {
    if (this.saveTasksTimer) { clearTimeout(this.saveTasksTimer); this.saveTasksTimer = null; }
    if (this.saveChatTimer) { clearTimeout(this.saveChatTimer); this.saveChatTimer = null; }
    this.saveTasks();
    this.saveChatHistory();
    saveMemory(this.memory);
    logger.info('Manager: state saved to disk (shutdown)');
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
      steps: (steps ?? [description]).map(s => ({ label: s, status: 'pending' as TaskStatus, trigger: 'manual' as StepTrigger })),
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
      // Push notification for terminal events
      if (status === 'done') this.notifyTaskEvent(task, 'completed');
      else if (status === 'failed') this.notifyTaskEvent(task, 'failed');
    }
  }

  /** Send FCM push notification for task lifecycle events */
  private notifyTaskEvent(task: DelegatedTask, event: 'completed' | 'failed' | 'needs_input'): void {
    if (this.fcmTokens.size === 0) return;
    const titles: Record<string, string> = {
      completed: `\u2705 ${task.description}`,
      failed: `\u274C ${task.description}`,
      needs_input: `\uD83D\uDD14 ${task.description}`,
    };
    const bodies: Record<string, string> = {
      completed: 'Aufgabe abgeschlossen',
      failed: 'Aufgabe fehlgeschlagen',
      needs_input: 'Deine Eingabe wird benötigt',
    };
    for (const token of this.fcmTokens) {
      fcmService.send(token, titles[event], bodies[event], { taskId: task.id, type: `task_${event}` })
        .catch(() => {}); // Don't crash on FCM errors
    }
  }

  /** Set FCM device tokens for push notifications (called from ws.handler) */
  setFcmTokens(tokens: Set<string>): void {
    this.fcmTokens = tokens;
  }

  private static readonly TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes max per task
  private static readonly QUESTION_COOLDOWN_MS = 15_000;    // 15s cooldown between auto-answers per session
  private static readonly USER_TYPING_PAUSE_MS = 5_000;     // Don't auto-answer if user typed recently
  private stableOutputCounts = new Map<string, number>(); // track consecutive unchanged outputs
  private reviewQueue: string[] = []; // task IDs waiting for AI review
  private reviewInFlight = new Set<string>(); // task IDs currently being reviewed (prevents duplicates)

  /** Heartbeat: check ALL delegated tasks every cycle.
   *  Phase 1: Timeout checks (always runs, even during isProcessing)
   *  Phase 2: Stability detection + pending prompt delivery (lightweight, no AI)
   *  Phase 3: Queue idle tasks for AI review
   *  Phase 4: Kick off review processing (one at a time, chained) */
  private static readonly TASK_CLEANUP_AGE_MS = 5 * 60 * 1000; // 5 minutes

  // ── Open question detection patterns ──────────────────────────────
  // Y/N patterns we do NOT treat as open questions (auto-approve handles these)
  private static readonly YN_EXCLUSION_PATTERNS = [
    /\[y\/n\]/i, /\[Y\/n\]/, /\[y\/N\]/, /\(yes\/no\)/i, /\(y\/n\)/i,
    /allow (this action|bash|command|running|tool|edit|execution)/i,
    /dangerous command/i, /Esc\s*to\s*cancel/i, /1\.?\s*Yes/,
    /allowalledits/i, /apply (this )?edit\?/i,
    /\?\s*›/,                       // inquirer prompt marker
    /\?\s*\[[^\]]{0,20}\]/,          // short bracket choices: [y/n], [yes]
    /\?\s*\([^)]{0,20}\)/,           // short paren choices: (yes/no), (y/n)
  ];

  // Conversational question patterns (German + English)
  private static readonly OPEN_QUESTION_PATTERNS = [
    // German
    /(?:soll|willst|möchtest|kannst|darf)\s+(?:ich|du|wir)\s+.{5,80}\?/i,
    /(?:welch|was|wie|wo|wann|warum|woran)\s+.{5,60}\?/i,
    /(?:hast du|gibt es|brauchst du)\s+.{5,60}\?/i,
    /(?:bevorzugst|präferierst)\s+.{3,60}\?/i,
    // English
    /(?:should|shall|would you like|do you want)\s+.{5,80}\?/i,
    /(?:which|what|how|where|when)\s+.{5,80}\?/i,
    /(?:would you prefer|do you prefer)\s+.{3,60}\?/i,
    /(?:can you|could you)\s+(?:tell|clarify|specify|confirm|decide)\s+.{3,60}\?/i,
    // Choice patterns (A oder B? / A or B?)
    /\b\w+\s+(?:oder|or)\s+\w+[^?]{0,40}\?/i,
  ];

  // Lines that are NOT questions (false positive suppression)
  private static readonly QUESTION_FALSE_POSITIVE = [
    /^#/,                           // Markdown headers
    /^[-*]\s/,                      // List items
    /╭──|╰──|│/,                   // Box drawing (Claude Code UI)
    /^\s*\d+\.\s/,                  // Numbered lists
    /https?:\/\//,                  // URLs containing ?
    /^\s*\/\//,                     // Code comments
    /console\.|print|log|echo/i,   // Code output
    /\bfunction\b|\bconst\b|\blet\b|\bvar\b|\bdef\b/,  // Code
    /what could go wrong/i,         // Rhetorical
    /you might wonder/i,            // Rhetorical
  ];

  private async heartbeat(): Promise<void> {
    // ── Phase 0: Cleanup completed/failed tasks older than 5 minutes ──
    // Don't clean up tasks linked to an active orchestrator
    const now = Date.now();
    const activeOrchestratorLinkedIds = new Set<string>();
    for (const t of this.delegatedTasks) {
      if (t.sessionId === '' && t.status !== 'done' && t.status !== 'failed' && t.linkedTaskIds) {
        for (const id of t.linkedTaskIds) activeOrchestratorLinkedIds.add(id);
      }
    }
    const beforeCount = this.delegatedTasks.length;
    this.delegatedTasks = this.delegatedTasks.filter(t => {
      if ((t.status === 'done' || t.status === 'failed') && (now - t.updatedAt) > ManagerService.TASK_CLEANUP_AGE_MS) {
        if (activeOrchestratorLinkedIds.has(t.id)) return true; // Keep — orchestrator needs it
        this.stableOutputCounts.delete(t.id);
        // Clean up retry counters for this task
        for (const key of this.orchestratorRetryCount.keys()) {
          if (key.startsWith(t.id + ':')) this.orchestratorRetryCount.delete(key);
        }
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
      // Orchestrator tasks (no sessionId) — process via orchestrator logic
      if (!task.sessionId) {
        if (this.processOrchestratorTask(task)) actionsTaken++;
        continue;
      }

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
      const requiredStableCycles = isClaudeReady ? 1 : 2;
      const outputChanged = currentOutput !== task.lastCheckedOutput;
      const stableCount = outputChanged ? 0 : (this.stableOutputCounts.get(task.id) ?? 0) + 1;

      // Always log heartbeat state for debugging
      logger.info(`Manager: heartbeat "${task.sessionLabel}" — age=${Math.round(age / 1000)}s, bufLen=${currentOutput.length}, changed=${outputChanged}, stable=${stableCount}/${requiredStableCycles}, ready=${isClaudeReady}, shell=${isShellPrompt}, prompt=${!!task.pendingPrompt}, tail="${currentOutput.slice(-40).replace(/\n/g, '\\n')}"`);

      if (outputChanged) {
        task.lastCheckedOutput = currentOutput;
        task.updatedAt = Date.now();
        this.stableOutputCounts.set(task.id, 0);
        continue;
      }

      this.stableOutputCounts.set(task.id, stableCount);
      if (stableCount < requiredStableCycles) continue;

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

        // Auto-complete the 'on_prompt_sent' step immediately (don't wait for next cycle)
        const promptStep = task.steps.find(s => s.status === 'running' && s.trigger === 'on_prompt_sent');
        if (promptStep) {
          this.completeStepAndAdvance(task, promptStep);
          logger.info(`Manager: auto-completed "on_prompt_sent" step for "${task.sessionLabel}"`);
        }

        this.broadcastTasks();
        actionsTaken++;
        continue;
      }

      // ── Phase 3b: Auto-complete monitoring tasks (0 steps, no prompt) ──
      if (task.steps.length === 0 && !task.pendingPrompt && isComplete) {
        logger.info(`Manager: monitoring task "${task.sessionLabel}" idle — marking done`);
        this.updateTaskStatus(task.id, 'done');
        actionsTaken++;
        continue;
      }

      // ── Phase 3c: System-driven step completion (trigger-based) ────
      // The system checks each running step's trigger and auto-completes it.
      // Only 'ai_input' steps need the AI — everything else is system-managed.
      if (task.status === 'running' && isComplete) {
        const currentStep = task.steps.find(s => s.status === 'running');
        if (currentStep) {
          let autoCompleted = false;

          if (currentStep.trigger === 'on_create') {
            // Terminal was created — should already be done via autoCompleteStepsFromToolExecution
            // If somehow still running, auto-complete now
            this.completeStepAndAdvance(task, currentStep);
            autoCompleted = true;
          } else if (currentStep.trigger === 'on_prompt_sent') {
            // Already handled in Phase 3a when prompt is actually delivered.
            // If we get here, the prompt was already sent — step should be done.
            // Only complete if prompt was actually delivered (step should have been
            // completed in Phase 3a, this is a safety net).
            if (!task.pendingPrompt) {
              this.completeStepAndAdvance(task, currentStep);
              autoCompleted = true;
            }
            // If pendingPrompt still exists, wait for delivery in Phase 3a
          } else if (currentStep.trigger === 'on_claude_idle' && isClaudeReady) {
            // Check for open question before auto-completing
            const questionText = this.detectOpenQuestion(lastChunk);
            if (questionText) {
              this.handleOpenQuestion(task.sessionId, task, questionText);
              actionsTaken++;
              continue; // Don't auto-complete — Claude asked a question
            }
            // Claude genuinely finished its work and is idle
            this.completeStepAndAdvance(task, currentStep);
            autoCompleted = true;
          } else if (currentStep.trigger === 'on_write') {
            // Should be completed by autoCompleteStepsFromToolExecution on write_to_terminal
            // If still running but terminal is idle, auto-complete
            this.completeStepAndAdvance(task, currentStep);
            autoCompleted = true;
          }

          if (autoCompleted) {
            logger.info(`Manager: system auto-completed step "${currentStep.label}" [${currentStep.trigger}] for "${task.sessionLabel}"`);
            actionsTaken++;
            // Check if the NEXT step can also be auto-completed (chain)
            continue; // Re-evaluate on next heartbeat cycle
          }
        }
      }

      // ── Phase 3d: Queue for AI review (only for ai_input steps) ────
      if (task.status === 'running' && !task.pendingPrompt && isComplete) {
        const currentStep = task.steps.find(s => s.status === 'running');
        const needsAI = !currentStep || currentStep.trigger === 'ai_input' || currentStep.trigger === 'manual';
        const alreadyQueued = this.reviewQueue.includes(task.id);
        const isInFlight = this.reviewInFlight.has(task.id);

        if (needsAI && !alreadyQueued && !isInFlight) {
          logger.info(`Manager: heartbeat — step "${currentStep?.label}" needs AI input, queuing "${task.sessionLabel}"`);
          this.reviewQueue.push(task.id);
          this.notifyTaskEvent(task, 'needs_input');
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

  /** Orchestrator: check if all linked terminals are ready, then queue for AI review.
   *  Lightweight — no AI calls, just state checking every 15s. */
  private processOrchestratorTask(task: DelegatedTask): boolean {
    // Auto-complete if all steps done
    if (task.steps.length > 0 && task.steps.every(s => s.status === 'done')) {
      logger.info(`Orchestrator: "${task.description}" completed — all steps done`);
      this.updateTaskStatus(task.id, 'done');
      return true;
    }

    const linkedTasks = (task.linkedTaskIds ?? [])
      .map(id => this.delegatedTasks.find(t => t.id === id))
      .filter((t): t is DelegatedTask => !!t);

    const hasLinks = linkedTasks.length > 0;

    // Keep-alive: refresh updatedAt while linked terminals are still active
    if (hasLinks) {
      const hasActiveLinked = linkedTasks.some(t => t.status === 'running' || t.status === 'waiting');
      if (hasActiveLinked) {
        task.updatedAt = Date.now();
      }
    }

    // Timeout check
    const taskAge = Date.now() - task.updatedAt;
    if (taskAge > ManagerService.TASK_TIMEOUT_MS) {
      logger.warn(`Orchestrator: "${task.description}" timed out`);
      this.updateTaskStatus(task.id, 'failed');
      return true;
    }

    const currentStep = task.steps.find(s => s.status === 'running');
    if (!currentStep) return false;

    // ── Steps that need linked terminals ──────────────────────────
    if (hasLinks) {
      // on_create — auto-complete when all terminals exist
      if (currentStep.trigger === 'on_create') {
        const allCreated = linkedTasks.every(t =>
          t.steps.some(s => s.trigger === 'on_create' && s.status === 'done')
        );
        if (allCreated) {
          this.completeStepAndAdvance(task, currentStep);
          logger.info(`Orchestrator: "${currentStep.label}" done — all ${linkedTasks.length} terminals created`);
          return true;
        }
        return false;
      }

      // on_claude_idle — auto-complete when ALL terminals have Claude idle
      if (currentStep.trigger === 'on_claude_idle') {
        const allIdle = linkedTasks.every(t => {
          if (t.status === 'done' || t.status === 'failed') return true;
          const claudeStep = t.steps.find(s => s.trigger === 'on_claude_idle');
          if (!claudeStep) return t.steps.every(s => s.status === 'done' || s.status === 'failed'); // No idle step → all steps done?
          return claudeStep.status === 'done';
        });
        if (allIdle) {
          this.completeStepAndAdvance(task, currentStep);
          logger.info(`Orchestrator: "${currentStep.label}" done — all ${linkedTasks.length} terminals idle`);
          return true;
        }
        return false;
      }
    } else if (currentStep.trigger === 'on_claude_idle' || currentStep.trigger === 'on_create' || currentStep.trigger === 'on_prompt_sent') {
      // These triggers WITHOUT linked terminals can't auto-complete.
      // Fall through to ai_input handler below WITHOUT mutating the trigger permanently.
      logger.info(`Orchestrator: "${currentStep.label}" [${currentStep.trigger}] has no linked terminals — treating as ai_input`);
    }

    // ── ai_input steps — queue for AI review ─────────────────────
    // Works with AND without linked terminals
    // ai_input OR unlinked triggers that fell through from above
    if (currentStep.trigger === 'ai_input' || (!hasLinks && (currentStep.trigger === 'on_claude_idle' || currentStep.trigger === 'on_create' || currentStep.trigger === 'on_prompt_sent'))) {
      // If we have linked terminals, wait for all to be idle first
      if (hasLinks) {
        const allReady = linkedTasks.every(t => {
          if (t.status === 'done' || t.status === 'failed') return true;
          const claudeStep = t.steps.find(s => s.trigger === 'on_claude_idle');
          if (!claudeStep) return t.steps.every(s => s.status === 'done' || s.status === 'failed'); // No idle step → all steps done?
          return claudeStep.status === 'done';
        });
        if (!allReady) return false;
      }

      // Queue for AI review (once)
      const alreadyQueued = this.reviewQueue.includes(task.id);
      const isInFlight = this.reviewInFlight.has(task.id);
      if (!alreadyQueued && !isInFlight) {
        logger.info(`Orchestrator: ${hasLinks ? `all ${linkedTasks.length} terminals ready — ` : ''}queuing "${currentStep.label}"`);
        this.reviewQueue.push(task.id);
        return true;
      }
    }

    return false;
  }

  /** Process queued task reviews one at a time, chaining the next review
   *  after each completion to ensure all tasks get attention. */
  private async processReviewQueue(): Promise<void> {
    // System slot: allows reviews to run even while user chat is processing
    // (LM Studio supports 4 concurrent slots). Only blocks concurrent reviews.
    if (this.isSystemProcessing) return;
    if (this.reviewQueue.length === 0) return;
    this.isSystemProcessing = true;

    // Find next valid task to review (skip completed/failed tasks)
    let task: DelegatedTask | undefined;
    while (this.reviewQueue.length > 0 && !task) {
      const taskId = this.reviewQueue.shift()!;
      const candidate = this.delegatedTasks.find(t => t.id === taskId);
      if (candidate && (candidate.status === 'running' || candidate.status === 'waiting')) {
        task = candidate;
      }
    }
    if (!task) { this.isSystemProcessing = false; return; }

    logger.info(`Manager: reviewing "${task.sessionLabel}" (${this.reviewQueue.length} more in queue)`);
    this.reviewInFlight.add(task.id);

    try {
    // ── Smart heartbeat: analyze state BEFORE waking the AI ────────
    // Check if there's actually something actionable to do
    const pendingSteps = task.steps.filter(s => s.status === 'pending' || s.status === 'running');
    const currentStep = task.steps.find(s => s.status === 'running');

    // If all steps done → just mark complete, don't wake AI
    if (task.steps.length > 0 && pendingSteps.length === 0) {
      logger.info(`Manager: smart heartbeat — all steps done for "${task.sessionLabel}", auto-completing without AI call`);
      this.updateTaskStatus(task.id, 'done');
      this.isSystemProcessing = false;
      if (this.reviewQueue.length > 0) {
        setTimeout(() => this.processReviewQueue(), 500);
      }
      return;
    }

    task.status = 'waiting';
    task.updatedAt = Date.now();
    this.broadcastTasks();

    let heartbeatPrompt: string;

    // ── ORCHESTRATOR TASK: aggregate all terminal outputs ──────────
    if (!task.sessionId && task.linkedTaskIds) {
      const linkedTasks = task.linkedTaskIds
        .map(id => this.delegatedTasks.find(t => t.id === id))
        .filter((t): t is DelegatedTask => !!t);

      const outputs = linkedTasks.map(lt => {
        const buf = this.outputBuffers.get(lt.sessionId);
        const out = buf?.data?.replace(ANSI_STRIP, '').slice(-600) ?? '(kein Output)';
        return `${lt.sessionLabel}:\n${out}`;
      }).join('\n\n---\n\n');

      const labels = linkedTasks.map(t => `"${t.sessionLabel}"`).join(', ');
      const stepLower = currentStep?.label?.toLowerCase() ?? '';

      if (/q&a|frage|runde/i.test(stepLower)) {
        heartbeatPrompt = `[ORCHESTRATOR] Alle ${linkedTasks.length} Terminals (${labels}) sind bereit für "${currentStep!.label}". Sende jetzt Q&A-Fragen an ALLE Terminals mit write_to_terminal.\n\n${outputs}`;
      } else if (/präsentation|ppt|summary|zusammenfass/i.test(stepLower)) {
        heartbeatPrompt = `[ORCHESTRATOR] Alle Ergebnisse liegen vor. Erstelle jetzt Präsentationen mit create_presentation.\n\n${outputs}`;
      } else if (/deploy|push|merge|release|publish/i.test(stepLower)) {
        heartbeatPrompt = `[ORCHESTRATOR] Alle ${linkedTasks.length} Terminals (${labels}) sind bereit. Führe jetzt "${currentStep!.label}" aus — nutze write_to_terminal für Shell-Befehle oder git_info für Git-Operationen.\n\n${outputs}`;
      } else if (/test|build|install|compil/i.test(stepLower)) {
        heartbeatPrompt = `[ORCHESTRATOR] Alle ${linkedTasks.length} Terminals (${labels}) sind bereit. Starte "${currentStep!.label}" in allen Terminals mit write_to_terminal.\n\n${outputs}`;
      } else if (/commit|speicher|sicher/i.test(stepLower)) {
        heartbeatPrompt = `[ORCHESTRATOR] Alle ${linkedTasks.length} Terminals sind fertig. Führe "${currentStep!.label}" aus — nutze write_to_terminal oder git_info.\n\n${outputs}`;
      } else if (/bild|image|generier|logo|design/i.test(stepLower)) {
        heartbeatPrompt = `[ORCHESTRATOR] Schritt "${currentStep!.label}" — nutze generate_image oder andere passende Tools.\n\n${outputs}`;
      } else {
        heartbeatPrompt = `[ORCHESTRATOR] Alle ${linkedTasks.length} Terminals (${labels}) sind bereit. Nächster Schritt: "${currentStep!.label}". Nutze die passenden Tools (write_to_terminal, read_file, create_presentation, etc.).\n\n${outputs}`;
      }
    }
    // ── REGULAR TASK: single terminal review ──────────────────────
    else {
      const buffer = this.outputBuffers.get(task.sessionId);
      const recentOutput = buffer?.data?.replace(ANSI_STRIP, '').slice(-1500) ?? '';
      const lastChunk = recentOutput.slice(-500);

      const claudeFinished =
        /for\s*shortcuts/i.test(lastChunk) ||
        /shells?\s*.*\s*esc/i.test(lastChunk) ||
        /waiting\s*for\s*input/i.test(lastChunk) ||
        (/claude\s*code/i.test(lastChunk.slice(-200)) && /[>❯›]\s*$/.test(lastChunk.slice(-40)));
      const tail50 = lastChunk.slice(-50).toLowerCase();
      const claudeWorking = /\b(thinking|reading|writing|searching|analyzing)\b/.test(tail50)
        || /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(tail50)
        || /\.{3}\s*$/.test(tail50);

      if (claudeWorking && !claudeFinished) {
        logger.info(`Manager: Claude still working in "${task.sessionLabel}", skipping`);
        task.status = 'running';
        this.broadcastTasks();
        this.isSystemProcessing = false;
        if (this.reviewQueue.length > 0) setTimeout(() => this.processReviewQueue(), 2000);
        return;
      }

      const stepLower = currentStep?.label?.toLowerCase() ?? '';
      const termLabel = task.sessionLabel;

      if (currentStep?.trigger === 'ai_input') {
        if (/q&a|frage|runde/i.test(stepLower)) {
          heartbeatPrompt = `[HEARTBEAT] Claude in "${termLabel}" ist fertig. Sende jetzt eine Q&A-Frage mit write_to_terminal an "${termLabel}".`;
        } else if (/präsentation|ppt|summary|zusammenfass/i.test(stepLower)) {
          heartbeatPrompt = `[HEARTBEAT] "${termLabel}" ist fertig. Erstelle die Präsentation mit create_presentation.`;
        } else {
          heartbeatPrompt = `[HEARTBEAT] "${termLabel}" ist idle. Führe "${currentStep.label}" aus.`;
        }
      } else {
        heartbeatPrompt = `[HEARTBEAT] "${termLabel}" ist idle. Nächster Schritt: "${currentStep?.label ?? 'fertig'}".`;
      }
    }

    try {
      // If user chat is processing, wait up to 10s for it to finish
      // instead of immediately queuing (which loses the review context)
      if (this.isProcessing) {
        let waited = 0;
        while (this.isProcessing && waited < 10_000) {
          await new Promise(r => setTimeout(r, 500));
          waited += 500;
        }
      }

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

      // The AI responded to the review — check if it actually DID something
      const reviewedStep = task.steps.find(s => s.status === 'running' && s.trigger === 'ai_input');
      if (reviewedStep) {
        // For ALL orchestrator ai_input steps: verify the AI actually made tool calls.
        // Gemma 4 sometimes just SAYS "done!" without calling any tools.
        // Applies to Q&A AND presentation steps.
        if (!task.sessionId && !this.lastChatHadToolCalls) {
          const retryKey = `${task.id}:${reviewedStep.label}`;
          const retries = (this.orchestratorRetryCount.get(retryKey) ?? 0) + 1;
          this.orchestratorRetryCount.set(retryKey, retries);

          if (retries <= 3) {
            logger.warn(`Orchestrator: AI responded to "${reviewedStep.label}" without tool calls — retry ${retries}/3`);
            task.status = 'running';
            task.updatedAt = Date.now();
            this.broadcastTasks();
            // Re-queue this task for retry + chain other queued tasks
            if (!this.reviewQueue.includes(task.id)) {
              this.reviewQueue.push(task.id);
            }
            return; // finally block resets isSystemProcessing + reviewInFlight
          } else {
            // Max retries reached — complete the step anyway to avoid infinite loop
            logger.warn(`Orchestrator: "${reviewedStep.label}" failed after 3 retries without tool calls — skipping`);
            this.orchestratorRetryCount.delete(retryKey);
            // Notify user that a step was skipped
            this.onStreamEnd?.(`⚠️ Schritt "${reviewedStep.label}" wurde übersprungen — die AI hat nach 3 Versuchen keine Aktion ausgeführt. Der Workflow fährt mit dem nächsten Schritt fort.`, [], [], undefined, undefined);
          }
        } else {
          // Tool calls were made — clear retry counter
          const retryKey = `${task.id}:${reviewedStep.label}`;
          this.orchestratorRetryCount.delete(retryKey);
        }

        this.completeStepAndAdvance(task, reviewedStep);
        logger.info(`Manager: ai_input step "${reviewedStep.label}" completed for "${task.description}" (AI responded with actions)`);

        // ORCHESTRATOR: reset linked per-terminal tasks for next round
        if (!task.sessionId && task.linkedTaskIds) {
          const hasMoreSteps = task.steps.some(s => s.status === 'pending' || s.status === 'running');
          if (hasMoreSteps) {
            for (const ltId of task.linkedTaskIds) {
              const lt = this.delegatedTasks.find(t => t.id === ltId);
              if (!lt) continue;
              const claudeStep = lt.steps.find(s => s.trigger === 'on_claude_idle');
              if (claudeStep && claudeStep.status === 'done') {
                claudeStep.status = 'running';
                lt.status = 'running';
                lt.lastCheckedOutput = undefined;
                lt.updatedAt = Date.now();
                // Reset stability counter so heartbeat doesn't immediately re-complete
                this.stableOutputCounts.delete(lt.id);
                // Snapshot current output so idle detection requires NEW output + silence
                const buf = this.outputBuffers.get(lt.sessionId);
                if (buf) {
                  lt.lastCheckedOutput = buf.data.replace(ANSI_STRIP, '').slice(-2000);
                }
              }
            }
            logger.info(`Orchestrator: reset ${task.linkedTaskIds.length} terminals for next round`);
            this.broadcastTasks();
          }
        }
      }

      const hasOpenSteps = task.steps.some(s => s.status === 'pending' || s.status === 'running');

      if (!hasOpenSteps && task.steps.length > 0) {
        this.updateTaskStatus(task.id, 'done');
        logger.info(`Manager: task "${task.description}" completed — all ${task.steps.length} steps done`);
      } else {
        task.status = 'running';
        task.lastCheckedOutput = undefined;
        task.updatedAt = Date.now();
        this.broadcastTasks();
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
      this.isSystemProcessing = false;
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

  /** Complete a specific step and advance to the next pending step. */
  private completeStepAndAdvance(task: DelegatedTask, step: TaskStep): void {
    step.status = 'done';
    // Advance: find next pending step and mark it running
    if (!task.steps.some(s => s.status === 'running')) {
      const next = task.steps.find(s => s.status === 'pending');
      if (next) next.status = 'running';
    }
    if (task.steps.every(s => s.status === 'done')) {
      task.status = 'done';
    }
    task.updatedAt = Date.now();
    this.broadcastTasks();
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
          const globalMgr = globalManager;
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
        setTimeout(() => globalManager.write(sessionId, `cd ${dir} && claude\r`), 800);
        this.addDelegatedTask(`Cron: ${job.name}`, sessionId, job.command);
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
    if (this.activeVoiceSession?.isBusy()) {
      throw new Error('Provider-Wechsel während aktivem Voice-Turn blockiert. Warte auf Antwortende.');
    }
    this.registry.setActive(id);
  }

  updateProviderConfig(updates: Partial<ProviderConfig>): void {
    this.registry.updateConfig(updates);
  }

  /** Get active sessions with labels for the client. */
  getSessionList(): Array<{ sessionId: string; label: string }> {
    return [...this.sessionLabels.entries()].map(([id, label]) => ({ sessionId: id, label }));
  }

  /** Create (or replace) a VoiceSessionController for a WebSocket connection. */
  createVoiceSession(emit: VoiceEmitter): VoiceSessionController {
    const session = new VoiceSessionController({
      registry: {
        getActive: () => {
          const provider = this.registry.getActive();
          return {
            id: provider.id,
            chatStream: (
              messages: Array<{ role: string; content: string }>,
              systemPrompt: string,
              onChunk: (token: string) => void,
            ) => provider.chatStream(messages as ChatMessage[], systemPrompt, onChunk),
          };
        },
      },
      whisper: {
        transcribe: async (audio: Buffer): Promise<string> => {
          // whisper-sidecar expects base64-encoded audio, not a raw Buffer
          const audioBase64 = audio.toString('base64');
          return whisperTranscribe(audioBase64);
        },
      },
      tts: {
        synthesizeChunked: async (text: string, onChunk): Promise<void> => {
          await synthesizeChunked(text, onChunk);
        },
      },
      emit,
      systemPrompt: buildSystemPrompt(this.personality),
    });
    this.activeVoiceSession = session;
    return session;
  }

  /** Returns the currently active voice session, if any (used for provider-switch blocking). */
  getActiveVoiceSession(): VoiceSessionController | null {
    return this.activeVoiceSession;
  }
}
