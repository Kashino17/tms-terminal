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
      // If _personalUserId hasn't been cached yet, fetch it
      if (_personalUserId === null) {
        const userRes = await get('/v2/user');
        const user = await userRes.json();
        _personalUserId = user.user.id;
      }
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
