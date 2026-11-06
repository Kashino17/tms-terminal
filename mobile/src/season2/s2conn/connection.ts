/**
 * Verbindungszustand der Season-2-Oberflaeche.
 *
 * Aus TerminalsScreen.tsx herausgezogen, weil die Datei als Ganzes tot war: die
 * native Season-2-Variante (SeasonTwoRoot) wird nicht gerendert, seit der
 * WebView-Weg gewonnen hat. Ausgerechnet diese drei Dinge waren aber noch
 * gebraucht — SeasonTwoWebRoot.tsx importiert den Store und den Live-Hook.
 *
 * Ein Modul-Store statt eines Component-Stores, damit der Zustand einen
 * Screen-Wechsel ueberlebt: die WebView laedt neu, das nicht.
 */
import { create } from 'zustand';
import { useEffect, useMemo, useState } from 'react';
import { getConnection } from '../../services/websocket.service';
import type { ConnectionState } from '../../types/websocket.types';

export interface S2Server {
  id: string;
  name: string;
  host: string;
  port: number;
  token?: string | null;
}

interface S2ConnState {
  server: S2Server | null;
  token: string | null;
  focusTabId: string | null;
  setServer: (server: S2Server | null, token: string | null) => void;
  setFocusTab: (id: string | null) => void;
}

export const useS2ConnStore = create<S2ConnState>((set) => ({
  server: null,
  token: null,
  focusTabId: null,
  setServer: (server, token) => set({ server, token }),
  setFocusTab: (focusTabId) => set({ focusTabId }),
}));

/** Live view over the season-2 connection: polls state/RTT (no handler theft
 *  from the classic screens — they use setStateHandler exclusively). */
export function useS2Connection() {
  const { server, token, focusTabId, setFocusTab } = useS2ConnStore();
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [rtt, setRtt] = useState<number | null>(null);
  const wsService = useMemo(() => (server ? getConnection(server.id) : null), [server]);

  useEffect(() => {
    if (!wsService) { setState('disconnected'); setRtt(null); return; }
    const tick = () => {
      setState(wsService.state);
      const r = wsService.getRtt?.();
      setRtt(typeof r === 'number' && r > 0 ? Math.round(r) : null);
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, [wsService]);

  return { server, token, wsService, state, rtt, focusTabId, focusTab: setFocusTab };
}