# Audio-Transkription (Speech-to-Text) — Design Spec

## Zusammenfassung

Sprachaufnahme auf dem Handy, Transkription via lokal laufendem OpenAI Whisper auf dem Server (MacBook, Apple Silicon), Ergebnis wird ins Terminal-Eingabefeld eingefügt.

## Anforderungen

- **Bedienung:** Tap-to-Toggle Mikrofon-Button in der TerminalToolbar
- **Transkription:** OpenAI Whisper `large-v3`, lokal auf dem Server (Python, MPS/Apple Silicon)
- **Sprache:** Deutsch (`language="de"`)
- **Ergebnis:** Text wird ins Eingabefeld eingefügt (kein Auto-Enter), User kann vor Absenden korrigieren
- **Server:** MacBook mit M-Chip (MPS Backend für PyTorch)

---

## 1. WebSocket-Protokoll

Drei neue Message-Typen im bestehenden `domain:action` Pattern.

### Client → Server

```typescript
// Audio zur Transkription senden
{
  type: 'audio:transcribe',
  sessionId: string,
  payload: {
    audio: string,   // Base64-encoded WAV
    format: 'wav'
  }
}
```

### Server → Client

```typescript
// Erfolgreiche Transkription
{
  type: 'audio:transcription',
  sessionId: string,
  payload: {
    text: string     // Transkribierter Text
  }
}

// Fehler
{
  type: 'audio:error',
  sessionId: string,
  payload: {
    message: string  // Fehlerbeschreibung
  }
}
```

### Payload-Limit

Das bestehende WebSocket Max-Payload von 1MB reicht für ~5s unkomprimiertes WAV. Audio wird als 16kHz Mono 16-bit PCM aufgenommen (was Whisper erwartet) — damit passen ~30 Sekunden in 1MB.

---

## 2. Mobile App

### 2.1 Mikrofon-Button (TerminalToolbar.tsx)

Neuer Button in der bestehenden Toolbar, ganz rechts als letzter Button (nach dem Enter-Button).

**Icon:** `Mic` aus lucide-react-native (bereits im Projekt).

**Drei Zustände:**

| Zustand | Visuell | Verhalten |
|---------|---------|-----------|
| Idle | Standard Icon + Farbe | Tap startet Aufnahme |
| Recording | Rotes Icon, pulsierend (Animated), Timer daneben (z.B. `0:03`) | Tap stoppt und sendet |
| Processing | Spinner/Ladeindikator | Warten auf Server-Antwort |

**Sichtbarkeit:** Nur wenn `audioInputEnabled` in Settings aktiviert ist (default: `true`).

### 2.2 Aufnahme-Logik

- **Package:** `expo-av` (bereits installiert) — `Audio.Recording` API
- **Format:** WAV, 16kHz, Mono, 16-bit PCM
- **Permission:** `Audio.requestPermissionsAsync()` beim ersten Tap, danach gecacht

**Flow:**

1. Tap → Permission prüfen → `Audio.Recording.createAsync()` startet Aufnahme
2. Tap → `recording.stopAndUnloadAsync()` stoppt Aufnahme
3. `FileSystem.readAsStringAsync(uri, { encoding: 'base64' })` liest die WAV-Datei
4. `wsService.send({ type: 'audio:transcribe', sessionId, payload: { audio, format: 'wav' } })`
5. UI wechselt in Processing-Zustand
6. Auf `audio:transcription` oder `audio:error` warten

### 2.3 Text-Injection ins Terminal

Transkribierter Text wird über die bestehende WebView-Bridge ins Shadow-Input injiziert — gleicher Mechanismus wie Clipboard-Paste. Der diff-basierte Input-Handler erkennt die Änderung und sendet die Zeichen an xterm.js.

---

## 3. Server — Whisper Sidecar

### 3.1 Architektur

Ein Python-Script (`whisper_sidecar.py`) das der TMS Server als lang laufenden Child Process startet. Kommunikation über **stdin/stdout mit JSON Lines**.

```
Mobile App                    TMS Server (Node.js)              Whisper Sidecar (Python)
    │                              │                                    │
    │── audio:transcribe ─────────>│                                    │
    │                              │── JSON Line (stdin) ──────────────>│
    │                              │                                    │── whisper.transcribe()
    │                              │<── JSON Line (stdout) ────────────│
    │<── audio:transcription ──────│                                    │
```

