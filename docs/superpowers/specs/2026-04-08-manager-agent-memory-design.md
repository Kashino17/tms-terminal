# Manager Agent Memory System — Design Spec

_2026-04-08_

## Ziel

Der Manager Agent (Kimi K2.5 / GLM 5.0 / Claude) soll sich an vergangene Gespräche erinnern, den User über die Zeit kennenlernen, seine Persönlichkeit vertiefen und den Projekt-Kontext immer besser verstehen. Das Memory lebt server-seitig und wird bei jedem Chat als Kontext an die AI mitgegeben.

## Entscheidungen

- **Ansatz:** Intelligentes Mittelding — Langzeitgedächtnis bleibt permanent, Chat-Details werden zu Erkenntnissen destilliert
- **Speicherort:** Server-Dateisystem (`~/.tms-terminal/manager-memory.json`), eine Datei pro Server
- **Scope:** Pro Server — jeder Server hat sein eigenes Memory
- **Verdichtung:** Bei Session-Ende UND wenn >40 Nachrichten im Chat

## Speicherstruktur

Datei: `~/.tms-terminal/manager-memory.json`

```json
{
  "user": {
    "name": "",
    "role": "",
    "techStack": [],
    "preferences": [],
    "learnedFacts": []
  },
  "personality": {
    "agentName": "Manager",
    "tone": "chill",
    "detail": "balanced",
    "emojis": true,
    "proactive": true,
    "traits": [],
    "sharedHistory": []
  },
  "projects": [
    { "name": "", "path": "", "type": "", "notes": "" }
  ],
  "insights": [
    { "date": "", "text": "", "source": "chat|summary|terminal" }
  ],
  "recentChat": [
    { "role": "user|assistant", "text": "", "timestamp": 0 }
  ],
  "stats": {
    "totalSessions": 0,
    "firstInteraction": "",
    "lastInteraction": "",
    "totalMessages": 0
  }
}
```

### Feld-Beschreibungen

**user** — Wer der Nutzer ist. Wächst organisch über Gespräche.
- `name`: Display-Name des Users
- `role`: Was er macht (z.B. "Fullstack Dev", "DevOps")
- `techStack`: Technologien mit denen er arbeitet
- `preferences`: Arbeitsweise-Präferenzen (z.B. "testet sofort auf echtem Gerät")
- `learnedFacts`: Einzelne Fakten die die AI über den User gelernt hat (max 50)

**personality** — Wie der Agent sich verhält. Wird durch Onboarding initialisiert und vertieft sich.
- `agentName`: Name des Agents (vom User gewählt)
- `tone`: Kommunikationston (chill/professional/technical/friendly/minimal)
- `detail`: Detailgrad (brief/balanced/detailed)
- `emojis`: Ob Emojis verwendet werden
- `proactive`: Ob der Agent proaktiv Vorschläge macht
- `traits`: Zusätzliche Charakter-Eigenschaften die sich entwickeln
- `sharedHistory`: Gemeinsame Erlebnisse, Insider-Referenzen

**projects** — Erkannte Projekte auf dem Server. Aus Terminal-Analyse gelernt.
- `name`: Projektname (z.B. aus package.json)
- `path`: Pfad auf dem Server
- `type`: Projekttyp (React Native, Node.js, Python, etc.)
- `notes`: Was die AI über das Projekt weiß

**insights** — Destillierte Erkenntnisse aus vergangenen Chats (max 200).
- `date`: Wann die Erkenntnis gewonnen wurde
- `text`: Die Erkenntnis selbst (1-2 Sätze)
- `source`: Woher (chat = Gespräch, summary = 15-Min Zusammenfassung, terminal = Output-Analyse)

**recentChat** — Kurzzeit-Gedächtnis, die letzten max 40 Nachrichten.
- Wird bei Verdichtung geleert und zu Insights komprimiert

**stats** — Nutzungsstatistiken.

## Datenfluss

### Bei jedem Chat-Request

```
Client sendet manager:chat
        │
        ▼
┌─────────────────────────┐
│ 1. Memory laden         │ ← ~/.tms-terminal/manager-memory.json
│ 2. Memory-Block bauen   │ → user + personality + insights + projects
│ 3. System-Prompt bauen  │ → Personality-Prompt + Memory-Block
│ 4. An AI senden         │ → System-Prompt + recentChat + neue Nachricht
│ 5. Antwort parsen       │ → [MEMORY_UPDATE] Blöcke extrahieren
│ 6. Memory aktualisieren │ → learnedFacts, traits, insights, recentChat
│ 7. Memory speichern     │ → Datei schreiben
│ 8. Antwort an Client    │ → Bereinigter Text (ohne MEMORY_UPDATE Tags)
└─────────────────────────┘
```

### Memory-Update durch die AI

Die AI kann in jeder Antwort einen `[MEMORY_UPDATE]` Block anhängen (wird dem User nicht angezeigt):

