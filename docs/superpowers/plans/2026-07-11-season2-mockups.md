# Season 2 Mockups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build three fully interactive, simulated HTML mockups (Command Deck, Liquid Deck, Mission Control) of the entire TMS Terminal feature set, served on port 4321 so the user can review them on his Galaxy Fold 7 via Tailscale.

**Architecture:** Plain HTML/CSS/JS, zero build step. One shared fake-data module + one terminal-streaming simulator (both loadable in browser and Node for tests). Each concept is a self-contained single-file SPA that consumes the shared modules. A chooser page links the three.

**Tech Stack:** Vanilla HTML/CSS/JS, `node --test` for the two shared modules, `python3 -m http.server` for serving. No dependencies, no framework.

**Spec:** `docs/superpowers/specs/2026-07-11-season2-mockups-design.md`

## Global Constraints

- **No build step.** Classic `<script>` tags only. No npm packages, no CDN fetches (must work offline on the phone via Tailscale).
- **UI strings in German**, code/comments in English (project convention).
- **Port 4321**, plain HTTP (Tailscale encrypts; matches project no-TLS decision).
- **Breakpoints** (project convention): compact `<400px`, medium `400–699px`, expanded `≥700px`. Folded Fold 7 ≈ compact/medium; unfolded ≈ expanded.
- **Same data everywhere:** concepts must only read `window.TMS_DATA` / `window.TMSSim` — no concept-private copies of domain data.
- **Git:** this worktree's git hangs on tree-scanning ops (iCloud Desktop). Always commit with explicit pathspecs (`git add <paths> && git commit -o <paths> --no-verify -m ...`), never `git add -A`/`git status`.
- **Feature Coverage Matrix** — every concept must make ALL of these reachable and clickable:
  1. Server-Liste + Verbinden (1 online, 1 offline Server)
  2. Terminal-Stack: mehrere benannte Terminals (Name, Beschreibung, Farbtag, Status-Chip), kollabierbar/anordenbar
  3. Live simulierte Claude-Code-Session (Streaming via TMSSim) inkl. Permission-Prompt + Auto-Approve/Autopilot-Reaktion
  4. Terminal-Toolbar: Esc, Pfeile, Ctrl, Tab, Paste, Selektion-Modus
  5. Touch-Text-Selektion mit Griffen (Demo: langer Tap zeigt Selektion + Handles + Copy-Bubble)
  6. Link-Erkennung über Zeilenumbruch (Demo: umgebrochener Link, Tap kopiert VOLLSTÄNDIGE URL, Toast bestätigt)
  7. Tool-Panels: Dateien, SQL, Ports, Prozesse, Snippets, Notizen, Screenshots, Browser, Watchers
  8. Manager-Chat V2: Verlauf, Voice-Message-Player, Transkription-Status, Artifacts, Memory
  9. Cloud (Vercel + Render): Projektliste mit Favoriten-Stern + Ordnern, Env-Vars ansehen/kopieren/editieren, großer Log-Viewer (durchsuchbar, selektierbar), Deploy-Status
  10. Spotlight-/Universalsuche
  11. Gebetszeiten + Adhan-Alert (Demo-Trigger)
  12. Lock/PIN-Screen (Demo-Eingabe, PIN `1234`)
  13. Einstellungen
  14. Update-Banner (v2.0.0 verfügbar)
  15. Dynamic Island / Status-Zentrum (nur Konzept 2 & 3)
- **Pain-point fixes must be *staged*, not just present** — the named terminal stack, touch selection, env edit, favorites/folders, log viewer and wrapped-link copy are the demo's hero moments.

## File Structure

```
mockups/season2/
├── index.html                  # Chooser page (Task 1)
├── shared/
│   ├── data.js                 # Fake data world → window.TMS_DATA (Task 1)
│   ├── data.test.cjs           # Node smoke tests (Task 1)
│   ├── sim.js                  # Streaming simulator → window.TMSSim (Task 2)
│   └── sim.test.cjs            # Node tests (Task 2)
├── command-deck/index.html     # Concept 1 SPA (Tasks 3–4)
├── liquid-deck/index.html      # Concept 2 SPA (Tasks 5–6)
└── mission-control/index.html  # Concept 3 SPA (Tasks 7–8)
```

Each concept file is self-contained (inline `<style>` + `<script>`), loading only `../shared/data.js` and `../shared/sim.js`.

---

### Task 1: Scaffold, shared data world, chooser page, serving

**Files:**
- Create: `mockups/season2/shared/data.js`
- Create: `mockups/season2/shared/data.test.cjs`
- Create: `mockups/season2/index.html`

**Interfaces:**
- Produces: `window.TMS_DATA` (browser) / `module.exports` (Node) with the exact shape below. All later tasks consume it verbatim.

- [ ] **Step 1: Write the failing test**

`mockups/season2/shared/data.test.cjs`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const DATA = require('./data.js');

test('servers: one online, one offline', () => {
  assert.equal(DATA.servers.length, 2);
  assert.equal(DATA.servers.filter(s => s.status === 'online').length, 1);
});

test('sessions: 4 named sessions, exactly one live claude session', () => {
  assert.equal(DATA.sessions.length, 4);
  for (const s of DATA.sessions) {
    assert.ok(s.id && s.name && s.description && s.colorTag && s.status);
    assert.ok(Array.isArray(s.buffer) && s.buffer.length > 0);
  }
  assert.equal(DATA.sessions.filter(s => s.live).length, 1);
  assert.ok(DATA.sessions.find(s => s.live).script.length > 5);
});

test('wrapped link demo present in a session buffer', () => {
  const all = DATA.sessions.flatMap(s => s.buffer).join('\n');
  assert.ok(all.includes(DATA.demo.wrappedLinkUrl.slice(0, 30)));
  assert.ok(DATA.demo.wrappedLinkUrl.startsWith('https://'));
});

test('cloud: 6 projects across vercel+render with env/logs/favorites/folders', () => {
  assert.equal(DATA.cloudProjects.length, 6);
  assert.ok(DATA.cloudProjects.some(p => p.provider === 'vercel'));
  assert.ok(DATA.cloudProjects.some(p => p.provider === 'render'));
  assert.ok(DATA.cloudProjects.some(p => p.favorite));
  for (const p of DATA.cloudProjects) {
    assert.ok(p.env.length >= 3 && p.logs.length >= 8 && typeof p.folder === 'string');
  }
});

