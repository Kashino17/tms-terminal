import { useEffect, useRef } from 'react';
import CookieManager from '@react-native-cookies/cookies';
import AsyncStorage from '@react-native-async-storage/async-storage';

const COOKIE_STORAGE_PREFIX = 'tms:browser-cookies:';

/**
 * Isolates cookies per terminal browser session.
 *
 * Android's CookieManager is a process-wide singleton — every WebView shares
 * the same cookie jar. This hook works around that by saving / restoring
 * cookies keyed by `browserKey` (serverId:terminalTabId) on mount / unmount.
 *
 * Flow:
 *  1. Mount  → clearAll → restore this terminal's saved cookies
 *  2. Unmount → save current cookies → clearAll (clean for next terminal)
 *
 * @param browserKey  Unique key per terminal browser (`${serverId}:${terminalTabId}`)
 * @param isActive    Only run isolation when the browser is actually visible
 */
export function useCookieIsolation(browserKey: string, isActive: boolean) {
  const prevKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isActive) return;

    let cancelled = false;

    const restore = async () => {
      try {
        // Save outgoing terminal's cookies before clearing (if switching terminals)
        if (prevKeyRef.current && prevKeyRef.current !== browserKey) {
          const outgoing = await CookieManager.getAll();
          if (Object.keys(outgoing).length > 0) {
            await AsyncStorage.setItem(
              COOKIE_STORAGE_PREFIX + prevKeyRef.current,
              JSON.stringify(outgoing),
            );
          }
        }

        // Clear the shared cookie jar
        await CookieManager.clearAll();

        if (cancelled) return;

        // Restore saved cookies for this terminal
        const raw = await AsyncStorage.getItem(COOKIE_STORAGE_PREFIX + browserKey);
        if (raw) {
          const saved = JSON.parse(raw) as Record<string, Record<string, CookieEntry>>;
          for (const [domain, cookies] of Object.entries(saved)) {
            for (const [name, cookie] of Object.entries(cookies)) {
              if (cancelled) return;
              try {
                await CookieManager.set(`http://${domain}`, {
                  name,
                  value: cookie.value,
                  domain: cookie.domain || domain,
                  path: cookie.path || '/',
                  ...(cookie.expires ? { expires: cookie.expires } : {}),
                  ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
                  ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
                });
              } catch {
                // Skip individual cookie errors
              }
            }
          }
        }
      } catch {
        // Best-effort — don't crash the browser
      }
      prevKeyRef.current = browserKey;
    };

    restore();

    // Cleanup: save cookies when unmounting or switching terminals
    return () => {
      cancelled = true;
      saveCookies(browserKey);
    };
  }, [browserKey, isActive]);
}

/** Save current cookies to AsyncStorage for a given browserKey. */
async function saveCookies(browserKey: string) {
  try {
    const all = await CookieManager.getAll();
    if (Object.keys(all).length > 0) {
      await AsyncStorage.setItem(
        COOKIE_STORAGE_PREFIX + browserKey,
        JSON.stringify(all),
      );
    }
    // Clear after saving so the next terminal starts clean
    await CookieManager.clearAll();
  } catch {
    // Best-effort
  }
}

/** Delete saved cookies for a browser profile (call when terminal tab is closed). */
export async function clearSavedCookies(browserKey: string) {
  try {
    await AsyncStorage.removeItem(COOKIE_STORAGE_PREFIX + browserKey);
  } catch {
    // Best-effort
  }
}

// Type matching CookieManager.getAll() response shape
interface CookieEntry {
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
}
