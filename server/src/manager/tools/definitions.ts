import type { ToolDefinition } from '../ai-provider';

// Moved verbatim out of manager.service.ts (was lines 33–405). Behaviour unchanged.
export const MANAGER_TOOLS: ToolDefinition[] = [
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
          target_dir: { type: 'string', description: 'Arbeitsverzeichnis, z.B. "~/Desktop/tms-terminal"' },
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
          directory: { type: 'string', description: 'Git-Verzeichnis, z.B. "~/Desktop/tms-terminal"' },
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
          model: { type: 'string', description: 'Model-Name wie in LM Studio angezeigt, z.B. "gemma-4-31b", "qwen3-coder-30b"' },
          reason: { type: 'string', description: 'Warum der Wechsel (für Logging)' },
        },
        required: ['model'],
      },
    },
  },
  // ── Stufe 1: Überblick, Agenda, Einträge, proaktiver Kanal ──────────────
  {
    type: 'function',
    function: {
      name: 'get_overview',
      description: 'Der aktuelle Gesamtstand: offene Terminals, offene To-dos, anstehende Termine, plus das heutige Datum. Rufe das auf, wenn der Nutzer fragt wie es läuft, was ansteht, oder bevor du ein Datum ausrechnest.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_project',
      description: 'Ein einzelnes Projekt im Detail: Pfad, Git-Branch, letzte Sitzungsthemen, Auszug der CLAUDE.md, offene To-dos dazu.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Projektname oder Teil des Pfads, z.B. "TMS Terminal"' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agenda',
      description: 'Termine und Erinnerungen verwalten. WICHTIG: "at" muss immer das Format YYYY-MM-DDTHH:MM haben (lokale Zeit) — rechne relative Angaben wie "in einer Woche" selbst aus, das heutige Datum steht in get_overview. Für Geburtstage: all_day=true und repeat=yearly.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list, add, update oder delete' },
          id: { type: 'string', description: 'Termin-ID (für update/delete)' },
          title: { type: 'string', description: 'Titel, z.B. "Zahnarzt" oder "Geburtstag Mama"' },
          at: { type: 'string', description: 'Zeitpunkt als YYYY-MM-DDTHH:MM, z.B. "2026-08-04T14:00"' },
          all_day: { type: 'string', description: '"true" für ganztägig (Geburtstage)' },
          repeat: { type: 'string', description: 'none, daily, weekly, monthly oder yearly' },
          reminder_offsets: { type: 'string', description: 'Minuten VOR dem Termin, komma-getrennt. "2880,1440,60" = 2 Tage, 1 Tag und 1 Stunde vorher. "0" = zum Termin.' },
          note: { type: 'string', description: 'Freitext — was der Nutzer wörtlich gesagt hat' },
          days: { type: 'string', description: 'Für list: wie viele Tage voraus. Standard 30.' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'entries',
      description: 'Notizen und To-dos verwalten. checkable=true macht ein abhakbares To-do, sonst ist es eine reine Notiz. Schau hier rein, bevor du beurteilst was noch offen ist.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list, add, complete, reopen, update oder delete' },
          id: { type: 'string', description: 'Eintrags-ID' },
          text: { type: 'string', description: 'Der Text des Eintrags' },
          checkable: { type: 'string', description: '"true" für ein abhakbares To-do, sonst Notiz' },
          due: { type: 'string', description: 'Optionale Frist als YYYY-MM-DDTHH:MM' },
          project: { type: 'string', description: 'Optionale Projektzuordnung' },
          only_open: { type: 'string', description: 'Für list: "true" zeigt nur offene To-dos' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notify_user',
      description: 'Schreibe dem Nutzer von dir aus — für eigene Beobachtungen und Vorschläge. Setze topic_key auf einen stabilen Schlüssel des Themas, damit dasselbe nie zweimal kommt. Wenn die Dosierung ablehnt, versuche es NICHT erneut. Vom Nutzer beauftragte Erinnerungen gehören nicht hierher, sondern in agenda.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Die Nachricht an den Nutzer' },
          kind: { type: 'string', description: 'stuck (er hängt fest), suggestion (Idee), event (Ereignis), checkin (Tageszusammenfassung)' },
          topic_key: { type: 'string', description: 'Stabiler Themenschlüssel, z.B. "stuck:<fehler-hash>"' },
          project: { type: 'string', description: 'Betroffenes Projekt' },
          session_id: { type: 'string', description: 'Betroffenes Terminal' },
        },
        required: ['text'],
      },
    },
  },
];
