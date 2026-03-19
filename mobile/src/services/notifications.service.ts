import { PermissionsAndroid, Platform, AppState } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import * as Notifications from 'expo-notifications';

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

// Create a dedicated notification channel for terminal prompts (Android)
if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync('terminal-prompts', {
    name: 'Terminal Prompts',
    description: 'Notifications when AI tools (Claude, Codex, Gemini) need input',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 200],
    enableVibrate: true,
    showBadge: true,
  }).catch(() => {});
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

/**
 * Must be called once outside any component.
 * Handles notifications that arrive when the app is backgrounded or killed.
 */
export function registerBackgroundHandler(): void {
  messaging().setBackgroundMessageHandler(async (_message) => {
    // OS displays the notification automatically from the FCM payload.
  });
}

/**
 * Handle foreground FCM messages.
 * Android does NOT show notification banners when the app is in foreground —
 * we re-post as a local notification via expo-notifications.
 */
export function registerForegroundHandler(): () => void {
  return messaging().onMessage(async (remoteMessage) => {
    const title = remoteMessage.notification?.title ?? '⚡ Terminal';
    const body = remoteMessage.notification?.body ?? 'Waiting for input';

    // Show a local notification so it appears as a heads-up banner
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: 'default',
        ...(Platform.OS === 'android' ? { channelId: 'terminal-prompts' } : {}),
      },
      trigger: null, // immediately
    });
  });
}
