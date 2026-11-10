/**
 * One "read this aloud" request: sentence after sentence through the voice,
 * each piece sent the moment it exists.
 *
 * The voice is ~3× faster than speech. Left alone it would finish a long
 * answer within seconds — megabytes over the phone's connection and Mac work
 * for something the listener may stop after two sentences. So it only stays
 * LOOK_AHEAD sentences ahead of what the phone has started playing.
 */
import { splitSentences } from './sentences';

export const LOOK_AHEAD = 3;
const MAX_PIECES = 600;

export interface SpeechChunk {
  seq: number;
  /** Which of the request's parts this belongs to (the page marks it). */
  index: number;
  /** First piece of that part. */
  first: boolean;
  /** Nothing follows. */
  last: boolean;
  audio: Buffer;
  ms: number;
}

export interface SpeechRun {
  /** The phone started playing piece `seq`. */
  played(seq: number): void;
  stop(): void;
  done: Promise<void>;
}

export function startSpeechRun(
  parts: string[],
  synth: (text: string) => Promise<{ audio: Buffer; ms: number }>,
  emit: (chunk: SpeechChunk) => void,
  onError: (message: string) => void,
  lookAhead: number = LOOK_AHEAD,
): SpeechRun {
  const pieces: Array<{ index: number; first: boolean; text: string }> = [];
  parts.forEach((part, index) => {
    splitSentences(String(part ?? '')).forEach((text, k) => { if (pieces.length < MAX_PIECES) pieces.push({ index, first: k === 0, text }); });
  });

  let stopped = false;
  let playedSeq = -1;
  let wake: (() => void) | null = null;

  const done = (async () => {
    if (pieces.length === 0) { emit({ seq: 0, index: 0, first: true, last: true, audio: Buffer.alloc(0), ms: 0 }); return; }
    for (let seq = 0; seq < pieces.length; seq++) {
      while (!stopped && seq > playedSeq + lookAhead) await new Promise<void>((r) => { wake = r; });
      if (stopped) return;
      const p = pieces[seq];
      let out: { audio: Buffer; ms: number };
      try { out = await synth(p.text); } catch (e) {
        if (!stopped) { stopped = true; onError((e as Error).message || 'voice failed'); }
        return;
      }
      if (stopped) return;
      emit({ seq, index: p.index, first: p.first, last: seq === pieces.length - 1, audio: out.audio, ms: out.ms });
    }
  })();

  return {
    played(seq) { if (seq > playedSeq) { playedSeq = seq; const w = wake; wake = null; w?.(); } },
    stop() { stopped = true; const w = wake; wake = null; w?.(); },
    done,
  };
}
