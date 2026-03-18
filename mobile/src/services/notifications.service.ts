import { PermissionsAndroid, Platform } from 'react-native';
import messaging from '@react-native-firebase/messaging';

/**
 * Request Android 13+ POST_NOTIFICATIONS runtime permission.
 * On older Android or iOS the permission is granted implicitly.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'android') {
    // Android 13 (API 33) requires POST_NOTIFICATIONS at runtime
    if (Number(Platform.Version) >= 33) {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );
      return result === PermissionsAndroid.RESULTS.GRANTED;
    }
    return true; // Android < 13: no runtime permission needed
  }
  // iOS
  const status = await messaging().requestPermission();
  return (
    status === messaging.AuthorizationStatus.AUTHORIZED ||
    status === messaging.AuthorizationStatus.PROVISIONAL
  );
}

/**
 * Returns the FCM registration token for this device.
 * Registers the device with APNS/FCM first (required on iOS & Android).
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
 * Must be called once outside any component (e.g. in App.tsx or index.js).
 * Handles notifications that arrive when the app is backgrounded or killed.
 */
export function registerBackgroundHandler(): void {
  messaging().setBackgroundMessageHandler(async (_message) => {
    // The OS displays the notification automatically from the FCM payload.
    // No manual action needed here.
  });
}

/**
 * Suppress in-app popup for foreground FCM messages.
 * Notifications are handled silently via the WebSocket tab-badge system.
 */
export function registerForegroundHandler(): () => void {
  return messaging().onMessage(async (_remoteMessage) => {
    // Silently consumed — badge is set via WebSocket terminal:prompt_detected
  });
}
