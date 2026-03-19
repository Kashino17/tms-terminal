import { Linking, Platform } from 'react-native';
import * as Application from 'expo-application';

// ── Config ──────────────────────────────────────────────────────────────────
const GITHUB_REPO = 'Kashino17/tms-terminal';
const API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

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
