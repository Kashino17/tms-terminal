import { useCallback, useEffect, useRef } from 'react';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

const DEX_PORT = 8768;

export interface DeXHostStatus {
  ok?: boolean;
  running: boolean;
  privileged: boolean;
  usbPlugged: boolean;
  usbTethering: boolean;
  usbIp: string | null;
  port: number;
  displayId: number;
  width: number;
  height: number;
  connectedClients: number;
  device?: string;
  adbCommand?: string;
}

/**
 * Pure helper (exported for unit tests): builds prioritized candidate IPs for the
 * Samsung Galaxy Fold 7 USB-C tethering interface (CDC-NCM / RNDIS).
 */
export function buildUsbDeXCandidateIps(
  localIp: string | null | undefined,
  lastKnownIp?: string | null,
): string[] {
  const seen = new Set<string>();
  const add = (ip: string | null | undefined) => {
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== localIp) {
      seen.add(ip);
    }
  };

  add(lastKnownIp);

  if (localIp && /^\d+\.\d+\.\d+\.\d+$/.test(localIp)) {
    const parts = localIp.split('.');
    const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
    // Android classic & One UI common gateway offsets on USB tethering (/24)
    add(`${prefix}.129`);
    add(`${prefix}.1`);
    add(`${prefix}.2`);
    add(`${prefix}.254`);
  }

  // Classic Android USB tethering defaults
  add('192.168.42.129');
  add('192.168.42.1');
  add('192.168.43.1');
  add('172.20.10.1');

  return Array.from(seen);
}

