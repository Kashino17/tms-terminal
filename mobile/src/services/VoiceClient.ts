/**
 * VoiceClient — thin wrapper over WebSocketService that handles voice:* messages.
 *
 * Usage:
 *   const ws = getConnection(serverId);
 *   const client = new VoiceClient(ws, handlers);
 *   client.subscribe();
 *   // ... use client.start(), client.sendAudioChunk(), etc.
 *   client.dispose(); // call on unmount
 */

import { WebSocketService } from './websocket.service';

export type VoicePhase =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'tool_call'
  | 'speaking'
  | 'paused';

export interface VoiceClientHandlers {
  onPhase: (phase: VoicePhase) => void;
  onTranscript: (text: string, final: boolean) => void;
  onAiDelta: (text: string) => void;
  onTtsChunk: (chunkIdx: number, audioBase64: string, sentence: string, isLast: boolean) => void;
  onAckAudio: (kind: 'pause' | 'resume', audioBase64: string) => void;
  onError: (message: string, recoverable: boolean) => void;
}

export class VoiceClient {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private ws: WebSocketService,
    private handlers: VoiceClientHandlers,
  ) {}

  /** Start listening for voice:* inbound messages. Call once after construction. */
  subscribe(): void {
    this.unsubscribe = this.ws.addMessageListener((msg: unknown) => {
      const m = msg as { type?: string; payload?: any };
      switch (m?.type) {
        case 'voice:phase':
          this.handlers.onPhase(m.payload.phase as VoicePhase);
          break;
        case 'voice:transcript':
          this.handlers.onTranscript(m.payload.text as string, m.payload.final as boolean);
          break;
        case 'voice:ai_delta':
          this.handlers.onAiDelta(m.payload.text as string);
          break;
        case 'voice:tts_chunk':
          this.handlers.onTtsChunk(
            m.payload.chunkIdx as number,
            m.payload.audio as string,
            m.payload.sentence as string,
            m.payload.isLast as boolean,
          );
          break;
        case 'voice:ack_audio':
          this.handlers.onAckAudio(m.payload.kind as 'pause' | 'resume', m.payload.audio as string);
          break;
        case 'voice:error':
          this.handlers.onError(m.payload.message as string, m.payload.recoverable as boolean);
          break;
      }
    });
  }

  /** Remove the message listener. Call on component unmount. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // ── Outbound commands ────────────────────────────────────────────────

  /** Begin a voice session. */
  start(): void {
    this.ws.send({ type: 'voice:start', payload: {} });
  }

  /** Stop the active voice session entirely. */
  stop(): void {
    this.ws.send({ type: 'voice:stop', payload: {} });
  }

  /** Send a raw audio chunk (base64-encoded PCM/opus). */
  sendAudioChunk(audioBase64: string): void {
    this.ws.send({ type: 'voice:audio_chunk', payload: { audio: audioBase64 } });
  }

  /** Signal end of user speech turn (VAD off / button release). */
  endTurn(): void {
    this.ws.send({ type: 'voice:end_turn', payload: {} });
  }

  /** Pause TTS playback on the server side. */
  pause(): void {
    this.ws.send({ type: 'voice:pause', payload: {} });
  }

  /**
   * Resume TTS playback.
   * @param strategy 'clean' — resume from start of next sentence;
   *                 'with_interjection' — resume mid-sentence with a bridge phrase.
   */
  resume(strategy: 'clean' | 'with_interjection' = 'clean'): void {
    this.ws.send({ type: 'voice:resume', payload: { strategy } });
  }

  /** Cancel the current AI turn (discard in-flight TTS). */
  cancel(): void {
    this.ws.send({ type: 'voice:cancel', payload: {} });
  }
}
