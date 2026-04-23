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

  it('discards transcription arriving within 800ms after last tts chunk', async () => {
    const ctrl = new VoiceSessionController({
      registry: mockRegistry, whisper: mockWhisper, tts: mockTts, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    ctrl.ingestAudio(Buffer.from('fake-audio'));
    await ctrl.endUserTurn(); // runs full turn, last tts_chunk emits, phase → listening
    emitted.length = 0;

    // Immediately ingest new audio and end turn — transcription should be suppressed
    ctrl.ingestAudio(Buffer.from('echo-bleed'));
    await ctrl.endUserTurn();

    const transcripts = emitted.filter((m) => m.type === 'voice:transcript');
    expect(transcripts.length).toBe(0);
  });

  it('emits voice:error after 3 echo suppressions within 60 seconds', async () => {
    const ctrl = new VoiceSessionController({
      registry: mockRegistry, whisper: mockWhisper, tts: mockTts, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    ctrl.ingestAudio(Buffer.from('a'));
    await ctrl.endUserTurn(); // primes lastTtsChunkAt

    // Three consecutive suppressions
    for (let i = 0; i < 3; i++) {
      ctrl.ingestAudio(Buffer.from('echo'));
      await ctrl.endUserTurn();
    }

    const errs = emitted.filter(
      (m) => m.type === 'voice:error' && m.payload.message.includes('Kopfhörer'),
    );
    expect(errs.length).toBe(1);
    expect(errs[0].payload.recoverable).toBe(true);
  });

  it('extracts [Ton: ...] tag from the stream and forwards it to TTS', async () => {
    const taggedRegistry = {
      getActive: () => ({
        id: 'mock',
        chatStream: vi.fn(async (_msgs, _sys, onChunk) => {
          // Simulate a response that begins with the voice-mode emotion tag.
          onChunk('[Ton: warm-freudig]\n');
          onChunk('Hallo, das hat geklappt.');
          return '[Ton: warm-freudig]\nHallo, das hat geklappt.';
        }),
      }),
    } as any;
    const ttsSpy = vi.fn(async (_text: string, onChunk: Function, _emotion?: string) => {
      onChunk({ idx: 0, sentence: 'Hallo, das hat geklappt.', audio: Buffer.from('fake') });
    });
    const ctrl = new VoiceSessionController({
      registry: taggedRegistry, whisper: mockWhisper,
      tts: { synthesizeChunked: ttsSpy } as any, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    ctrl.ingestAudio(Buffer.from('fake-audio'));
    await ctrl.endUserTurn();

    // voice:ai_delta must NOT carry the raw tag
    const deltas = emitted
      .filter((m) => m.type === 'voice:ai_delta')
      .map((m) => m.payload.text)
      .join('');
    expect(deltas).not.toContain('[Ton:');
    expect(deltas).toContain('Hallo');

    // TTS synthesizeChunked must be called with the extracted emotion
    expect(ttsSpy).toHaveBeenCalledTimes(1);
    expect(ttsSpy.mock.calls[0][2]).toBe('warm-freudig');
  });

  it('falls back gracefully when the LLM forgets the [Ton: ...] tag', async () => {
    const untaggedRegistry = {
      getActive: () => ({
        id: 'mock',
        chatStream: vi.fn(async (_msgs, _sys, onChunk) => {
          onChunk('Einfach nur Text ohne Tag.');
          return 'Einfach nur Text ohne Tag.';
        }),
      }),
    } as any;
    const ttsSpy = vi.fn(async (_text: string, onChunk: Function, _emotion?: string) => {
      onChunk({ idx: 0, sentence: 'Einfach nur Text ohne Tag.', audio: Buffer.from('fake') });
    });
    const ctrl = new VoiceSessionController({
      registry: untaggedRegistry, whisper: mockWhisper,
      tts: { synthesizeChunked: ttsSpy } as any, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    ctrl.ingestAudio(Buffer.from('fake-audio'));
    await ctrl.endUserTurn();

    const deltas = emitted
      .filter((m) => m.type === 'voice:ai_delta')
      .map((m) => m.payload.text)
      .join('');
    expect(deltas).toContain('Einfach nur Text ohne Tag.');

    expect(ttsSpy).toHaveBeenCalledTimes(1);
    // No tag present → emotion is falsy (empty string or undefined)
    expect(ttsSpy.mock.calls[0][2] || '').toBe('');
  });

  it('does not emit echo warning twice in the same 60s window', async () => {
    const ctrl = new VoiceSessionController({
      registry: mockRegistry, whisper: mockWhisper, tts: mockTts, emit,
      systemPrompt: 'test',
    });
    ctrl.start();
    ctrl.ingestAudio(Buffer.from('a'));
    await ctrl.endUserTurn();

    // Six consecutive suppressions — still only one warning expected
    for (let i = 0; i < 6; i++) {
      ctrl.ingestAudio(Buffer.from('echo'));
      await ctrl.endUserTurn();
    }

    const errs = emitted.filter(
      (m) => m.type === 'voice:error' && m.payload.message.includes('Kopfhörer'),
    );
    expect(errs.length).toBe(1);
  });
});
