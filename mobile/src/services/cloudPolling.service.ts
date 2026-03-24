// mobile/src/services/cloudPolling.service.ts
import * as Notifications from 'expo-notifications';
import { useCloudWatchStore } from '../store/cloudWatchStore';
import { useCloudAuthStore } from '../store/cloudAuthStore';
import { createRenderService } from './render.service';
import { createVercelService } from './vercel.service';
import type { CloudProvider } from './cloud.types';

let foregroundInterval: ReturnType<typeof setInterval> | null = null;

function getServiceForPlatform(platform: 'render' | 'vercel'): CloudProvider | null {
  const tokens = useCloudAuthStore.getState().tokens;
  const token = tokens[platform];
  if (!token) return null;
  return platform === 'render' ? createRenderService(token) : createVercelService(token);
}

export async function checkWatchedDeployments(): Promise<void> {
  const { getActiveWatches, removeWatch, updateStatus } = useCloudWatchStore.getState();
  const { notificationsEnabled } = useCloudAuthStore.getState();
  const watches = getActiveWatches();

  if (watches.length === 0) return;

  for (const watch of watches) {
    try {
      const service = getServiceForPlatform(watch.platform);
      if (!service) continue;

      const result = await service.listDeployments(watch.projectId);
      const deploy = result.items.find((d) => d.id === watch.deployId);
      if (!deploy) continue;

      if (deploy.status !== watch.status) {
        if (deploy.status === 'ready' || deploy.status === 'error') {
          // Terminal state — remove from watch and notify
          removeWatch(watch.deployId);

          if (notificationsEnabled) {
            const isSuccess = deploy.status === 'ready';
            const platformName = watch.platform === 'render' ? 'Render' : 'Vercel';
            const duration = deploy.duration
              ? ` (${Math.floor(deploy.duration / 60)}m ${deploy.duration % 60}s)`
              : '';

            await Notifications.scheduleNotificationAsync({
              content: {
                title: `${isSuccess ? '✅' : '❌'} ${platformName}: ${watch.projectName}`,
                body: isSuccess
                  ? `Deployment erfolgreich${duration}`
                  : `Deployment fehlgeschlagen`,
                sound: 'default',
                data: {
                  type: 'cloud_deploy',
                  platform: watch.platform,
                  projectId: watch.projectId,
                },
              },
              trigger: null,
            });
          }
        } else {
          // Intermediate state change — update
          updateStatus(watch.deployId, deploy.status);
        }
      }
    } catch {
      // Rate limited or network error — skip, retry next cycle
      continue;
    }
  }
}

export function startForegroundPolling(intervalMs: number = 30_000): void {
  stopForegroundPolling();
  foregroundInterval = setInterval(checkWatchedDeployments, intervalMs);
}

export function stopForegroundPolling(): void {
  if (foregroundInterval) {
    clearInterval(foregroundInterval);
    foregroundInterval = null;
  }
}
