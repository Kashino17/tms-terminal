# HTML Presentations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the Manager Agent to create HTML-based slide presentations that are rendered in an in-app fullscreen WebView viewer with swipe navigation, Chart.js, Mermaid.js, and rich visual styling.

**Architecture:** New `create_presentation` tool for the Manager Agent. Server builds complete HTML from a template with inline libraries + agent-provided slide content, saves to disk, serves via HTTP. Mobile app renders a preview card in chat messages and a fullscreen `PresentationViewer` modal with WebView.

**Tech Stack:** TypeScript, HTML/CSS/JS (presentation template), Chart.js (inline), Mermaid.js (inline), React Native WebView, existing WebSocket protocol

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `server/src/manager/presentation.template.ts` | Create | HTML template builder with inline Chart.js, Mermaid, design system |
| `server/src/manager/manager.service.ts` | Modify | Add `create_presentation` tool + handler, add `presentations` to stream end |
| `server/src/index.ts` | Modify | Add `/generated-presentations/` HTTP route |
| `mobile/src/store/managerStore.ts` | Modify | Add `presentations` field to ManagerMessage |
| `mobile/src/components/PresentationViewer.tsx` | Create | Fullscreen WebView modal with slide counter |
| `mobile/src/screens/ManagerChatScreen.tsx` | Modify | Render presentation cards, add `/ppt` command, wire up viewer |

---

### Task 1: Create presentation HTML template

**Files:**
- Create: `server/src/manager/presentation.template.ts`

- [ ] **Step 1: Create presentation.template.ts**

This file exports `buildPresentationHTML(title, slides)` that wraps agent slide content in a complete HTML document with inline libraries and a design system. The libraries (Chart.js, Mermaid) will be loaded from CDN with local fallback since inlining the full minified source would be too large for a single code block. The template includes:

```typescript
// server/src/manager/presentation.template.ts

/**
 * Builds a self-contained HTML presentation from slide content.
 * Libraries: Chart.js (CDN), Mermaid.js (CDN), Highlight.js (CDN)
 * The agent writes ONLY the inner HTML for each slide.
 */
export function buildPresentationHTML(title: string, slides: string[]): string {
  const slideHTML = slides.map((html, i) =>
    `<div class="slide${i === 0 ? ' active' : ''}" data-index="${i}">${html}</div>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>${escapeHtml(title)}</title>

<!-- Libraries -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark.min.css">
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/highlight.min.js"></script>

<style>
/* ── Reset & Base ─────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif; background: #0F172A; color: #F8FAFC; -webkit-font-smoothing: antialiased; }

/* ── Slide Container ──────────────────────────────────────── */
.presentation { width: 100%; height: 100%; position: relative; }
.slide { position: absolute; inset: 0; padding: 32px 24px; display: flex; flex-direction: column; justify-content: center; opacity: 0; transform: translateX(40px); transition: opacity 0.4s ease, transform 0.4s ease; pointer-events: none; overflow-y: auto; }
.slide.active { opacity: 1; transform: translateX(0); pointer-events: auto; }
.slide.exit-left { opacity: 0; transform: translateX(-40px); }

