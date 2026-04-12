import { Audio } from 'expo-av';
import { NativeModules, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { AdhanModule } = NativeModules;

export interface AdhanOption {
  id: string;
  name: string;
  reciter: string;
  source: any; // require() asset
}

export const ADHAN_OPTIONS: AdhanOption[] = [
  {
    id: 'mishary',
    name: 'Mishary Rashid Alafasy',
    reciter: 'Mishary Rashid Alafasy',
    source: require('../../assets/adhan/mishary_alafasy.mp3'),
  },
  {
    id: 'nafees',
    name: 'Ahmad al-Nafees',
    reciter: 'Ahmad al-Nafees',
    source: require('../../assets/adhan/ahmad_nafees.mp3'),
  },
  {
    id: 'mansour',
    name: 'Mansour Al-Zahrani',
    reciter: 'Mansour Al-Zahrani',
    source: require('../../assets/adhan/mansour_zahrani.mp3'),
  },
];

const STORAGE_KEY = 'tms-adhan-selected';
const ENABLED_KEY = 'tms-adhan-enabled';
const FAJR_WECKER_KEY = 'tms-fajr-wecker';

let currentSound: Audio.Sound | null = null;

/** Get selected adhan ID from storage */
export async function getSelectedAdhan(): Promise<string> {
  try {
    const val = await AsyncStorage.getItem(STORAGE_KEY);
    return val ?? 'mishary';
  } catch { return 'mishary'; }
}

/** Save selected adhan ID */
export async function setSelectedAdhan(id: string): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, id);
}

/** Get adhan notifications enabled */
export async function getAdhanEnabled(): Promise<boolean> {
  try {
    const val = await AsyncStorage.getItem(ENABLED_KEY);
    return val !== 'false'; // default true
  } catch { return true; }
}

/** Set adhan notifications enabled */
export async function setAdhanEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false');
}

/** Get Fajr Wecker mode (auto-loud alarm) */
export async function getFajrWecker(): Promise<boolean> {
  try {
    const val = await AsyncStorage.getItem(FAJR_WECKER_KEY);
    return val === 'true';
  } catch { return false; }
}

/** Set Fajr Wecker mode */
export async function setFajrWecker(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(FAJR_WECKER_KEY, enabled ? 'true' : 'false');
}

/** Play the selected adhan sound */
export async function playAdhan(adhanId?: string, onComplete?: () => void): Promise<void> {
  try {
    await stopAdhan(); // Stop any currently playing
    const id = adhanId ?? await getSelectedAdhan();
    const option = ADHAN_OPTIONS.find(o => o.id === id) ?? ADHAN_OPTIONS[0];

    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
    });

    const { sound } = await Audio.Sound.createAsync(option.source, { shouldPlay: true, volume: 1.0 });
    currentSound = sound;

    // Auto-cleanup when done
    sound.setOnPlaybackStatusUpdate((status) => {
      if (status.isLoaded && status.didJustFinish) {
        sound.unloadAsync().catch(() => {});
        currentSound = null;
        onComplete?.();
      }
    });
  } catch (err) {
    console.warn('[adhan] play error:', err);
  }
}

/** Stop currently playing adhan */
export async function stopAdhan(): Promise<void> {
  if (currentSound) {
    try {
      await currentSound.stopAsync();
      await currentSound.unloadAsync();
    } catch {}
    currentSound = null;
  }
}

/** Preview an adhan (play first 10 seconds) */
export async function previewAdhan(adhanId: string): Promise<void> {
  try {
    await stopAdhan();
    const option = ADHAN_OPTIONS.find(o => o.id === adhanId) ?? ADHAN_OPTIONS[0];

    await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
    const { sound } = await Audio.Sound.createAsync(option.source, { shouldPlay: true, volume: 1.0 });
    currentSound = sound;

    // Stop after 10 seconds
    setTimeout(async () => {
      if (currentSound === sound) {
        await stopAdhan();
      }
    }, 10000);
  } catch (err) {
    console.warn('[adhan] preview error:', err);
  }
}

// ── Notification Setup ──────────────────────────────────────────────────────

/** Setup notification channel for adhan (Android: max priority, full-screen intent) */
export async function setupAdhanNotificationChannel(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('adhan', {
      name: 'Gebetsruf (Azān)',
      description: 'Vollbild-Benachrichtigung bei Gebetszeit',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 800, 400, 800, 400, 800, 400, 800],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
      enableLights: true,
      lightColor: '#10B981',
      sound: undefined,
    });
  }

  // Foreground: suppress system notification, show our custom UI instead
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const isAdhan = notification.request.content.data?.type === 'adhan';
      return {
        shouldShowAlert: !isAdhan, // Don't show system alert for adhan (we show our own UI)
        shouldPlaySound: false,
        shouldSetBadge: false,
        priority: Notifications.AndroidNotificationPriority.MAX,
      };
    },
  });
}

/** Schedule a fullscreen adhan alarm after `delaySec` seconds.
 *  On Android: uses native AlarmManager + fullscreen Activity (appears over lockscreen).
 *  On iOS: falls back to expo-notifications. */
export async function scheduleTestAdhan(
  prayerName: string,
  prayerTime: string,
  prayerArabic: string,
  delaySec: number = 10,
  isWecker: boolean = false,
): Promise<string> {
  if (Platform.OS === 'android' && AdhanModule) {
    try {
      const id = await AdhanModule.scheduleAlarm(delaySec, prayerName, prayerTime, prayerArabic, isWecker);
      return String(id);
    } catch (err) {
      console.warn('[adhan] native alarm failed, falling back:', err);
    }
  }

  // Fallback: expo-notifications
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return '';

  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: `🕌 Gebetszeit: ${prayerName}`,
      body: `${prayerArabic} — ${prayerTime}`,
      data: { type: 'adhan', prayerName, prayerTime, prayerArabic, isWecker },
      ...(Platform.OS === 'android' ? { channelId: 'adhan', priority: 'max' } : {}),
    },
    trigger: { seconds: delaySec },
  });
  return id;
}

/** Schedule adhan for a specific prayer time today */
export async function scheduleAdhanForPrayer(
  prayerName: string,
  prayerTime: string,
  prayerArabic: string,
): Promise<string | null> {
  const enabled = await getAdhanEnabled();
  if (!enabled) return null;

  const [h, m] = prayerTime.split(':').map(Number);
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
  const diffSec = Math.floor((target.getTime() - now.getTime()) / 1000);

  if (diffSec <= 0) return null; // Already passed

  const wecker = prayerName === 'Fajr' ? await getFajrWecker() : false;
  return scheduleTestAdhan(prayerName, prayerTime, prayerArabic, diffSec, wecker);
}

/** Cancel all scheduled adhan alarms/notifications */
export async function cancelAllAdhanNotifications(): Promise<void> {
  if (Platform.OS === 'android' && AdhanModule) {
    try { await AdhanModule.cancelAllAlarms(); } catch {}
  }
  await Notifications.cancelAllScheduledNotificationsAsync();
}
