# Cloud Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Render and Vercel cloud management panels to the TMS Terminal mobile app ToolRail, enabling project listing, deployment management, env var CRUD, log viewing, and deploy notifications — all via direct REST API calls from mobile (no server changes).

**Architecture:** Two new ToolRail entries (Group 4 — Cloud) each open a panel backed by platform-specific API services implementing a shared `CloudProvider` interface. State lives in three Zustand stores (auth, projects cache, deployment watch list). Background Fetch polls watched deployments and fires local notifications on status changes.

**Tech Stack:** React Native (Expo), Zustand + AsyncStorage, Feather Icons, useResponsive(), fetch() for REST APIs, expo-notifications for local push, react-native-background-fetch for polling.

**Spec:** `docs/superpowers/specs/2026-03-24-cloud-panels-design.md`

---

## File Structure

```
mobile/src/
├── services/
│   ├── cloud.types.ts              [CREATE] Shared interfaces: CloudProvider, Owner, Project, Deployment, etc.
│   ├── render.service.ts           [CREATE] Render REST API client implementing CloudProvider
│   └── vercel.service.ts           [CREATE] Vercel REST API client implementing CloudProvider
├── store/
│   ├── cloudAuthStore.ts           [CREATE] API tokens, active owner per platform, notification prefs
│   ├── cloudProjectsStore.ts       [CREATE] Projects cache with TTL + pagination
│   └── cloudWatchStore.ts          [CREATE] Deployment watch list for background polling
├── components/
│   ├── RenderPanel.tsx             [CREATE] Thin wrapper passing renderService to shared components
│   ├── VercelPanel.tsx             [CREATE] Thin wrapper passing vercelService to shared components
│   ├── CloudProjectList.tsx        [CREATE] Owner switcher + search + project list
│   ├── CloudProjectDetail.tsx      [CREATE] Tab-based detail: Deploys | Env | Logs | Actions
│   ├── CloudEnvSheet.tsx           [CREATE] Bottom sheet for env var create/edit
│   ├── CloudSetup.tsx              [CREATE] Token setup view with instructions
│   └── ToolRail.tsx                [MODIFY] Add Group 4, add panel rendering
├── screens/
│   └── SettingsScreen.tsx          [MODIFY] Add "Cloud Accounts" section
├── services/
│   ├── notifications.service.ts    [MODIFY] Add cloud deploy notification handling
│   └── cloudPolling.service.ts     [CREATE] Background + foreground polling for deploy status
└── App.tsx                         [MODIFY] Register background fetch task
```

---

### Task 1: Shared Types & CloudProvider Interface

**Files:**
- Create: `mobile/src/services/cloud.types.ts`

- [ ] **Step 1: Create the shared types file**

```typescript
// mobile/src/services/cloud.types.ts

export interface Owner {
  id: string;
  name: string;
  slug: string;
  type: 'personal' | 'team';
}

export interface PaginatedResult<T> {
  items: T[];
  cursor?: string;
}

export type ProjectStatus = 'ready' | 'building' | 'error' | 'queued' | 'canceled' | 'suspended' | 'inactive';

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  type: string;
  updatedAt: string;
  repo?: string;
  latestDeployId?: string;
}

export type DeploymentStatus = 'ready' | 'building' | 'queued' | 'error' | 'canceled';

export interface Deployment {
  id: string;
  status: DeploymentStatus;
  commitMessage?: string;
  commitHash?: string;
  createdAt: string;
  finishedAt?: string;
  duration?: number;
}

export interface LogEntry {
  timestamp: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
}

export interface EnvVar {
  id: string;
  key: string;
  value: string;
  scope: string[];
}

export type NewEnvVar = Omit<EnvVar, 'id'>;

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  lastRunAt?: string;
  lastRunStatus?: 'success' | 'failed';
}

export interface CloudProvider {
  validateToken(token: string): Promise<boolean>;
  listOwners(): Promise<Owner[]>;
  listProjects(ownerId: string, cursor?: string): Promise<PaginatedResult<Project>>;
  listDeployments(projectId: string, cursor?: string): Promise<PaginatedResult<Deployment>>;
  getDeploymentLogs(deployId: string): Promise<LogEntry[]>;
  getServiceLogs(projectId: string): Promise<LogEntry[]>;
  triggerDeploy(projectId: string): Promise<Deployment>;
  rollbackDeploy(projectId: string, targetDeployId: string): Promise<void>;
  listEnvVars(projectId: string): Promise<EnvVar[]>;
  createEnvVar(projectId: string, env: NewEnvVar): Promise<void>;
  updateEnvVar(projectId: string, envId: string, env: NewEnvVar): Promise<void>;
  deleteEnvVar(projectId: string, envId: string): Promise<void>;
  listCronJobs(projectId: string): Promise<CronJob[]>;
  triggerCronJob(jobId: string): Promise<void>;
}

export const PROJECT_STATUS_COLORS: Record<ProjectStatus, string> = {
  ready: '#22C55E',
  building: '#F59E0B',
  error: '#EF4444',
  queued: '#3B82F6',
  canceled: '#64748B',
  suspended: '#64748B',
  inactive: '#64748B',
};

export const DEPLOYMENT_STATUS_COLORS: Record<DeploymentStatus, string> = {
  ready: '#22C55E',
  building: '#F59E0B',
  queued: '#3B82F6',
  error: '#EF4444',
  canceled: '#64748B',
};

export class TokenExpiredError extends Error {
  constructor() { super('Token expired'); this.name = 'TokenExpiredError'; }
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /Users/ayysir/Desktop/TMS\ Terminal/mobile && npx tsc --noEmit src/services/cloud.types.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add mobile/src/services/cloud.types.ts
git commit -m "feat(cloud): add shared CloudProvider interface and types"
```

---

### Task 2: Zustand Stores

**Files:**
- Create: `mobile/src/store/cloudAuthStore.ts`
- Create: `mobile/src/store/cloudProjectsStore.ts`
- Create: `mobile/src/store/cloudWatchStore.ts`

- [ ] **Step 1: Create cloudAuthStore**

Follow the pattern from `autoApproveStore.ts`: Zustand + persist + AsyncStorage + partialize.

```typescript
// mobile/src/store/cloudAuthStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type CloudPlatform = 'render' | 'vercel';

interface CloudAuthState {
  tokens: Record<CloudPlatform, string | null>;
  activeOwnerId: Record<CloudPlatform, string | null>;
  notificationsEnabled: boolean;
  pollingIntervalMs: number;

  setToken: (platform: CloudPlatform, token: string | null) => void;
  setActiveOwnerId: (platform: CloudPlatform, ownerId: string | null) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setPollingIntervalMs: (ms: number) => void;
  clearPlatform: (platform: CloudPlatform) => void;
}

export const useCloudAuthStore = create<CloudAuthState>()(
  persist(
    (set, get) => ({
      tokens: { render: null, vercel: null },
      activeOwnerId: { render: null, vercel: null },
      notificationsEnabled: true,
      pollingIntervalMs: 120_000, // 2min default

      setToken: (platform, token) =>
        set({ tokens: { ...get().tokens, [platform]: token } }),

      setActiveOwnerId: (platform, ownerId) =>
        set({ activeOwnerId: { ...get().activeOwnerId, [platform]: ownerId } }),

      setNotificationsEnabled: (enabled) =>
        set({ notificationsEnabled: enabled }),

      setPollingIntervalMs: (ms) =>
        set({ pollingIntervalMs: ms }),

      clearPlatform: (platform) =>
        set({
          tokens: { ...get().tokens, [platform]: null },
          activeOwnerId: { ...get().activeOwnerId, [platform]: null },
        }),
    }),
    {
      name: 'tms-cloud-auth',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
```

