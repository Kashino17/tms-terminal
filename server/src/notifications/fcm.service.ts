import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { logger } from '../utils/logger';

// Service account JSON must be placed at this path by the user.
// Download it from Firebase Console → Project Settings → Service accounts → Generate new private key.
const SERVICE_ACCOUNT_PATH = path.join(os.homedir(), '.tms-terminal', 'firebase-service-account.json');

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
    if (!this.ready || !this.admin) return;

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
}

export const fcmService = new FcmService();
