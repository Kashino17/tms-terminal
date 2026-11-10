/** Typen für queue.core.mjs (siehe dort). */
export interface SpeechPiece { seq: number; index: number; first: boolean; last: boolean; audio: string }
export interface SpeechPlayer { play(onEnd: () => void): void; unload(): void }
export interface SpeechQueue { push(chunk: SpeechPiece): void; stop(): void; readonly stopped: boolean }
export declare function createSpeechQueue(deps: {
  load: (chunk: SpeechPiece) => Promise<SpeechPlayer>;
  onPart: (index: number) => void;
  onPlayed: (seq: number) => void;
  onDone: () => void;
  onError: (message: string) => void;
}): SpeechQueue;
