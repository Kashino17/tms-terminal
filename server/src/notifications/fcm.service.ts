import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { logger } from '../utils/logger';

// Service account JSON must be placed at this path by the user.
// Download it from Firebase Console → Project Settings → Service accounts → Generate new private key.
const SERVICE_ACCOUNT_PATH = path.join(os.homedir(), '.tms-terminal', 'firebase-service-account.json');

const TRUNCATE_SUFFIX = '\n\n… (tap to read more)';

export function truncateForPush(text: string, limit: number): { text: string; truncated: boolean } {
  const graphemes = Array.from(text);
  if (graphemes.length <= limit) return { text, truncated: false };
  const truncated = graphemes.slice(0, limit).join('') + TRUNCATE_SUFFIX;
  return { text: truncated, truncated: true };
}

export function stripMarkdownForPush(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

class FcmService {
  private admin: typeof import('firebase-admin') | null = null;
  private ready = false;

  init(): void {
    if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
      logger.warn(
        `FCM: Service account not found at ${SERVICE_ACCOUNT_PATH}\n` +
        '  → Push notifications disabled. See README for setup instructions.',
      );
      return;
    }

    try {
      // Tighten file permissions on the service account JSON (no-op on Windows)
      try { fs.chmodSync(SERVICE_ACCOUNT_PATH, 0o600); } catch { /* ignore on platforms that don't support chmod */ }

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.admin = require('firebase-admin') as typeof import('firebase-admin');
      const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8'));
      this.admin.initializeApp({ credential: this.admin.credential.cert(serviceAccount) });
      this.ready = true;
      logger.success('FCM: Push notifications enabled ✓');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`FCM: Initialization failed — ${msg}`);
    }
  }

  async send(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    if (!this.ready || !this.admin) {
      logger.warn(`FCM: not ready (ready=${this.ready}, admin=${!!this.admin})`);
      return;
    }
    logger.info(`FCM: attempting send to ${token.slice(0, 20)}... — "${body.slice(0, 60)}"`);

    try {
      const result = await this.admin.messaging().send({
        token,
        notification: { title, body },
        data,
        android: {
          priority: 'high',
          notification: {
            priority: 'max',
            defaultSound: true,
            // No custom channelId — Firebase SDK auto-creates 'fcm_fallback_notification_channel'.
            // Custom channels require the app to register them via NotificationManager first.
          },
        },
      });
      logger.success(`FCM: Notification sent ✓ (${result})`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Token might be stale — log as warning, not error
      logger.warn(`FCM: Send failed — ${msg}`);
    }
  }

  /**
   * Send a data-only FCM message for Big-Style rendering on the mobile client.
   * Body is truncated to 800 grapheme-count chars. Title is unchanged.
   * data payload MUST include the full `text` field so the client can render.
   */
  async sendBig(
    token: string,
    title: string,
    body: string,
    data: Record<string, string>,
  ): Promise<void> {
    if (!this.ready || !this.admin) {
      logger.warn(`FCM: sendBig not ready (ready=${this.ready}, admin=${!!this.admin})`);
      return;
    }
    const { text: truncatedBody } = truncateForPush(body, 800);
    logger.info(`FCM sendBig: to ${token.slice(0, 20)}… — "${truncatedBody.slice(0, 60)}" (${truncatedBody.length} chars)`);

    try {
      // Data-only payload. Client renders via native module (Android) or expo-notifications (iOS).
      const result = await this.admin.messaging().send({
        token,
        data: {
          ...data,
          title,
          body: truncatedBody,
        },
        android: {
          priority: 'high', // required for data-only to wake the app reliably
        },
      });
      logger.success(`FCM sendBig: ✓ (${result})`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`FCM sendBig: failed — ${msg}`);
      throw err; // re-throw so callers can delete stale tokens
    }
  }
}

export const fcmService = new FcmService();
