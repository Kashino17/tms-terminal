# Cloud Panels — Render & Vercel Management

**Date:** 2026-03-24
**Status:** Approved
**Author:** ayysir + Claude

## Overview

Add Render and Vercel cloud platform management to the TMS Terminal mobile app. Two new Tool Rail entries allow managing projects, deployments, environment variables, logs, and cron jobs directly from the phone. Background polling sends local push notifications on deployment status changes.

## Requirements

- Both platforms used equally, 10+ projects each, multiple teams/orgs
- Priority order: Deployment Status/Logs > Trigger Actions > Env Vars
- Logs are frequently copied
- Push notifications when deployments finish or fail

## Architecture

**Approach:** Rein Mobile-Side — direct REST API calls from the app to Render/Vercel APIs. No server-side proxy needed.

**Rationale:**
- No server code required — faster to implement
- Works independently of TMS Server
- Tailscale VPN handles network security
- Background polling for notifications is sufficient (no webhooks needed)

**Independence from TMS Server:** Cloud panels are fully self-contained. They do not use WebSocket, `serverId`, `sessionId`, or any server-scoped props. They read state exclusively from their own Zustand stores (`cloudAuthStore`, `cloudProjectsStore`, `cloudWatchStore`). However, the panels are rendered within the ToolRail on the TerminalScreen — so a server connection must be active for the ToolRail to be visible. This is acceptable because the user is typically working in a terminal session when they want to check deployment status.

## Tool Rail Integration

New **Group 4 — Cloud** added below existing Group 3 (Capture & Monitoring):

| Tool | Icon | Color | Panel |
|------|------|-------|-------|
| Render | `box` (Feather Icons) | `#4353FF` (Render Blue) | `RenderPanel` |
| Vercel | `triangle` (Feather Icons) | `#FFFFFF` | `VercelPanel` |

**Icon notes:** Feather's `triangle` is an outline, not the filled Vercel logo — acceptable as a recognizable stand-in. Feather's `box` is used for Render since there's no official Render icon in Feather. Both are visually distinct from existing tool icons.

Both panels share identical structure via shared components, differing only in API backend.

## Panel Structure & Navigation

### Level 1: Project List

```
┌─────────────────────────┐
│ [Icon] Render      [⚙️]  │  Header + Settings gear
│ Account: My-Team   [▼]  │  Owner/Team dropdown switcher
├─────────────────────────┤
│ 🔍 Suche...             │  Filter/search across projects
├─────────────────────────┤
│ 🟢 my-api         Web   │
│ 🟡 worker      Building │
│ 🟢 postgres-db     DB   │
│ 🔴 cron-job     Failed  │
│ ...                      │
└─────────────────────────┘
```

- Owner/Team switcher as dropdown at top (label: "Account" — covers both personal accounts and teams)
- Search bar filters projects by name (client-side, no API call)
- Each project shows: status indicator (colored dot), name, type/framework badge
- Tap on project → navigates to detail view
- Pull-to-refresh reloads project list
- Pagination: loads first 20 projects, "Mehr laden" button at bottom for next page (cursor-based)

### Level 2: Project Detail (Tab-based)

```
┌─────────────────────────┐
│ ← my-api                │  Back button + project name
├─────────────────────────┤
│ Deploys │ Env │ Logs │ ⚡│  4 tabs
├─────────────────────────┤
│ [tab content]            │
└─────────────────────────┘
```

#### Tab: Deploys
- Deployment history list: status icon, commit message (truncated), relative timestamp
- Copy button per deployment (copies build log)
- Tap on deployment → expands inline build log view
- Pull-to-refresh
- Pagination: loads 20 most recent, "Mehr laden" button for older deploys

#### Tab: Env
- List of environment variables: key + masked value (`•••`)
- Tap on variable → Bottom Sheet with Name, Value, Scope fields
- "+" floating button to add new variable
- Swipe-to-delete with confirmation
- Scope selector (Render: all services / Vercel: production/preview/development)

#### Tab: Logs
- **Runtime/service logs** (stdout/stderr of the running service — distinct from build logs in Deploys tab)
- Render: `GET /services/{id}/logs` — runtime logs
- Vercel: `GET /v2/deployments/{latestDeployId}/events` filtered to runtime events
- Auto-scroll to bottom, "Copy All" button in header
- Tap on single log line → copies it to clipboard
- Monospace font, color-coded by level (error=red, warn=amber, info=default)

#### Tab: ⚡ Actions
- **Redeploy** — trigger new deployment from latest commit
- **Rollback** — select a previous successful deployment to rollback to
- **Cron Jobs** (Render: list cron jobs with manual trigger button / Vercel: show cron config from vercel.json)
- Each action has confirmation dialog before executing

