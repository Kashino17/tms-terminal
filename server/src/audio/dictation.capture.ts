/**
 * Diagnostics: the last dictations as they reached Whisper — the decoded audio
 * (16 kHz WAV) plus every piece it was cut into with the text Whisper heard
 * (`raw`) and the text after the dictionary (`text`).
 *
 * Exists so recognition errors can be replayed offline against other settings
 * (prompt, cut rule, model) with the speaker's REAL voice — synthetic voices
 * are recognised almost perfectly and hide what goes wrong.
 *
 * Stays on this machine in ~/.tms-terminal/dictation-captures (owner-only),
 * newest N only, nothing older than three days.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { encodeWav } from './dictation.segment';

const RATE = 16000;
const MAX_AGE_MS = 3 * 24 * 3600_000;

export interface CapturedPiece {
  /** Sample range [from, to) of the recording that went to Whisper as one piece. */
  from: number;
  to: number;
  /** What Whisper returned. */
  raw: string;
  /** After the dictionary's replacements. */
  text: string;
}

export interface DictationCapture {
  id: string;
  /** When the stop arrived (ms since epoch). */
  at: number;
  samples: Float32Array;
  pieces: CapturedPiece[];
  /** The result the app received. */
  text: string;
}

export class DictationCaptureStore {
  constructor(
    private readonly dir: string,
    private readonly keep = 30,
    private readonly now: () => number = Date.now,
  ) {}

  save(cap: DictationCapture): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    const base = `${cap.at}-${cap.id.replace(/[^A-Za-z0-9_-]/g, '')}`;
    fs.writeFileSync(path.join(this.dir, `${base}.wav`), encodeWav(cap.samples, RATE), { mode: 0o600 });
    const meta = { id: cap.id, at: cap.at, audioSecs: cap.samples.length / RATE, text: cap.text, pieces: cap.pieces };
    fs.writeFileSync(path.join(this.dir, `${base}.json`), JSON.stringify(meta, null, 1), { mode: 0o600 });
    this.prune();
  }

  private prune(): void {
    const bases = [...new Set(fs.readdirSync(this.dir).filter((f) => /^\d+-.*\.(wav|json)$/.test(f)).map((f) => f.replace(/\.(wav|json)$/, '')))]
      .sort((a, b) => Number(b.split('-')[0]) - Number(a.split('-')[0]));
    const cutoff = this.now() - MAX_AGE_MS;
    bases.forEach((b, i) => {
      if (i < this.keep && Number(b.split('-')[0]) >= cutoff) return;
      for (const ext of ['.wav', '.json']) fs.rmSync(path.join(this.dir, b + ext), { force: true });
    });
  }
}