async function probeDeXEndpoint(ip: string, timeoutMs = 380): Promise<DeXHostStatus | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:${DEX_PORT}/dex/status`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.ok && data.service === 'tms-dex-host') {
      return {
        ok: true,
        running: true,
        privileged: !!data.privileged,
        usbPlugged: true,
        usbTethering: true,
        usbIp: data.usbIp || ip,
        port: data.port || DEX_PORT,
        displayId: typeof data.displayId === 'number' ? data.displayId : -1,
        width: data.width || 2048,
        height: data.height || 1536,
        connectedClients: data.connectedClients || 0,
        device: data.device || 'Samsung Galaxy Fold 7',
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scans a /24 USB tethering subnet in fast parallel batches when Android 11+
 * assigns a randomized last octet to the `ncm0` interface.
 */
async function scanUsbSubnetForDeX(localIp: string): Promise<{ ip: string; status: DeXHostStatus } | null> {
  const parts = localIp.split('.');
  if (parts.length !== 4) return null;
  const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const selfHost = Number(parts[3]);

  const batchSize = 32;
  for (let start = 1; start <= 254; start += batchSize) {
    const batch: number[] = [];
    for (let i = start; i < start + batchSize && i <= 254; i++) {
      if (i !== selfHost && i !== 1 && i !== 129) batch.push(i);
    }
    const found = await Promise.all(
      batch.map(async (octet) => {
        const ip = `${prefix}.${octet}`;
        const st = await probeDeXEndpoint(ip, 260);
        return st ? { ip, status: st } : null;
      }),
    );
    const hit = found.find((x) => x !== null);
    if (hit) return hit;
  }
  return null;
}

export function useDeXUsbMonitor(
  ready: boolean,
  call: (fn: string, ...args: unknown[]) => void,
) {
  const activeDeXIp = useRef<string | null>(null);
  const lastKnownIp = useRef<string | null>(null);
  const manualDismissedIp = useRef<string | null>(null);
  const probing = useRef<boolean>(false);
  const missCount = useRef<number>(0);

  const openTetherSettings = useCallback(async () => {
    const mod = NativeModules.TMSDeXHost;
    if (mod && typeof mod.openTetherSettings === 'function') {
      await mod.openTetherSettings().catch(() => {});
    }
  }, []);

  const startHostEngine = useCallback(async () => {
    const mod = NativeModules.TMSDeXHost;
    if (!mod || typeof mod.startEngine !== 'function') return;
    try {
      const res = await mod.startEngine();
      const st = await mod.getStatus().catch(() => null);
      if (st) call('setDeXHostStatus', st);
      if (res && res.privileged) {
        call('toast', '⚡ Samsung DeX Engine aktiv (Port 8768)');
      } else {
        call('toast', 'DeX-Standby aktiv — 1x per "tms-terminal dex" am Mac/PC freischalten');
      }
    } catch {
      call('toast', 'DeX-Engine Start fehlgeschlagen');
    }
  }, [call]);

  const notifyManualStop = useCallback(() => {
    if (activeDeXIp.current) {
      manualDismissedIp.current = activeDeXIp.current;
      activeDeXIp.current = null;
    }
  }, []);

  // ── Android Host Side (Samsung Galaxy Fold 7) ─────────────────────────────
  useEffect(() => {
    if (!ready || Platform.OS !== 'android') return;
    const mod = NativeModules.TMSDeXHost;
    if (!mod || typeof mod.getStatus !== 'function') return;

    let cancelled = false;
    const refreshHost = async () => {
      try {
        const st: DeXHostStatus = await mod.getStatus();
        if (cancelled || !st) return;
        call('setDeXHostStatus', st);
        // Auto-start engine when USB cable is plugged in
        if ((st.usbPlugged || st.usbTethering) && !st.running && typeof mod.startEngine === 'function') {
          await mod.startEngine().catch(() => {});
          const st2 = await mod.getStatus().catch(() => null);
          if (!cancelled && st2) call('setDeXHostStatus', st2);
        }
      } catch {}
    };

    void refreshHost();
    const interval = setInterval(refreshHost, 4000);
    const emitter = new NativeEventEmitter(mod);
    const sub = emitter.addListener('DeXUsbStateChanged', () => {
      void refreshHost();
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      sub.remove();
    };
  }, [ready, call]);

  // ── iPad / Client Monitor Side (Zero-Touch USB Auto-Discovery) ────────────
  useEffect(() => {
    if (!ready || Platform.OS !== 'ios') return;
    let cancelled = false;

    const checkConnection = async (netState?: NetInfoState, allowSubnetScan = false) => {
      if (probing.current || cancelled) return;
      probing.current = true;
      try {
        // 1) If already connected to DeX over USB, verify health
        if (activeDeXIp.current) {
          const alive = await probeDeXEndpoint(activeDeXIp.current, 600);
          if (alive) {
            missCount.current = 0;
            return;
          }
          missCount.current += 1;
          if (missCount.current >= 2 && !cancelled) {
            activeDeXIp.current = null;
            manualDismissedIp.current = null;
            missCount.current = 0;
            call('stopDeXMonitor');
          }
          return;
        }

        // 2) Not connected yet: probe prioritized USB-C tethering candidate IPs
        const state = netState ?? (await NetInfo.fetch().catch(() => null));
        const localIp = (state?.details as { ipAddress?: string } | undefined)?.ipAddress ?? null;
        const candidates = buildUsbDeXCandidateIps(localIp, lastKnownIp.current);

        for (const ip of candidates) {
          if (cancelled) return;
          const st = await probeDeXEndpoint(ip, 350);
          if (st) {
            lastKnownIp.current = ip;
            if (manualDismissedIp.current === ip) return;
            activeDeXIp.current = ip;
            missCount.current = 0;
            call('startDeXMonitor', {
              host: ip,
              port: st.port || DEX_PORT,
              device: st.device || 'Samsung Galaxy Fold 7',
            });
            return;
          }
        }

        // 3) If USB interface just came up with a 192.168.x.y address (Android 11+ randomized NCM IP),
        //    scan the /24 subnet in fast batches.
        if (allowSubnetScan && localIp && localIp.startsWith('192.168.')) {
          const found = await scanUsbSubnetForDeX(localIp);
          if (found && !cancelled) {
            lastKnownIp.current = found.ip;
            if (manualDismissedIp.current === found.ip) return;
            activeDeXIp.current = found.ip;
            missCount.current = 0;
            call('startDeXMonitor', {
              host: found.ip,
              port: found.status.port || DEX_PORT,
              device: found.status.device || 'Samsung Galaxy Fold 7',
            });
          }
        }
      } finally {
        probing.current = false;
      }
    };

    void checkConnection(undefined, true);
    const unsub = NetInfo.addEventListener((state) => {
      // Reset manual dismissal if network topology changes (e.g. cable re-plugged)
      if (!state.isConnected) {
        manualDismissedIp.current = null;
      }
      void checkConnection(state, true);
    });
    const timer = setInterval(() => {
      void checkConnection(undefined, false);
    }, 2500);

    return () => {
      cancelled = true;
      unsub();
      clearInterval(timer);
    };
  }, [ready, call]);

  return {
    openTetherSettings,
    startHostEngine,
    notifyManualStop,
  };
}