## Env Var Bottom Sheet

```
┌─────────────────────────┐
│ Umgebungsvariable        │
├─────────────────────────┤
│ Key                      │
│ ┌───────────────────────┐│
│ │ DATABASE_URL           ││
│ └───────────────────────┘│
│ Value                    │
│ ┌───────────────────────┐│
│ │ postgres://...         ││
│ └───────────────────────┘│
│ Scope                    │
│ ┌───────────────────────┐│
│ │ All Environments   ▼  ││
│ └───────────────────────┘│
│                          │
│ [Löschen]    [Speichern] │
└─────────────────────────┘
```

- Opens on tap of existing var (pre-filled) or "+" button (empty)
- Value field is multiline for long values (JSON, connection strings)
- Delete button with destructive styling + confirmation alert
- Save validates non-empty key/value before API call

## Data Architecture

### Shared Interface

Both API services implement a common `CloudProvider` interface:

```typescript
interface CloudProvider {
  // Auth
  validateToken(token: string): Promise<boolean>

  // Owners/Teams
  listOwners(): Promise<Owner[]>

  // Projects/Services
  listProjects(ownerId: string, cursor?: string): Promise<PaginatedResult<Project>>

  // Deployments
  listDeployments(projectId: string, cursor?: string): Promise<PaginatedResult<Deployment>>
  getDeploymentLogs(deployId: string): Promise<LogEntry[]>

  // Runtime Logs
  getServiceLogs(projectId: string): Promise<LogEntry[]>

  // Deploy Actions
  triggerDeploy(projectId: string): Promise<Deployment>
  rollbackDeploy(projectId: string, targetDeployId: string): Promise<void>

  // Env Vars
  listEnvVars(projectId: string): Promise<EnvVar[]>
  createEnvVar(projectId: string, env: NewEnvVar): Promise<void>
  updateEnvVar(projectId: string, envId: string, env: NewEnvVar): Promise<void>
  deleteEnvVar(projectId: string, envId: string): Promise<void>

  // Cron/Jobs
  listCronJobs(projectId: string): Promise<CronJob[]>
  triggerCronJob(jobId: string): Promise<void>
}
```

### Shared Types

```typescript
interface Owner {
  id: string
  name: string
  slug: string
  type: 'personal' | 'team'    // Render personal account vs team, Vercel personal vs team
}

interface PaginatedResult<T> {
  items: T[]
  cursor?: string               // undefined = no more pages
}

type ProjectStatus = 'ready' | 'building' | 'error' | 'queued' | 'canceled' | 'suspended' | 'inactive'

interface Project {
  id: string
  name: string
  status: ProjectStatus         // derived from latest deployment for Vercel
  type: string                  // e.g. 'web_service', 'cron_job', 'nextjs', 'static'
  updatedAt: string
  repo?: string
  latestDeployId?: string       // needed for Vercel runtime logs + rollback
}

type DeploymentStatus = 'ready' | 'building' | 'queued' | 'error' | 'canceled'

interface Deployment {
  id: string
  status: DeploymentStatus
  commitMessage?: string
  commitHash?: string
  createdAt: string
  finishedAt?: string
  duration?: number             // seconds
}

interface LogEntry {
  timestamp: string
  level: 'error' | 'warn' | 'info' | 'debug'
  message: string
}

interface EnvVar {
  id: string                    // Render: uses `key` as id (no separate id field)
  key: string
  value: string
  scope: string[]               // Render: ['all'] / Vercel: ['production','preview','development']
}

type NewEnvVar = Omit<EnvVar, 'id'>

interface CronJob {
  id: string
  name: string
  schedule: string              // cron expression
  lastRunAt?: string
  lastRunStatus?: 'success' | 'failed'
}
```

### Status Mapping

Each platform's native statuses are mapped to the unified enums:

**Project Status:**

| Unified | Render native | Vercel (from latest deploy) |
|---------|--------------|----------------------------|
| `ready` | `deployed` | `READY` |
| `building` | `deploying`, `build_in_progress` | `BUILDING` |
| `error` | `deploy_failed`, `build_failed` | `ERROR` |
| `queued` | `pending` | `QUEUED` |
| `canceled` | `canceled` | `CANCELED` |
| `suspended` | `suspended` | `—` (not applicable) |
| `inactive` | `not_deployed` | no deployments |

**Deployment Status:**

| Unified | Render native | Vercel native |
|---------|--------------|---------------|
| `ready` | `live` | `READY` |
| `building` | `build_in_progress`, `update_in_progress` | `BUILDING` |
| `queued` | `created`, `pending` | `QUEUED` |
| `error` | `build_failed`, `update_failed` | `ERROR` |
| `canceled` | `canceled`, `deactivated` | `CANCELED` |