### 3.2 Sidecar Lifecycle

1. **Lazy Start:** Wird beim ersten `audio:transcribe` Request gestartet, nicht beim Server-Boot
2. **Modell laden:** `whisper.load_model("large-v3", device="mps")` — einmalig, bleibt im RAM (~10GB)
3. **Warten:** Liest JSON Lines von stdin
4. **Verarbeiten:** Base64 → Temp-Datei → Whisper transcribe → Temp-Datei löschen → Ergebnis auf stdout
5. **Am Leben bleiben:** Prozess bleibt offen für weitere Requests
6. **Shutdown:** `SIGTERM` beim Server-Shutdown

### 3.3 Sidecar Protokoll (JSON Lines über stdio)

**Request (stdin):**
```json
{"id": "req-1", "audio_base64": "UklGR...", "language": "de"}
```

**Response (stdout):**
```json
{"id": "req-1", "text": "der transkribierte text"}
```

**Error (stdout):**
```json
{"id": "req-1", "error": "Transcription failed: ..."}
```

Das `id`-Feld ermöglicht Zuordnung bei parallelen Requests (mehrere Clients).

### 3.4 Whisper-Konfiguration

```python
model = whisper.load_model("large-v3", device="mps")
result = model.transcribe(temp_path, language="de", fp16=False)
```

- `fp16=False` weil MPS kein float16 bei Whisper zuverlässig unterstützt
- `language="de"` für Deutsch
- Temp-Dateien werden nach Transkription sofort gelöscht

### 3.5 Server-Integration (ws.handler.ts)

- Neuer Handler für `audio:transcribe` im Extension-Message-Block (neben `client:backgrounding`, `autopilot:*`)
- Validierung: sessionId, payload.audio (string, <1MB), payload.format === 'wav'
- Leitet Base64-Audio an Sidecar weiter
- Wartet auf Sidecar-Antwort (max 30s Timeout)
- Sendet `audio:transcription` oder `audio:error` zurück an Client

### 3.6 Fehlerbehandlung

| Situation | Verhalten |
|-----------|-----------|
| Python/Whisper nicht installiert | `audio:error`: "Whisper nicht verfuegbar — `pip3 install openai-whisper torch`" |
| Sidecar crasht | Automatischer Neustart beim naechsten Request |
| Transkription dauert >30s | Timeout → `audio:error`: "Transkription Timeout" |
| Leeres Audio | `audio:error`: "Keine Audiodaten empfangen" |

---

## 4. Setup & Abhängigkeiten

### Server-Seite (einmalig vom Benutzer)

```bash
pip3 install openai-whisper torch
```

- Python 3.8+ muss installiert sein
- Modell `large-v3` (~2.9GB) wird beim ersten Sidecar-Start automatisch heruntergeladen nach `~/.cache/whisper/`
- Kein Auto-Install durch den TMS Server

### Mobile-Seite

- `expo-av` bereits installiert — keine neuen Dependencies
- `RECORD_AUDIO` Permission in `app.json` Plugin-Config hinzufuegen

### Feature-Toggle

- Neuer Boolean in `settingsStore.ts`: `audioInputEnabled` (default: `true`)
- Mikrofon-Button nur sichtbar wenn aktiviert
- Erlaubt das Feature auszuschalten wenn Whisper nicht eingerichtet ist

---

## 5. Dateien (neu/geändert)

### Neue Dateien

| Datei | Beschreibung |
|-------|-------------|
| `server/src/audio/whisper-sidecar.ts` | Node.js Manager fuer den Python Child Process |
| `server/audio/whisper_sidecar.py` | Python Whisper Script (stdin/stdout JSON Lines) |

### Geänderte Dateien

| Datei | Änderung |
|-------|----------|
| `shared/protocol.ts` | Neue Message-Typen: `audio:transcribe`, `audio:transcription`, `audio:error` |
| `server/src/websocket/ws.handler.ts` | Handler fuer `audio:transcribe` |
| `mobile/src/components/TerminalToolbar.tsx` | Mikrofon-Button mit drei Zustaenden |
| `mobile/src/services/websocket.service.ts` | Handler fuer `audio:transcription` / `audio:error` |
| `mobile/src/store/settingsStore.ts` | `audioInputEnabled` Toggle |
| `mobile/src/components/TerminalView.tsx` | Text-Injection nach Transkription |
| `mobile/app.json` | `RECORD_AUDIO` Permission |
