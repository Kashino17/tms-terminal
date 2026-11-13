/** Typen für clipboard.core.mjs (siehe dort). */
export interface Clip { id: string; text: string; src: string; at: number; pinned: boolean }
export declare const CLIP_LIMIT: number;
export declare function addClip(list: Clip[], entry: { text: string; src: string; at: number }): Clip[];
export declare function togglePin(list: Clip[], id: string): Clip[];
export declare function removeClip(list: Clip[], id: string): Clip[];
export declare function clearUnpinned(list: Clip[]): Clip[];
