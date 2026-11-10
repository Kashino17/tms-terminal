// Decoded audio of a growing AAC-ADTS recording.
//
// The streamed dictation asks for "all samples so far" several times a second.
// Decoding the whole upload each time would cost more and more as a dictation
// gets longer — and the last, biggest decode would sit right in the wait after
// the stop. So only the frames that are new since the last call are decoded.
//
// AAC frames build on their predecessor, so each decode starts two frames
// early and those samples are thrown away (measured: from the third frame on
// the output is identical to one decode of the whole stream).

export interface PcmStream {
  push(bytes: Buffer): void;
  /** All samples decoded so far (16 kHz mono); decodes only what is new. */
  samples(): Promise<Float32Array>;
  /** Raw bytes still held in memory. */
  readonly bytes: number;
  release(): void;
}

/** Samples one AAC-LC frame decodes to (at the recording's own sample rate). */
export const ADTS_FRAME_SAMPLES = 1024;
const OVERLAP_FRAMES = 2;
const ADTS_HEADER_BYTES = 7;

/**
 * Start offsets of the complete ADTS frames in `buf` at/after `from`, and the
 * offset just past the last one. `broken` = no frame header where one must be.
 */
export function adtsFrames(buf: Buffer, from: number): { starts: number[]; end: number; broken: boolean } {
  const starts: number[] = [];
  let i = from;
  while (i + ADTS_HEADER_BYTES <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xf0) !== 0xf0) return { starts, end: i, broken: true };
    const len = ((buf[i + 3] & 0x03) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
    if (len < ADTS_HEADER_BYTES) return { starts, end: i, broken: true };
    if (i + len > buf.length) break;
    starts.push(i);
    i += len;
  }
  return { starts, end: i, broken: false };
}

export class AdtsPcm implements PcmStream {
  private raw: Buffer = Buffer.alloc(0);
  /** Start offsets (in `raw`) of the last decoded frames — the overlap for the next decode. */
  private tailStarts: number[] = [];
  /** Offset in `raw` just past the last decoded frame. */
  private decodedTo = 0;
  private pcm = new Float32Array(0);
  private length = 0;
  private fullMode = false;
  /** Set when full mode starts: samples kept from before, and how many of each full decode they cover. */
  private fullBase: { length: number; skip: number } | null = null;
  private dirty = false;

  constructor(private readonly decode: (bytes: Buffer) => Promise<Float32Array>) {}

  get mode(): 'incremental' | 'full' { return this.fullMode ? 'full' : 'incremental'; }
  get bytes(): number { return this.raw.length; }

  push(bytes: Buffer): void {
    if (bytes.length === 0) return;
    this.raw = this.raw.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.raw, bytes]);
    this.dirty = true;
  }

  async samples(): Promise<Float32Array> {
    if (!this.dirty) return this.view();
    this.dirty = false;
    if (!this.fullMode) await this.decodeNew();
    if (this.fullMode) await this.decodeAll();
    return this.view();
  }

  release(): void {
    this.raw = Buffer.alloc(0);
    this.tailStarts = [];
    this.decodedTo = 0;
    this.pcm = new Float32Array(0);
    this.length = 0;
    this.dirty = false;
    this.fullBase = null;
  }

  private view(): Float32Array { return this.pcm.subarray(0, this.length); }

  private async decodeNew(): Promise<void> {
    const { starts, end, broken } = adtsFrames(this.raw, this.decodedTo);
    if (broken) { this.fullMode = true; return; }
    if (starts.length === 0) return;
    const overlap = this.tailStarts.length;
    const from = overlap > 0 ? this.tailStarts[0] : this.decodedTo;
    let out: Float32Array;
    try {
      out = await this.decode(this.raw.subarray(from, end));
    } catch {
      this.fullMode = true;
      return;
    }
    // Anything but exactly 1024 samples per frame (another sample rate, another
    // AAC profile) means the bookkeeping here does not hold for this recording.
    if (out.length !== (overlap + starts.length) * ADTS_FRAME_SAMPLES) { this.fullMode = true; return; }
    this.append(out.subarray(overlap * ADTS_FRAME_SAMPLES));
    const all = this.tailStarts.concat(starts);
    const keep = all.slice(-OVERLAP_FRAMES);
    // Bytes before the overlap are never needed again.
    const drop = keep[0];
    this.raw = this.raw.subarray(drop);
    this.tailStarts = keep.map((o) => o - drop);
    this.decodedTo = end - drop;
  }

  private async decodeAll(): Promise<void> {
    // The stream does not fit the incremental scheme: decode everything that
    // is still held, every time — slower, but as correct as one full decode.
    // If the switch happens mid-stream, `raw` starts with the overlap frames
    // whose samples are already in `pcm`; they are skipped.
    if (this.fullBase === null) this.fullBase = { length: this.length, skip: this.tailStarts.length * ADTS_FRAME_SAMPLES };
    const out = await this.decode(this.raw);
    this.length = this.fullBase.length;
    if (out.length > this.fullBase.skip) this.append(out.subarray(this.fullBase.skip));
  }

  private append(more: Float32Array): void {
    if (this.length + more.length > this.pcm.length) {
      const grown = new Float32Array(Math.max(this.pcm.length * 2, this.length + more.length, 16000 * 30));
      grown.set(this.pcm.subarray(0, this.length));
      this.pcm = grown;
    }
    this.pcm.set(more, this.length);
    this.length += more.length;
  }
}
