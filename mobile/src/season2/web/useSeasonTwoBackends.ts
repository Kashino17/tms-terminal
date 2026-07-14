/**
 * The Manager and Cloud halves of the Season-2 bridge.
 *
 * Both screens exist fully formed in the Liquid-Deck page; all they were
 * missing is real data. This hook keeps TMS_DATA.manager / TMS_DATA.cloudProjects
 * in sync with the manager WebSocket and the Vercel API, in the exact shapes the
 * mockup's renderers already read.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { WebSocketService } from '../../services/websocket.service';
import { useManagerStore, type ManagerMessage } from '../../store/managerStore';
import { useCloudAuthStore } from '../../store/cloudAuthStore';
import { createVercelService } from '../../services/vercel.service';
import type { Project, Deployment, EnvVar, LogEntry } from '../../services/cloud.types';

type Call = (fn: string, ...args: unknown[]) => void;

// ── Manager ─────────────────────────────────────────────────────────────────

/** managerStore → the chat bubbles the mockup renders. */
function toMockupMessages(messages: ManagerMessage[], streaming: string) {
  const out = messages.map((m, i) => ({
    type: 'text' as const,
    from: m.role === 'user' ? 'user' : 'manager',
    time: new Date(m.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
    text: m.text,
    _id: m.id || `msg${i}`,
  }));
  // A streaming answer is just the bubble that is still growing. Marked so the
  // chat header can show "tippt …" while it grows.
  if (streaming) {
    out.push({ type: 'text', from: 'manager', time: '', text: streaming, _id: 'streaming', _streaming: true } as never);
  }
  return out;
}

export function useManagerBridge(wsService: WebSocketService | null, ready: boolean, call: Call) {
  useEffect(() => {
    if (!ready) return;
    let lastPersona = '';
    const push = () => {
      const s = useManagerStore.getState();
      const chat = s.activeChat;
      const msgs = (s.messages ?? []).filter((m) => !m.targetSessionId || m.targetSessionId === chat);
      call('setManager', toMockupMessages(msgs, s.streamingText ?? ''));
      // Name + Profilbild nur schicken, wenn sie sich wirklich geändert haben —
      // sie bauen die ganze Manager-Ansicht neu auf, das soll nicht bei jeder
      // eintreffenden Nachricht passieren.
      const persona = JSON.stringify([s.personality.agentName, s.personality.agentAvatarUri ?? null]);
      if (persona !== lastPersona) {
        lastPersona = persona;
        call('setManagerPersona', s.personality.agentName || 'Manager', s.personality.agentAvatarUri ?? null);
      }
    };
    push();
    return useManagerStore.subscribe(push);
  }, [ready, call]);

  return useCallback((text: string) => {
    if (!wsService) return;
    const store = useManagerStore.getState();
    const target = store.activeChat;
    store.addMessage({ role: 'user', text, targetSessionId: target !== 'alle' ? target : undefined }, target);
    store.setLoading(true);
    wsService.send({
      type: 'manager:chat',
      payload: { text, targetSessionId: target !== 'alle' ? target : undefined, onboarding: false },
    });
  }, [wsService]);
}

// ── Cloud ───────────────────────────────────────────────────────────────────

const STATUS_MAP: Record<string, string> = {
  ready: 'ready', building: 'building', error: 'error', queued: 'building', canceled: 'suspended',
};

function relativeTime(iso?: string): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const min = Math.round(ms / 60000);
  if (min < 60) return `vor ${Math.max(1, min)} Min`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std`;
  return `vor ${Math.round(h / 24)} Tagen`;
}

export function useCloudBridge(ready: boolean, call: Call) {
  const tokens = useCloudAuthStore((s) => s.tokens);
  const activeOwnerId = useCloudAuthStore((s) => s.activeOwnerId);
  /** The owner we resolved the project list against — needed for the detail calls. */
  const provider = useRef<ReturnType<typeof createVercelService> | null>(null);

  const loadProjects = useCallback(async () => {
    const token = tokens.vercel;
    if (!ready || !token) return;
    try {
      const svc = createVercelService(token);
      provider.current = svc;
      const ownerId = activeOwnerId.vercel ?? (await svc.listOwners())[0]?.id;
      if (!ownerId) return;
      const page = await svc.listProjects(ownerId);
      call('setCloud', page.items.map((p: Project) => ({
        id: p.id,
        provider: 'vercel',
        name: p.name,
        folder: p.repo ?? 'Vercel',
        favorite: false,
        status: STATUS_MAP[p.status] ?? 'ready',
        lastDeploy: relativeTime(p.updatedAt),
        env: [],
        logs: [],
      })));
    } catch (e: any) {
      call('toast', `Cloud: ${e?.message ?? 'Laden fehlgeschlagen'}`);
    }
  }, [ready, tokens.vercel, activeOwnerId.vercel, call]);

  /** Env, Logs and Deploys for one project — fetched when its detail opens. */
  const loadDetail = useCallback(async (projectId: string) => {
    const svc = provider.current;
    if (!svc) return;
    const [env, logs, deploys] = await Promise.all([
      svc.listEnvVars(projectId).catch(() => [] as EnvVar[]),
      svc.getServiceLogs(projectId).catch(() => [] as LogEntry[]),
      svc.listDeployments(projectId).then((r) => r.items).catch(() => [] as Deployment[]),
    ]);
    call('setCloudDetail', projectId, {
      env: env.map((e) => ({ key: e.key, value: e.value })),
      logs: logs.map((l) => `${new Date(l.timestamp).toLocaleTimeString('de-DE')} ${l.message}`),
      deploys: deploys.slice(0, 10).map((d, i) => ({
        version: d.commitHash ? d.commitHash.slice(0, 7) : `#${deploys.length - i}`,
        time: relativeTime(d.createdAt),
        status: STATUS_MAP[d.status] ?? d.status,
      })),
    });
  }, [call]);

  return { loadProjects, loadDetail };
}
