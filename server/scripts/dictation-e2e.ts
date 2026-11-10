// End-to-end check of streamed dictation against the REAL pipeline:
// real ffmpeg decode, real mlx Whisper sidecar, real DictationManager.
// Not part of `npm test` (needs the venv + model, takes a while).
//
//   cd server && node --require ts-node/register scripts/dictation-e2e.ts <audio file>
//       [--cut=new|legacy]   pause rule (8-28s pieces) or the earlier 60s rule   (default new)
//       [--piece=0.5]        seconds of audio per upload message                  (default 0.5)
//       [--speedup=1]        stream faster than real time ...                     (default 1)
//       [--tail=20]          ... except the last N seconds, which run in real time (default 20)
//       [--stop-delay=0]     ms between the last audio and the stop               (default 0)
//       [--truth=file.txt]   expected text: prints the word errors
//       [--resume]           also run the "dropped piece + resume from a new socket" check
//       [--text] [--verbose] print the transcript / the manager's log lines
//
// Prints one line per run:  stop -> result Nms, rest N.Ns, calls N, word errors N of N
// Fixtures with a known text: scripts/dictation-fixtures.sh

import { execFileSync } from 'child_process';
import fs from 'fs';
import { DictationManager, DictationEvent } from '../src/audio/dictation';
import { nextCut, nextCutLegacy } from '../src/audio/dictation.segment';
import { AdtsPcm } from '../src/audio/adts-pcm';
import type { DictationStat } from '../src/audio/dictation.stats';
import { decodeToFloat32, findFfmpeg } from '../src/audio/ffmpeg-decode';
import { transcribe, prewarm, shutdown } from '../src/audio/whisper-sidecar';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name: string, dflt: string) => (args.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${dflt}`).split('=').slice(1).join('=');
if (!file) { console.error('usage: dictation-e2e.ts <audio file> [--cut=new|legacy] [--piece=0.5] [--speedup=1] [--tail=20] [--stop-delay=0] [--truth=file] [--resume] [--text] [--verbose]'); process.exit(2); }

const cutName = opt('cut', 'new');
const pieceSecs = Number(opt('piece', '0.5'));
const speedup = Number(opt('speedup', '1'));
const tailSecs = Number(opt('tail', '20'));
const stopDelay = Number(opt('stop-delay', '0'));
const truthFile = opt('truth', '');
const withResume = args.includes('--resume');

const adts = execFileSync(findFfmpeg()!, ['-nostdin', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '96k', '-f', 'adts', 'pipe:1'], { maxBuffer: 1 << 28 });

let calls = 0;
let lastStat: DictationStat | null = null;
const mgr = new DictationManager({
  decode: decodeToFloat32,
  openPcm: () => new AdtsPcm((b) => decodeToFloat32(b, 'adts')),
  transcribeWav: (b64) => { calls++; return transcribe(b64); },
  onDone: (s) => { lastStat = s; },
  now: () => Date.now(),
  log: (m) => { if (args.includes('--verbose')) console.log('   ', m); },
}, { cut: cutName === 'legacy' ? nextCutLegacy : nextCut });

const words = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
/** Word-level edit distance (substitutions, insertions, deletions). */
function wordErrors(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(label: string, bytesPerSec: number, dropPieceAt: number | null): Promise<string> {
  const id = `e2e${label.replace(/[^a-z]/g, '')}`;
  const piece = Math.max(1, Math.round(bytesPerSec * pieceSecs));
  let result: string | null = null;
  let stopAt = 0;
  let doneAt = 0;
  calls = 0; lastStat = null;
  const sink = (ev: DictationEvent) => {
    if (ev.type === 'dictation:result') { result = ev.text; doneAt = Date.now(); }
    if (ev.type === 'dictation:error') { console.error('ERROR', ev.message); process.exit(1); }
  };
  mgr.start(id, 'adts', sink);
  const tailFrom = adts.length - tailSecs * bytesPerSec;
  let n = 0;
  for (let off = 0; off < adts.length; off += piece, n++) {
    if (n !== dropPieceAt) mgr.chunk(id, off, adts.subarray(off, Math.min(adts.length, off + piece)), sink);
    await sleep((pieceSecs * 1000) / (off >= tailFrom ? 1 : speedup));
  }
  if (stopDelay > 0) await sleep(stopDelay);
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
    for (let off = have; off < adts.length; off += piece) mgr.chunk(id, off, adts.subarray(off, Math.min(adts.length, off + piece)), sink2);
  }
  await mgr.idle(id);
  if (result === null) { console.error('no result'); process.exit(1); }
  const text = result as string;
  const stat = lastStat as DictationStat | null;
  let errs = '';
  if (truthFile) {
    const truth = words(fs.readFileSync(truthFile, 'utf8'));
    errs = `, word errors ${wordErrors(truth, words(text))} of ${truth.length}`;
  }
  console.log(`${label} [cut=${cutName} piece=${pieceSecs}s delay=${stopDelay}ms]: stop -> result ${doneAt - stopAt}ms, rest ${stat ? stat.restSecs.toFixed(1) : '?'}s, calls ${calls}${stat?.specHit ? ', ahead' : ''}${errs}`);
  return text;
}

(async () => {
  await prewarm();
  const secs = (await decodeToFloat32(adts, 'adts')).length / 16000;
  const bytesPerSec = adts.length / secs;
  console.log(`audio ${secs.toFixed(1)}s, ${adts.length} bytes ADTS`);
  const a = await run('stream', bytesPerSec, null);
  let ok = true;
  if (withResume) {
    const b = await run('drop+resume', bytesPerSec, 7);
    ok = a === b;
    console.log('same text after resume:', ok);
  }
  if (args.includes('--text')) console.log('TEXT:', a);
  shutdown();
  process.exit(ok ? 0 : 1);
})();
