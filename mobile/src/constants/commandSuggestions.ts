// ── Command Suggestion Database ─────────────────────────────────────────────
// Curated local database of ~80 common tasks mapped to shell commands.
// Used by the "??" feature: user types e.g. "große dateien finden??" and
// the app shows matching command suggestions without any external AI API.

export interface CommandSuggestion {
  keywords: string[];  // search terms (German + English)
  command: string;     // the actual command
  description: string; // short German description
}

export const COMMAND_DATABASE: CommandSuggestion[] = [
  // ── File operations ─────────────────────────────────────────────────────────
  { keywords: ['große dateien', 'large files', 'big files', 'speicherplatz'], command: 'find . -size +100M -type f', description: 'Dateien größer als 100 MB finden' },
  { keywords: ['große dateien', 'disk usage', 'speicher', 'platz'], command: 'du -sh * | sort -rh | head -20', description: 'Größte Ordner/Dateien anzeigen' },
  { keywords: ['datei suchen', 'find file', 'finden'], command: 'find . -name "FILENAME" -type f', description: 'Datei nach Name suchen' },
  { keywords: ['text suchen', 'grep', 'inhalt suchen', 'search text'], command: 'grep -rn "SEARCH" .', description: 'Text in Dateien suchen' },
  { keywords: ['löschen', 'delete', 'remove', 'entfernen'], command: 'rm -rf PFAD', description: 'Datei/Ordner löschen' },
  { keywords: ['kopieren', 'copy', 'cp'], command: 'cp -r QUELLE ZIEL', description: 'Datei/Ordner kopieren' },
  { keywords: ['verschieben', 'move', 'mv', 'umbenennen', 'rename'], command: 'mv QUELLE ZIEL', description: 'Verschieben/Umbenennen' },
  { keywords: ['rechte', 'permissions', 'chmod', 'berechtigung'], command: 'chmod -R 755 PFAD', description: 'Berechtigungen setzen' },
  { keywords: ['besitzer', 'owner', 'chown'], command: 'chown -R USER:GROUP PFAD', description: 'Besitzer ändern' },
  { keywords: ['symlink', 'link', 'verknüpfung'], command: 'ln -s ZIEL LINKNAME', description: 'Symbolischen Link erstellen' },
  { keywords: ['leere dateien', 'empty files'], command: 'find . -empty -type f', description: 'Leere Dateien finden' },
  { keywords: ['zuletzt geändert', 'recently modified', 'letzte änderung'], command: 'find . -mtime -1 -type f', description: 'Heute geänderte Dateien' },
  { keywords: ['datei typ', 'file type', 'extension', 'endung'], command: 'find . -name "*.EXT" -type f', description: 'Dateien nach Endung suchen' },
  { keywords: ['ordner erstellen', 'mkdir', 'verzeichnis'], command: 'mkdir -p PFAD', description: 'Ordner erstellen (inkl. Eltern)' },
  { keywords: ['dateigröße', 'file size', 'wie groß'], command: 'ls -lh DATEI', description: 'Dateigröße anzeigen' },
  { keywords: ['baum', 'tree', 'verzeichnisstruktur', 'ordnerstruktur'], command: 'tree -L 2', description: 'Verzeichnisbaum (2 Ebenen)' },

  // ── Process management ──────────────────────────────────────────────────────
  { keywords: ['prozess', 'process', 'running', 'laufend'], command: 'ps aux | grep PROZESS', description: 'Laufende Prozesse suchen' },
  { keywords: ['kill', 'beenden', 'stoppen', 'process kill'], command: 'kill -9 PID', description: 'Prozess beenden' },
  { keywords: ['port', 'listening', 'welcher port', 'port belegt'], command: 'lsof -i :PORT', description: 'Prozess auf Port finden' },
  { keywords: ['top', 'cpu', 'auslastung', 'ressourcen'], command: 'top -o cpu', description: 'CPU-Auslastung anzeigen' },
  { keywords: ['speicher', 'memory', 'ram'], command: 'free -h', description: 'RAM-Auslastung anzeigen' },
  { keywords: ['hintergrund', 'background', 'nohup'], command: 'nohup BEFEHL &', description: 'Im Hintergrund ausführen' },
  { keywords: ['alle prozesse', 'all processes'], command: 'ps aux --sort=-%mem | head -20', description: 'Top 20 Prozesse nach RAM' },

  // ── Network ─────────────────────────────────────────────────────────────────
  { keywords: ['ip', 'netzwerk', 'network', 'ip adresse'], command: 'ifconfig | grep inet', description: 'IP-Adresse anzeigen' },
  { keywords: ['ping', 'erreichbar', 'reachable'], command: 'ping -c 4 HOST', description: 'Host anpingen' },
  { keywords: ['download', 'herunterladen', 'wget', 'curl'], command: 'curl -O URL', description: 'Datei herunterladen' },
  { keywords: ['offene ports', 'open ports', 'netstat'], command: 'netstat -tlnp', description: 'Offene Ports anzeigen' },
  { keywords: ['dns', 'lookup', 'auflösen'], command: 'nslookup DOMAIN', description: 'DNS auflösen' },
  { keywords: ['traceroute', 'route', 'netzwerkpfad'], command: 'traceroute HOST', description: 'Netzwerkpfad verfolgen' },
  { keywords: ['bandbreite', 'bandwidth', 'speed', 'geschwindigkeit'], command: 'curl -o /dev/null -w "%{speed_download}" URL', description: 'Download-Geschwindigkeit testen' },
  { keywords: ['http', 'request', 'api', 'anfrage'], command: 'curl -X GET URL -H "Content-Type: application/json"', description: 'HTTP-Request senden' },
  { keywords: ['post', 'json', 'api senden'], command: 'curl -X POST URL -H "Content-Type: application/json" -d \'{"key":"value"}\'', description: 'JSON POST-Request' },
  { keywords: ['ssl', 'zertifikat', 'certificate'], command: 'openssl s_client -connect HOST:443 -servername HOST', description: 'SSL-Zertifikat prüfen' },

  // ── Git ─────────────────────────────────────────────────────────────────────
  { keywords: ['git status', 'änderungen', 'changes'], command: 'git status', description: 'Git Status anzeigen' },
  { keywords: ['git log', 'history', 'verlauf', 'commits'], command: 'git log --oneline -20', description: 'Letzte 20 Commits' },
  { keywords: ['git branch', 'branches', 'zweige'], command: 'git branch -a', description: 'Alle Branches anzeigen' },
  { keywords: ['git diff', 'unterschiede', 'diff'], command: 'git diff', description: 'Änderungen anzeigen' },
  { keywords: ['git stash', 'zwischenspeichern'], command: 'git stash', description: 'Änderungen zwischenspeichern' },
  { keywords: ['git reset', 'rückgängig', 'undo'], command: 'git reset --soft HEAD~1', description: 'Letzten Commit rückgängig' },
  { keywords: ['git clone', 'klonen', 'repo'], command: 'git clone URL', description: 'Repository klonen' },
  { keywords: ['git blame', 'wer hat', 'schuld', 'author'], command: 'git blame DATEI', description: 'Zeilenweise Autor anzeigen' },
  { keywords: ['git cherry-pick', 'commit übernehmen'], command: 'git cherry-pick COMMIT_HASH', description: 'Einzelnen Commit übernehmen' },
  { keywords: ['git tag', 'version', 'release tag'], command: 'git tag -a v1.0.0 -m "Release"', description: 'Git Tag erstellen' },

  // ── Docker ──────────────────────────────────────────────────────────────────
  { keywords: ['docker', 'container', 'laufende container'], command: 'docker ps', description: 'Laufende Container' },
  { keywords: ['docker logs', 'container logs'], command: 'docker logs -f CONTAINER', description: 'Container-Logs streamen' },
  { keywords: ['docker stop', 'container stoppen'], command: 'docker stop CONTAINER', description: 'Container stoppen' },
  { keywords: ['docker images', 'bilder'], command: 'docker images', description: 'Docker Images auflisten' },
  { keywords: ['docker exec', 'container shell', 'in container'], command: 'docker exec -it CONTAINER /bin/sh', description: 'Shell im Container öffnen' },
  { keywords: ['docker compose', 'compose up'], command: 'docker compose up -d', description: 'Docker Compose starten' },
  { keywords: ['docker build', 'image bauen'], command: 'docker build -t NAME .', description: 'Docker Image bauen' },
  { keywords: ['docker prune', 'aufräumen', 'cleanup docker'], command: 'docker system prune -af', description: 'Docker aufräumen (alles)' },

  // ── System ──────────────────────────────────────────────────────────────────
  { keywords: ['disk', 'festplatte', 'speicherplatz', 'df'], command: 'df -h', description: 'Festplattenspeicher anzeigen' },
  { keywords: ['uptime', 'laufzeit'], command: 'uptime', description: 'System-Laufzeit' },
  { keywords: ['wer', 'who', 'eingeloggt', 'users'], command: 'who', description: 'Eingeloggte Benutzer' },
  { keywords: ['environment', 'env', 'umgebung', 'variablen'], command: 'env | sort', description: 'Umgebungsvariablen anzeigen' },
  { keywords: ['cron', 'cronjob', 'zeitplan', 'scheduled'], command: 'crontab -l', description: 'Cronjobs anzeigen' },
  { keywords: ['service', 'dienst', 'systemctl'], command: 'systemctl status DIENST', description: 'Service-Status prüfen' },
  { keywords: ['reboot', 'neustart', 'restart'], command: 'sudo reboot', description: 'System neustarten' },
  { keywords: ['hostname', 'computername', 'servername'], command: 'hostname', description: 'Hostname anzeigen' },
  { keywords: ['uname', 'system info', 'os', 'betriebssystem', 'kernel'], command: 'uname -a', description: 'Systeminfo anzeigen' },
  { keywords: ['datum', 'date', 'uhrzeit', 'zeit'], command: 'date', description: 'Datum & Uhrzeit anzeigen' },
  { keywords: ['journal', 'systemlog', 'syslog'], command: 'journalctl -u DIENST --since "1 hour ago"', description: 'Systemlogs der letzten Stunde' },

  // ── Package managers ────────────────────────────────────────────────────────
  { keywords: ['npm install', 'paket installieren', 'package'], command: 'npm install PAKET', description: 'NPM Paket installieren' },
  { keywords: ['pip install', 'python paket'], command: 'pip install PAKET', description: 'Python Paket installieren' },
  { keywords: ['brew', 'homebrew', 'installieren mac'], command: 'brew install PAKET', description: 'Homebrew Paket installieren' },
  { keywords: ['apt', 'ubuntu', 'debian install'], command: 'sudo apt install PAKET', description: 'APT Paket installieren' },
  { keywords: ['npm outdated', 'veraltete pakete', 'updates npm'], command: 'npm outdated', description: 'Veraltete NPM-Pakete anzeigen' },
  { keywords: ['npm audit', 'sicherheit', 'vulnerabilities'], command: 'npm audit', description: 'NPM Sicherheitscheck' },

  // ── Text processing ─────────────────────────────────────────────────────────
  { keywords: ['zählen', 'count', 'wc', 'zeilen'], command: 'wc -l DATEI', description: 'Zeilen zählen' },
  { keywords: ['sortieren', 'sort'], command: 'sort DATEI | uniq', description: 'Sortieren & Duplikate entfernen' },
  { keywords: ['ersetzen', 'replace', 'sed'], command: "sed -i 's/ALT/NEU/g' DATEI", description: 'Text ersetzen in Datei' },
  { keywords: ['letzte zeilen', 'tail', 'ende'], command: 'tail -f DATEI', description: 'Dateiende live verfolgen' },
  { keywords: ['erste zeilen', 'head', 'anfang'], command: 'head -20 DATEI', description: 'Erste 20 Zeilen anzeigen' },
  { keywords: ['json', 'formatieren', 'pretty print', 'jq'], command: 'cat DATEI | jq .', description: 'JSON formatiert anzeigen' },
  { keywords: ['awk', 'spalte', 'column', 'feld'], command: "awk '{print $1}' DATEI", description: 'Erste Spalte ausgeben' },
  { keywords: ['diff dateien', 'vergleichen', 'compare files'], command: 'diff DATEI1 DATEI2', description: 'Zwei Dateien vergleichen' },

  // ── Compression ─────────────────────────────────────────────────────────────
  { keywords: ['zip', 'komprimieren', 'compress', 'archiv'], command: 'tar -czf archiv.tar.gz ORDNER', description: 'Ordner komprimieren' },
  { keywords: ['entpacken', 'extract', 'unzip', 'auspacken'], command: 'tar -xzf archiv.tar.gz', description: 'Archiv entpacken' },
  { keywords: ['zip erstellen', 'zip file'], command: 'zip -r archiv.zip ORDNER', description: 'ZIP-Archiv erstellen' },

  // ── SSH & Remote ────────────────────────────────────────────────────────────
  { keywords: ['ssh', 'verbinden', 'remote', 'server'], command: 'ssh user@host', description: 'SSH-Verbindung' },
  { keywords: ['scp', 'remote kopieren', 'datei übertragen'], command: 'scp DATEI user@host:PFAD', description: 'Datei per SCP übertragen' },
  { keywords: ['ssh key', 'schlüssel', 'keygen'], command: 'ssh-keygen -t ed25519', description: 'SSH-Schlüssel generieren' },
  { keywords: ['ssh tunnel', 'port forwarding', 'weiterleitung'], command: 'ssh -L LOCAL_PORT:localhost:REMOTE_PORT user@host', description: 'SSH-Tunnel / Port-Forwarding' },

  // ── Screen / tmux ───────────────────────────────────────────────────────────
  { keywords: ['tmux', 'session', 'terminal multiplexer'], command: 'tmux new -s NAME', description: 'Neue tmux-Session starten' },
  { keywords: ['tmux attach', 'tmux list', 'session fortsetzen'], command: 'tmux attach -t NAME', description: 'tmux-Session fortsetzen' },
  { keywords: ['screen', 'screen session'], command: 'screen -S NAME', description: 'Neue screen-Session' },
];

/**
 * Search the command database by a free-text query.
 * Returns up to 6 best-matching suggestions, scored by keyword/command/description overlap.
 */
export function searchCommands(query: string): CommandSuggestion[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const words = q.split(/\s+/);

  return COMMAND_DATABASE
    .map(cmd => {
      let score = 0;
      for (const word of words) {
        for (const kw of cmd.keywords) {
          if (kw.includes(word)) score += word.length;
        }
        if (cmd.command.toLowerCase().includes(word)) score += word.length * 0.5;
        if (cmd.description.toLowerCase().includes(word)) score += word.length * 0.3;
      }
      return { ...cmd, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}
