/** Typen für rtt.core.mjs (siehe dort). */
export declare class RttWindow {
  constructor(size?: number);
  push(ms: number): void;
  median(): number | undefined;
}