### Zustand Stores

| Store | Purpose | Persistence |
|-------|---------|-------------|
| `cloudAuthStore` | API tokens for Render + Vercel, active owner per platform, notification settings (toggle + interval) | AsyncStorage (persistent) |
| `cloudProjectsStore` | Projects cache per owner, last fetch timestamp, selected project | AsyncStorage (cache, TTL 5min) |
| `cloudWatchStore` | Deployments with `status === 'building' \| 'queued'` being watched for notifications | AsyncStorage (persistent, survives app restart) |

### API Services

| File | Base URL | Auth Header |
|------|----------|-------------|
| `render.service.ts` | `https://api.render.com/v1` | `Authorization: Bearer {token}` |
| `vercel.service.ts` | `https://api.vercel.com` | `Authorization: Bearer {token}` |

Both services handle:
- HTTP error codes → user-friendly error messages (German)
- Rate limiting (429) → exponential backoff retry (max 3 retries, backoff: 1s → 2s → 4s, max 30s)
- Token expiry (401) → clear token, show setup screen
- When all retries exhausted → show error banner "API nicht erreichbar, bitte später erneut versuchen"

### Platform-Specific API Details

**Render `triggerDeploy`:** Simple `POST /services/{id}/deploys` — Render handles the rest.

**Vercel `triggerDeploy`:** Uses redeploy semantics — `POST /v13/deployments` with body `{ "deploymentId": latestDeployId, "target": "production" }`. Requires `latestDeployId` from the project.

**Vercel `rollbackDeploy`:** Uses instant rollback — `POST /v9/deployments/{targetDeployId}/promote` to promote a previous successful deployment. The spec's original endpoint was incorrect.

**Render Env Var IDs:** Render's API identifies env vars by `key`, not a separate `id`. The Render service implementation sets `id = key` in the returned `EnvVar` objects. Update/delete operations use the `key` field internally.

## Notifications & Background Polling

### Foreground Polling
- When a Cloud Panel is open: poll every 30 seconds
- Only polls the currently visible project's deployments
- Updates deployment list in real-time

### Background Polling
- Uses React Native Background Fetch (~2 min interval, OS-controlled)
- Only checks deployments stored in `cloudWatchStore` (status = `building` or `queued`)
- One API call per watched deployment (minimal load)
- On status change: remove from watch list + send local notification
- If rate-limited during background poll: skip this cycle, retry next interval

### Watch Lifecycle
1. User triggers a deploy → deployment added to `cloudWatchStore`
2. User opens a project with a building/queued deploy → added to watch list
3. Background poll detects status change → local notification + remove from watch
4. No watched deployments → background fetch is a no-op

### Notification Format

| Event | Title | Body |
|-------|-------|------|
| Deploy success | `✅ Render: my-api` | `Deployment #42 erfolgreich (2m 34s)` |
| Deploy failed | `❌ Vercel: frontend` | `Deployment #15 fehlgeschlagen` |

### Notification Deep-Link

Notification `data` payload:
```typescript
interface CloudNotificationData {
  type: 'cloud_deploy'
  platform: 'render' | 'vercel'
  projectId: string
  projectName: string
}
```

The existing `notifications.service.ts` `consumePendingNotificationTarget()` is extended: if the returned data has `type === 'cloud_deploy'`, the navigation handler opens the TerminalScreen (if not already there), activates the corresponding cloud panel, and navigates to the project's Deploys tab. This is distinct from the existing `sessionId`-based terminal idle notifications.

## Auth Flow

### First-time Setup (in Panel)
1. User opens Render/Vercel panel
2. No token found → shows setup view with instructions
3. "Go to [Platform]" link opens In-App Browser to API key page
   - Render: `https://dashboard.render.com/settings#api-keys`
   - Vercel: `https://vercel.com/account/tokens`
4. User creates token, copies it, pastes into input field
5. Tap "Verbinden" → validates token via `listOwners()` API call
6. Success → stores token, loads owners, shows project list
7. Failure → error message "Ungültiger Token"

### Settings Integration
New section **"Cloud Accounts"** in existing SettingsScreen, inserted **after "Terminal Theme"** section and **before "Clear Data"** button:
- Shows connected status per platform (token prefix masked: `rnd_•••` / `vrc_•••`)
- "Trennen" button to disconnect (clears token + all cached data)
- Deploy-Alerts toggle (on/off) — stored in `cloudAuthStore`
- Polling interval selector (1min / 2min / 5min) — stored in `cloudAuthStore`

## File Structure

