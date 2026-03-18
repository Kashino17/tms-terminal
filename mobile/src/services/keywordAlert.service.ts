import { Platform, Vibration } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { stripAnsi } from '../utils/stripAnsi';

// ── Alert Categories ─────────────────────────────────────────────────────────
export type AlertCategory = 'error' | 'warning' | 'success' | 'custom';

export interface KeywordRule {
  id: string;
  keyword: string;
  category: AlertCategory;
  enabled: boolean;
}

export interface AlertConfig {
  enabled: boolean;
  rules: KeywordRule[];
}

const STORAGE_KEY = 'tms:keyword-alerts';

// ── Default Rules ────────────────────────────────────────────────────────────
const DEFAULT_RULES: KeywordRule[] = [
  // Error patterns
  { id: 'e1', keyword: 'error',     category: 'error',   enabled: true },
  { id: 'e2', keyword: 'failed',    category: 'error',   enabled: true },
  { id: 'e3', keyword: 'fatal',     category: 'error',   enabled: true },
  { id: 'e4', keyword: 'crash',     category: 'error',   enabled: true },
  { id: 'e5', keyword: 'exception', category: 'error',   enabled: true },
  { id: 'e6', keyword: 'panic',     category: 'error',   enabled: true },
  { id: 'e7', keyword: 'ECONNREFUSED', category: 'error', enabled: true },
  { id: 'e8', keyword: 'segfault',  category: 'error',   enabled: true },
  // Warning patterns
  { id: 'w1', keyword: 'warning',    category: 'warning', enabled: true },
  { id: 'w2', keyword: 'deprecated', category: 'warning', enabled: true },
  { id: 'w3', keyword: 'timeout',    category: 'warning', enabled: true },
  // Success patterns
  { id: 's1', keyword: 'done',      category: 'success', enabled: true },
  { id: 's2', keyword: 'completed', category: 'success', enabled: true },
  { id: 's3', keyword: 'passed',    category: 'success', enabled: true },
  { id: 's4', keyword: 'success',   category: 'success', enabled: true },
  { id: 's5', keyword: 'ready',     category: 'success', enabled: true },
  { id: 's6', keyword: 'built in',  category: 'success', enabled: true },
  { id: 's7', keyword: 'compiled successfully', category: 'success', enabled: true },
];

// ── Vibration Patterns (Android: [pause, vibrate, pause, vibrate, ...]) ─────
// Each pattern is designed to be distinguishable by feel alone.
const VIBRATION_PATTERNS: Record<AlertCategory, number[]> = {
  // Error: SOS-like urgent triple pulse — ··· ——— ···
  error:   [0, 100, 80, 100, 80, 100, 200, 300, 80, 300, 80, 300, 200, 100, 80, 100, 80, 100],
  // Warning: Two medium pulses with gap
  warning: [0, 200, 150, 200],
  // Success: Single satisfying long buzz
  success: [0, 400],
  // Custom: Triple quick taps
  custom:  [0, 80, 60, 80, 60, 80],
};

// ── Haptic Patterns for iOS (Haptics API, no custom vibration patterns) ─────
const HAPTIC_SEQUENCES: Record<AlertCategory, () => Promise<void>> = {
  error: async () => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    await sleep(150);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    await sleep(150);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  },
  warning: async () => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    await sleep(200);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  },
  success: async () => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  },
  custom: async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await sleep(100);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await sleep(100);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Sound Frequencies (generate distinct tones via expo-av) ──────────────────
// Since we can't bundle audio files easily, we use Notifications for sound.
// Android notification channels handle the distinct sounds per category.
const CATEGORY_INFO: Record<AlertCategory, { title: string; icon: string; channelName: string }> = {
  error:   { title: 'Error Detected',   icon: '🔴', channelName: 'Terminal Errors' },
  warning: { title: 'Warning',          icon: '⚠️', channelName: 'Terminal Warnings' },
  success: { title: 'Task Completed',   icon: '✅', channelName: 'Terminal Success' },
  custom:  { title: 'Keyword Match',    icon: '📌', channelName: 'Terminal Alerts' },
};

// ── Service ──────────────────────────────────────────────────────────────────
class KeywordAlertService {
  private config: AlertConfig = { enabled: true, rules: [] };
  private loaded = false;
  private lastAlertTime = 0;
  private cooldownMs = 3000; // Minimum 3s between alerts to prevent spam

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        this.config = JSON.parse(raw);
      } else {
        // First run — use defaults
        this.config = { enabled: true, rules: DEFAULT_RULES };
        await this.persist();
      }
    } catch {
      this.config = { enabled: true, rules: DEFAULT_RULES };
    }
    this.loaded = true;

    // Set up notification channels (Android)
    if (Platform.OS === 'android') {
      await this.setupAndroidChannels();
    }
  }

  private async setupAndroidChannels(): Promise<void> {
    // Each category gets its own channel with distinct vibration
    for (const [category, info] of Object.entries(CATEGORY_INFO)) {
      await Notifications.setNotificationChannelAsync(`terminal-${category}`, {
        name: info.channelName,
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: VIBRATION_PATTERNS[category as AlertCategory],
        enableVibrate: true,
        sound: 'default',
      });
    }
  }

  getConfig(): AlertConfig {
    return this.config;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.persist();
  }

  getRules(): KeywordRule[] {
    return this.config.rules;
  }

  addRule(keyword: string, category: AlertCategory): void {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    this.config.rules.push({ id, keyword: keyword.toLowerCase(), category, enabled: true });
    this.persist();
  }

  removeRule(id: string): void {
    this.config.rules = this.config.rules.filter((r) => r.id !== id);
    this.persist();
  }

  toggleRule(id: string): void {
    this.config.rules = this.config.rules.map((r) =>
      r.id === id ? { ...r, enabled: !r.enabled } : r,
    );
    this.persist();
  }

  private async persist(): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
  }

  // ── Core: scan terminal output for keyword matches ─────────────────────────
  scan(rawData: string): void {
    if (!this.config.enabled || !this.loaded) return;

    // Rate limit — don't spam alerts
    const now = Date.now();
    if (now - this.lastAlertTime < this.cooldownMs) return;

    // Strip ANSI escape codes
    const clean = stripAnsi(rawData).toLowerCase();
    // Only scan last 500 chars of the chunk to avoid false positives on large output
    const tail = clean.slice(-500);

    // Check enabled rules
    for (const rule of this.config.rules) {
      if (!rule.enabled) continue;
      if (tail.includes(rule.keyword.toLowerCase())) {
        this.lastAlertTime = now;
        this.triggerAlert(rule);
        return; // One alert per output chunk max
      }
    }
  }

  // ── Trigger vibration + notification ───────────────────────────────────────
  private async triggerAlert(rule: KeywordRule): Promise<void> {
    const info = CATEGORY_INFO[rule.category];

    // 1. Vibration (platform-specific pattern)
    if (Platform.OS === 'android') {
      Vibration.vibrate(VIBRATION_PATTERNS[rule.category]);
    } else {
      // iOS: use Haptics sequence (fire-and-forget, suppress errors on unsupported devices)
      HAPTIC_SEQUENCES[rule.category]?.().catch(() => {});
    }

    // 2. Local notification with sound (works in foreground + background)
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `${info.title}`,
        body: `"${rule.keyword}" detected in terminal output`,
        sound: true,
      },
      trigger: null, // Immediate
    });
  }
}

export const keywordAlertService = new KeywordAlertService();
