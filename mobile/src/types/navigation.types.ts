import type { WebSocketService } from '../services/websocket.service';

export type RootStackParamList = {
  Home: undefined;
  ServerList: undefined;
  PrayerTimes: undefined;
  Hydra: undefined;
  AddServer: { server?: any } | undefined;
  Terminal: { serverId: string; serverName: string; serverHost: string; serverPort: number; token: string; openManager?: boolean };
  Settings: undefined;
  Drawing: { serverHost: string; serverPort: number; serverToken: string };
  PinSetup: { mode?: string } | undefined;
  Lock: undefined;
  Browser: { serverHost: string; serverId: string; terminalTabId: string; openDirect?: boolean };
  Dashboard: undefined;
  Processes: { wsService: WebSocketService };
  ManagerChat: { wsService: WebSocketService; serverId: string; serverHost: string; serverPort: number; serverToken: string };
  ManagerMemory: { wsService: WebSocketService; serverId: string };
  ManagerArtifacts: { serverId: string; serverHost: string; serverPort: number; serverToken: string };
  Voice: { wsService: WebSocketService };
};
