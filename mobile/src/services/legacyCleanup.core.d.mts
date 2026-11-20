/**
 * Typen fuer legacyCleanup.core.mjs (JavaScript, damit
 * scripts/legacy-cleanup.test.mjs es unter node:test ausfuehren kann).
 */
export declare const DONE_KEY: string;
export declare const LEGACY_KEYS: string[];
export declare const LEGACY_PREFIXES: string[];

export declare function isLegacyKey(key: string): boolean;
export declare function isLegacyCacheFile(name: string): boolean;
export declare function legacySecureKeys(serverIds: string[], supabaseIds: string[]): string[];

export interface LegacyCleanupDeps {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiRemove(keys: string[]): Promise<void>;
  deleteSecure(key: string): Promise<void>;
  /** Ids of the saved servers — saved logins were filed under them. */
  serverIds(): Promise<string[]>;
  cacheFiles(): Promise<string[]>;
  deleteCacheFile(name: string): Promise<void>;
}

export declare function runLegacyCleanup(
  deps: LegacyCleanupDeps,
): Promise<{ keys: string[]; secure: string[]; files: string[] } | null>;