test('manager conversation has voice message, artifact and memory', () => {
  assert.ok(DATA.manager.messages.some(m => m.type === 'voice'));
  assert.ok(DATA.manager.artifacts.length >= 2);
  assert.ok(DATA.manager.memory.length >= 3);
});

test('aux data present', () => {
  assert.equal(DATA.prayerTimes.length, 5);
  assert.ok(DATA.snippets.length >= 4 && DATA.notes.length >= 2);
  assert.ok(DATA.processes.length >= 6 && DATA.watchers.length >= 2);
  assert.equal(DATA.update.latest, '2.0.0');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "mockups/season2/shared/"`
Expected: FAIL — `Cannot find module './data.js'`

- [ ] **Step 3: Write `data.js`**

`mockups/season2/shared/data.js` — classic script + CommonJS export. Complete content (German UI strings, English keys):

```js
// TMS_DATA — the single fake data world shared by all three Season-2 concepts.
(function (global) {
  const wrappedLinkUrl = 'https://vercel.com/kashino17/pinterest-scraper/deployments/dpl_8fK2mQx9LpR3nWv7Jh4TzYcB6d';

  const claudeScript = [
    { t: 400,  type: 'status', data: 'running' },
    { t: 200,  type: 'out', data: '\x1b[1m● Claude Code v3.2\x1b[0m — Session: fix failing tests\n' },
    { t: 600,  type: 'out', data: '● Ich schaue mir die fehlgeschlagenen Tests an…\n' },
    { t: 900,  type: 'out', data: '  ⎿ Read tests/scraper.test.ts (142 lines)\n' },
    { t: 800,  type: 'out', data: '  ⎿ Read src/scraper/parser.ts (96 lines)\n' },
    { t: 1200, type: 'out', data: '● Der Test erwartet ein leeres Array bei 404, parser.ts wirft aber.\n  Ich fixe parser.ts:41.\n' },
    { t: 500,  type: 'prompt', data: { tool: 'Edit', target: 'src/scraper/parser.ts', question: 'Edit erlauben?' } },
    { t: 300,  type: 'out', data: '  ⎿ ✔ Auto-Approve: Edit erlaubt (Regel: src/**)\n' },
    { t: 900,  type: 'out', data: '  ⎿ Updated src/scraper/parser.ts (+4 -1)\n' },
    { t: 700,  type: 'out', data: '● Tests laufen…\n' },
    { t: 1400, type: 'out', data: '  ⎿ npm test → \x1b[32m✓ 27 passed\x1b[0m, 0 failed (3.2s)\n' },
    { t: 600,  type: 'out', data: `● Fertig! Deployment-Preview:\n  ${wrappedLinkUrl}\n` },
    { t: 300,  type: 'status', data: 'done' },
    { t: 100,  type: 'done', data: null },
  ];

  const DATA = {
    demo: { wrappedLinkUrl, pin: '1234' },
    servers: [
      { id: 'srv-mac', name: 'Ayysir MacBook', host: '100.64.0.12', port: 8767, status: 'online',  sessions: 4, os: 'macOS 26', latency: 12 },
      { id: 'srv-hetzner', name: 'Hetzner Cloud', host: '100.64.0.31', port: 8767, status: 'offline', sessions: 0, os: 'Ubuntu 24.04', latency: null },
    ],
    sessions: [
      { id: 't1', name: 'Pinterest Scraper', description: 'Claude fixt fehlschlagende Tests', colorTag: '#e8590c', status: 'running', live: true, script: claudeScript,
        buffer: ['\x1b[2m~/dev/pinterest-scraper\x1b[0m $ claude "fix the failing tests"'] },
      { id: 't2', name: 'TMS Server', description: 'Live-Logs des Terminal-Servers', colorTag: '#1971c2', status: 'idle', live: false,
        buffer: ['\x1b[2m~/Desktop/tms-terminal\x1b[0m $ tms-terminal start', '[ws] listening on :8767', '[fcm] push service ready', '[pty] session t1 attached (120x38)', '[health] audio ok · whisper large-v3-turbo geladen'] },
      { id: 't3', name: 'Deploy Watch', description: 'Vercel Deployment beobachten', colorTag: '#2f9e44', status: 'done', live: false,
        buffer: ['$ vercel logs pinterest-scraper --follow', '2026-07-11 14:02:11  BUILD  Compiled successfully', '2026-07-11 14:02:19  READY  ' + wrappedLinkUrl, '\x1b[32m✓ Deployment ready\x1b[0m'] },
      { id: 't4', name: 'Scratchpad', description: 'Freies Terminal', colorTag: '#9c36b5', status: 'waiting', live: false,
        buffer: ['$ htop', 'Warte auf Eingabe…'] },
    ],
    cloudProjects: [
      { id: 'c1', provider: 'vercel', name: 'pinterest-scraper', folder: 'Kunden/Pinterest', favorite: true,  status: 'ready',    lastDeploy: 'vor 8 Min',
        env: [ { key: 'DATABASE_URL', value: 'postgres://tms:s3cr3t@db.internal:5432/scraper' }, { key: 'PINTEREST_TOKEN', value: 'pina_9f8e7d6c5b4a' }, { key: 'NODE_ENV', value: 'production' }, { key: 'LOG_LEVEL', value: 'info' } ],
        logs: ['14:02:11 BUILD Compiled successfully', '14:02:19 READY Deployment ready', '14:03:02 GET /api/pins 200 (34ms)', '14:03:15 GET /api/boards 200 (51ms)', '14:04:40 POST /api/scrape 202 (queued)', '14:05:01 WORKER scrape job #4211 started', '14:06:33 WORKER scraped 480 pins', '14:06:34 WORKER job #4211 done (93s)'] },
      { id: 'c2', provider: 'vercel', name: 'tms-landing', folder: 'Eigene', favorite: false, status: 'ready', lastDeploy: 'vor 2 Tagen',
        env: [ { key: 'NEXT_PUBLIC_API', value: 'https://api.tms.dev' }, { key: 'ANALYTICS_ID', value: 'ga-7781' }, { key: 'NODE_ENV', value: 'production' } ],
        logs: ['09:11:02 BUILD Compiled', '09:11:20 READY Deployment ready', '10:15:44 GET / 200 (18ms)', '10:15:59 GET /pricing 200 (22ms)', '11:20:13 GET / 200 (15ms)', '12:01:27 GET /docs 404 (9ms)', '12:44:08 GET / 200 (14ms)', '13:37:55 GET /pricing 200 (19ms)'] },
      { id: 'c3', provider: 'vercel', name: 'aivertiser-app', folder: 'Kunden/Aivertiser', favorite: true, status: 'building', lastDeploy: 'läuft…',
        env: [ { key: 'OPENAI_KEY', value: 'sk-proj-a1b2c3' }, { key: 'STRIPE_KEY', value: 'sk_live_x9y8z7' }, { key: 'NODE_ENV', value: 'production' } ],
        logs: ['14:08:00 BUILD Installing dependencies…', '14:08:41 BUILD Compiling…', '14:09:12 BUILD Linting…', '14:09:30 BUILD Generating pages (12/48)', '14:09:48 BUILD Generating pages (31/48)', '14:10:02 BUILD Generating pages (48/48)', '14:10:11 BUILD Finalizing…', '14:10:15 BUILD Uploading…'] },
      { id: 'c4', provider: 'render', name: 'scraper-worker', folder: 'Kunden/Pinterest', favorite: false, status: 'live', lastDeploy: 'vor 1 Std',
        env: [ { key: 'REDIS_URL', value: 'redis://red-abc123:6379' }, { key: 'QUEUE_CONCURRENCY', value: '4' }, { key: 'SENTRY_DSN', value: 'https://o11y@sentry.io/881' } ],
        logs: ['13:00:12 worker booted (4 threads)', '13:04:55 job #4207 done', '13:22:10 job #4208 done', '13:40:33 job #4209 done', '13:58:01 job #4210 done', '14:05:01 job #4211 started', '14:06:34 job #4211 done', '14:06:35 queue empty — idle'] },
      { id: 'c5', provider: 'render', name: 'tms-postgres', folder: 'Infra', favorite: true, status: 'live', lastDeploy: 'vor 12 Tagen',
        env: [ { key: 'POSTGRES_DB', value: 'tms' }, { key: 'POSTGRES_USER', value: 'tms' }, { key: 'BACKUP_CRON', value: '0 3 * * *' } ],
        logs: ['03:00:00 backup started', '03:02:41 backup ok (412 MB)', '08:11:09 checkpoint complete', '10:44:52 autovacuum "pins" done', '12:00:00 stats: 214 conn/s peak', '13:15:33 checkpoint complete', '13:59:59 WAL rotated', '14:05:10 checkpoint complete'] },
      { id: 'c6', provider: 'render', name: 'adhan-cron', folder: 'Eigene', favorite: false, status: 'suspended', lastDeploy: 'vor 30 Tagen',
        env: [ { key: 'CITY', value: 'Berlin' }, { key: 'METHOD', value: 'MWL' }, { key: 'TZ', value: 'Europe/Berlin' } ],
        logs: ['05:12:00 fajr trigger sent', '13:24:00 dhuhr trigger sent', '17:31:00 asr trigger sent', '21:26:00 maghrib trigger sent', '23:01:00 isha trigger sent', '23:01:02 sleeping until 05:11', '—', 'service suspended by owner'] },
    ],
    manager: {
      messages: [
        { type: 'text',  from: 'user',    time: '13:41', text: 'Wie lief das Pinterest-Deployment?' },
        { type: 'text',  from: 'manager', time: '13:41', text: 'Deployment ist durch ✅ — Build in 68s, alle 27 Tests grün. Der Scraper-Worker hat direkt Job #4211 gezogen (480 Pins in 93s).' },
        { type: 'voice', from: 'user',    time: '13:52', duration: 14, transcript: 'Okay super, kannst du mir noch ein kurzes Update zu den Env-Änderungen geben und das in die Memory schreiben?', transcribing: false },
        { type: 'text',  from: 'manager', time: '13:53', text: 'Erledigt: LOG_LEVEL auf info gesetzt, PINTEREST_TOKEN rotiert. Beides in der Memory notiert 📝' },
        { type: 'voice', from: 'user',    time: '14:07', duration: 6, transcript: null, transcribing: true },
      ],
      artifacts: [
        { id: 'a1', title: 'Deploy-Report Pinterest', kind: 'report', time: 'heute 13:42' },
        { id: 'a2', title: 'Env-Änderungsprotokoll', kind: 'table', time: 'heute 13:53' },
      ],
      memory: [
        { id: 'm1', text: 'PINTEREST_TOKEN wird monatlich rotiert (zuletzt 11.07.)', time: 'heute' },
        { id: 'm2', text: 'User bevorzugt Deploys vor 15 Uhr', time: 'gestern' },
        { id: 'm3', text: 'Hetzner-Server ist Staging, Mac ist Produktion', time: 'vor 3 Tagen' },
      ],
    },
    prayerTimes: [
      { name: 'Fajr', time: '03:12' }, { name: 'Dhuhr', time: '13:24' }, { name: 'Asr', time: '17:31' },
      { name: 'Maghrib', time: '21:26' }, { name: 'Isha', time: '23:01' },
    ],
    snippets: [
      { id: 's1', label: 'Server neustarten', cmd: 'tms-terminal restart' },
      { id: 's2', label: 'Tests', cmd: 'npm test' },
      { id: 's3', label: 'Git Log kompakt', cmd: 'git log --oneline -15' },
      { id: 's4', label: 'Ports anzeigen', cmd: 'lsof -i -P | grep LISTEN' },
    ],
    notes: [
      { id: 'n1', title: 'Season 2 Ideen', body: 'Terminal-Stack, Env-Editor, Log-Viewer XXL', time: 'heute' },
      { id: 'n2', title: 'Bug-Sammlung', body: 'Link-Kopieren bei Umbruch, Selektion per Touch', time: 'gestern' },
    ],
    processes: [
      { pid: 412, name: 'node (tms-server)', cpu: 2.1, mem: 184 }, { pid: 833, name: 'claude', cpu: 41.7, mem: 912 },
      { pid: 1204, name: 'postgres', cpu: 0.8, mem: 356 }, { pid: 77, name: 'tailscaled', cpu: 0.3, mem: 44 },
      { pid: 902, name: 'whisper-server', cpu: 12.4, mem: 1480 }, { pid: 1533, name: 'chrome --headless', cpu: 6.2, mem: 618 },
    ],
    watchers: [
      { id: 'w1', pattern: 'ERROR|FATAL', session: 'TMS Server', hits: 0, active: true },
      { id: 'w2', pattern: 'Deployment ready', session: 'Deploy Watch', hits: 1, active: true },
    ],
    ports: [
      { port: 8767, service: 'tms-terminal', forwarded: true }, { port: 4321, service: 'season2-mockups', forwarded: true },
      { port: 5432, service: 'postgres', forwarded: false },
    ],
    files: [
      { name: 'server/', type: 'dir' }, { name: 'mobile/', type: 'dir' }, { name: 'shared/', type: 'dir' },
      { name: 'CLAUDE.md', type: 'file', size: '4.1 KB' }, { name: 'package.json', type: 'file', size: '1.2 KB' },
      { name: 'README.md', type: 'file', size: '2.8 KB' },
    ],
    sql: { query: 'SELECT id, board, pins FROM scrapes ORDER BY created_at DESC LIMIT 3;',
      rows: [ { id: 4211, board: 'interior-ideas', pins: 480 }, { id: 4210, board: 'streetwear', pins: 312 }, { id: 4209, board: 'ux-patterns', pins: 155 } ] },
    update: { current: '1.4.2', latest: '2.0.0', notes: 'Season 2 — komplettes Redesign' },
  };

  global.TMS_DATA = DATA;
  if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "mockups/season2/shared/"`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the chooser page**

`mockups/season2/index.html` — dark landing page, three cards (name, one-line pitch, style dots), each linking to `./command-deck/`, `./liquid-deck/`, `./mission-control/`. Title: `TMS Terminal — Season 2`. German copy: „Wähle ein Konzept", cards: „Command Deck — Pro-Tool pur · dicht, präzise, schnell", „Liquid Deck — iOS-Glass · Tiefe, Blur, Premium-Motion", „Mission Control — Hub-first · alles auf einen Blick". Mobile-first (cards stacked full-width on compact, 3-column grid ≥700px). Links must work before the concept pages exist (404 until Tasks 3–8 — acceptable). Keep it under ~120 lines; visual quality follows the frontend-design skill.

- [ ] **Step 6: Serve and verify**

Run (background): `python3 -m http.server 4321 -d "mockups/season2" --bind 0.0.0.0`
Run: `curl -s -o /dev/null -w '%{http_code}' http://localhost:4321/` → Expected: `200`
Run: `curl -s http://localhost:4321/shared/data.js | head -c 60` → Expected: starts with `// TMS_DATA`
Run: `tailscale ip -4 2>/dev/null || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4` → note the IP; phone URL is `http://<ip>:4321`.

- [ ] **Step 7: Commit**

```bash
git add mockups/season2/shared/data.js mockups/season2/shared/data.test.cjs mockups/season2/index.html
git commit --no-verify -o mockups/season2/shared/data.js -o mockups/season2/shared/data.test.cjs -o mockups/season2/index.html -m "feat(season2): scaffold mockups — shared data world + chooser page"
```

---

### Task 2: Terminal streaming simulator (`sim.js`)

**Files:**
- Create: `mockups/season2/shared/sim.js`
- Create: `mockups/season2/shared/sim.test.cjs`

**Interfaces:**
- Consumes: session `script` arrays from `TMS_DATA.sessions[].script` (events `{ t, type: 'out'|'status'|'prompt'|'done', data }`).
- Produces: `window.TMSSim.createSession(script, opts)` →
  `{ on(event, cb), start(), respond(), reset(), state }` where `event` ∈ `'out' | 'status' | 'prompt' | 'done'`; `opts = { speed = 1, immediate = false, autoApprove = false, autoApproveDelay = 600 }`. `state` ∈ `'idle' | 'playing' | 'awaiting-prompt' | 'done'`. On a `prompt` event playback PAUSES (state `awaiting-prompt`) until `respond()` — unless `autoApprove` is true, in which case it auto-continues after `autoApproveDelay` ms (0 in immediate mode) so concepts can demo Auto-Approve.

- [ ] **Step 1: Write the failing test**

`mockups/season2/shared/sim.test.cjs`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createSession } = require('./sim.js');

const SCRIPT = [
  { t: 10, type: 'status', data: 'running' },
  { t: 10, type: 'out', data: 'hello ' },
  { t: 10, type: 'prompt', data: { tool: 'Edit', question: 'Erlauben?' } },
  { t: 10, type: 'out', data: 'world' },
  { t: 10, type: 'status', data: 'done' },
  { t: 10, type: 'done', data: null },
];

test('immediate mode pauses at prompt, respond() continues', () => {
  const events = [];
  const s = createSession(SCRIPT, { immediate: true });
  for (const ev of ['out', 'status', 'prompt', 'done']) s.on(ev, d => events.push([ev, d]));
  s.start();
  assert.equal(s.state, 'awaiting-prompt');
  assert.deepEqual(events.map(e => e[0]), ['status', 'out', 'prompt']);
  s.respond();
  assert.equal(s.state, 'done');
  assert.deepEqual(events.map(e => e[0]), ['status', 'out', 'prompt', 'out', 'status', 'done']);
});

test('autoApprove runs through without respond()', () => {
  const s = createSession(SCRIPT, { immediate: true, autoApprove: true });
  s.start();
  assert.equal(s.state, 'done');
});

test('reset() allows replay', () => {
  const s = createSession(SCRIPT, { immediate: true, autoApprove: true });
  s.start(); s.reset();
  assert.equal(s.state, 'idle');
  s.start();
  assert.equal(s.state, 'done');
});

test('timer mode: autoApprove plays through with ordered payloads', async () => {
  const s = createSession(SCRIPT, { speed: 4, autoApprove: true, autoApproveDelay: 10 });
  const out = [];
  const finished = new Promise(resolve => s.on('done', resolve));
  s.on('out', d => out.push(d));
  s.start();
  await finished;
  assert.equal(s.state, 'done');
  assert.equal(out.join(''), 'hello world');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "mockups/season2/shared/"`
Expected: sim tests FAIL (`Cannot find module './sim.js'`), data tests still PASS.

- [ ] **Step 3: Implement `sim.js`**

```js
// TMSSim — deterministic scripted playback of a terminal session.
// immediate:true runs synchronously (tests); otherwise setTimeout-driven with speed multiplier.
(function (global) {
  function createSession(script, opts) {
    opts = Object.assign({ speed: 1, immediate: false, autoApprove: false, autoApproveDelay: 600 }, opts);
    const listeners = {};
    let i = 0, timer = null, autoTimer = null, epoch = 0;
    const api = {
      state: 'idle',
      on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return api; },
      start() { if (api.state !== 'idle') return; api.state = 'playing'; step(); },
      respond() {
        if (api.state !== 'awaiting-prompt') return;
        clearTimeout(autoTimer); // manual answer must disarm a pending auto-approve
        api.state = 'playing'; i++; step();
      },
      reset() { clearTimeout(timer); clearTimeout(autoTimer); epoch++; i = 0; api.state = 'idle'; },
    };
    function emit(ev, data) { (listeners[ev] || []).forEach(cb => cb(data)); }
    function schedule(fn, ms, isAuto) {
      if (opts.immediate) { fn(); return; }
      const e = epoch; // timers armed before a reset() must never fire into the replay
      const id = setTimeout(() => { if (e === epoch) fn(); }, ms / opts.speed);
      if (isAuto) autoTimer = id; else timer = id;
    }
    function step() {
      if (i >= script.length) return;
      const ev = script[i];
      schedule(() => {
        emit(ev.type, ev.data);
        if (ev.type === 'done') { api.state = 'done'; return; }
        if (ev.type === 'prompt') {
          api.state = 'awaiting-prompt';
          if (opts.autoApprove) schedule(() => api.respond(), opts.autoApproveDelay, true);
          return;
        }
        i++; step();
      }, ev.t);
    }
    return api;
  }
  const TMSSim = { createSession };
  global.TMSSim = TMSSim;
  if (typeof module !== 'undefined' && module.exports) module.exports = TMSSim;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "mockups/season2/shared/"`
Expected: PASS (10 tests total)

- [ ] **Step 5: Commit**

```bash
git add mockups/season2/shared/sim.js mockups/season2/shared/sim.test.cjs
git commit --no-verify -o mockups/season2/shared/sim.js -o mockups/season2/shared/sim.test.cjs -m "feat(season2): terminal streaming simulator with prompt pause + auto-approve"
```

---

### Task 3: Command Deck — shell, navigation, terminal workspace

**Files:**
- Create: `mockups/season2/command-deck/index.html`

**Interfaces:**
- Consumes: `window.TMS_DATA`, `window.TMSSim` via `<script src="../shared/data.js"></script>` and `<script src="../shared/sim.js"></script>`.
- Produces: SPA shell with screen router used by Task 4: `show(name)` toggles `<section data-screen="...">` visibility; screens registered so far: `servers`, `terminals`, plus command palette overlay.

**Design tokens (put in `:root`):**

```css
:root {
  --bg: #0a0a0c; --bg-raised: #131318; --border: #26262e;
  --text: #e6e6ea; --text-dim: #8b8b96; --accent: #7c6cff;
  --ok: #3fb950; --warn: #d29922; --err: #f85149;
  --font-ui: -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'SF Mono', ui-monospace, 'JetBrains Mono', monospace;
  --radius: 10px; --hairline: 1px solid var(--border);
}
```

Aesthetic rules: near-black, ONE accent, hairline borders, monospace for all data values, no shadows/gradients, 150ms ease-out transitions only. Follow the frontend-design skill for execution quality.

- [ ] **Step 1: Build the shell**

Structure:

```html
<body>
  <main id="screens">
    <section data-screen="servers"></section>
    <section data-screen="terminals" hidden></section>
    <!-- Task 4 adds: manager, cloud, tools, settings, prayer, lock -->
  </main>
  <nav id="commandbar"><!-- bottom bar: Server · Terminals · Manager · Cloud · ⌘ --></nav>
  <div id="palette" hidden><!-- Spotlight overlay --></div>
  <script src="../shared/data.js"></script>
  <script src="../shared/sim.js"></script>
  <script>
    function show(name) {
      document.querySelectorAll('[data-screen]').forEach(s => s.hidden = s.dataset.screen !== name);
      document.querySelectorAll('#commandbar [data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
    }
  </script>
</body>
```

Bottom command bar: 5 items (Server, Terminals, Manager, Cloud, ⌘-Palette). The ⌘ button opens the palette overlay instead of switching screens.

- [ ] **Step 2: Servers screen**

Render `TMS_DATA.servers` as dense list rows: status dot (ok/err), name, `host:port` in mono, latency chip, session count. Tap online server → `show('terminals')`. Offline server: dimmed, tap shows toast „Server offline — zuletzt gesehen vor 2 Std". Update banner (from `TMS_DATA.update`) pinned on top: „v2.0.0 verfügbar — Jetzt updaten", dismissible.

- [ ] **Step 3: Terminal Stack (the hero)**

Render all 4 `TMS_DATA.sessions` stacked vertically. Each terminal card: header row with color tag bar, **name (editable on tap — prompt-free inline `<input>`)**, description in `--text-dim`, status chip (`running` = pulsing accent, `waiting` = amber, `done` = green ✓, `idle` = gray). Body: mono `<pre>` rendering `buffer` lines (map `\x1b[…m` codes to spans — implement a ~20-line `ansiToHtml()` supporting bold/dim/green/red/reset; strip unknown codes so NO raw escapes ever show). Cards collapsible (tap header chevron) and reorderable (▲▼ buttons in header — no drag needed for mockup). Compact (<400px): one card expanded, rest collapsed. Expanded (≥700px): two-column stack grid.

- [ ] **Step 4: Live Claude session via TMSSim**

For session `t1` (`live: true`): on screen entry create `TMSSim.createSession(script, { autoApprove: false })`, `start()`, append `out` chunks to the pre (auto-scroll ONLY if user is at bottom — respect manual scroll). On `prompt`: render an inline permission card (tool, target, „Erlauben? [Ja] [Nein] [Auto-Approve an]") — „Ja" calls `respond()`; toggling Auto-Approve stores a flag and future prompts auto-respond after 600ms showing the „✔ Auto-Approve" line. Status chip follows `status` events. When `done`: show replay button „▶ Session erneut abspielen" → `reset()` + `start()`.

- [ ] **Step 5: Terminal toolbar + touch selection + wrapped-link demo**

Toolbar above keyboard area (fixed bottom inside terminal screen, above command bar): keys `Esc ↑ ↓ ← → Tab Ctrl ⌘V Aa`. `Aa` toggles **selection mode**: tapping a line highlights it with visible start/end handles (two draggable dots — pointer events), selected text gets accent background, floating „Kopieren"-bubble appears; tapping it → `navigator.clipboard.writeText` + toast „Kopiert ✓". The `wrappedLinkUrl` in sessions t1/t3 must render as ONE `<a>`-styled span even though CSS-wrapped across 2+ visual lines; tap → toast „Vollständiger Link kopiert ✓ (…dpl_8fK2mQx9…)". Other toolbar keys just flash a small key-echo chip (mockup behavior).

- [ ] **Step 6: Command palette (Spotlight)**

⌘ button → full-screen overlay with search input, fuzzy-filtering a flat index: sessions (by name), cloud projects, snippets (tap = toast „In Terminal eingefügt"), screens („Einstellungen", „Gebetszeiten", „Manager"…), actions („Neues Terminal", „Sperren"). Selecting navigates via `show()` or toasts. Until Task 4 screens exist, palette entries for them may `show()` placeholder-free — ONLY list entries whose targets exist at this point (sessions, snippets, „Neues Terminal", „Server"); Task 4 extends the index.

- [ ] **Step 7: Verify**

Run: `curl -s -o /dev/null -w '%{http_code}' http://localhost:4321/command-deck/` → `200`
Browser check (Chrome tools or manual): servers → tap → terminal stack renders 4 named terminals; t1 streams and pauses at permission prompt; Ja continues to done; selection mode shows handles + copy bubble; wrapped link copies full URL; palette opens/filters; no raw `\x1b` visible anywhere; layout works at 380px and 840px widths.

- [ ] **Step 8: Commit**

```bash
git add mockups/season2/command-deck/index.html
git commit --no-verify -o mockups/season2/command-deck/index.html -m "feat(season2): Command Deck — shell, terminal stack, palette"
```

---

### Task 4: Command Deck — full feature coverage

**Files:**
- Modify: `mockups/season2/command-deck/index.html`

**Interfaces:**
- Consumes: `show()`, palette index, toast helper, `ansiToHtml()` from Task 3.

- [ ] **Step 1: Tool panels screen**

`data-screen="tools"`: dense icon grid (9 tools from the coverage matrix). Each opens a bottom sheet rendering its `TMS_DATA` source: Dateien (`files` list), SQL (`sql.query` in mono + result table), Ports (`ports` with forward toggle), Prozesse (`processes` table, CPU bars), Snippets (tap = „eingefügt"-Toast), Notizen (`notes` cards), Screenshots (3 gray placeholder thumbs + „Aufnehmen"-Button → flash effect), Browser (fake URL bar + gray page skeleton), Watchers (`watchers` list with hit badges + active toggle). Reach: command bar „Cloud"-slot long-press OR palette; also add a `⋯`-button in the terminal screen header → tools.

- [ ] **Step 2: Manager screen**

`data-screen="manager"`: chat list from `TMS_DATA.manager.messages` — text bubbles; voice messages as player pill (▶, waveform bars, `duration`s, transcript below when `transcribing:false`; when `transcribing:true` show animated „Transkribiere… ●●●" that after 2.5s resolves to a transcript „(Demo) Transkription abgeschlossen" — demonstrating the FIXED fast transcription). Sub-tabs: Chat / Artifacts (`artifacts` cards) / Memory (`memory` rows with time). Input row with mic button (tap = recording animation 2s → new voice bubble appears).

- [ ] **Step 3: Cloud screen**

`data-screen="cloud"`: toolbar with provider filter (Alle/Vercel/Render) + view toggle (Ordner/Liste). Folder view groups by `folder` (collapsible groups „Kunden/Pinterest", „Eigene", „Infra", „Kunden/Aivertiser"). Rows: provider glyph, name, status chip (ready/live/building=pulsing/suspended), `lastDeploy`, **★ favorite toggle** (favorites float to top, persists in `localStorage`). Row tap → detail view: tabs **Env / Logs / Deploys**. Env: each row key + masked value, tap value to reveal, buttons „Kopieren" (clipboard + toast) and „Bearbeiten" (inline input + „Speichern" → toast „Gespeichert — Redeploy nötig"-Hinweis). Logs: **full-height mono viewer**, search input filters lines live, „Selektieren"-toggle reuses Task 3 selection handles, „Kopieren"-button for whole log, auto-stick to bottom for `building` project (append fake line every 2s). Deploys: 3 fake history entries (version, time, status).

- [ ] **Step 4: Settings, PrayerTimes, Lock, remaining coverage**

Settings (`data-screen="settings"`): grouped rows — Server (host/port), Sicherheit (PIN ändern, Auto-Lock), Benachrichtigungen (toggles), Terminal (Schriftgröße slider live-preview), Über (v1.4.2 → Update-Hinweis). PrayerTimes (`data-screen="prayer"`): today's 5 times from `prayerTimes`, next prayer highlighted with countdown, „Adhan-Demo"-button → full-screen alert overlay (name + „Stopp"-button). Lock (`data-screen="lock"`): shown on load BEFORE servers screen — PIN pad, `TMS_DATA.demo.pin` unlocks, wrong PIN shakes. Extend palette index with all new screens + actions („Env kopieren", „Adhan-Demo"…). Add prayer + settings entry points (palette + settings icon in servers header).

- [ ] **Step 5: Verify full coverage**

Walk the Feature Coverage Matrix items 1–14 (15 n/a for concept 1) on `http://localhost:4321/command-deck/` at 380px and 840px; each item must be reachable and functional. Fix anything missing.

- [ ] **Step 6: Commit**

```bash
git add mockups/season2/command-deck/index.html
git commit --no-verify -o mockups/season2/command-deck/index.html -m "feat(season2): Command Deck — full feature coverage (tools, manager, cloud, settings, prayer, lock)"
```

---

### Task 5: Liquid Deck — shell, navigation, terminal workspace

**Files:**
- Create: `mockups/season2/liquid-deck/index.html`

**Interfaces:** same consumption pattern as Task 3 (`../shared/data.js`, `../shared/sim.js`); own `show()` router.

**Design tokens:**

```css
:root {
  --bg-grad: radial-gradient(120% 90% at 20% 0%, #1b2340 0%, #0b0e1a 55%, #06070d 100%);
  --glass: rgba(255,255,255,0.07); --glass-strong: rgba(255,255,255,0.12);
  --glass-border: rgba(255,255,255,0.16); --blur: blur(24px) saturate(160%);
  --text: #f2f4ff; --text-dim: rgba(242,244,255,0.55);
  --accent: #6aa8ff; --accent-warm: #ff9f6a;
  --ok: #4ade80; --warn: #fbbf24; --err: #f87171;
  --radius-lg: 24px; --radius-md: 16px;
  --spring: cubic-bezier(0.34, 1.3, 0.5, 1);
}
```

Aesthetic rules: every surface is a glass layer (`background: var(--glass); backdrop-filter: var(--blur); border: 1px solid var(--glass-border)`), soft depth via layered translucency not box-shadows, 350ms `--spring` transitions, subtle top light-reflection line (`::before` 1px white/20% gradient) on cards. Follow the frontend-design skill.

- [ ] **Step 1: Shell — Dynamic Island + glass dock**

Same router pattern as Task 3 Step 1, but navigation = floating **glass dock** (bottom, pill, 5 icons: Server · Terminals · Manager · Cloud · Mehr) + **Dynamic Island** (top center, persistent across screens): compact pill showing live state — pulsing dot + „Claude arbeitet · Pinterest Scraper" while sim runs, „✓ Fertig" after, prayer countdown segment („Asr in 2:14h"). Tap island → expands (spring) into status card: running sessions, agent activity, next prayer, building deploy. „Mehr"-dock icon → glass action sheet (Tools, Einstellungen, Gebetszeiten, Sperren).

- [ ] **Step 2: Servers screen**

Glass cards (not rows) with big server name, status glow (green halo online / gray offline), latency, session count; update banner as floating glass pill on top. Tap online → terminals.

- [ ] **Step 3: Terminal workspace — spatial card stack**

Terminals as **swipeable spatial stack** (Safari-tab feel): active session fills most of viewport as glass-framed terminal card; other sessions peek behind/below with scale+translate; horizontal swipe (touch + pointer drag) cycles sessions with spring animation; a stack-overview button (⊞) shrinks all 4 into a 2×2 grid (tap to focus). Each card header: color tag, editable name, description, status chip — same semantics as Task 3 Step 3, glass styling. Terminal body: SAME `ansiToHtml()` approach (reimplement locally — file is self-contained), dark glass pane so text stays high-contrast/readable. Expanded (≥700px): active card left (60%), stack rail right (40%) with mini previews; drag from rail to swap.

- [ ] **Step 4: Live session, toolbar, selection, wrapped link**

Same functional requirements as Task 3 Steps 4–5 (TMSSim streaming, permission card, Auto-Approve toggle, replay; toolbar keys; selection mode with handles + copy bubble; wrapped-link full copy) — restyled: permission prompt is a glass sheet sliding from bottom with spring; toolbar is a floating glass pill above the dock; selection handles are glowing dots. Functional acceptance identical.

- [ ] **Step 5: Verify**

`curl` 200 on `/liquid-deck/`; browser: island updates live during stream, swipe cycles cards, overview grid works, permission sheet + auto-approve + replay work, selection + wrapped link work, readable text on glass (contrast!), 380px + 840px layouts.

- [ ] **Step 6: Commit**

```bash
git add mockups/season2/liquid-deck/index.html
git commit --no-verify -o mockups/season2/liquid-deck/index.html -m "feat(season2): Liquid Deck — glass shell, dynamic island, spatial terminal stack"
```

---

### Task 6: Liquid Deck — full feature coverage

**Files:**
- Modify: `mockups/season2/liquid-deck/index.html`

Same functional requirements as Task 4 (tools sheet grid, manager with voice/artifacts/memory + transcription demo, cloud with favorites/folders/env-edit/log-viewer, settings, prayer + adhan overlay, lock-first, spotlight) — restyled to glass:

- [ ] **Step 1: Tools** — „Mehr"-sheet → tool grid of frosted tiles; each tool opens a glass sheet; same data bindings as Task 4 Step 1.
- [ ] **Step 2: Manager** — chat over blurred backdrop, voice pill with animated waveform, transcription demo identical; Artifacts as glass cards carousel; Memory rows.
- [ ] **Step 3: Cloud** — folder groups as glass sections, ★ favorites with glow + `localStorage`, env reveal/copy/edit, XXL log viewer with search/selection/copy, building project live-appends; deploys tab.
- [ ] **Step 4: Settings + Prayer + Lock + Spotlight** — settings glass groups; prayer screen with large next-prayer glass card + countdown + Adhan overlay (full-screen blur); lock-first PIN pad on frosted background (`1234`); spotlight = pull-down on any screen (and dock long-press) with same index scope as Task 4.
- [ ] **Step 5: Verify coverage** — matrix items 1–15 at 380px/840px (island = item 15 ✓).
- [ ] **Step 6: Commit**

```bash
git add mockups/season2/liquid-deck/index.html
git commit --no-verify -o mockups/season2/liquid-deck/index.html -m "feat(season2): Liquid Deck — full feature coverage"
```

---

### Task 7: Mission Control — shell, hub, terminal workspace

**Files:**
- Create: `mockups/season2/mission-control/index.html`

**Interfaces:** same consumption pattern; own router. **Hub-first:** start screen (after lock) is the Hub, not a server list.

**Design tokens:**

```css
:root {
  --bg: #0c0e12; --panel: #14171d; --panel-2: #1a1e26; --border: #262b35;
  --text: #e8ebf2; --text-dim: #97a0af; --accent: #4f8cff; --accent-2: #8f6aff;
  --glass: rgba(79,140,255,0.08); --glass-border: rgba(79,140,255,0.25); --blur: blur(18px);
  --ok: #35c26e; --warn: #e5a53a; --err: #ec5f67;
  --radius: 14px; --font-mono: 'SF Mono', ui-monospace, monospace;
}
```

Aesthetic rules: pro-tool dark density as base (solid panels, hairlines), glass ONLY for elevated moments (island, sheets, alerts, permission prompts) — glass = importance. Follow the frontend-design skill.

- [ ] **Step 1: Shell + Hub**

Router as before. Hub (`data-screen="hub"`) = zone grid: **Sessions-Zone** (live tiles per session: name, colortag, status, last output line — the live one shows streaming text via a shared hub-level TMSSim instance), **Server-Zone** (2 compact status tiles), **Cloud-Zone** (favorites first, building project with progress shimmer), **Manager-Zone** (last message + unread dot), **Heute-Zone** (next prayer countdown, update banner v2.0.0). Compact: zones stacked, priority order Sessions → Manager → Cloud → Server → Heute. Expanded (≥700px, Fold open): 2-column operations-center grid — Sessions zone spans left column full-height, right column stacks the rest. Slim top status strip (glass): time, server dot, „Claude aktiv"-pulse, prayer countdown; tap → expands (this is the concept-3 island, item 15).

- [ ] **Step 2: Workspace — dive-in from hub**

Tap session tile → `data-screen="workspace"`: focused terminal (same semantics as Task 3 Step 3–4: editable name, description, status chip, ansiToHtml, TMSSim streaming with glass permission sheet + Auto-Approve + replay). Folded: single terminal + bottom session-switcher chips. Unfolded: **terminal left (~62%), context rail right** — rail shows tabs Kontext (running session meta, watchers hits), Dateien, Notizen bound to `TMS_DATA`. Back-chip top-left → hub.

- [ ] **Step 3: Toolbar, selection, wrapped link**

Identical functional requirements to Task 3 Step 5 (toolbar keys, selection handles + copy bubble, wrapped-link full copy) in the workspace; pro-tool styling, glass copy-bubble.

- [ ] **Step 4: Verify**

`curl` 200 on `/mission-control/`; browser: hub zones live-update while sim streams, dive-in/back works, both fold layouts (380px/840px), permission sheet, selection, wrapped link.

- [ ] **Step 5: Commit**

```bash
git add mockups/season2/mission-control/index.html
git commit --no-verify -o mockups/season2/mission-control/index.html -m "feat(season2): Mission Control — hub-first shell + workspace"
```

---

### Task 8: Mission Control — full feature coverage

**Files:**
- Modify: `mockups/season2/mission-control/index.html`

Same functional requirements as Task 4, integrated hub-first:

- [ ] **Step 1: Cloud-Zone → Cloud screen** — full cloud module (folders, ★ favorites + `localStorage`, env reveal/copy/edit, XXL log viewer w/ search+selection+copy, live building logs, deploys) as Task 4 Step 3.
- [ ] **Step 2: Manager-Zone → Manager screen** — chat/voice/transcription-demo/artifacts/memory as Task 4 Step 2.
- [ ] **Step 3: Tools** — workspace context rail „Tools"-tab (unfolded) + hub quick-actions row (folded): all 9 panels as sheets, data-bound as Task 4 Step 1.
- [ ] **Step 4: Settings, Prayer, Lock, Spotlight, Servers** — settings screen; prayer screen + Adhan overlay from Heute-Zone; lock-first PIN `1234`; spotlight via search icon in status strip (full index incl. actions); server detail from Server-Zone (connect toast for offline).
- [ ] **Step 5: Verify coverage** — matrix items 1–15 at 380px/840px.
- [ ] **Step 6: Commit**

```bash
git add mockups/season2/mission-control/index.html
git commit --no-verify -o mockups/season2/mission-control/index.html -m "feat(season2): Mission Control — full feature coverage"
```

---

### Task 9: QA sweep + phone handoff

**Files:**
- Modify: any of the four HTML files (fixes only)

- [ ] **Step 1: Automated smoke**

Run: `node --test "mockups/season2/shared/"` → all PASS.
Run: `for p in "" command-deck/ liquid-deck/ mission-control/; do curl -s -o /dev/null -w "%{http_code} $p\n" http://localhost:4321/$p; done` → four `200`s.
Run: `grep -L 'shared/data.js' mockups/season2/*/index.html` → empty (every concept binds shared data).

- [ ] **Step 2: Coverage matrix audit**

For EACH concept, walk matrix items 1–15 in the browser at 380px and 840px. Record a checklist; fix every gap in place. Specifically re-test the five hero moments per concept: named-terminal stack, streaming+prompt+auto-approve, touch selection copy, wrapped-link full copy, env edit + log viewer.

- [ ] **Step 3: Chooser polish**

Ensure `index.html` cards deep-link correctly and render well on the phone; add the Tailscale URL hint line („Auf dem Handy: http://<tailscale-ip>:4321") populated via `location.host`.

- [ ] **Step 4: Final commit + handoff message**

```bash
git add mockups/season2
git commit --no-verify -o mockups/season2 -m "feat(season2): QA pass — full coverage across all three concepts"
```

Report to user: phone URL `http://<tailscale-ip>:4321`, what to look at per concept, and that Phase 2 (pick & refine) starts on their verdict.

---

## Self-Review Notes

- **Spec coverage:** matrix items 1–15 mapped to Tasks 3–8; shared data world → Task 1; simulator → Task 2; Fold modes verified in every concept's verify step + Task 9; serving/Tailscale → Task 1 Step 6 + Task 9 Step 3; pain-point staging called out as hero moments (Tasks 3/5/7 + 9).
- **Types:** `TMS_DATA` shape defined once (Task 1) and consumed read-only; `TMSSim.createSession` signature defined in Task 2 and reused verbatim in Tasks 3–8.
- **Known trade-off:** concept SPAs are creative work — steps specify exact behavior + data bindings + acceptance checks rather than full markup; visual execution follows the frontend-design skill within each task's token block.
