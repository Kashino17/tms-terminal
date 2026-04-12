# HTML-Präsentationen im Manager Chat

_Design Spec — 2026-04-12_

## Zusammenfassung

Der Manager Agent kann HTML-basierte Präsentationen erstellen und im Chat einbetten. Slides werden in einem Fullscreen-WebView-Modal angezeigt mit Swipe-Navigation. Ein Template-System liefert Layout, Styling und Libraries (Chart.js, Mermaid, Highlight.js, Animate.css) — der Agent füllt nur den Slide-Content.

## Entscheidungen

| Entscheidung | Wahl | Begründung |
|---|---|---|
| Trigger | Proaktiv + auf Anfrage | Agent darf vorschlagen, User kann per `/ppt` anfordern |
| Visualisierung | Maximal | Charts, Flowcharts, Timelines, Code, Animationen, Icons, Gradients |
| Rendering | WebView mit HTML | Maximale Flexibilität ohne nativen Code pro Slide-Typ |
| Libraries | Inline (kein CDN) | Funktioniert offline, keine externen Abhängigkeiten |

## Datenmodell

### Presentation (Server-seitig)

```typescript
interface Presentation {
  id: string;            // nanoid
  title: string;         // "Projekt-Übersicht Q2"
  slideCount: number;    // Anzahl Slides
  filename: string;      // "pres_abc123.html"
  createdAt: number;
}
```

### ManagerMessage Erweiterung

```typescript
interface ManagerMessage {
  // ... bestehende Felder ...
  presentations?: string[];   // Dateinamen: ["pres_abc123.html"]
}
```

## Neue Dateien

| Datei | Zweck |
|---|---|
| `server/src/manager/presentation.template.ts` | HTML-Template-Builder mit eingebetteten Libraries |
| `server/generated-presentations/` | Gespeicherte HTML-Dateien |
| `mobile/src/components/PresentationViewer.tsx` | Fullscreen WebView Modal |

## HTML-Template System

### presentation.template.ts

Exportiert eine Funktion:

```typescript
function buildPresentationHTML(title: string, slides: string[]): string
```

Nimmt den Titel und ein Array von HTML-Strings (je ein Slide) und baut ein komplettes HTML-Dokument.

### Template-Struktur

```html
<!DOCTYPE html>
<html lang="de">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  
  <!-- Inline Libraries (keine CDN-Abhängigkeit) -->
  <script>/* Chart.js — Torten, Balken, Linien, Radar, Doughnut */</script>
  <script>/* Mermaid.js — Flowcharts, Sequence, Timelines, Gantt */</script>
  <script>/* Highlight.js — Code-Syntax-Highlighting */</script>
  
  <style>
    /* Animate.css Subset — fadeIn, slideInUp, fadeInLeft, etc. */
    /* Basis-Layout — Slide-Container, Typografie, Spacing */
    /* Design-System — Gradients, Shadows, Rounded Corners */
    /* Icon-Set — CSS-basierte einfache Icons/Shapes */
    /* Responsive — funktioniert auf Fold 7 Screens */
    /* Slide-Navigation — Transitions zwischen Slides */
    /* Utility-Klassen — .text-center, .grid-2, .accent, etc. */
  </style>
</head>
<body>
  <div class="presentation" data-total="{N}">
    <div class="slide active" data-index="0">
      <!-- Agent's HTML für Slide 1 -->
    </div>
    <div class="slide" data-index="1">
      <!-- Agent's HTML für Slide 2 -->
    </div>
    ...
  </div>
  
  <div class="slide-counter">1 / {N}</div>
  
  <script>
    // Navigation: Touch-Swipe + Keyboard (←→)
    // postMessage an React Native: { type: 'slideChange', index, total }
    // Mermaid.init() nach DOM ready
    // Chart.js auto-init für <canvas data-chart="...">
  </script>
</body>
</html>
```

### Was der Agent schreibt vs. was das Template liefert

| Agent schreibt | Template liefert |
|---|---|
| Slide-Inhalte als HTML | Dokument-Struktur, `<head>`, Libraries |
| Chart.js Canvas-Elemente mit Daten | Chart.js Library + Auto-Init Script |
| Mermaid-Diagramm-Definitionen | Mermaid Library + Rendering |
| Code-Blocks mit Sprach-Klassen | Highlight.js + Themes |
| CSS-Klassen für Animationen | Animate.css Keyframes |
| Inline-Styles für Gradients/Colors | Basis-Design-System + Utilities |

### Beispiel: Was der Agent für eine Slide schreibt

```html
<h1 class="fade-in">Projekt-Status</h1>
<div class="grid-2">
  <div class="card gradient-blue">
    <h3>Tests</h3>
    <canvas data-chart="doughnut" data-values="[42, 3, 2]" 
            data-labels="['Passed', 'Failed', 'Skipped']"
            data-colors="['#22c55e', '#ef4444', '#94a3b8']"></canvas>
  </div>
  <div class="card gradient-purple">
    <h3>Build Pipeline</h3>
    <div class="mermaid">
      graph LR
        A[Lint] --> B[Test]
        B --> C[Build]
        C --> D[Deploy]
        style C fill:#22c55e
    </div>
  </div>
</div>
```

## Neues Tool für den Manager Agent

### create_presentation

