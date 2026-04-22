/** Internal types used by VoiceSessionController. Not exported over WS. */

export type VoicePhase =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'tool_call'
  | 'speaking'
  | 'paused';

export interface TtsChunk {
  idx: number;                  // Sentence index within the current turn
  sentence: string;             // Source text
  audio: Buffer;                // WAV audio buffer
  sent: boolean;                // Has this been transmitted to client?
}

export interface PauseState {
  resumeCursor: number;         // First un-played chunk index
  remainingText: string;        // Unspoken AI text
  interjection?: string;        // User input during pause (sub-behavior c)
  pausedAt: number;             // Timestamp for auto-timeout
}

export type VoiceEmitter = (msg:
  | { type: 'voice:phase'; payload: { phase: VoicePhase } }
  | { type: 'voice:transcript'; payload: { text: string; final: boolean } }
  | { type: 'voice:ai_delta'; payload: { text: string } }
  | { type: 'voice:tts_chunk'; payload: { chunkIdx: number; audio: string; sentence: string; isLast: boolean } }
  | { type: 'voice:ack_audio'; payload: { kind: 'pause' | 'resume'; audio: string } }
  | { type: 'voice:error'; payload: { message: string; recoverable: boolean } }
) => void;
