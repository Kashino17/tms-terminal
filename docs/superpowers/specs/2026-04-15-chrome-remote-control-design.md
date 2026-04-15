# Chrome Remote Control — Design Spec

_2026-04-15 · TMS Terminal_

## Zusammenfassung

Chrome Remote Control ermöglicht es, Google Chrome auf dem PC direkt aus der TMS Terminal App auf dem Samsung Galaxy Fold 7 zu steuern. Die echte Chrome-Instanz mit allen Konten, Cookies und Extensions wird via Chrome DevTools Protocol (CDP) ferngesteuert und als Live-Screencast auf dem Handy angezeigt.

## Motivation

- Terminal-Befehle wie `render login` öffnen Browser-Tabs auf dem PC — diese sollen sofort in der App sichtbar und bedienbar sein
- Google-Konten, gespeicherte Passwörter und Extensions des PCs sollen nutzbar sein, ohne sie am Handy einzurichten
- Ergänzt den bestehenden lokalen Browser (Port-Forwarding) um eine PC-Chrome-Fernsteuerung

## Technischer Ansatz: CDP Screencast

Chrome DevTools Protocol streamt JPEG-Frames der aktiven Seite. Der TMS Server fungiert als Brücke zwischen CDP und der App.

```
Chrome (CDP, localhost:9222)
    ↕  CDP WebSocket
TMS Terminal Server (Node.js)
    ↕  Bestehende WebSocket-Verbindung über Tailscale
TMS Terminal App (React Native, Fold 7)
```

Kein DOM-Mirroring, keine Chrome-Extension erforderlich. CDP ist ein offizielles, von Google gepflegtes Protokoll.

## UX-Entscheidungen

| Entscheidung | Ergebnis |
|-------------|----------|
| Platzierung in der App | Neuer Tab-Typ im bestehenden BrowserPanel — Remote-Tabs (🖥️) neben lokalen Tabs (🌐) |
| Chrome-Verbindung | Hybrid: Auto-Detect ob Chrome mit Debug-Port läuft, sonst "Chrome starten"-Button |
| Tab-Management | Vollständig: alle Tabs sehen, wechseln, öffnen, schließen |
| Interaktion | Touch-to-Click: Tap = Click, Wisch = Scroll, LongPress = Rechtsklick |
| Bildqualität | Adaptiv: niedrig bei Interaktion, hoch bei Stillstand |
| Bookmarks/History | Nicht im Scope — nur URL-Bar |

## Protokoll-Erweiterung

Neue `chrome:*` Messages in `shared/protocol.ts`:

### Client → Server

| Message | Payload | Zweck |
|---------|---------|-------|
| `chrome:connect` | `{}` | Chrome-Verbindung aufbauen |
| `chrome:disconnect` | `{}` | Verbindung trennen |
| `chrome:input` | `{ type: 'click' \| 'scroll' \| 'key' \| 'dblclick', x?, y?, deltaX?, deltaY?, key?, modifiers? }` | Touch/Keyboard-Input an Chrome weiterleiten |
| `chrome:navigate` | `{ url: string }` | URL-Navigation |
| `chrome:tab:switch` | `{ targetId: string }` | Tab wechseln |
| `chrome:tab:open` | `{ url?: string }` | Neuer Tab |
| `chrome:tab:close` | `{ targetId: string }` | Tab schließen |
| `chrome:quality` | `{ quality: number, maxFps: number }` | Qualitätsstufe ändern |
| `chrome:pause` | `{}` | Screencast pausieren (App im Background) |
| `chrome:resume` | `{}` | Screencast fortsetzen |
| `chrome:resize` | `{ width: number, height: number }` | Viewport-Größe ändern (Fold auf-/zuklappen) |

### Server → Client

| Message | Payload | Zweck |
|---------|---------|-------|
| `chrome:status` | `{ state: 'connected' \| 'disconnected' \| 'not-found' \| 'busy', reason?: string, activeClient?: string }` | Verbindungsstatus |
| `chrome:frame` | `{ data: string (Base64 JPEG), width: number, height: number, timestamp: number }` | Screencast-Frame |
| `chrome:tabs` | `{ tabs: Array<{ targetId, title, url, faviconUrl }> }` | Tab-Liste |
| `chrome:tab:created` | `{ targetId, title, url }` | Neuer Tab erkannt (reaktiv) |
| `chrome:tab:removed` | `{ targetId }` | Tab geschlossen |
| `chrome:tab:updated` | `{ targetId, title?, url? }` | Tab-Titel oder URL geändert |