```
mobile/src/
├── services/
│   ├── render.service.ts        # Render REST API client (implements CloudProvider)
│   ├── vercel.service.ts        # Vercel REST API client (implements CloudProvider)
│   └── cloud.types.ts           # Shared interfaces (CloudProvider, Owner, Project, etc.)
├── store/
│   ├── cloudAuthStore.ts        # Tokens, active owner per platform, notification prefs
│   ├── cloudProjectsStore.ts    # Projects cache with TTL + pagination cursors
│   └── cloudWatchStore.ts       # Deployment watch list for notifications
├── components/
│   ├── RenderPanel.tsx          # Thin wrapper — passes renderService to shared components
│   ├── VercelPanel.tsx          # Thin wrapper — passes vercelService to shared components
│   ├── CloudProjectList.tsx     # Shared: owner switcher + search + project list
│   ├── CloudProjectDetail.tsx   # Shared: tab-based detail view (Deploys|Env|Logs|Actions)
│   ├── CloudEnvSheet.tsx        # Bottom sheet for env var create/edit
│   └── CloudSetup.tsx           # Token setup view (instructions + input + validate)
```

## UI Details

### Styling
- Follows existing dark theme from `theme.ts`
- Uses `useResponsive()` hook for all dimensions
- Panel width follows existing `panelWidth` constants per breakpoint
- Status colors: ready=`#22C55E`, building=`#F59E0B`, error=`#EF4444`, inactive=`#64748B`, queued=`#3B82F6`
- Log viewer uses monospace font with existing terminal theme colors

### Compact Breakpoint (<400dp)
At compact width (170dp panel), content is simplified:
- Project list: name + status dot only (no type badge)
- Detail tabs: icons instead of text labels
- Log lines: truncated with horizontal scroll
- Env var keys: truncated with ellipsis

### Animations
- Panel open/close: existing spring/timing animation from ToolRail
- Tab switching: horizontal slide transition
- Bottom sheet: slide-up with backdrop
- List items: LayoutAnimation on refresh (consistent with WatchersPanel)

### Error & Offline States
- Network error → banner at top of panel "Keine Verbindung" with retry button
- Offline: show cached project list with dimmed styling + "Offline — letzte Daten" label. Disable all mutation actions (deploy, rollback, env CRUD). Read-only browsing of cached data still works.
- Empty project list → centered message "Keine Projekte gefunden"
- Empty deployment list → "Noch keine Deployments"
- Token expired → redirect to setup view with message "Token abgelaufen"

## Platform-Specific API Endpoints

| Feature | Render API | Vercel API |
|---------|-----------|------------|
| List owners/teams | `GET /owners` | `GET /v2/teams` + personal account from token info |
| List projects | `GET /services?ownerId=X&limit=20&cursor=Y` | `GET /v9/projects?teamId=X&limit=20&until=Y` |
| List deployments | `GET /services/{id}/deploys?limit=20&cursor=Y` | `GET /v6/deployments?projectId=X&limit=20&until=Y` |
| Get build logs | `GET /deploys/{id}/logs` | `GET /v2/deployments/{id}/events?builds=1` |
| Get runtime logs | `GET /services/{id}/logs` | `GET /v2/deployments/{latestDeployId}/events` |
| Trigger deploy | `POST /services/{id}/deploys` | `POST /v13/deployments` with `{ deploymentId, target }` |
| Rollback | `POST /services/{id}/rollbacks/{deployId}` | `POST /v9/deployments/{targetDeployId}/promote` |
| List env vars | `GET /services/{id}/env-vars` | `GET /v9/projects/{id}/env` |
| Create env var | `POST /services/{id}/env-vars` | `POST /v10/projects/{id}/env` |
| Update env var | `PUT /services/{id}/env-vars/{key}` | `PATCH /v10/projects/{id}/env/{envId}` |
| Delete env var | `DELETE /services/{id}/env-vars/{key}` | `DELETE /v10/projects/{id}/env/{envId}` |
| Cron jobs | `GET /services?type=cron_job&ownerId=X` | Read from project config (vercel.json `crons` field) |
| Trigger cron | `POST /services/{id}/deploys` (redeploy cron) | `POST /v13/deployments` (redeploy project) |

## Scope & Non-Goals

### In Scope
- Project/service listing with search and owner/team switching
- Deployment history, build logs, runtime logs, manual redeploy, rollback
- Environment variable CRUD with bottom sheet editor
- Cron job listing and manual triggering
- Background polling with local push notifications
- Token management in panel + settings

### Out of Scope (future work)
- Domain management
- Billing/usage stats
- Project creation/deletion
- Real-time log streaming (WebSocket)
- Server-side webhook integration for instant notifications
- Database management (Render Postgres, Vercel Storage)
