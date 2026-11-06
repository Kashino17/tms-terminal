// End-to-end check of streamed dictation against the REAL pipeline:
// real ffmpeg decode, real mlx Whisper sidecar, real DictationManager.
// Not part of `npm test` (needs the venv + model, takes ~a minute).
//
//   cd server && node --require ts-node/register scripts/dictation-e2e.ts <audio file> [speedup]
//
// Streams the file as AAC-ADTS in 2s-of-audio pieces (default 10x real time),
// then measures stop -> result. Second run drops a piece and recovers via
// resume from a "new socket", like the app after a reconnect.

import { execFileSync } from 'child_process';
import { DictationManager, DictationEvent } from '../src/audio/dictation';
import { decodeToFloat32, findFfmpeg } from '../src/audio/ffmpeg-decode';
import { transcribe, prewarm, shutdown } from '../src/audio/whisper-sidecar';

const file = process.argv[2];
const speedup = Number(process.argv[3] ?? 10);
if (!file) { console.error('usage: dictation-e2e.ts <audio file> [speedup]'); process.exit(2); }

const adts = execFileSync(findFfmpeg()!, ['-nostdin', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '96k', '-f', 'adts', 'pipe:1'], { maxBuffer: 1 << 28 });
const BYTES_PER_SEC = 96000 / 8;
const PIECE = Math.round(BYTES_PER_SEC * 2);

const mgr = new DictationManager({
  decode: decodeToFloat32,
  transcribeWav: (b64) => transcribe(b64),
  rewrite: async (t) => t,
  now: () => Date.now(),
  log: (m) => console.log('   ', m),
});

async function run(label: string, dropPieceAt: number | null): Promise<string> {
  const id = `e2e${label}`;
  let result: string | null = null;
  let stopAt = 0;
  let doneAt = 0;
  const sink = (ev: DictationEvent) => {
    if (ev.type === 'dictation:result') { result = ev.text; doneAt = Date.now(); }
    if (ev.type === 'dictation:error') { console.error('ERROR', ev.message); process.exit(1); }
  };
  mgr.start(id, 'adts', false, sink);
  let n = 0;
  for (let off = 0; off < adts.length; off += PIECE, n++) {
    const piece = adts.subarray(off, Math.min(adts.length, off + PIECE));
    if (n !== dropPieceAt) mgr.chunk(id, off, piece, sink);
    await new Promise((r) => setTimeout(r, 2000 / speedup));
  }
  stopAt = Date.now();
  mgr.end(id, adts.length, sink);
  if (dropPieceAt !== null) {
    // The app reconnects, asks where it stands and resends from there.
    let have = 0;
    const sink2 = (ev: DictationEvent) => {
      if (ev.type === 'dictation:state') have = ev.bytes;
      sink(ev);
    };
    mgr.resume(id, sink2);
    for (let off = have; off < adts.length; off += PIECE) mgr.chunk(id, off, adts.subarray(off, Math.min(adts.length, off + PIECE)), sink2);
  }
  await mgr.idle(id);
  if (result === null) { console.error('no result'); process.exit(1); }
  console.log(`${label}: stop -> result ${doneAt - stopAt}ms, ${(result as string).length} chars`);
  return result as string;
}

(async () => {
  await prewarm();
  console.log(`audio ${(adts.length / BYTES_PER_SEC).toFixed(0)}s, ${adts.length} bytes ADTS, streaming at ${speedup}x`);
  const a = await run('A-stream', null);
  const b = await run('B-drop+resume', 7);
  console.log('same text after resume:', a === b);
  console.log('TEXT:', a.slice(0, 300), '…');
  shutdown();
  process.exit(a === b ? 0 : 1);
})();
