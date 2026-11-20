/**
 * Minimal Ogg reader for the Windows sound path: ffmpeg encodes the PCM to
 * Opus and can only hand out packet boundaries inside a container, Ogg being
 * the simplest. This takes the byte stream apart into Opus packets, skipping
 * the two header packets (OpusHead, OpusTags). Pure — no I/O.
 *
 * Page layout (RFC 3533): "OggS", version, header type, granule (8),
 * serial (4), sequence (4), CRC (4), segment count, segment table, data.
 * A packet ends at the first segment shorter than 255 bytes.
 */
export interface OggReader {
  push(chunk: Buffer): Buffer[];
}

export function createOggReader(): OggReader {
  let buf: Buffer = Buffer.alloc(0);
  let partial: Buffer[] = [];

  const isHeader = (p: Buffer) =>
    p.length >= 8 && (p.subarray(0, 8).toString('latin1') === 'OpusHead' || p.subarray(0, 8).toString('latin1') === 'OpusTags');

  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const out: Buffer[] = [];
      for (;;) {
        if (buf.length < 27) break;
        if (buf.toString('latin1', 0, 4) !== 'OggS') {
          // Out of step (should not happen): find the next page start.
          const next = buf.indexOf('OggS', 1, 'latin1');
          if (next < 0) { buf = buf.subarray(buf.length - 3); break; }
          buf = buf.subarray(next);
          partial = [];
          continue;
        }
        const segs = buf[26];
        if (buf.length < 27 + segs) break;
        let size = 0;
        for (let i = 0; i < segs; i++) size += buf[27 + i];
        if (buf.length < 27 + segs + size) break;
        let off = 27 + segs;
        for (let i = 0; i < segs; i++) {
          const len = buf[27 + i];
          partial.push(buf.subarray(off, off + len));
          off += len;
          if (len < 255) {
            const packet = Buffer.concat(partial);
            partial = [];
            if (packet.length && !isHeader(packet)) out.push(packet);
          }
        }
        buf = Buffer.from(buf.subarray(off));
      }
      return out;
    },
  };
}

/** ffmpeg: raw float PCM in, Opus in Ogg out, every 20 ms packet flushed at once. */
export function buildOpusEncoderArgs(rate: number, channels: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error',
    // No probing: the format is given, and ffmpeg would otherwise read up to
    // 5 s of sound before encoding the first packet (measured: nothing came
    // out for a live 1 s stream).
    '-probesize', '32', '-analyzeduration', '0', '-fflags', 'nobuffer',
    '-f', 'f32le', '-ar', String(rate), '-ac', String(channels), '-i', 'pipe:0',
    '-ar', '48000', '-ac', '2',
    '-c:a', 'libopus', '-b:a', '96k', '-application', 'lowdelay', '-frame_duration', '20',
    '-f', 'ogg', '-page_duration', '20000', '-flush_packets', '1', 'pipe:1',
  ];
}
