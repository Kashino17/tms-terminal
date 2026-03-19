import { Linking, Platform } from 'react-native';
import * as Application from 'expo-application';
import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';

// ── Config ──────────────────────────────────────────────────────────────────
const GITHUB_REPO = 'Kashino17/tms-terminal';
const API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const BG_UPDATE_TASK = 'BACKGROUND_UPDATE_CHECK';

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  assets: {
    name: string;
    browser_download_url: string;
    size: number;
  }[];
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

export function getCurrentVersion(): string {
  return Application.nativeApplicationVersion ?? '1.0.0';
}

export async function checkForUpdate(): Promise<{
  version: string;
  changelog: string;
  downloadUrl: string;
  releaseUrl: string;
  size: number;
} | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(API_URL, {
      headers: { Accept: 'application/vnd.github.v3+json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const release: GitHubRelease = await res.json();
    const remoteVersion = release.tag_name;
    const currentVersion = getCurrentVersion();

    if (compareSemver(remoteVersion, currentVersion) <= 0) return null;

    const apk = release.assets.find(a => a.name.endsWith('.apk'));
    if (!apk) return null;

    return {
      version: remoteVersion,
      changelog: release.body ?? release.name ?? 'New version available',
      downloadUrl: apk.browser_download_url,
      releaseUrl: release.html_url,
      size: apk.size,
    };
  } catch {
    return null;
  }
}

/**
 * Open the APK download URL directly in the browser.
 * Android will download the APK and prompt to install it.
 */
export async function downloadAndInstall(downloadUrl: string): Promise<void> {
  await Linking.openURL(downloadUrl);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── Background Update Check ─────────────────────────────────────────────────

// Create notification channel for updates (Android)
if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync('app-updates', {
    name: 'App Updates',
    description: 'Benachrichtigungen wenn ein neues Update verfügbar ist',
    importance: Notifications.AndroidImportance.DEFAULT,
    sound: 'default',
  }).catch(() => {});
}

// Register the background task handler
TaskManager.defineTask(BG_UPDATE_TASK, async () => {
  try {
    const update = await checkForUpdate();
    if (update) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '🔄 Update verfügbar',
          body: `TMS Terminal ${update.version} ist verfügbar (${formatSize(update.size)})`,
          sound: 'default',
          data: { downloadUrl: update.downloadUrl },
          ...(Platform.OS === 'android' ? { channelId: 'app-updates' } : {}),
        },
        trigger: null,
      });
      return BackgroundFetch.BackgroundFetchResult.NewData;
    }
    return BackgroundFetch.BackgroundFetchResult.NoData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

/**
 * Register the background update check.
 * Android runs this roughly every 15–30 min (OS-controlled).
 */
export async function registerBackgroundUpdateCheck(): Promise<void> {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(BG_UPDATE_TASK);
  if (isRegistered) return;

  await BackgroundFetch.registerTaskAsync(BG_UPDATE_TASK, {
    minimumInterval: 60 * 60, // 1 hour minimum
    stopOnTerminate: false,
    startOnBoot: true,
  });
}