```
[MEMORY_UPDATE]
learned: User arbeitet hauptsächlich mit React Native und TypeScript
trait: Mag trockenen Humor
project: TMS Terminal | /home/user/tms-terminal | React Native + Node.js
insight: User bevorzugt schnelle Iterationen statt lange Planungsphasen
[/MEMORY_UPDATE]
```

Parsing:
- `learned:` → wird zu `user.learnedFacts` hinzugefügt
- `trait:` → wird zu `personality.traits` hinzugefügt
- `project:` → wird in `projects` eingefügt/aktualisiert (Name | Pfad | Typ)
- `insight:` → wird zu `insights` hinzugefügt mit aktuellem Datum

### Verdichtung

Trigger: Session-Ende (WS disconnect) ODER recentChat.length > 40.

Ablauf:
1. Gesamten `recentChat` an die AI senden mit Verdichtungs-Prompt
2. AI extrahiert: neue Insights, User-Fakten, Personality-Updates
3. Ergebnis wird in die entsprechenden Memory-Felder geschrieben
4. `recentChat` wird geleert
5. `stats` werden aktualisiert (totalSessions++, lastInteraction, totalMessages)

Verdichtungs-Prompt:
```
Analysiere diesen Chat-Verlauf und extrahiere das Wichtigste:
1. Was hast du Neues über den User gelernt? (learned: ...)
2. Welche Projekte wurden erwähnt? (project: Name | Pfad | Typ)
3. Welche Erkenntnisse sind für zukünftige Gespräche relevant? (insight: ...)
4. Hat sich an deiner Persönlichkeit/Beziehung etwas verändert? (trait: ...)

Antworte NUR mit einem [MEMORY_UPDATE] Block, nichts anderes.
```

### Onboarding (Erstes Gespräch)

Wenn `stats.totalSessions === 0`:
- Server nutzt den Onboarding-System-Prompt (bereits implementiert)
- Alles was die AI lernt, fließt über `[MEMORY_UPDATE]` ins Memory
- Nach dem Onboarding-Chat wird verdichtet → Personality und User-Profil sind gefüllt
- Ab der nächsten Nachricht nutzt der Server den normalen Personality-Prompt mit Memory-Kontext

### Memory-Kontext-Block im System-Prompt

Wird bei jedem Chat-Request gebaut und in den System-Prompt eingefügt:

```
## Dein Gedächtnis

### Über den User
Name: {user.name}
Rolle: {user.role}
Tech-Stack: {techStack.join(', ')}
Gelernte Fakten:
{learnedFacts als Bullet-Liste}

### Deine Persönlichkeit
{personality.traits als Bullet-Liste}
Gemeinsame Geschichte:
{sharedHistory als Bullet-Liste}

### Aktive Projekte
{projects als Tabelle}

### Erkenntnisse aus vergangenen Gesprächen
{letzte 30 insights als Bullet-Liste}

### Statistik
{totalSessions} Sessions seit {firstInteraction}
```

## Größenbegrenzungen

| Feld | Max | Bei Überschreitung |
|------|-----|-------------------|
| `recentChat` | 40 Einträge | Verdichtung auslösen |
| `insights` | 200 Einträge | Älteste 100 zusammenfassen zu 10 Meta-Insights |
| `user.learnedFacts` | 50 Einträge | Älteste entfernen |
| `personality.traits` | 30 Einträge | Ähnliche zusammenfassen |
| `personality.sharedHistory` | 20 Einträge | Älteste entfernen |
| `projects` | 20 Einträge | Inaktive entfernen |
| Gesamte Datei | ~100 KB | Älteste Insights verdichten |

## Betroffene Dateien

### Neu erstellen

| Datei | Zweck |
|-------|-------|
| `server/src/manager/manager.memory.ts` | Memory I/O: laden, speichern, Memory-Kontext-Block bauen, Verdichtungs-Logik, Größenbegrenzungen durchsetzen |

### Ändern

| Datei | Änderung |
|-------|----------|
| `server/src/manager/manager.service.ts` | Memory bei Chat laden, `[MEMORY_UPDATE]` parsen, Memory nach Antwort speichern, Verdichtung bei >40 Nachrichten triggern, Memory-Kontext in System-Prompt einfügen |
| `server/src/websocket/ws.handler.ts` | Verdichtung bei WS disconnect triggern (`ws.on('close')`) |

### Nicht ändern

- Mobile App — kein Änderungsbedarf. Memory lebt komplett auf dem Server. Der Client schickt Nachrichten wie bisher, der Server reichert den Kontext an.
- `shared/protocol.ts` — keine neuen Message-Types nötig. Memory ist server-intern.

## Bestehender Code der wiederverwendet wird

- `manager.config.ts` — Pattern für `~/.tms-terminal/` Dateizugriff (loadManagerConfig/saveManagerConfig)
- `manager.service.ts` — System-Prompt-Builder (`buildSystemPrompt`), `handleChat()` Methode
- `ws.handler.ts` — `ws.on('close')` Handler existiert bereits, Verdichtungs-Call wird dort eingefügt
