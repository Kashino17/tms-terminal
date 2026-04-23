import { AppState, NativeModules, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

let _chatScreenActive = false;

export function setChatScreenActive(active: boolean): void {
  _chatScreenActive = active;
}

export function isChatScreenActive(): boolean {
  return _chatScreenActive;
}

/** Call once at app startup to create the notification channel */
export function setupManagerNotificationChannel(): void {
  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('manager-responses', {
      name: 'Manager Agent',
      description: 'Benachrichtigungen vom Manager-Agent',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
      vibrationPattern: [0, 300, 150, 300, 150, 300],
      enableVibrate: true,
    }).catch(() => {});
  }
}

function truncateForPush(text: string, limit = 800): string {
  const graphemes = Array.from(text);
  if (graphemes.length <= limit) return text;
  return graphemes.slice(0, limit).join('') + '\n\n… (tap to read more)';
}

/**
 * Render a local notification for a manager reply.
 *
 * New rule: only render when the app is foregrounded AND the user is NOT on the
 * ManagerChatScreen. When the app is backgrounded, the server sends a matching
 * FCM push instead — the background handler renders via the same native module.
 * This avoids duplicate notifications.
 */
export async function notifyManagerResponse(
  text: string,
  agentName: string,
  avatarUri?: string,
  messageId?: string,
): Promise<void> {
  try {
    if (AppState.currentState !== 'active') return; // server handles it via FCM
    if (_chatScreenActive) return;                   // user is reading the reply live

    const preview = truncateForPush(text, 800);
    const title = `💬 ${agentName}`;

    if (Platform.OS === 'android' && NativeModules.AgentNotification) {
      NativeModules.AgentNotification.show(title, preview, avatarUri ?? null, messageId ?? null);
      return;
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body: preview,
        sound: 'default',
        data: { type: 'manager_reply', messageId: messageId ?? '' },
        ...(Platform.OS === 'android' ? { channelId: 'manager-responses' } : {}),
      },
      trigger: null,
    });
  } catch {
    // Permission denied or other error — silently ignore
  }
}
