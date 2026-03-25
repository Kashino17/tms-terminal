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
