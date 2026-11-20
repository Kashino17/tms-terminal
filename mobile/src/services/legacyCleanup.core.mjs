/**
 * One-time removal of what the removed classic UI left on the phone: its
 * stores (hydration tracker, orb layout, autopilot, snippets, keyword alerts,
 * browser tabs/cookies, Supabase links) and its saved logins.
 *
 * Deleting is final, so the list is explicit — exact keys and prefixes that
 * only the classic UI ever wrote. Nothing is matched by pattern guessing, and
 * scripts/legacy-cleanup.test.mjs holds every key the app still uses against
 * it.
 *
 * Plain JavaScript with injected storage, so the test runs it under node:test.
 */

/** Set once the cleanup went through; it never runs again after that. */
export const DONE_KEY = 'tms:legacy-cleanup-v1';

export const LEGACY_KEYS = [
  'tms-autopilot',
  'tms-cloud-projects',
  'tms-cloud-watch',
  'tms-hydra',
  'tms-orb-layout',
  'tms:paneGroups',
  'tms:supabase_v1',
  'tms:keyword-alerts',
  'tms:snippets',
  'tms:snippets:defaults_v1',
];

const CREDENTIALS_PREFIX = 'tms:credentials:';
const SUPABASE_TOKEN_PREFIX = 'supabase-token-';

export const LEGACY_PREFIXES = [
  'tms:browser-tabs:',
  'tms:browser-cookies:',
  CREDENTIALS_PREFIX,
  SUPABASE_TOKEN_PREFIX,
];

export function isLegacyKey(key) {
  return LEGACY_KEYS.includes(key) || LEGACY_PREFIXES.some((p) => key.startsWith(p));
}

/** Spoken replies the classic chat wrote into the cache and never removed. */
export function isLegacyCacheFile(name) {
  return /^tts_\d+\.wav$/.test(name);
}

/** The keystore has no listing — saved logins are found through the ids they were filed under. */
export function legacySecureKeys(serverIds, supabaseIds) {
  const logins = serverIds.map((id) => 'tms_credentials_' + String(id).replace(/[^a-zA-Z0-9._-]/g, '_'));
  const tokens = supabaseIds.map((id) => SUPABASE_TOKEN_PREFIX + id);
  return [...new Set([...logins, ...tokens])];
}

function supabaseIdsFrom(raw) {
  try {
    const list = JSON.parse(raw ?? '{}').connections;
    return Array.isArray(list) ? list.map((c) => c && c.id).filter((id) => typeof id === 'string' && id) : [];
  } catch {
    return [];
  }
}

/**
 * @returns what was removed, or null when the cleanup had already run.
 * A step that fails leaves DONE_KEY unset, so the next app start tries again.
 */
export async function runLegacyCleanup(deps) {
  if (await deps.getItem(DONE_KEY)) return null;

  const keys = await deps.getAllKeys();
  const legacy = keys.filter(isLegacyKey);

  const serverIds = [
    ...(await deps.serverIds()),
    ...legacy.filter((k) => k.startsWith(CREDENTIALS_PREFIX)).map((k) => k.slice(CREDENTIALS_PREFIX.length)),
  ];
  const supabaseIds = [
    ...supabaseIdsFrom(await deps.getItem('tms:supabase_v1')),
    ...legacy.filter((k) => k.startsWith(SUPABASE_TOKEN_PREFIX)).map((k) => k.slice(SUPABASE_TOKEN_PREFIX.length)),
  ];
  const secure = legacySecureKeys(serverIds, supabaseIds);

  // The keystore first: its ids are read from the entries removed right after.
  for (const key of secure) await deps.deleteSecure(key);
  if (legacy.length) await deps.multiRemove(legacy);

  const files = (await deps.cacheFiles()).filter(isLegacyCacheFile);
  for (const name of files) await deps.deleteCacheFile(name);

  await deps.setItem(DONE_KEY, '1');
  return { keys: legacy, secure, files };
}
