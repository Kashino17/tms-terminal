import { AppState, NativeModules, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

/** Call once at app startup to create the notification channel */
export function setupManagerNotificationChannel(): void {
  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('manager-responses', {
      name: 'Manager Agent',
      description: 'Benachrichtigungen vom Manager-Agent',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
      vibrationPattern: [0, 150],
      enableVibrate: true,
    }).catch(() => {});
  }
}

/** Send a local notification when the agent responds while app is backgrounded.
 *  On Android, uses native AgentNotification module for avatar large icon support. */
export async function notifyManagerResponse(text: string, agentName: string, avatarUri?: string): Promise<void> {
  try {
    const state = AppState.currentState;
    if (state === 'active') return;

    const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
    const title = `💬 ${agentName}`;

    // Use native module on Android for avatar support
    if (Platform.OS === 'android' && NativeModules.AgentNotification) {
      NativeModules.AgentNotification.show(title, preview, avatarUri ?? null);
      return;
    }

    // Fallback: expo-notifications (iOS or if native module unavailable)
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body: preview,
        sound: 'default',
        data: { type: 'manager_response' },
        ...(Platform.OS === 'android' ? { channelId: 'manager-responses' } : {}),
      },
      trigger: null,
    });
  } catch {
    // Permission denied or other error — silently ignore
  }
}
