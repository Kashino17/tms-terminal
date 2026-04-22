import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoiceSessionController } from '../src/manager/voice.controller';
import type { VoiceEmitter } from '../src/manager/voice.types';

// Minimal mocks; real integration is covered in manual testing later.
const mockRegistry = {
  getActive: () => ({
    id: 'mock',
    chatStream: vi.fn(async (_msgs, _sys, onChunk) => {
      onChunk('Hallo.');
      return 'Hallo.';
    }),
  }),
} as any;

const mockWhisper = { transcribe: vi.fn(async () => 'User text') } as any;
const mockTts = {
  synthesizeChunked: vi.fn(async (text: string, onChunk: Function) => {
    onChunk({ idx: 0, sentence: text, audio: Buffer.from('fake-wav') });
  }),
} as any;

describe('VoiceSessionController', () => {
  let emitted: any[];
  let emit: VoiceEmitter;

  beforeEach(() => {
    emitted = [];
    emit = (msg) => emitted.push(msg);
  });

  it('emits phase transitions idle → listening on start', async () => {
    const ctrl = new VoiceSessionController({
      registry: mockRegistry, whisper: mockWhisper, tts: mockTts, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    expect(emitted.some((m) => m.type === 'voice:phase' && m.payload.phase === 'listening')).toBe(true);
  });

  it('runs full turn: listening → transcribing → thinking → speaking → listening', async () => {
    const ctrl = new VoiceSessionController({
      registry: mockRegistry, whisper: mockWhisper, tts: mockTts, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    ctrl.ingestAudio(Buffer.from('fake-audio'));
    await ctrl.endUserTurn();
    const phases = emitted
      .filter((m) => m.type === 'voice:phase')
      .map((m) => m.payload.phase);
    expect(phases).toEqual(['listening', 'transcribing', 'thinking', 'speaking', 'listening']);
  });

  it('emits a tts_chunk with audio for each sentence', async () => {
    const ctrl = new VoiceSessionController({
      registry: mockRegistry, whisper: mockWhisper, tts: mockTts, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    ctrl.ingestAudio(Buffer.from('fake-audio'));
    await ctrl.endUserTurn();
    const ttsChunks = emitted.filter((m) => m.type === 'voice:tts_chunk');
    expect(ttsChunks.length).toBeGreaterThanOrEqual(1);
    expect(ttsChunks[ttsChunks.length - 1].payload.isLast).toBe(true);
  });

  it('stops gracefully', () => {
    const ctrl = new VoiceSessionController({
      registry: mockRegistry, whisper: mockWhisper, tts: mockTts, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    ctrl.stop();
    expect(emitted.some((m) => m.type === 'voice:phase' && m.payload.phase === 'idle')).toBe(true);
  });
});
