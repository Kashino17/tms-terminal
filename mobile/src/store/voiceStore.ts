import { create } from 'zustand';

export type VoicePhase =
  | 'idle' | 'listening' | 'transcribing' | 'thinking'
  | 'tool_call' | 'speaking' | 'paused';

interface VoiceState {
  phase: VoicePhase;
  userTranscript: string;              // most recent user transcript
  aiStreaming: string;                 // current turn's streamed AI text
  aiSpokenWordCount: number;           // for karaoke highlight
  turnStartedAt: number | null;
  errorBanner: string | null;
  pausedWithInterjection: boolean;     // sub-behavior (c): show resume options
  interjectionText: string | null;

  setPhase: (p: VoicePhase) => void;
  setUserTranscript: (t: string) => void;
  appendAiDelta: (t: string) => void;
  markWordSpoken: (sentenceText: string) => void;
  resetTurn: () => void;
  setError: (msg: string | null) => void;
  setPausedWithInterjection: (b: boolean, text?: string) => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  phase: 'idle',
  userTranscript: '',
  aiStreaming: '',
  aiSpokenWordCount: 0,
  turnStartedAt: null,
  errorBanner: null,
  pausedWithInterjection: false,
  interjectionText: null,

  setPhase: (p) => set((s) => {
    const patch: Partial<VoiceState> = { phase: p };
    if (p === 'listening' && s.phase === 'idle') patch.turnStartedAt = Date.now();
    return patch;
  }),
  setUserTranscript: (t) => set({ userTranscript: t }),
  appendAiDelta: (t) => set((s) => ({ aiStreaming: s.aiStreaming + t })),
  markWordSpoken: (sentenceText) => set((s) => ({
    aiSpokenWordCount: s.aiSpokenWordCount + sentenceText.split(/\s+/).length,
  })),
  resetTurn: () => set({
    aiStreaming: '',
    aiSpokenWordCount: 0,
    userTranscript: '',
    pausedWithInterjection: false,
    interjectionText: null,
  }),
  setError: (msg) => set({ errorBanner: msg }),
  setPausedWithInterjection: (b, text) => set({ pausedWithInterjection: b, interjectionText: text ?? null }),
}));
