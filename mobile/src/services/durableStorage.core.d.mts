/**
 * Typen fuer durableStorage.core.mjs (JavaScript, damit
 * scripts/durable-storage.test.mjs es unter node:test ausfuehren kann).
 */
export interface DurablePrimary {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface DurableMirror {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export declare function createDurableStorage(primary: DurablePrimary, mirror: DurableMirror): DurablePrimary;
