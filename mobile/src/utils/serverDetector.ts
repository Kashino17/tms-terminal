import type { ServerType } from '../types/terminal.types';

const FRONTEND_PROCESSES = /\b(vite|next|nuxt|webpack|parcel|astro|gatsby|remix|svelte)\b/i;
const BACKEND_PROCESSES = /\b(node|python|flask|django|express|fastify|uvicorn|gunicorn|rails|php|java|spring|nest)\b/i;
const DATABASE_PROCESSES = /\b(postgres|postgresql|mysql|mariadb|redis|mongo|mongod|sqlite)\b/i;

const PORT_PATTERN = /(?:port|listening on|running (?:at|on)|localhost:)\s*:?(\d{2,5})/i;

export function detectServerType(processName: string | undefined, output?: string): { type: ServerType; port: string | null } | null {
  const name = processName?.toLowerCase() ?? '';

  if (FRONTEND_PROCESSES.test(name)) {
    return { type: 'frontend', port: extractPort(output) };
  }
  if (BACKEND_PROCESSES.test(name)) {
    return { type: 'backend', port: extractPort(output) };
  }
  if (DATABASE_PROCESSES.test(name)) {
    return { type: 'database', port: extractPort(output) };
  }

  // Fallback: check output patterns
  if (output) {
    const clean = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    if (PORT_PATTERN.test(clean)) {
      return { type: 'server', port: extractPort(output) };
    }
  }

  return null;
}

function extractPort(output?: string): string | null {
  if (!output) return null;
  const clean = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const match = clean.match(PORT_PATTERN);
  return match?.[1] ?? null;
}

export const SERVER_TYPE_COLORS: Record<string, string> = {
  frontend: '#06B6D4',
  backend: '#A855F7',
  database: '#F59E0B',
  server: '#64748B',
};

export const SERVER_TYPE_LABELS: Record<string, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  database: 'Database',
  server: 'Server',
};
