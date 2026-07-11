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
    demo: { wrappedLinkUrl, pin: '1234', dictation: 'npm test && vercel logs pinterest-scraper --follow' },
    servers: [
      { id: 'srv-mac', name: 'Ayysir MacBook', host: '100.64.0.12', port: 8767, status: 'online',  sessions: 4, os: 'macOS 26', latency: 12 },
      { id: 'srv-hetzner', name: 'Hetzner Cloud', host: '100.64.0.31', port: 8767, status: 'offline', sessions: 0, os: 'Ubuntu 24.04', latency: null },
    ],
    sessions: [
      { id: 't1', name: 'Pinterest Scraper', description: 'Claude fixt fehlschlagende Tests', colorTag: '#e8590c', status: 'running', live: true, script: claudeScript,
        buffer: ['\x1b[2m~/dev/pinterest-scraper\x1b[0m $ claude "fix the failing tests"'],
        notes: [ { id: 't1n1', text: 'Parser wirft bei 404 statt leerem Array — Fix in parser.ts:41', time: 'heute' } ],
        todos: [ { id: 't1d1', text: 'Tests grün bekommen', done: true }, { id: 't1d2', text: 'Preview-Deployment prüfen', done: false } ] },
      { id: 't2', name: 'TMS Server', description: 'Live-Logs des Terminal-Servers', colorTag: '#1971c2', status: 'idle', live: false,
        buffer: ['\x1b[2m~/Desktop/tms-terminal\x1b[0m $ tms-terminal start', '[ws] listening on :8767', '[fcm] push service ready', '[pty] session t1 attached (120x38)', '[health] audio ok · whisper large-v3-turbo geladen'],
        notes: [ { id: 't2n1', text: 'Whisper large-v3-turbo läuft seit Boot stabil', time: 'heute' } ],
        todos: [ { id: 't2d1', text: 'Log-Rotation einrichten', done: false } ] },
      { id: 't3', name: 'Deploy Watch', description: 'Vercel Deployment beobachten', colorTag: '#2f9e44', status: 'done', live: false,
        buffer: ['$ vercel logs pinterest-scraper --follow', '2026-07-11 14:02:11  BUILD  Compiled successfully', '2026-07-11 14:02:19  READY  ' + wrappedLinkUrl, '\x1b[32m✓ Deployment ready\x1b[0m'],
        notes: [ { id: 't3n1', text: 'Deploy-Baseline: 68s Build, 27 Tests', time: 'heute' } ],
        todos: [ { id: 't3d1', text: 'Alte Preview-Deployments aufräumen', done: false } ] },
      { id: 't4', name: 'Scratchpad', description: 'Freies Terminal', colorTag: '#9c36b5', status: 'waiting', live: false,
        buffer: ['$ htop', 'Warte auf Eingabe…'],
        notes: [],
        todos: [ { id: 't4d1', text: 'htop durch btop ersetzen?', done: false } ] },
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
