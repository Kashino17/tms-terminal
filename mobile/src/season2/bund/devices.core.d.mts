/** Typen für devices.core.mjs (siehe dort). */
export interface BundDevice { id: string; online: boolean; caps: string[] }
export declare function deviceColor(index: number): string;
export declare function deviceForSession(sessionServer: Record<string, string>, sessionId: string | null | undefined, devices: BundDevice[]): string | null;
export declare function activeDeviceId(activeSessionId: string | null | undefined, sessionServer: Record<string, string>, devices: BundDevice[]): string | null;
export declare function dictationDeviceId(devices: BundDevice[]): string | null;
export declare function speechDeviceId(devices: BundDevice[]): string | null;