## Server-Architektur

### Neue Dateien

**`server/src/chrome/chrome.manager.ts`** — Hauptkomponente

- Chrome-Instanz finden oder starten via `chrome-launcher`
- CDP-Verbindung aufbauen und halten via `chrome-remote-interface`
- Screencast starten/stoppen mit adaptiver Qualität
- Frames an verbundenen Client weiterleiten
- Reconnect-Logik wenn Chrome abstürzt oder neugestartet wird

Lifecycle:
1. Client sendet `chrome:connect`
2. ChromeManager prüft: läuft Chrome mit Debug-Port?
   - Ja → CDP-Verbindung aufbauen
   - Nein → Chrome starten mit `--remote-debugging-port=9222`
3. Tab-Liste senden (`chrome:tabs`)
4. Screencast starten auf aktivem Tab
5. Frames streamen bis `chrome:disconnect` oder Verbindungsverlust

**`server/src/chrome/chrome.input.ts`** — Input-Übersetzer

Übersetzt App-Events in CDP-Calls:
- `click(x, y)` → `Input.dispatchMouseEvent` (mousePressed + mouseReleased)
- `dblclick(x, y)` → Zwei Click-Sequenzen mit clickCount=2
- `scroll(x, y, deltaX, deltaY)` → `Input.dispatchMouseEvent` (mouseWheel)
- `key(key, modifiers)` → `Input.dispatchKeyEvent` (keyDown + keyUp)
- Koordinaten-Mapping: Handy-Screen-Größe → Chrome-Viewport-Größe (proportionales Scaling)

**`server/src/chrome/chrome.tabs.ts`** — Tab-Watcher

- Pollt `Target.getTargets()` alle 2 Sekunden
- Erkennt neue/geschlossene/geänderte Tabs
- Sendet `chrome:tab:created`, `chrome:tab:removed`, `chrome:tab:updated`
- Tab-Switch: Screencast auf neuem Tab starten, alten stoppen

### Integration in bestehenden Code

- `ws.handler.ts`: Neuer Message-Block für `chrome:*` Messages (analog zu `terminal:*`, `manager:*`)
- ChromeManager wird pro WebSocket-Connection instanziiert
- Nutzt bestehende RTT-Messung für adaptive Qualität

### Neue npm Dependencies

- `chrome-remote-interface` — CDP-Client (stabil, gut maintained)
- `chrome-launcher` — Chrome finden/starten (Google Lighthouse Team)

## Adaptive Qualität

Drei Stufen, automatisch gewechselt:

| Stufe | Trigger | Quality | maxFPS |
|-------|---------|---------|--------|
| **Interaktion** | User scrollt/tippt/klickt | 40 | 20 |
| **Idle** | 1.5s keine Interaktion | 80 | 5 |
| **Standbild** | 3s+ keine Interaktion | 95 | 1 (einmaliger Snapshot) |

Bei schlechter Verbindung (RTT > 500ms): Quality auf max 30, maxFPS auf max 10.

## Mobile App — Komponenten

### Neue Dateien

**`mobile/src/components/ChromeRemoteView.tsx`**

- Rendert JPEG-Frames als React Native `<Image>` Component
- Touch-Event-Capture via PanResponder
- Koordinaten-Mapping (Touch-Position → proportionale Chrome-Position)
- Unsichtbarer `TextInput` für Keyboard-Input (Shadow-Input-Pattern, wie beim Terminal)

**`mobile/src/components/ChromeConnectScreen.tsx`**

- "PC Chrome verbinden"-UI wenn noch keine Verbindung besteht
- "Verbinden"-Button → sendet `chrome:connect`
- Fehlermeldungen bei Verbindungsproblemen

**`mobile/src/store/chromeRemoteStore.ts`** (Zustand)

