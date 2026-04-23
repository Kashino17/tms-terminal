import { NativeModules, PermissionsAndroid, Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import messaging from '@react-native-firebase/messaging';
import * as Notifications from 'expo-notifications';
import { isChatScreenActive } from './managerNotifications.service';

// Configure how notifications appear when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// Create a dedicated notification channel for terminal idle alerts (Android)
if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync('terminal-prompts', {
    name: 'Terminal Idle',
    description: 'Notifications when a terminal session has been idle',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 200],
    enableVibrate: true,
    showBadge: true,
  }).catch(() => {});
}

// ── Pending notification navigation target ──────────────────────────────────
// When a notification is tapped, we store the sessionId here.
// App.tsx reads and consumes it to navigate to the right terminal.
let _pendingNotificationSessionId: string | null = null;

/** Read and consume the pending navigation target (returns null if none). */
export function consumePendingNotificationTarget(): string | null {
  const sid = _pendingNotificationSessionId;
  _pendingNotificationSessionId = null;
  return sid;
}

// ── Pending cloud deploy navigation target ───────────────────────────────────
// When a cloud_deploy notification is tapped, we store the target here.
// App.tsx reads and consumes it to navigate to the right cloud project.
let _pendingCloudTarget: { platform: 'render' | 'vercel'; projectId: string } | null = null;

/** Read and consume the pending cloud navigation target (returns null if none). */
export function consumePendingCloudTarget(): { platform: 'render' | 'vercel'; projectId: string } | null {
  const target = _pendingCloudTarget;
  _pendingCloudTarget = null;
  return target;
}

// ── Pending manager chat open target ─────────────────────────────────────────
// Set when the user taps a manager-reply notification. App.tsx primes it;
// any screen with a live WebSocket connection can consume it and navigate
// to ManagerChat *with full route params*.
let _pendingManagerChatOpen = false;

export function setPendingManagerChatOpen(active: boolean): void {
  _pendingManagerChatOpen = active;
}

/** Read and consume the pending manager-chat-open flag (returns false if none). */
export function consumePendingManagerChatOpen(): boolean {
  const was = _pendingManagerChatOpen;
  _pendingManagerChatOpen = false;
  return was;
}

/** Set up a listener for notification response (tap). */
export function registerNotificationResponseHandler(): (() => void) {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as Record<string, unknown> | undefined;
    const sessionId = data?.sessionId;
    if (typeof sessionId === 'string') {
      _pendingNotificationSessionId = sessionId;
    }
    if (data?.type === 'cloud_deploy') {
      _pendingCloudTarget = {
        platform: data.platform as 'render' | 'vercel',
        projectId: data.projectId as string,
      };
    }
  });
  return () => subscription.remove();
}

/**
 * Request Android 13+ POST_NOTIFICATIONS runtime permission.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'android') {
    if (Number(Platform.Version) >= 33) {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );
      return result === PermissionsAndroid.RESULTS.GRANTED;
    }
    return true;
  }
  const status = await messaging().requestPermission();
  return (
    status === messaging.AuthorizationStatus.AUTHORIZED ||
    status === messaging.AuthorizationStatus.PROVISIONAL
  );
}

/**
 * Returns the FCM registration token for this device.
 */
export async function getFcmToken(): Promise<string | null> {
  try {
    await messaging().registerDeviceForRemoteMessages();
    return await messaging().getToken();
  } catch (err) {
    console.warn('[FCM] Could not get token:', err);
    return null;
  }
}

// ── Avatar cache helpers ─────────────────────────────────────────────────────
// The FCM background handler runs outside React context and cannot access
// Zustand stores. We cache the avatar URI to AsyncStorage whenever it changes,
// so the background handler can read it without touching the store.

const AVATAR_CACHE_KEY = 'manager.agentAvatarUri';