- [ ] **Step 2: Create cloudProjectsStore**

```typescript
// mobile/src/store/cloudProjectsStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CloudPlatform } from './cloudAuthStore';
import type { Project } from '../services/cloud.types';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedProjects {
  items: Project[];
  cursor?: string;
  fetchedAt: number;
}

interface CloudProjectsState {
  cache: Record<string, CachedProjects>; // key: `${platform}:${ownerId}`
  selectedProjectId: Record<CloudPlatform, string | null>;

  getCacheKey: (platform: CloudPlatform, ownerId: string) => string;
  getProjects: (platform: CloudPlatform, ownerId: string) => CachedProjects | null;
  isStale: (platform: CloudPlatform, ownerId: string) => boolean;
  setProjects: (platform: CloudPlatform, ownerId: string, data: CachedProjects) => void;
  appendProjects: (platform: CloudPlatform, ownerId: string, items: Project[], cursor?: string) => void;
  setSelectedProjectId: (platform: CloudPlatform, projectId: string | null) => void;
  clearCache: (platform: CloudPlatform) => void;
}

export const useCloudProjectsStore = create<CloudProjectsState>()(
  persist(
    (set, get) => ({
      cache: {},
      selectedProjectId: { render: null, vercel: null },

      getCacheKey: (platform, ownerId) => `${platform}:${ownerId}`,

      getProjects: (platform, ownerId) => {
        const key = `${platform}:${ownerId}`;
        return get().cache[key] ?? null;
      },

      isStale: (platform, ownerId) => {
        const key = `${platform}:${ownerId}`;
        const cached = get().cache[key];
        if (!cached) return true;
        return Date.now() - cached.fetchedAt > CACHE_TTL_MS;
      },

      setProjects: (platform, ownerId, data) => {
        const key = `${platform}:${ownerId}`;
        set({ cache: { ...get().cache, [key]: data } });
      },

      appendProjects: (platform, ownerId, items, cursor) => {
        const key = `${platform}:${ownerId}`;
        const existing = get().cache[key];
        if (!existing) return;
        set({
          cache: {
            ...get().cache,
            [key]: {
              ...existing,
              items: [...existing.items, ...items],
              cursor,
            },
          },
        });
      },

      setSelectedProjectId: (platform, projectId) =>
        set({ selectedProjectId: { ...get().selectedProjectId, [platform]: projectId } }),

      clearCache: (platform) => {
        const newCache = { ...get().cache };
        for (const key of Object.keys(newCache)) {
          if (key.startsWith(`${platform}:`)) delete newCache[key];
        }
        set({ cache: newCache, selectedProjectId: { ...get().selectedProjectId, [platform]: null } });
      },
    }),
    {
      name: 'tms-cloud-projects',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ cache: state.cache }),
    },
  ),
);
```

- [ ] **Step 3: Create cloudWatchStore**

```typescript
// mobile/src/store/cloudWatchStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CloudPlatform } from './cloudAuthStore';
import type { DeploymentStatus } from '../services/cloud.types';

export interface WatchedDeployment {
  deployId: string;
  projectId: string;
  projectName: string;
  platform: CloudPlatform;
  status: DeploymentStatus;
  addedAt: number;
}

interface CloudWatchState {
  watched: WatchedDeployment[];

  addWatch: (deploy: WatchedDeployment) => void;
  removeWatch: (deployId: string) => void;
  updateStatus: (deployId: string, status: DeploymentStatus) => void;
  getActiveWatches: () => WatchedDeployment[];
  clearAll: () => void;
}

export const useCloudWatchStore = create<CloudWatchState>()(
  persist(
    (set, get) => ({
      watched: [],

      addWatch: (deploy) => {
        const existing = get().watched.find((w) => w.deployId === deploy.deployId);
        if (existing) return;
        set({ watched: [...get().watched, deploy] });
      },

      removeWatch: (deployId) =>
        set({ watched: get().watched.filter((w) => w.deployId !== deployId) }),

      updateStatus: (deployId, status) =>
        set({
          watched: get().watched.map((w) =>
            w.deployId === deployId ? { ...w, status } : w,
          ),
        }),

      getActiveWatches: () =>
        get().watched.filter((w) => w.status === 'building' || w.status === 'queued'),

      clearAll: () => set({ watched: [] }),
    }),
    {
      name: 'tms-cloud-watch',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
```

- [ ] **Step 4: Commit**

```bash
git add mobile/src/store/cloudAuthStore.ts mobile/src/store/cloudProjectsStore.ts mobile/src/store/cloudWatchStore.ts
git commit -m "feat(cloud): add Zustand stores for auth, projects cache, and deploy watching"
```

---

### Task 3: Render API Service

**Files:**
- Create: `mobile/src/services/render.service.ts`

- [ ] **Step 1: Implement the Render service**

This is the core API client. It implements `CloudProvider` against `https://api.render.com/v1`. Key mapping details:

- `GET /owners` → `listOwners()` — returns both personal + team accounts
- `GET /services?ownerId=X&limit=20&cursor=Y` → `listProjects()` — status mapped from Render native values
- `GET /services/{id}/deploys?limit=20&cursor=Y` → `listDeployments()`
- `GET /deploys/{id}/logs` → `getDeploymentLogs()` — parse log lines into LogEntry[]
- `GET /services/{id}/logs` → `getServiceLogs()` — runtime logs
- `POST /services/{id}/deploys` → `triggerDeploy()`
- `POST /services/{id}/rollbacks/{deployId}` → `rollbackDeploy()`
- Env vars use `key` as id (no separate id field in Render API)
- `GET /services?type=cron_job&ownerId=X` → `listCronJobs()`

Include:
- `fetchWithRetry()` helper with exponential backoff (max 3 retries, 1s→2s→4s)
- Error mapping: 401 → throw `TokenExpiredError`, 429 → retry, others → German error messages
- Status mapping table: Render native → unified ProjectStatus/DeploymentStatus

```typescript
// mobile/src/services/render.service.ts
import type {
  CloudProvider, Owner, PaginatedResult, Project, Deployment,
  LogEntry, EnvVar, NewEnvVar, CronJob, ProjectStatus, DeploymentStatus,
} from './cloud.types';
import { TokenExpiredError } from './cloud.types';

const BASE_URL = 'https://api.render.com/v1';

const PROJECT_STATUS_MAP: Record<string, ProjectStatus> = {
  deployed: 'ready',
  deploying: 'building',
  build_in_progress: 'building',
  deploy_failed: 'error',
  build_failed: 'error',
  pending: 'queued',
  canceled: 'canceled',
  suspended: 'suspended',
  not_deployed: 'inactive',
};

const DEPLOY_STATUS_MAP: Record<string, DeploymentStatus> = {
  live: 'ready',
  build_in_progress: 'building',
  update_in_progress: 'building',
  created: 'queued',
  pending: 'queued',
  build_failed: 'error',
  update_failed: 'error',
  canceled: 'canceled',
  deactivated: 'canceled',
};

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, options);
    if (res.status === 401) throw new TokenExpiredError();
    if (res.status === 429 && attempt < retries) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Render API Fehler (${res.status}): ${body || res.statusText}`);
    }
    return res;
  }
  throw new Error('API nicht erreichbar, bitte später erneut versuchen');
}

