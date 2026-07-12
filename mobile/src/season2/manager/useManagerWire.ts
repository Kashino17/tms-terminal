/**
 * Season 2 manager wiring — registers the persistent manager-message handler
 * on the season2 connection. Mirrors the classic TerminalScreen handler 1:1
 * (same store mutations, same notifications), because that handler is only
 * installed when the CLASSIC terminal screen mounts — without this, manager
 * responses would never reach the store while living in Season 2.
 * `setPersistentHandler` is single-slot per connection; if the user visits
 * the classic terminal later it re-registers the identical logic. Harmless.
 */
import { useEffect } from 'react';
import type { WebSocketService } from '../../services/websocket.service';
import { useManagerStore } from '../../store/managerStore';
import { notifyManagerResponse } from '../../services/managerNotifications.service';

export function useManagerWire(wsService: WebSocketService | null) {
  useEffect(() => {
    if (!wsService) return;
    wsService.setPersistentHandler((data: unknown) => {
      const m = data as { type: string; payload?: any };
      if (!m.type?.startsWith('manager:')) return;

      const store = useManagerStore.getState();
      const chatKey = m.payload?.targetSessionId ?? store.activeChat;
      const agentName = store.personality.agentName;

      switch (m.type) {
        case 'manager:summary':
          store.addSummary(m.payload.text, m.payload.sessions, m.payload.timestamp, 'alle');
          notifyManagerResponse(m.payload.text, agentName, store.personality.agentAvatarUri);
          break;
        case 'manager:response':
          store.addResponse(m.payload.text, m.payload.actions, chatKey);
          notifyManagerResponse(m.payload.text, agentName, store.personality.agentAvatarUri);
          break;
        case 'manager:error':
          store.addError(m.payload.message, chatKey);
          break;
        case 'manager:providers': {
          store.setProviders(m.payload.providers, m.payload.active);
          const persisted = store.activeProvider;
          if (persisted && persisted !== m.payload.active && m.payload.providers.some((p: any) => p.id === persisted)) {
            wsService.send({ type: 'manager:set_provider', payload: { providerId: persisted } });
          }
          break;
        }
        case 'manager:status':
          store.setEnabled(m.payload.enabled);
          break;
        case 'manager:personality_configured':
          if (m.payload) {
            store.setPersonality(m.payload);
            store.setOnboarded(true);
          }
          break;
        case 'manager:thinking':
          store.setThinking(m.payload.phase, m.payload.detail, m.payload.elapsed, chatKey);
          break;
        case 'manager:stream_chunk':
          store.appendStreamChunk(
            m.payload.token,
            m.payload.completionTokens != null
              ? { completionTokens: m.payload.completionTokens, tps: m.payload.tps ?? 0 }
              : undefined,
          );
          break;
        case 'manager:stream_end':
          store.finishStream(m.payload.text, m.payload.actions, m.payload.phases, m.payload.images, m.payload.presentations);
          notifyManagerResponse(m.payload.text, agentName, store.personality.agentAvatarUri);
          break;
        case 'manager:tasks':
          if (Array.isArray(m.payload?.tasks)) {
            store.setDelegatedTasks(m.payload.tasks);
          }
          break;
      }
    });
  }, [wsService]);
}
