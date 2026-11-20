export const CHECK_EVERY_MS: number;
export const RESUME_GAP_MS: number;
export function shouldCheck(now: number, lastCheck: number, minGapMs: number): boolean;
export function shouldReport(now: number, lastSent: number, received: number, total: number): boolean;
export function apkFileName(version: string): string;