export function createRenderService(token: string): CloudProvider {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  const get = (path: string) => fetchWithRetry(`${BASE_URL}${path}`, { method: 'GET', headers });
  const post = (path: string, body?: object) =>
    fetchWithRetry(`${BASE_URL}${path}`, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined });
  const put = (path: string, body: object) =>
    fetchWithRetry(`${BASE_URL}${path}`, { method: 'PUT', headers, body: JSON.stringify(body) });
  const del = (path: string) => fetchWithRetry(`${BASE_URL}${path}`, { method: 'DELETE', headers });

  return {
    async validateToken() {
      try {
        await get('/owners');
        return true;
      } catch {
        return false;
      }
    },

    async listOwners() {
      const res = await get('/owners');
      const data = await res.json();
      return (data as any[]).map((o: any) => ({
        id: o.owner.id,
        name: o.owner.name,
        slug: o.owner.id,
        type: o.owner.type === 'user' ? 'personal' as const : 'team' as const,
      }));
    },

    async listProjects(ownerId, cursor?) {
      const params = new URLSearchParams({ ownerId, limit: '20' });
      if (cursor) params.set('cursor', cursor);
      const res = await get(`/services?${params}`);
      const data = await res.json();
      const items: Project[] = (data as any[]).map((s: any) => {
        // Derive status from Render's native fields
        let nativeStatus: string;
        if (s.service.suspended === 'suspended') {
          nativeStatus = 'suspended';
        } else if (s.service.serviceDetails?.pullRequestPreviewsEnabled !== undefined) {
          // Has deploy details — check latest deploy status
          nativeStatus = s.service.serviceDetails?.lastDeployStatus ?? 'deployed';
        } else {
          nativeStatus = 'not_deployed';
        }
        return {
          id: s.service.id,
          name: s.service.name,
          status: PROJECT_STATUS_MAP[nativeStatus] ?? 'inactive',
          type: s.service.type ?? 'web_service',
          updatedAt: s.service.updatedAt,
          repo: s.service.repo,
        };
      });
      const nextCursor = data.length === 20 ? (data as any[])[data.length - 1]?.cursor : undefined;
      return { items, cursor: nextCursor };
    },

    async listDeployments(projectId, cursor?) {
      const params = new URLSearchParams({ limit: '20' });
      if (cursor) params.set('cursor', cursor);
      const res = await get(`/services/${projectId}/deploys?${params}`);
      const data = await res.json();
      const items: Deployment[] = (data as any[]).map((d: any) => ({
        id: d.deploy.id,
        status: DEPLOY_STATUS_MAP[d.deploy.status] ?? 'error',
        commitMessage: d.deploy.commit?.message,
        commitHash: d.deploy.commit?.id,
        createdAt: d.deploy.createdAt,
        finishedAt: d.deploy.finishedAt,
        duration: d.deploy.finishedAt
          ? Math.round((new Date(d.deploy.finishedAt).getTime() - new Date(d.deploy.createdAt).getTime()) / 1000)
          : undefined,
      }));
      const nextCursor = data.length === 20 ? (data as any[])[data.length - 1]?.cursor : undefined;
      return { items, cursor: nextCursor };
    },

    async getDeploymentLogs(deployId) {
      const res = await get(`/deploys/${deployId}/logs`);
      const data = await res.json();
      return (data as any[]).map((l: any) => ({
        timestamp: l.timestamp ?? new Date().toISOString(),
        level: (l.level ?? 'info') as LogEntry['level'],
        message: l.message ?? String(l),
      }));
    },

    async getServiceLogs(projectId) {
      const res = await get(`/services/${projectId}/logs`);
      const data = await res.json();
      return (data as any[]).map((l: any) => ({
        timestamp: l.timestamp ?? new Date().toISOString(),
        level: (l.level ?? 'info') as LogEntry['level'],
        message: l.message ?? String(l),
      }));
    },

    async triggerDeploy(projectId) {
      const res = await post(`/services/${projectId}/deploys`);
      const data = await res.json();
      return {
        id: data.id,
        status: DEPLOY_STATUS_MAP[data.status] ?? 'queued',
        createdAt: data.createdAt,
      };
    },

    async rollbackDeploy(projectId, targetDeployId) {
      await post(`/services/${projectId}/rollbacks/${targetDeployId}`);
    },

    async listEnvVars(projectId) {
      const res = await get(`/services/${projectId}/env-vars`);
      const data = await res.json();
      return (data as any[]).map((e: any) => ({
        id: e.envVar.key,
        key: e.envVar.key,
        value: e.envVar.value,
        scope: ['all'],
      }));
    },

    async createEnvVar(projectId, env) {
      await post(`/services/${projectId}/env-vars`, { key: env.key, value: env.value });
    },

    async updateEnvVar(projectId, envId, env) {
      await put(`/services/${projectId}/env-vars/${envId}`, { value: env.value });
    },

    async deleteEnvVar(projectId, envId) {
      await del(`/services/${projectId}/env-vars/${envId}`);
    },

    async listCronJobs(projectId) {
      // Render cron jobs are separate services — this is called with ownerId context
      // For a specific project that IS a cron job, return it as a single-item list
      const res = await get(`/services/${projectId}`);
      const data = await res.json();
      if (data.type === 'cron_job') {
        return [{
          id: data.id,
          name: data.name,
          schedule: data.serviceDetails?.schedule ?? '',
          lastRunAt: data.serviceDetails?.lastSuccessfulRunAt,
          lastRunStatus: data.serviceDetails?.lastSuccessfulRunAt ? 'success' : undefined,
        }];
      }
      return [];
    },

    async triggerCronJob(jobId) {
      await post(`/services/${jobId}/deploys`);
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add mobile/src/services/render.service.ts
git commit -m "feat(cloud): implement Render REST API service"
```

---

### Task 4: Vercel API Service

**Files:**
- Create: `mobile/src/services/vercel.service.ts`

- [ ] **Step 1: Implement the Vercel service**

Key differences from Render:
- `GET /v2/teams` + token owner info → `listOwners()`
- Project status derived from latest deployment (not a project field)
- `POST /v13/deployments` with `{ deploymentId, target }` for redeploy
- `POST /v9/deployments/{targetDeployId}/promote` for rollback
- Env vars have a real `id` field
- Cron jobs read from project config

```typescript
// mobile/src/services/vercel.service.ts
import type {
  CloudProvider, Owner, PaginatedResult, Project, Deployment,
  LogEntry, EnvVar, NewEnvVar, CronJob, ProjectStatus, DeploymentStatus,
} from './cloud.types';
import { TokenExpiredError } from './cloud.types';

const BASE_URL = 'https://api.vercel.com';

const DEPLOY_STATUS_MAP: Record<string, DeploymentStatus> = {
  READY: 'ready',
  BUILDING: 'building',
  QUEUED: 'queued',
  ERROR: 'error',
  CANCELED: 'canceled',
};

const PROJECT_STATUS_FROM_DEPLOY: Record<string, ProjectStatus> = {
  READY: 'ready',
  BUILDING: 'building',
  QUEUED: 'queued',
  ERROR: 'error',
  CANCELED: 'canceled',
};

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, options);
    if (res.status === 401 || res.status === 403) throw new TokenExpiredError();
    if (res.status === 429 && attempt < retries) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Vercel API Fehler (${res.status}): ${body || res.statusText}`);
    }
    return res;
  }
  throw new Error('API nicht erreichbar, bitte später erneut versuchen');
}

export function createVercelService(token: string): CloudProvider {
  let _personalUserId: string | null = null; // cached after first listOwners() call
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  const get = (path: string) => fetchWithRetry(`${BASE_URL}${path}`, { method: 'GET', headers });
  const post = (path: string, body?: object) =>
    fetchWithRetry(`${BASE_URL}${path}`, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined });
  const patch = (path: string, body: object) =>
    fetchWithRetry(`${BASE_URL}${path}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  const del = (path: string) => fetchWithRetry(`${BASE_URL}${path}`, { method: 'DELETE', headers });

  return {
    async validateToken() {
      try {
        await get('/v2/user');
        return true;
      } catch {
        return false;
      }
    },

    async listOwners() {
      const owners: Owner[] = [];
      // Personal account
      const userRes = await get('/v2/user');
      const user = await userRes.json();
      _personalUserId = user.user.id; // cache for listProjects
      owners.push({
        id: user.user.id,
        name: user.user.name || user.user.username,
        slug: user.user.username,
        type: 'personal',
      });
      // Teams
      const teamsRes = await get('/v2/teams');
      const teams = await teamsRes.json();
      for (const team of teams.teams ?? []) {
        owners.push({
          id: team.id,
          name: team.name,
          slug: team.slug,
          type: 'team',
        });
      }
      return owners;
    },

    async listProjects(ownerId, cursor?) {
      const params = new URLSearchParams({ limit: '20' });
      if (cursor) params.set('until', cursor);
      // Use cached personal user ID from listOwners() to determine owner type
      const isPersonal = ownerId === _personalUserId;
      const teamParam = isPersonal ? '' : `&teamId=${ownerId}`;
      const res = await get(`/v9/projects?${params}${teamParam}`);
      const data = await res.json();
      const items: Project[] = (data.projects ?? []).map((p: any) => ({
        id: p.id,
        name: p.name,
        status: p.latestDeployments?.[0]?.readyState
          ? (PROJECT_STATUS_FROM_DEPLOY[p.latestDeployments[0].readyState] ?? 'inactive')
          : 'inactive',
        type: p.framework ?? 'static',
        updatedAt: new Date(p.updatedAt).toISOString(),
        repo: p.link?.repo,
        latestDeployId: p.latestDeployments?.[0]?.id,
      }));
      const pagination = data.pagination;
      return { items, cursor: pagination?.next ? String(pagination.next) : undefined };
    },

    async listDeployments(projectId, cursor?) {
      const params = new URLSearchParams({ projectId, limit: '20' });
      if (cursor) params.set('until', cursor);
      const res = await get(`/v6/deployments?${params}`);
      const data = await res.json();
      const items: Deployment[] = (data.deployments ?? []).map((d: any) => ({
        id: d.uid,
        status: DEPLOY_STATUS_MAP[d.readyState ?? d.state] ?? 'error',
        commitMessage: d.meta?.githubCommitMessage,
        commitHash: d.meta?.githubCommitSha,
        createdAt: new Date(d.createdAt ?? d.created).toISOString(),
        finishedAt: d.ready ? new Date(d.ready).toISOString() : undefined,
        duration: d.ready && d.buildingAt
          ? Math.round((d.ready - d.buildingAt) / 1000)
          : undefined,
      }));
      const pagination = data.pagination;
      return { items, cursor: pagination?.next ? String(pagination.next) : undefined };
    },

    async getDeploymentLogs(deployId) {
      const res = await get(`/v2/deployments/${deployId}/events?builds=1&direction=backward&limit=200`);
      const data = await res.json();
      return (data ?? []).map((e: any) => ({
        timestamp: new Date(e.created ?? e.date ?? Date.now()).toISOString(),
        level: e.type === 'stderr' ? 'error' as const : 'info' as const,
        message: e.text ?? e.payload?.text ?? '',
      })).reverse();
    },

    async getServiceLogs(projectId) {
      // Get latest deployment, then its runtime events
      const deploys = await this.listDeployments(projectId);
      const latestReady = deploys.items.find((d) => d.status === 'ready');
      if (!latestReady) return [];
      const res = await get(`/v2/deployments/${latestReady.id}/events?direction=backward&limit=200`);
      const data = await res.json();
      return (data ?? [])
        .filter((e: any) => e.type !== 'build')
        .map((e: any) => ({
          timestamp: new Date(e.created ?? e.date ?? Date.now()).toISOString(),
          level: e.type === 'stderr' ? 'error' as const : 'info' as const,
          message: e.text ?? e.payload?.text ?? '',
        }))
        .reverse();
    },

    async triggerDeploy(projectId) {
      // Get project to find latest deployment for redeploy
      const projRes = await get(`/v9/projects/${projectId}`);
      const proj = await projRes.json();
      const latestDeployId = proj.latestDeployments?.[0]?.id;
      if (!latestDeployId) throw new Error('Kein vorheriges Deployment zum Redeployen gefunden');

      const teamId = proj.accountId;
      const teamParam = teamId ? `?teamId=${teamId}` : '';
      const res = await post(`/v13/deployments${teamParam}`, {
        name: proj.name,
        deploymentId: latestDeployId,
        target: 'production',
      });
      const data = await res.json();
      return {
        id: data.id,
        status: 'queued' as DeploymentStatus,
        createdAt: new Date().toISOString(),
      };
    },

    async rollbackDeploy(_projectId, targetDeployId) {
      await post(`/v9/deployments/${targetDeployId}/promote`);
    },

    async listEnvVars(projectId) {
      const res = await get(`/v9/projects/${projectId}/env`);
      const data = await res.json();
      return (data.envs ?? []).map((e: any) => ({
        id: e.id,
        key: e.key,
        value: e.value ?? '••••••',
        scope: e.target ?? ['production', 'preview', 'development'],
      }));
    },

    async createEnvVar(projectId, env) {
      await post(`/v10/projects/${projectId}/env`, {
        key: env.key,
        value: env.value,
        target: env.scope,
        type: 'encrypted',
      });
    },

    async updateEnvVar(projectId, envId, env) {
      await patch(`/v10/projects/${projectId}/env/${envId}`, {
        value: env.value,
        target: env.scope,
      });
    },

    async deleteEnvVar(projectId, envId) {
      await del(`/v10/projects/${projectId}/env/${envId}`);
    },

    async listCronJobs(projectId) {
      // Vercel crons are defined in vercel.json — read from project config
      const res = await get(`/v9/projects/${projectId}`);
      const data = await res.json();
      const crons = data.crons?.definitions ?? [];
      return crons.map((c: any, i: number) => ({
        id: `${projectId}-cron-${i}`,
        name: c.path ?? `Cron ${i + 1}`,
        schedule: c.schedule ?? '',
      }));
    },

    async triggerCronJob(_jobId) {
      // Vercel crons run on deploy — trigger a redeploy
      // jobId format: `${projectId}-cron-${index}`
      const projectId = _jobId.replace(/-cron-\d+$/, '');
      await this.triggerDeploy(projectId);
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add mobile/src/services/vercel.service.ts
git commit -m "feat(cloud): implement Vercel REST API service"
```

---

### Task 5: CloudSetup Component

**Files:**
- Create: `mobile/src/components/CloudSetup.tsx`

- [ ] **Step 1: Create the token setup component**

Props: `platform: 'render' | 'vercel'`, `onConnected: () => void`

Key implementation:
- Use `expo-web-browser` (`WebBrowser.openBrowserAsync()`) for the "Go to [Platform]" link
- Token URLs: Render → `https://dashboard.render.com/settings#api-keys`, Vercel → `https://vercel.com/account/tokens`
- TextInput for token paste (secureTextEntry=true)
- "Verbinden" button: calls `createRenderService(token).validateToken()` or `createVercelService(token).validateToken()`
- Loading spinner during validation
- Error state: "Ungültiger Token — bitte überprüfen"
- On success: `cloudAuthStore.setToken(platform, token)` → calls `onConnected()`

```typescript
// mobile/src/components/CloudSetup.tsx — key structure
import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as WebBrowser from 'expo-web-browser';
import { useResponsive } from '../hooks/useResponsive';
import { useCloudAuthStore } from '../store/cloudAuthStore';
import { createRenderService } from '../services/render.service';
import { createVercelService } from '../services/vercel.service';
import { colors } from '../theme';

interface Props {
  platform: 'render' | 'vercel';
  onConnected: () => void;
}

const PLATFORM_CONFIG = {
  render: {
    name: 'Render',
    icon: 'box' as const,
    color: '#4353FF',
    tokenUrl: 'https://dashboard.render.com/settings#api-keys',
  },
  vercel: {
    name: 'Vercel',
    icon: 'triangle' as const,
    color: '#FFFFFF',
    tokenUrl: 'https://vercel.com/account/tokens',
  },
};

export function CloudSetup({ platform, onConnected }: Props) {
  const { rf, rs, ri } = useResponsive();
  const setToken = useCloudAuthStore((s) => s.setToken);
  const config = PLATFORM_CONFIG[platform];

  const [tokenInput, setTokenInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = useCallback(async () => {
    if (!tokenInput.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const service = platform === 'render'
        ? createRenderService(tokenInput.trim())
        : createVercelService(tokenInput.trim());
      const valid = await service.validateToken(tokenInput.trim());
      if (valid) {
        setToken(platform, tokenInput.trim());
        onConnected();
      } else {
        setError('Ungültiger Token — bitte überprüfen');
      }
    } catch {
      setError('Verbindung fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  }, [tokenInput, platform, setToken, onConnected]);

  return (
    <View style={[s.container, { padding: rs(16) }]}>
      <Feather name={config.icon} size={ri(32)} color={config.color} style={{ alignSelf: 'center', marginBottom: rs(16) }} />
      <Text style={[s.title, { fontSize: rf(15) }]}>API Token für {config.name}</Text>
      <Text style={[s.subtitle, { fontSize: rf(12), marginBottom: rs(16) }]}>
        Erstelle einen API Token in deinem {config.name} Account:
      </Text>
      <TouchableOpacity
        onPress={() => WebBrowser.openBrowserAsync(config.tokenUrl)}
        style={[s.linkBtn, { marginBottom: rs(16), paddingVertical: rs(10) }]}
      >
        <Feather name="external-link" size={ri(14)} color={colors.primary} />
        <Text style={[s.linkText, { fontSize: rf(13) }]}>Token-Seite öffnen</Text>
      </TouchableOpacity>
      <TextInput
        style={[s.input, { fontSize: rf(13), padding: rs(10) }]}
        placeholder="Token einfügen..."
        placeholderTextColor={colors.textDim}
        value={tokenInput}
        onChangeText={setTokenInput}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      {error && <Text style={[s.error, { fontSize: rf(11) }]}>{error}</Text>}
      <TouchableOpacity
        style={[s.connectBtn, { marginTop: rs(12), paddingVertical: rs(12) }]}
        onPress={handleConnect}
        disabled={loading || !tokenInput.trim()}
      >
        {loading ? (
          <ActivityIndicator color={colors.text} size="small" />
        ) : (
          <Text style={[s.connectText, { fontSize: rf(14) }]}>Verbinden</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center' },
  title: { color: colors.text, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  subtitle: { color: colors.textMuted, textAlign: 'center' },
  linkBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  linkText: { color: colors.primary, fontWeight: '600' },
  input: { backgroundColor: colors.surfaceAlt, color: colors.text, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
  error: { color: colors.destructive, marginTop: 6 },
  connectBtn: { backgroundColor: colors.primary, borderRadius: 8, alignItems: 'center' },
  connectText: { color: colors.text, fontWeight: '700' },
});
```

- [ ] **Step 2: Commit**

```bash
git add mobile/src/components/CloudSetup.tsx
git commit -m "feat(cloud): add CloudSetup token configuration component"
```

---

### Task 6: CloudProjectList Component

**Files:**
- Create: `mobile/src/components/CloudProjectList.tsx`

- [ ] **Step 1: Create the project list component**

Props: `platform: 'render' | 'vercel'`, `service: CloudProvider`, `onSelectProject: (project: Project) => void`

Key structure:

```typescript
// mobile/src/components/CloudProjectList.tsx — key structure
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, Text, FlatList, TextInput, TouchableOpacity, ActivityIndicator, LayoutAnimation, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useResponsive } from '../hooks/useResponsive';
import { useCloudAuthStore } from '../store/cloudAuthStore';
import { useCloudProjectsStore } from '../store/cloudProjectsStore';
import { colors } from '../theme';
import { PROJECT_STATUS_COLORS } from '../services/cloud.types';
import type { CloudProvider, Project, Owner } from '../services/cloud.types';
import type { CloudPlatform } from '../store/cloudAuthStore';
import NetInfo from '@react-native-community/netinfo';

interface Props {
  platform: CloudPlatform;
  service: CloudProvider;
  onSelectProject: (project: Project) => void;
}

export function CloudProjectList({ platform, service, onSelectProject }: Props) {
  const { rf, rs, ri, isCompact } = useResponsive();
  const activeOwnerId = useCloudAuthStore((s) => s.activeOwnerId[platform]);
  const setActiveOwnerId = useCloudAuthStore((s) => s.setActiveOwnerId);

  const [owners, setOwners] = useState<Owner[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  const { getProjects, setProjects, appendProjects, isStale } = useCloudProjectsStore();
  const cached = activeOwnerId ? getProjects(platform, activeOwnerId) : null;
  const projects = cached?.items ?? [];
  const cursor = cached?.cursor;

  // Network status
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => setIsOffline(!state.isConnected));
    return () => unsub();
  }, []);

  // Load owners on mount
  useEffect(() => {
    service.listOwners().then((o) => {
      setOwners(o);
      if (!activeOwnerId && o.length > 0) setActiveOwnerId(platform, o[0].id);
    }).catch(() => setError('Accounts konnten nicht geladen werden'));
  }, [service]);

  // Load projects when owner changes or cache is stale
  useEffect(() => {
    if (!activeOwnerId || isOffline) return;
    if (!isStale(platform, activeOwnerId) && projects.length > 0) return;
    loadProjects();
  }, [activeOwnerId, isOffline]);

  const loadProjects = useCallback(async () => {
    if (!activeOwnerId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await service.listProjects(activeOwnerId);
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setProjects(platform, activeOwnerId, { items: result.items, cursor: result.cursor, fetchedAt: Date.now() });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [activeOwnerId, service, platform]);

  const loadMore = useCallback(async () => {
    if (!activeOwnerId || !cursor) return;
    try {
      const result = await service.listProjects(activeOwnerId, cursor);
      appendProjects(platform, activeOwnerId, result.items, result.cursor);
    } catch (e: any) {
      setError(e.message);
    }
  }, [activeOwnerId, cursor, service, platform]);

  // Client-side search filter
  const filtered = useMemo(() => {
    if (!search.trim()) return projects;
    const q = search.toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, search]);

  // Owner switcher dropdown (simplified — use a picker or custom dropdown)
  // Project item renderer
  // "Mehr laden" footer
  // Error banner + offline indicator
  // Empty state

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={[s.header, { paddingHorizontal: rs(12), paddingVertical: rs(10) }]}>
        <Feather name={platform === 'render' ? 'box' : 'triangle'} size={ri(14)} color={platform === 'render' ? '#4353FF' : '#FFFFFF'} />
        <Text style={[s.title, { fontSize: rf(13) }]}>{platform === 'render' ? 'Render' : 'Vercel'}</Text>
      </View>
      <View style={s.divider} />

      {/* Offline banner */}
      {isOffline && (
        <View style={s.offlineBanner}>
          <Text style={[s.offlineText, { fontSize: rf(11) }]}>Offline — letzte Daten</Text>
        </View>
      )}

      {/* Owner switcher */}
      {owners.length > 1 && (
        <TouchableOpacity style={[s.ownerSwitcher, { paddingHorizontal: rs(12), paddingVertical: rs(8) }]}>
          <Text style={[s.ownerLabel, { fontSize: rf(11) }]}>Account:</Text>
          <Text style={[s.ownerName, { fontSize: rf(12) }]}>
            {owners.find((o) => o.id === activeOwnerId)?.name ?? '—'}
          </Text>
          <Feather name="chevron-down" size={ri(12)} color={colors.textDim} />
        </TouchableOpacity>
      )}

      {/* Search */}
      <TextInput
        style={[s.searchInput, { fontSize: rf(12), marginHorizontal: rs(12), marginVertical: rs(6), padding: rs(8) }]}
        placeholder="Suche..."
        placeholderTextColor={colors.textDim}
        value={search}
        onChangeText={setSearch}
      />

      {/* Error */}
      {error && (
        <View style={s.errorBanner}>
          <Text style={[s.errorText, { fontSize: rf(11) }]}>{error}</Text>
          <TouchableOpacity onPress={loadProjects}><Text style={s.retryText}>Erneut</Text></TouchableOpacity>
        </View>
      )}

      {/* Project list */}
      {loading && projects.length === 0 ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: rs(24) }} />
      ) : filtered.length === 0 ? (
        <View style={s.empty}>
          <Feather name="inbox" size={ri(28)} color={colors.border} />
          <Text style={[s.emptyText, { fontSize: rf(12) }]}>Keine Projekte gefunden</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(p) => p.id}
          onRefresh={loadProjects}
          refreshing={loading}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[s.projectRow, { paddingHorizontal: rs(12), paddingVertical: rs(10) }]}
              onPress={() => onSelectProject(item)}
              disabled={isOffline}
              activeOpacity={0.7}
            >
              <View style={[s.statusDot, { backgroundColor: PROJECT_STATUS_COLORS[item.status] }]} />
              <Text style={[s.projectName, { fontSize: rf(12) }]} numberOfLines={1}>{item.name}</Text>
              {!isCompact && <Text style={[s.projectType, { fontSize: rf(10) }]}>{item.type}</Text>}
            </TouchableOpacity>
          )}
          ListFooterComponent={cursor ? (
            <TouchableOpacity style={s.loadMore} onPress={loadMore}>
              <Text style={[s.loadMoreText, { fontSize: rf(11) }]}>Mehr laden</Text>
            </TouchableOpacity>
          ) : null}
        />
      )}
    </View>
  );
}

// StyleSheet follows AutoApprovePanel/WatchersPanel patterns
const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  title: { color: colors.text, fontWeight: '700' },
  divider: { height: 1, backgroundColor: 'rgba(51,65,85,0.7)' },
  offlineBanner: { backgroundColor: colors.warning + '22', paddingVertical: 4, alignItems: 'center' },
  offlineText: { color: colors.warning },
  ownerSwitcher: { flexDirection: 'row', alignItems: 'center', gap: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  ownerLabel: { color: colors.textDim },
  ownerName: { color: colors.text, fontWeight: '600', flex: 1 },
  searchInput: { backgroundColor: colors.surfaceAlt, color: colors.text, borderRadius: 6, borderWidth: 1, borderColor: colors.border },
  errorBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.destructive + '22' },
  errorText: { color: colors.destructive, flex: 1 },
  retryText: { color: colors.primary, fontWeight: '600', fontSize: 11 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 40 },
  emptyText: { color: colors.textDim },
  projectRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border + '44' },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  projectName: { color: colors.text, flex: 1 },
  projectType: { color: colors.textDim, backgroundColor: colors.surfaceAlt, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  loadMore: { alignItems: 'center', paddingVertical: 12 },
  loadMoreText: { color: colors.primary, fontWeight: '600' },
});
```

- [ ] **Step 2: Commit**

```bash
git add mobile/src/components/CloudProjectList.tsx
git commit -m "feat(cloud): add CloudProjectList with owner switcher and search"
```

---

### Task 7: CloudProjectDetail Component

**Files:**
- Create: `mobile/src/components/CloudProjectDetail.tsx`

- [ ] **Step 1: Create the tab-based detail component**

Props: `platform: 'render' | 'vercel'`, `service: CloudProvider`, `project: Project`, `onBack: () => void`

Key structure — component is large (~400 lines), so implement each tab as a separate internal component:

```typescript
// mobile/src/components/CloudProjectDetail.tsx — key structure
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, FlatList, ScrollView, TouchableOpacity, Alert, ActivityIndicator, StyleSheet, Platform as RNPlatform } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useResponsive } from '../hooks/useResponsive';
import { useCloudWatchStore } from '../store/cloudWatchStore';
import { colors, fonts } from '../theme';
import { DEPLOYMENT_STATUS_COLORS } from '../services/cloud.types';
import { CloudEnvSheet } from './CloudEnvSheet';
import type { CloudProvider, Project, Deployment, LogEntry, EnvVar, CronJob } from '../services/cloud.types';
import type { CloudPlatform } from '../store/cloudAuthStore';

type Tab = 'deploys' | 'env' | 'logs' | 'actions';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'deploys', label: 'Deploys', icon: 'layers' },
  { id: 'env', label: 'Env', icon: 'lock' },
  { id: 'logs', label: 'Logs', icon: 'terminal' },
  { id: 'actions', label: '⚡', icon: 'zap' },
];

interface Props {
  platform: CloudPlatform;
  service: CloudProvider;
  project: Project;
  onBack: () => void;
}

export function CloudProjectDetail({ platform, service, project, onBack }: Props) {
  const { rf, rs, ri, isCompact } = useResponsive();
  const [activeTab, setActiveTab] = useState<Tab>('deploys');
  const addWatch = useCloudWatchStore((s) => s.addWatch);

  // Foreground polling: refresh deploys every 30s while this component is mounted
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [deployRefreshKey, setDeployRefreshKey] = useState(0);

  useEffect(() => {
    pollingRef.current = setInterval(() => {
      setDeployRefreshKey((k) => k + 1);
    }, 30_000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, []);

  return (
    <View style={s.container}>
      {/* Header: back + project name */}
      <TouchableOpacity style={[s.header, { paddingHorizontal: rs(12), paddingVertical: rs(10) }]} onPress={onBack}>
        <Feather name="arrow-left" size={ri(16)} color={colors.text} />
        <Text style={[s.projectName, { fontSize: rf(13) }]} numberOfLines={1}>{project.name}</Text>
      </TouchableOpacity>
      <View style={s.divider} />

      {/* Tab bar */}
      <View style={[s.tabBar, { paddingHorizontal: rs(8) }]}>
        {TABS.map((tab) => (
          <TouchableOpacity
            key={tab.id}
            style={[s.tab, activeTab === tab.id && s.tabActive]}
            onPress={() => setActiveTab(tab.id)}
          >
            <Text style={[
              s.tabLabel,
              { fontSize: rf(11) },
              activeTab === tab.id && s.tabLabelActive,
            ]}>
              {isCompact ? '' : tab.label}
              {isCompact && <Feather name={tab.icon as any} size={ri(12)} color={activeTab === tab.id ? colors.primary : colors.textDim} />}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={s.divider} />

      {/* Tab content */}
      {activeTab === 'deploys' && <DeploysTab service={service} projectId={project.id} platform={platform} refreshKey={deployRefreshKey} addWatch={addWatch} projectName={project.name} />}
      {activeTab === 'env' && <EnvTab service={service} projectId={project.id} platform={platform} />}
      {activeTab === 'logs' && <LogsTab service={service} projectId={project.id} />}
      {activeTab === 'actions' && <ActionsTab service={service} project={project} platform={platform} addWatch={addWatch} />}
    </View>
  );
}

// --- DeploysTab: FlatList of deployments with expandable build logs ---
// - Loads via service.listDeployments(projectId)
// - refreshKey changes trigger re-fetch (foreground polling)
// - Each item: status dot + commit msg (truncated) + relative time + copy button
// - Tap expands inline log (lazy loads via service.getDeploymentLogs)
// - "Mehr laden" footer for pagination
// - Copy button: Clipboard.setStringAsync(logText)

// --- EnvTab: FlatList of env vars with CloudEnvSheet ---
// - Loads via service.listEnvVars(projectId)
// - Each item: key + masked "••••••" value
// - Tap opens CloudEnvSheet in edit mode
// - "+" FAB opens CloudEnvSheet in create mode
// - Swipe-to-delete with Alert.alert("Löschen?", ...) confirmation

// --- LogsTab: ScrollView with runtime logs ---
// - Loads via service.getServiceLogs(projectId)
// - Monospace font (fonts.mono), color-coded by level
// - "Alles kopieren" button copies all log text
// - Tap single line copies it
// - Auto-scrolls to bottom via scrollViewRef.current?.scrollToEnd()

// --- ActionsTab: Manual triggers ---
// - "Neu deployen" button → Alert.alert confirmation → service.triggerDeploy
//   → adds to cloudWatchStore
// - "Rollback" → loads previous successful deployments → picker → service.rollbackDeploy
// - Cron Jobs: service.listCronJobs → each with "Jetzt ausführen" button → service.triggerCronJob

// StyleSheet follows existing panel patterns (s.container, s.header, etc.)
```

Each sub-tab component (`DeploysTab`, `EnvTab`, `LogsTab`, `ActionsTab`) is defined in the same file as internal components. They share the `service` prop and call the `CloudProvider` methods directly.

**Offline handling:** When `NetInfo` reports offline, show cached deployment list (dimmed) and disable all mutation buttons (deploy, rollback, env CRUD, cron trigger) via `disabled` prop + reduced opacity.

- [ ] **Step 2: Commit**

```bash
git add mobile/src/components/CloudProjectDetail.tsx
git commit -m "feat(cloud): add CloudProjectDetail with Deploys, Env, Logs, Actions tabs"
```

---

### Task 8: CloudEnvSheet Component

**Files:**
- Create: `mobile/src/components/CloudEnvSheet.tsx`

- [ ] **Step 1: Create the bottom sheet component**

Props: `visible: boolean`, `onClose: () => void`, `platform: 'render' | 'vercel'`, `service: CloudProvider`, `projectId: string`, `envVar?: EnvVar` (undefined = create mode), `onSaved: () => void`

Features:
- Modal with slide-up animation + backdrop
- Key input (disabled in edit mode)
- Value input (multiline, for long values like JSON)
- Scope dropdown: Render = "Alle Umgebungen" / Vercel = multi-select of production/preview/development
- "Löschen" button (destructive, only in edit mode) with confirmation Alert
- "Speichern" button — validates non-empty key/value, calls createEnvVar or updateEnvVar
- Keyboard-aware: shifts up when keyboard opens

- [ ] **Step 2: Commit**

```bash
git add mobile/src/components/CloudEnvSheet.tsx
git commit -m "feat(cloud): add CloudEnvSheet bottom sheet for env var editing"
```

---

### Task 9: RenderPanel & VercelPanel Wrappers

**Files:**
- Create: `mobile/src/components/RenderPanel.tsx`
- Create: `mobile/src/components/VercelPanel.tsx`

- [ ] **Step 1: Create both thin wrapper panels**

Each panel is a thin wrapper that:
1. Reads token from `cloudAuthStore`
2. If no token → shows `<CloudSetup platform="render|vercel" />`
3. If token → creates service instance via `createRenderService(token)` / `createVercelService(token)`
4. Shows `<CloudProjectList>` initially
5. When project selected → shows `<CloudProjectDetail>`
6. Manages the list↔detail navigation state internally

These receive **no props from ToolRail** — they are self-contained.

```typescript
// mobile/src/components/RenderPanel.tsx
import React, { useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useCloudAuthStore } from '../store/cloudAuthStore';
import { createRenderService } from '../services/render.service';
import { CloudSetup } from './CloudSetup';
import { CloudProjectList } from './CloudProjectList';
import { CloudProjectDetail } from './CloudProjectDetail';
import type { Project } from '../services/cloud.types';
import { colors } from '../theme';

export function RenderPanel() {
  const token = useCloudAuthStore((s) => s.tokens.render);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  const service = useMemo(
    () => (token ? createRenderService(token) : null),
    [token],
  );

  if (!token || !service) {
    return <CloudSetup platform="render" onConnected={() => {}} />;
  }

  if (selectedProject) {
    return (
      <CloudProjectDetail
        platform="render"
        service={service}
        project={selectedProject}
        onBack={() => setSelectedProject(null)}
      />
    );
  }

  return (
    <CloudProjectList
      platform="render"
      service={service}
      onSelectProject={setSelectedProject}
    />
  );
}
```

VercelPanel is identical but uses `'vercel'` and `createVercelService`.

- [ ] **Step 2: Commit**

```bash
git add mobile/src/components/RenderPanel.tsx mobile/src/components/VercelPanel.tsx
git commit -m "feat(cloud): add RenderPanel and VercelPanel wrapper components"
```

---

### Task 10: ToolRail Integration

**Files:**
- Modify: `mobile/src/components/ToolRail.tsx`

- [ ] **Step 1: Add Group 4 to TOOL_GROUPS**

Add after the existing 3 groups in the `TOOL_GROUPS` array:

```typescript
// Group 4: Cloud
[
  { id: 'render', icon: 'box', color: '#4353FF', label: 'Render' },
  { id: 'vercel', icon: 'triangle', color: '#FFFFFF', label: 'Vercel' },
],
```

- [ ] **Step 2: Add imports and panel rendering**

Add imports at top:
```typescript
import { RenderPanel } from './RenderPanel';
import { VercelPanel } from './VercelPanel';
```

Add in the panel conditional rendering section (where existing panels like AutoApprovePanel are rendered):
```typescript
{active === 'render' && <RenderPanel />}
{active === 'vercel' && <VercelPanel />}
```

Note: RenderPanel and VercelPanel receive **no props** — unlike other panels that get `serverId`/`wsService`.

- [ ] **Step 3: Verify the app builds**

Run: `cd /Users/ayysir/Desktop/TMS\ Terminal/mobile && npx expo export --platform android --clear 2>&1 | tail -5`
Expected: Build completes without errors

- [ ] **Step 4: Commit**

```bash
git add mobile/src/components/ToolRail.tsx
git commit -m "feat(cloud): integrate Render and Vercel panels into ToolRail Group 4"
```

---

### Task 11: Settings Screen — Cloud Accounts Section

**Files:**
- Modify: `mobile/src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Add Cloud Accounts section**

Insert after the "Terminal Theme" section and before the "Clear Data" button. Add:
- Render connection status + "Trennen" button
- Vercel connection status + "Trennen" button
- Deploy-Alerts toggle
- Polling interval selector (1min / 2min / 5min)

Read/write from `useCloudAuthStore`. The "Trennen" button calls `clearPlatform(platform)` which clears token + cached data (also call `useCloudProjectsStore.getState().clearCache(platform)`).

- [ ] **Step 2: Commit**

```bash
git add mobile/src/screens/SettingsScreen.tsx
git commit -m "feat(cloud): add Cloud Accounts section to Settings"
```

---

### Task 12: Notification Deep-Links

**Files:**
- Modify: `mobile/src/services/notifications.service.ts`
- Modify: `mobile/src/components/ToolRail.tsx` (add `openPanel` to ToolRailRef)
- Modify: `mobile/src/screens/TerminalScreen.tsx` (consume pending cloud target)

- [ ] **Step 1: Extend notification handling for cloud deploys**

Add a new pending cloud notification holder in `notifications.service.ts`:
```typescript
let _pendingCloudTarget: { platform: 'render' | 'vercel'; projectId: string } | null = null;

export function consumePendingCloudTarget() {
  const target = _pendingCloudTarget;
  _pendingCloudTarget = null;
  return target;
}
```

In the notification response handler, check for `data.type === 'cloud_deploy'` and set the pending target:
```typescript
// In registerNotificationResponseHandler or equivalent:
if (data?.type === 'cloud_deploy') {
  _pendingCloudTarget = {
    platform: data.platform as 'render' | 'vercel',
    projectId: data.projectId as string,
  };
}
```

- [ ] **Step 2: Extend ToolRailRef with `openPanel` method**

In `ToolRail.tsx`, add an `openPanel(toolId: string)` method to the imperative ref handle so that external code (TerminalScreen) can programmatically open a cloud panel:

```typescript
// In ToolRail's useImperativeHandle:
openPanel: (toolId: string) => {
  setActive(toolId);
  // trigger panel open animation
},
```

- [ ] **Step 3: Consume pending cloud target in TerminalScreen**

In `TerminalScreen.tsx`, on mount/focus, check for pending cloud targets and open the corresponding panel:

```typescript
useEffect(() => {
  const target = consumePendingCloudTarget();
  if (target) {
    toolRailRef.current?.openPanel(target.platform); // 'render' or 'vercel'
    // The panel will load and show the project list — the projectId can be used
    // to auto-navigate to the project detail via cloudProjectsStore.setSelectedProjectId
    useCloudProjectsStore.getState().setSelectedProjectId(target.platform, target.projectId);
  }
}, []);
```

- [ ] **Step 4: Commit**

```bash
git add mobile/src/services/notifications.service.ts mobile/src/components/ToolRail.tsx mobile/src/screens/TerminalScreen.tsx
git commit -m "feat(cloud): extend notifications for cloud deployment deep-links"
```

---

### Task 13: Background Polling for Deploy Notifications

**Files:**
- Create: `mobile/src/services/cloudPolling.service.ts`

- [ ] **Step 1: Create the polling service**

Uses `react-native-background-fetch` (or `expo-background-fetch` + `expo-task-manager`).

Logic:
1. Registered as a background task
2. Reads `cloudWatchStore.getActiveWatches()`
3. For each watched deployment: check status via API (create service from stored token)
4. If status changed from building/queued → ready/error:
   - Remove from watch list
   - Schedule local notification with `CloudNotificationData` payload
5. If rate-limited (429): skip, retry next cycle

Also export a `startForegroundPolling(intervalMs)` / `stopForegroundPolling()` pair for when the panel is open (30s interval).

- [ ] **Step 2: Register background task in App.tsx**

Add background fetch registration in the app's root component.

- [ ] **Step 3: Commit**

```bash
git add mobile/src/services/cloudPolling.service.ts mobile/src/App.tsx
git commit -m "feat(cloud): add background polling for deployment status notifications"
```

---

### Task 14: Manual Testing & Polish

**Files:**
- All created/modified files

- [ ] **Step 1: Test on Samsung Galaxy Fold 7 — all breakpoints**

Test flow:
1. Open Render panel → Setup screen appears → Enter token → Projects load
2. Switch teams → Project list updates
3. Search → filters correctly
4. Tap project → Detail view with tabs
5. Deploys tab: list loads, expand shows logs, copy works
6. Env tab: list loads, tap opens sheet, create/edit/delete works
7. Logs tab: runtime logs load, copy all works, tap-to-copy works
8. Actions tab: redeploy triggers, rollback works, cron trigger works
9. Repeat for Vercel panel
10. Settings: Cloud Accounts section shows, disconnect works
11. Notifications: trigger a deploy, background → notification appears, tap opens correct project
12. Test at compact (cover screen), medium (phone), expanded (inner screen)

- [ ] **Step 2: Fix any issues found**

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat(cloud): polish and fix issues from manual testing"
```
