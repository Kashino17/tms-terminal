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
  validateToken(): Promise<boolean>;
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