/* ── Typography ───────────────────────────────────────────── */
h1 { font-size: 28px; font-weight: 800; line-height: 1.2; margin-bottom: 16px; letter-spacing: -0.5px; }
h2 { font-size: 22px; font-weight: 700; line-height: 1.3; margin-bottom: 12px; }
h3 { font-size: 17px; font-weight: 600; margin-bottom: 8px; color: #94A3B8; }
p { font-size: 15px; line-height: 1.6; color: #CBD5E1; margin-bottom: 12px; }
ul, ol { padding-left: 20px; margin-bottom: 12px; }
li { font-size: 14px; line-height: 1.7; color: #CBD5E1; margin-bottom: 4px; }
strong { color: #F8FAFC; }
code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; background: #1E293B; padding: 2px 6px; border-radius: 4px; }
pre { background: #1E293B; padding: 16px; border-radius: 12px; overflow-x: auto; margin-bottom: 12px; }
pre code { background: none; padding: 0; font-size: 12px; }

/* ── Grid Layouts ─────────────────────────────────────────── */
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
.grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 16px; }
.flex-row { display: flex; gap: 12px; align-items: center; }
.flex-col { display: flex; flex-direction: column; gap: 8px; }

/* ── Cards ────────────────────────────────────────────────── */
.card { background: #1B2336; border-radius: 16px; padding: 20px; border: 1px solid rgba(148,163,184,0.08); }
.card-sm { background: #1B2336; border-radius: 12px; padding: 14px; border: 1px solid rgba(148,163,184,0.06); }

/* ── Gradients ────────────────────────────────────────────── */
.gradient-blue { background: linear-gradient(135deg, #1e3a5f 0%, #1B2336 100%); }
.gradient-purple { background: linear-gradient(135deg, #2d1b4e 0%, #1B2336 100%); }
.gradient-green { background: linear-gradient(135deg, #1a3a2a 0%, #1B2336 100%); }
.gradient-orange { background: linear-gradient(135deg, #3d2b1a 0%, #1B2336 100%); }
.gradient-red { background: linear-gradient(135deg, #3d1a1a 0%, #1B2336 100%); }
.gradient-cyan { background: linear-gradient(135deg, #0d3b4a 0%, #1B2336 100%); }
.bg-gradient-hero { background: linear-gradient(160deg, #0F172A 0%, #1e293b 40%, #0f2744 100%); }

/* ── Accent Colors ────────────────────────────────────────── */
.accent { color: #3B82F6; }
.accent-green { color: #22C55E; }
.accent-red { color: #EF4444; }
.accent-amber { color: #F59E0B; }
.accent-cyan { color: #06B6D4; }
.accent-purple { color: #A855F7; }

/* ── Badges & Tags ────────────────────────────────────────── */
.badge { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.badge-blue { background: rgba(59,130,246,0.15); color: #60A5FA; }
.badge-green { background: rgba(34,197,94,0.15); color: #4ADE80; }
.badge-red { background: rgba(239,68,68,0.15); color: #FCA5A5; }
.badge-amber { background: rgba(245,158,11,0.15); color: #FCD34D; }

/* ── Stat Numbers ─────────────────────────────────────────── */
.stat { text-align: center; }
.stat-value { font-size: 36px; font-weight: 800; letter-spacing: -1px; }
.stat-label { font-size: 12px; color: #64748B; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }

/* ── Dividers ─────────────────────────────────────────────── */
.divider { height: 1px; background: rgba(148,163,184,0.1); margin: 16px 0; }

/* ── Chart Containers ─────────────────────────────────────── */
.chart-container { position: relative; width: 100%; max-height: 250px; margin-bottom: 12px; }
canvas { max-width: 100%; }

/* ── Mermaid ──────────────────────────────────────────────── */
.mermaid { margin-bottom: 12px; }
.mermaid svg { max-width: 100%; height: auto; }

/* ── Animations ───────────────────────────────────────────── */
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
@keyframes slideInLeft { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
@keyframes scaleIn { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
@keyframes countUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.fade-in { animation: fadeIn 0.6s ease both; }
.slide-up { animation: slideUp 0.5s ease both; }
.slide-in-left { animation: slideInLeft 0.5s ease both; }
.scale-in { animation: scaleIn 0.4s ease both; }
.count-up { animation: countUp 0.5s ease both; }

.delay-1 { animation-delay: 0.1s; }
.delay-2 { animation-delay: 0.2s; }
.delay-3 { animation-delay: 0.3s; }
.delay-4 { animation-delay: 0.4s; }
.delay-5 { animation-delay: 0.5s; }

/* ── Utilities ────────────────────────────────────────────── */
.text-center { text-align: center; }
.text-right { text-align: right; }
.text-sm { font-size: 13px; }
.text-xs { font-size: 11px; }
.text-dim { color: #64748B; }
.text-muted { color: #94A3B8; }
.mt-1 { margin-top: 8px; }
.mt-2 { margin-top: 16px; }
.mt-3 { margin-top: 24px; }
.mb-1 { margin-bottom: 8px; }
.mb-2 { margin-bottom: 16px; }
.gap-1 { gap: 8px; }
.gap-2 { gap: 16px; }
.w-full { width: 100%; }

/* ── Slide Counter ────────────────────────────────────────── */
.slide-counter { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: rgba(15,23,42,0.85); backdrop-filter: blur(8px); padding: 6px 16px; border-radius: 999px; font-size: 13px; font-weight: 600; color: #94A3B8; border: 1px solid rgba(148,163,184,0.1); z-index: 100; pointer-events: none; }

/* ── Progress Bar ─────────────────────────────────────────── */
.progress-bar { position: fixed; top: 0; left: 0; height: 3px; background: #3B82F6; transition: width 0.3s ease; z-index: 100; }
</style>
</head>
<body>
<div class="progress-bar" id="progress"></div>
<div class="presentation" data-total="${slides.length}">
${slideHTML}
</div>
<div class="slide-counter" id="counter">1 / ${slides.length}</div>

<script>
// ── Slide Navigation ─────────────────────────────────────
const slides = document.querySelectorAll('.slide');
const counter = document.getElementById('counter');
const progress = document.getElementById('progress');
const total = slides.length;
let current = 0;

function goToSlide(idx) {
  if (idx < 0 || idx >= total || idx === current) return;
  slides[current].classList.remove('active');
  slides[current].classList.add(idx > current ? 'exit-left' : '');
  current = idx;
  slides[current].classList.remove('exit-left');
  slides[current].classList.add('active');
  counter.textContent = (current + 1) + ' / ' + total;
  progress.style.width = ((current + 1) / total * 100) + '%';
  // Notify React Native
  try {
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'slideChange', index: current, total: total }));
  } catch(e) {}
}

// Touch swipe
let startX = 0, startY = 0, tracking = false;
document.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; tracking = true; });
document.addEventListener('touchend', (e) => {
  if (!tracking) return; tracking = false;
  const dx = e.changedTouches[0].clientX - startX;
  const dy = e.changedTouches[0].clientY - startY;
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
    if (dx < 0) goToSlide(current + 1); else goToSlide(current - 1);
  }
});

// Keyboard
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === ' ') goToSlide(current + 1);
  if (e.key === 'ArrowLeft') goToSlide(current - 1);
});

// Init progress
progress.style.width = (1 / total * 100) + '%';

// ── Chart.js Auto-Init ──────────────────────────────────
document.querySelectorAll('canvas[data-chart]').forEach(canvas => {
  try {
    const type = canvas.dataset.chart;
    const values = JSON.parse(canvas.dataset.values || '[]');
    const labels = JSON.parse(canvas.dataset.labels || '[]');
    const colors = JSON.parse(canvas.dataset.colors || '["#3B82F6","#22C55E","#EF4444","#F59E0B","#A855F7","#06B6D4"]');
    new Chart(canvas, {
      type: type,
      data: { labels: labels, datasets: [{ data: values, backgroundColor: colors, borderColor: 'transparent', borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: '#94A3B8', font: { size: 11 } } } }, scales: type === 'bar' || type === 'line' ? { x: { ticks: { color: '#64748B' }, grid: { color: 'rgba(148,163,184,0.06)' } }, y: { ticks: { color: '#64748B' }, grid: { color: 'rgba(148,163,184,0.06)' } } } : {} }
    });
  } catch(e) { console.warn('Chart init failed:', e); }
});

// ── Mermaid Init ─────────────────────────────────────────
if (typeof mermaid !== 'undefined') {
  mermaid.initialize({ startOnLoad: true, theme: 'dark', themeVariables: { primaryColor: '#3B82F6', primaryTextColor: '#F8FAFC', primaryBorderColor: '#475569', lineColor: '#64748B', secondaryColor: '#1B2336', tertiaryColor: '#243044' } });
}

// ── Highlight.js Init ────────────────────────────────────
if (typeof hljs !== 'undefined') { hljs.highlightAll(); }

// ── Notify Ready ─────────────────────────────────────────
try { window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'ready', total: total })); } catch(e) {}
</script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/server" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/src/manager/presentation.template.ts
git commit -m "feat(manager): add HTML presentation template with Chart.js, Mermaid, design system"
```

---

### Task 2: Add create_presentation tool and handler to ManagerService

**Files:**
- Modify: `server/src/manager/manager.service.ts:26-168,172-176`

- [ ] **Step 1: Add import for presentation template and fs/path**

At the top of `server/src/manager/manager.service.ts`, add:
```typescript
import { buildPresentationHTML } from './presentation.template';
```

- [ ] **Step 2: Add create_presentation to MANAGER_TOOLS array**

In the MANAGER_TOOLS array (before the closing `];`), add:

```typescript
  {
    type: 'function',
    function: {
      name: 'create_presentation',
      description: 'Erstellt eine HTML-Präsentation mit mehreren Slides. Jede Slide ist freies HTML. Dir stehen Chart.js, Mermaid.js und Highlight.js zur Verfügung. Gestalte visuell ansprechend mit den verfügbaren CSS-Klassen. Nutze create_presentation wenn Informationen visuell besser vermittelt werden — Status-Reports, Analysen, Vergleiche, Projekt-Übersichten.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Titel der Präsentation' },
          slides: { type: 'string', description: 'JSON-Array von HTML-Strings, ein String pro Slide. Beispiel: ["<h1>Titel</h1><p>Intro</p>", "<h2>Daten</h2><canvas data-chart=\\"pie\\" data-values=\\"[30,70]\\" data-labels=\\"[\\'A\\',\\'B\\']\\"></canvas>"]' },
        },
        required: ['title', 'slides'],
      },
    },
  },
```

- [ ] **Step 3: Add 'create_presentation' to ManagerAction type**

In the ManagerAction type union (line 173), add `| 'create_presentation'`:
```typescript
  type: '...' | 'create_presentation';
```

- [ ] **Step 4: Update StreamEndCallback type to include presentations**

Find the `StreamEndCallback` type (around line 219) and update it:
```typescript
type StreamEndCallback = (text: string, actions: ManagerAction[], phases: PhaseInfo[], images?: string[], presentations?: string[]) => void;
```

- [ ] **Step 5: Add create_presentation handler in tool execution**

In the tool call handling section (where `generate_image`, `self_education` etc. are dispatched), add:

```typescript
      case 'create_presentation': {
        try {
          const presTitle = tc.arguments.title ?? 'Präsentation';
          const slidesJson = tc.arguments.slides ?? '[]';
          const slideContents = JSON.parse(slidesJson) as string[];
          if (slideContents.length === 0) {
            toolResults.push({ id: tc.id, result: 'Fehler: Keine Slides angegeben.' });
            break;
          }
          const html = buildPresentationHTML(presTitle, slideContents);
          const filename = `pres_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.html`;
          const presDir = path.join(__dirname, '..', '..', 'generated-presentations');
          if (!fs.existsSync(presDir)) fs.mkdirSync(presDir, { recursive: true });
          fs.writeFileSync(path.join(presDir, filename), html, 'utf-8');
          actionPresentations.push(filename);
          toolResults.push({ id: tc.id, result: `Präsentation "${presTitle}" erstellt (${slideContents.length} Slides). Datei: ${filename}` });
          logger.info(`Manager: presentation created — "${presTitle}", ${slideContents.length} slides, file=${filename}`);
        } catch (err) {
          toolResults.push({ id: tc.id, result: `Fehler beim Erstellen: ${err instanceof Error ? err.message : err}` });
        }
        break;
      }
```

- [ ] **Step 6: Add actionPresentations collection**

In the `handleChat()` method, near where `actionImages` is declared (around line 1030), add:
```typescript
      const actionPresentations: string[] = [];
```

And in the stream end call (around line 1381), update to pass presentations:
```typescript
      this.onStreamEnd?.(finalText, actions, phases, actionImages.length > 0 ? actionImages : undefined, actionPresentations.length > 0 ? actionPresentations : undefined);
```

- [ ] **Step 7: Verify it compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/server" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add server/src/manager/manager.service.ts
git commit -m "feat(manager): add create_presentation tool and handler"
```

---

### Task 3: Add HTTP route for generated presentations

**Files:**
- Modify: `server/src/index.ts:71-98`

- [ ] **Step 1: Add /generated-presentations/ route**

In `server/src/index.ts`, after the `/generated-images/` route block (after line 98), add:

```typescript
    } else if (req.url?.startsWith('/generated-presentations/')) {
      // Serve generated presentations (JWT-protected)
      const authHeader = req.headers['authorization'] ?? '';
      let token = authHeader.replace(/^Bearer\s+/i, '');
      if (!token) {
        try {
          const u = new URL(req.url, 'http://localhost');
          token = u.searchParams.get('token') ?? '';
        } catch {}
      }
      if (!token || !validateToken(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const filename = decodeURIComponent(req.url.replace('/generated-presentations/', '').split('?')[0]);
      if (filename.includes('..') || filename.includes('/')) {
        res.writeHead(400); res.end('Bad request'); return;
      }
      const filePath = path.join(__dirname, '..', 'generated-presentations', filename);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404); res.end('Not found'); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(filePath).pipe(res);
```

- [ ] **Step 2: Verify it compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/server" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): add HTTP route for generated presentations"
```

---

### Task 4: Update WebSocket handler to pass presentations

**Files:**
- Modify: `server/src/websocket/ws.handler.ts:94-107`

- [ ] **Step 1: Update stream_end callback to include presentations**

In `ws.handler.ts`, find the `setupManagerCallbacks()` function (around line 94-107). Update the `onStreamEnd` callback to pass presentations:

Find the line that sends `manager:stream_end` (around line 102-103) and update it:
```typescript
    (text, actions, phases, images, presentations) => sendManager({ type: 'manager:stream_end', payload: { text, actions, phases, images, presentations } }),
```

- [ ] **Step 2: Verify it compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/server" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/src/websocket/ws.handler.ts
git commit -m "feat(ws): pass presentations in stream_end payload"
```

---

### Task 5: Update mobile store for presentations

**Files:**
- Modify: `mobile/src/store/managerStore.ts:7-24,256-274`

- [ ] **Step 1: Add presentations field to ManagerMessage**

In `mobile/src/store/managerStore.ts`, after the `attachmentUris` field (around line 23), add:
```typescript
  /** Generated presentation filenames (served via /generated-presentations/). */
  presentations?: string[];
```

- [ ] **Step 2: Update finishStream to handle presentations**

In the `finishStream` action, update the signature and message creation. Change:
```typescript
      finishStream: (text, actions, phases, images) => set((s) => {
```
to:
```typescript
      finishStream: (text, actions, phases, images, presentations) => set((s) => {
```

And in the `newMsg` creation inside, add `presentations`:
```typescript
          presentations,
```

- [ ] **Step 3: Update the finishStream type in the interface**

In the ManagerState interface (around line 137), update:
```typescript
  finishStream: (text: string, actions?: ManagerMessage['actions'], phases?: PhaseInfo[], images?: string[], presentations?: string[]) => void;
```

- [ ] **Step 4: Verify mobile compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/mobile" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add mobile/src/store/managerStore.ts
git commit -m "feat(store): add presentations field to ManagerMessage"
```

---

### Task 6: Update TerminalScreen persistent handler

**Files:**
- Modify: `mobile/src/screens/TerminalScreen.tsx:438-441`

- [ ] **Step 1: Pass presentations in finishStream call**

In `TerminalScreen.tsx`, find the `manager:stream_end` handler (around line 438-439). Update:
```typescript
        case 'manager:stream_end':
          store.finishStream(m.payload.text, m.payload.actions, m.payload.phases, m.payload.images, m.payload.presentations);
```

- [ ] **Step 2: Verify mobile compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/mobile" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add mobile/src/screens/TerminalScreen.tsx
git commit -m "feat(terminal): pass presentations from stream_end to store"
```

---

### Task 7: Create PresentationViewer component

**Files:**
- Create: `mobile/src/components/PresentationViewer.tsx`

- [ ] **Step 1: Create PresentationViewer.tsx**

```typescript
// mobile/src/components/PresentationViewer.tsx
import React, { useState, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Share,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface Props {
  visible: boolean;
  url: string;
  title: string;
  onClose: () => void;
}

export function PresentationViewer({ visible, url, title, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [slideInfo, setSlideInfo] = useState({ index: 0, total: 1 });

  const handleMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'slideChange' || msg.type === 'ready') {
        setSlideInfo({ index: msg.index ?? 0, total: msg.total ?? 1 });
      }
    } catch {}
  }, []);

  const handleShare = useCallback(async () => {
    try {
      await Share.share({ url, title });
    } catch {}
  }, [url, title]);

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <StatusBar hidden />
      <View style={styles.container}>
        {/* Header Overlay */}
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>  
          <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.headerBtn}>
            <Feather name="x" size={22} color="#F8FAFC" />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
          <TouchableOpacity onPress={handleShare} hitSlop={12} style={styles.headerBtn}>
            <Feather name="share-2" size={18} color="#94A3B8" />
          </TouchableOpacity>
        </View>

        {/* WebView */}
        <WebView
          source={{ uri: url }}
          style={styles.webview}
          onMessage={handleMessage}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          scrollEnabled={false}
          bounces={false}
        />

        {/* Slide Counter */}
        <View style={[styles.counter, { bottom: insets.bottom + 16 }]}>  
          <Text style={styles.counterText}>{slideInfo.index + 1} / {slideInfo.total}</Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  webview: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  counter: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: 'rgba(15,23,42,0.85)',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.1)',
  },
  counterText: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '600',
  },
});
```

- [ ] **Step 2: Verify react-native-webview is installed**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/mobile" && grep "react-native-webview" package.json`
Expected: Should already be installed (used for terminal rendering). If not: `npx expo install react-native-webview`

- [ ] **Step 3: Verify mobile compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/mobile" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add mobile/src/components/PresentationViewer.tsx
git commit -m "feat(mobile): add PresentationViewer fullscreen component"
```

---

### Task 8: Integrate presentations into ManagerChatScreen

**Files:**
- Modify: `mobile/src/screens/ManagerChatScreen.tsx`

- [ ] **Step 1: Import PresentationViewer**

At the top of `ManagerChatScreen.tsx`, add:
```typescript
import { PresentationViewer } from '../components/PresentationViewer';
```

- [ ] **Step 2: Add presentation state**

In the component (after the `lightboxImage` state, around line 293), add:
```typescript
  const [activePres, setActivePres] = useState<{ url: string; title: string } | null>(null);
```

- [ ] **Step 3: Add /ppt to SLASH_COMMANDS**

In the SLASH_COMMANDS array (lines 82-89), add:
```typescript
  { cmd: '/ppt', label: 'Präsentation', desc: 'Präsentation erstellen lassen' },
```

- [ ] **Step 4: Add /ppt handler in handleSend()**

After the `/cron` handler (or after `/askill`), add:

```typescript
      if (cmd === '/ppt') {
        const topic = text.slice('/ppt'.length).trim();
        const pptPrompt = topic
          ? `[PRÄSENTATION] Erstelle eine Präsentation zum Thema: "${topic}". Nutze create_presentation mit visuell ansprechenden Slides. Nutze Charts, Mermaid-Diagramme und die CSS-Klassen für Gradients und Animationen.`
          : `[PRÄSENTATION] Der User möchte eine Präsentation erstellen. Frage ihn worüber die Präsentation sein soll und welche Aspekte wichtig sind.`;

        addMessage({ role: 'user', text: topic ? `/ppt ${topic}` : '/ppt', targetSessionId: activeChat !== 'alle' ? activeChat : undefined }, activeChat);
        setLoading(true);
        wsService.send({
          type: 'manager:chat',
          payload: { text: pptPrompt, targetSessionId: activeChat !== 'alle' ? activeChat : undefined, onboarding: false },
        });
        setInput('');
        Keyboard.dismiss();
        return;
      }
```

- [ ] **Step 5: Render presentation cards in messages**

In the `renderMessage` callback, after the generated images block (after line 775), add:

```typescript
            {/* Presentations */}
            {item.presentations && item.presentations.length > 0 && (
              <View style={{ marginTop: 8, gap: 8 }}>
                {item.presentations.map((pres, i) => {
                  const presUrl = `http://${serverHost}:${serverPort}/generated-presentations/${encodeURIComponent(pres)}?token=${serverToken}`;
                  return (
                    <TouchableOpacity
                      key={i}
                      activeOpacity={0.8}
                      onPress={() => setActivePres({ url: presUrl, title: item.text.slice(0, 50) })}
                      style={presCardStyles.card}
                    >
                      <View style={presCardStyles.icon}>
                        <Feather name="monitor" size={20} color="#3B82F6" />
                      </View>
                      <View style={presCardStyles.info}>
                        <Text style={presCardStyles.title} numberOfLines={1}>Präsentation</Text>
                        <Text style={presCardStyles.subtitle}>Tippen zum Öffnen</Text>
                      </View>
                      <Feather name="maximize-2" size={14} color="#64748B" />
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
```

- [ ] **Step 6: Add PresentationViewer modal to render tree**

Before the closing `</KeyboardAvoidingView>` (around line 1301), add:

```typescript
      {/* Presentation Viewer */}
      {activePres && (
        <PresentationViewer
          visible={!!activePres}
          url={activePres.url}
          title={activePres.title}
          onClose={() => setActivePres(null)}
        />
      )}
```

- [ ] **Step 7: Add presentation card styles**

At the bottom of the file, after the main `styles` StyleSheet, add:

```typescript
const presCardStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1B2336',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.15)',
    gap: 12,
  },
  icon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: 'rgba(59,130,246,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    flex: 1,
  },
  title: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '600',
  },
  subtitle: {
    color: '#64748B',
    fontSize: 11,
    marginTop: 2,
  },
});
```

- [ ] **Step 8: Verify mobile compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/mobile" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add mobile/src/screens/ManagerChatScreen.tsx
git commit -m "feat(manager): integrate presentation viewer and /ppt command"
```

---

### Task 9: Add presentation instructions to system prompt

**Files:**
- Modify: `server/src/manager/manager.service.ts` (buildSystemPrompt function)

- [ ] **Step 1: Add presentation section to system prompt**

In `buildSystemPrompt()`, in the capabilities section (around line 380), add:

```typescript
## Präsentationen

Du kannst HTML-Präsentationen erstellen mit dem create_presentation Tool.
Nutze es wenn Informationen visuell besser vermittelt werden — Status-Reports, Projekt-Übersichten, Analysen, Vergleiche.

### Verfügbare Libraries in Slides
- Chart.js: \`<canvas data-chart="pie|bar|line|doughnut|radar" data-values="[10,20,30]" data-labels="['A','B','C']" data-colors="['#3B82F6','#22C55E','#EF4444']"></canvas>\`
- Mermaid: \`<div class="mermaid">graph LR\\n  A[Start] --> B[End]</div>\`
- Code: \`<pre><code class="language-typescript">const x = 1;</code></pre>\`
- Animationen: Klassen fade-in, slide-up, slide-in-left, scale-in, count-up + delay-1 bis delay-5

### CSS-Klassen
- Layout: .grid-2, .grid-3, .flex-row, .flex-col
- Cards: .card, .card-sm
- Gradients: .gradient-blue, .gradient-purple, .gradient-green, .gradient-orange, .gradient-red, .gradient-cyan
- Farben: .accent (blau), .accent-green, .accent-red, .accent-amber, .accent-cyan, .accent-purple
- Badges: .badge .badge-blue, .badge-green, .badge-red, .badge-amber
- Stats: .stat > .stat-value + .stat-label
- Text: .text-center, .text-sm, .text-xs, .text-dim, .text-muted
- Spacing: .mt-1, .mt-2, .mt-3, .mb-1, .mb-2, .gap-1, .gap-2, .divider

### Design-Richtlinien
- Jede Slide hat EINEN Fokus — nicht überladen
- Titel-Slide: Großer Titel + kurze Zusammenfassung
- Daten-Slides: Charts statt Zahlen-Walls
- Abschluss-Slide: Key Takeaways oder nächste Schritte
- Visuell ansprechend: Gradients, Animationen, Whitespace, Kontrast
- Du darfst auch proaktiv Präsentationen vorschlagen wenn es sinnvoll ist
```

- [ ] **Step 2: Verify it compiles**

Run: `cd "/Users/ayysir/Desktop/TMS Terminal/server" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/src/manager/manager.service.ts
git commit -m "feat(manager): add presentation instructions to system prompt"
```