```typescript
{
  name: 'create_presentation',
  description: 'Erstellt eine HTML-Präsentation mit mehreren Slides. '
    + 'Jede Slide ist freies HTML. Dir stehen Chart.js, Mermaid.js, Highlight.js und Animate.css zur Verfügung. '
    + 'Gestalte visuell ansprechend: Gradients, Animationen, saubere Typografie. '
    + 'Jede Slide hat EINEN Fokus. Nutze Charts für Daten, Mermaid für Flows.',
  parameters: {
    title: string,                    // Präsentations-Titel
    slides: string                    // JSON-Array von HTML-Strings, eines pro Slide
  }
}
```

### Server-seitige Verarbeitung

```
Agent ruft create_presentation auf
  → Server parst slides JSON-Array
  → Server ruft buildPresentationHTML(title, slides) auf
  → HTML wird geschrieben nach server/generated-presentations/pres_{id}.html
  → Filename wird zurückgegeben
  → ManagerService hängt filename an die Antwort-Message (presentations[])
```

### HTTP-Endpoint

Wie bei `/generated-images/`:

```
GET /generated-presentations/{filename}?token={auth}
  → Sendet HTML-Datei
  → Content-Type: text/html
```

## Mobile App: Chat-Integration

### Message-Rendering

Wenn `item.presentations` existiert:

```
┌─────────────────────────────────┐
│  ┌───────────────────────────┐  │
│  │  ░░ Gradient Background ░░│  │
│  │                           │  │
│  │   📊 Projekt-Status       │  │
│  │      5 Slides             │  │
│  │                           │  │
│  └───────────────────────────┘  │
│                          10:03  │
└─────────────────────────────────┘
```

- Styled Card mit Gradient-Hintergrund
- Titel der Präsentation + Slide-Anzahl
- Tap → öffnet PresentationViewer

### PresentationViewer.tsx

Fullscreen Modal Component:

```
┌──────────────────────────────────────┐
│  ✕                          ⇧ Share  │  ← Header (transparent overlay)
│                                      │
│                                      │
│         WebView lädt HTML            │
│         von Server-URL               │
│                                      │
│         Swipe ← → navigiert         │
│                                      │
│                                      │
│              3 / 8                   │  ← Slide-Counter
└──────────────────────────────────────┘
```

**Props:**
```typescript
{
  visible: boolean;
  presentationUrl: string;
  onClose: () => void;
}
```

**Features:**
- WebView mit `source={{ uri: presentationUrl }}`
- `onMessage` Handler für postMessage vom HTML (Slide-Index Updates)
- Slide-Counter Overlay aus React Native (nicht im WebView)
- Close-Button (X) oben links
- Share-Button oben rechts (URL oder HTML-Datei teilen)
- StatusBar hidden im Fullscreen

### Kommunikation WebView ↔ React Native

```
HTML → React Native (postMessage):
  { type: 'slideChange', index: 2, total: 8 }
  { type: 'ready' }

React Native → HTML (injectedJavaScript):
  // Optional: Slide direkt ansteuern
  window.goToSlide(3);
```

## System Prompt Erweiterung

Dem Agent wird im System Prompt erklärt:

```
## Präsentationen

Du kannst HTML-Präsentationen erstellen mit dem create_presentation Tool.
Nutze es wenn Informationen visuell besser vermittelt werden — Status-Reports,
Projekt-Übersichten, Analysen, Vergleiche.

### Verfügbare Libraries in Slides
- Chart.js: <canvas data-chart="pie|bar|line|doughnut|radar" data-values="[...]" data-labels="[...]" data-colors="[...]">
- Mermaid: <div class="mermaid">graph LR ...</div>
- Code: <pre><code class="language-typescript">...</code></pre>
- Animationen: Klassen fade-in, slide-up, fade-in-left auf beliebigen Elementen

### Design-Richtlinien
- Jede Slide hat EINEN Fokus — nicht überladen
- Nutze die Utility-Klassen: .grid-2, .grid-3, .card, .gradient-blue, .gradient-purple, .accent
- Titel-Slide: Großer Titel + kurze Zusammenfassung
- Daten-Slides: Charts statt Zahlen-Walls
- Abschluss-Slide: Nächste Schritte oder Key Takeaways
- Visuell ansprechend: Gradients, abgerundete Ecken, Whitespace, Kontrast
```

## Trigger-Logik

### Auf Anfrage
- User tippt `/ppt Thema` → Agent erstellt Präsentation zum Thema
- User sagt "Mach eine Präsentation über..." → Agent erkennt Intent

### Proaktiv
- Bei Cron-Reports mit komplexen Ergebnissen
- Bei Status-Zusammenfassungen mit mehreren Terminals
- Agent darf vorschlagen: "Das wäre als Präsentation übersichtlicher — soll ich?"

### SLASH_COMMANDS

```typescript
{ cmd: '/ppt', label: 'Präsentation', desc: 'Präsentation erstellen lassen' }
```

## Änderungen an bestehendem Code

| Datei | Änderung |
|---|---|
| `managerStore.ts` | `presentations?: string[]` zu ManagerMessage |
| `managerStore.ts` | `finishStream` verarbeitet presentations Array |
| `ManagerChatScreen.tsx` | Rendering für Presentation-Cards + Modal |
| `ManagerChatScreen.tsx` | `/ppt` in SLASH_COMMANDS |
| `manager.service.ts` | `create_presentation` Tool registrieren + Handler |
| `manager.prompt.ts` | System Prompt mit Präsentations-Instruktionen |
| `ws.handler.ts` | HTTP-Route für `/generated-presentations/` |