export async function cacheAvatarUri(uri: string | null): Promise<void> {
  try {
    if (uri) await AsyncStorage.setItem(AVATAR_CACHE_KEY, uri);
    else await AsyncStorage.removeItem(AVATAR_CACHE_KEY);
  } catch { /* ignore */ }
}

async function readCachedAvatarUri(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(AVATAR_CACHE_KEY);
  } catch {
    return null;
  }
}

/**
 * Must be called once outside any component.
 * Handles notifications that arrive when the app is backgrounded or killed.
 */
export function registerBackgroundHandler(): void {
  messaging().setBackgroundMessageHandler(async (message) => {
    const type = typeof message.data?.type === 'string' ? message.data.type : '';

    if (type === 'manager_reply') {
      const title = String(message.data?.title ?? '💬 Manager');
      const body = String(message.data?.body ?? '');
      const messageId = String(message.data?.messageId ?? '');
      const avatarUri = await readCachedAvatarUri();

      if (Platform.OS === 'android' && NativeModules.AgentNotification) {
        NativeModules.AgentNotification.show(title, body, avatarUri ?? null, messageId || null);
        return;
      }
      // Fallback: expo-notifications
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: 'default',
          data: { type: 'manager_reply', messageId },
          ...(Platform.OS === 'android' ? { channelId: 'manager-responses' } : {}),
        },
        trigger: null,
      });
      return;
    }

    if (type.startsWith('task_')) {
      const title = String(message.data?.title ?? '');
      const body = String(message.data?.body ?? '');
      const taskId = String(message.data?.taskId ?? '');
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: 'default',
          data: { type, taskId },
          ...(Platform.OS === 'android' ? { channelId: 'terminal-prompts' } : {}),
        },
        trigger: null,
      });
      return;
    }

    if (type === 'watcher_alert') {
      const title = String(message.data?.title ?? '🔔 Watcher');
      const body = String(message.data?.body ?? '');
      const data: Record<string, string> = {};
      for (const [k, v] of Object.entries(message.data ?? {})) {
        if (typeof v === 'string') data[k] = v;
      }
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: 'default',
          data,
          ...(Platform.OS === 'android' ? { channelId: 'terminal-prompts' } : {}),
        },
        trigger: null,
      });
      return;
    }

    // Fallback for any legacy notification-shaped message
  });
}

/**
 * Handle foreground FCM messages.
 * Android does NOT show notification banners when the app is in foreground —
 * we re-post as a local notification via expo-notifications.
 */
export function registerForegroundHandler(): () => void {
  return messaging().onMessage(async (remoteMessage) => {
    const type = typeof remoteMessage.data?.type === 'string' ? remoteMessage.data.type : '';

    if (type === 'manager_reply') {
      // Belt-and-suspenders: also gate on chat-screen-active even though server
      // should already have skipped this push (defense against stale-state race).
      if (isChatScreenActive()) return;
      const title = String(remoteMessage.data?.title ?? '💬 Manager');
      const body = String(remoteMessage.data?.body ?? '');
      const messageId = String(remoteMessage.data?.messageId ?? '');
      const avatarUri = await readCachedAvatarUri();
      if (Platform.OS === 'android' && NativeModules.AgentNotification) {
        NativeModules.AgentNotification.show(title, body, avatarUri ?? null, messageId || null);
        return;
      }
      // iOS / fallback: no MessagingStyle, just a regular expanded notification
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: 'default',
          data: { type: 'manager_reply', messageId },
          ...(Platform.OS === 'android' ? { channelId: 'manager-responses' } : {}),
        },
        trigger: null,
      });
      return;
    }

    const title = String(remoteMessage.data?.title ?? remoteMessage.notification?.title ?? '💤 Terminal');
    const body = String(remoteMessage.data?.body ?? remoteMessage.notification?.body ?? '');
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(remoteMessage.data ?? {})) {
      if (typeof v === 'string') data[k] = v;
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: 'default',
        data,
        ...(Platform.OS === 'android' ? { channelId: 'terminal-prompts' } : {}),
      },
      trigger: null,
    });
  });
}