```
State:
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error'
  tabs: Array<{ targetId, title, url, faviconUrl }>
  activeTabId: string | null
  currentFrame: { data: string, width: number, height: number } | null
  quality: { level: 'interaction' | 'idle' | 'still', value: number, fps: number }
  latency: number
  error: string | null
```

### Integration in BrowserPanel

Bestehende Tab-Leiste erweitert:
- Remote-Tabs bekommen 🖥️-Icon und blaue Akzentfarbe
- Lokale Tabs behalten 🌐-Icon
- `+`-Button bekommt Option: "Neuer lokaler Tab" / "Neuer PC Chrome Tab"
- Wenn aktiver Tab ein Remote-Tab ist → `ChromeRemoteView` statt `WebView` rendern

## Responsive Design (Fold 7)

Nutzt bestehenden `useResponsive()` Hook mit drei Breakpoints:

### Compact (<400dp) — Zugeklappt

- Tab-Labels: nur Domain, gekürzt
- URL-Bar: nur Domain, kein Protokoll
- Nav-Buttons: nur ← → (kein Reload)
- Badges: minimal (nur Zahl)
- Verbindungs-Badge: nur Dot, kein Text
- Chrome-Viewport: 375px breit (mobile Webseiten-Ansicht)

### Medium (400-699dp)

- Tab-Labels: Domain
- URL-Bar: volle URL
- Nav-Buttons: ← → ↻
- Badges: Quality + Latenz
- Verbindungs-Badge: "Chrome verbunden"
- Chrome-Viewport: 600px breit

### Expanded (≥700dp) — Aufgeklappt

- Tab-Labels: Domain + Seitentitel
- URL-Bar: volle URL + Tab-Counter
- Nav-Buttons: ← → ↻
- Badges: Quality + Latenz + Status-Dot
- Verbindungs-Badge: "Chrome verbunden · hostname"
- Chrome-Viewport: 900px+ breit

### Viewport-Sync

Wenn der Fold auf-/zugeklappt wird:
1. `useResponsive()` erkennt Größenänderung
2. App sendet `chrome:resize { width, height }`
3. Server setzt Chrome-Viewport via CDP `Emulation.setDeviceMetricsOverride`
4. Chrome rendert Seite im neuen Format
5. Neue Frames kommen sofort

## Error Handling

### Verbindungsverluste

| Szenario | Verhalten |
|----------|-----------|
| App verliert WebSocket | Screencast pausiert. Bei Reconnect: Server sendet letzten Frame + Tab-Liste. |
| Server verliert CDP zu Chrome | `chrome:status { state: 'disconnected', reason: 'chrome-closed' }`. App zeigt "Neu verbinden"-Button. |
| Chrome-Tab auf chrome:// oder DevTools | Hinweis: "Diese Seite kann nicht gespiegelt werden". |
| Debug-Port blockiert | Server versucht Ports 9222-9232. Wenn alle belegt: Fehlermeldung. |

### Performance-Schutz

| Szenario | Verhalten |
|----------|-----------|
| Langsame Verbindung (RTT > 500ms) | Quality 30, maxFPS 10, Badge zeigt ⚠️. |
| App im Background | `chrome:pause` stoppt Screencast. Bei Foreground: `chrome:resume`. |
| >20 offene Tabs | Tab-Liste paginiert. Screencast nur auf aktivem Tab. |

### Input-Edge-Cases

| Szenario | Verhalten |
|----------|-----------|
| Input während Frame lädt | Events gequeued, max 10, danach drop. |
| Koordinaten außerhalb Viewport | Events ignoriert. |
| Schnelles Doppeltippen (<300ms) | Als `dblclick` dispatcht. |

### Chrome-Lifecycle

| Szenario | Verhalten |
|----------|-----------|
| User schließt Chrome manuell | Status disconnected, kein Auto-Restart. |
| Chrome-Update während Verbindung | 10s Reconnect-Versuch nach CDP-Verlust. |
| Zweiter Client will Chrome steuern | `chrome:status { state: 'busy' }` — nur eine Session pro Server. |

## Nicht im Scope

- Bookmarks/History-Zugriff
- Chrome-Extension
- DOM-Mirroring
- Video-Playback-Optimierung
- Multi-Touch / Pinch-to-Zoom
- File-Upload-Dialoge
- Delta-Compression (spätere Optimierung)
