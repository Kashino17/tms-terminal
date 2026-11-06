// Stand-alone dictation server for device/emulator tests of the Android
// bubble — the real DictationManager + ffmpeg + Whisper sidecar, but NOT the
// live TMS server (no terminals, no restart needed). Accepts any token.
//
//   cd server && node --require ts-node/register scripts/dictation-test-server.ts [port]
import http from 'http';
import fs from 'fs';
import { WebSocketServer } from 'ws';
import { DictationManager } from '../src/audio/dictation';
import { createDictationConnectionHandler, isDictationRequest } from '../src/audio/dictation.connection';
import { decodeToFloat32 } from '../src/audio/ffmpeg-decode';
import { transcribe, prewarm } from '../src/audio/whisper-sidecar';

const port = Number(process.argv[2] ?? 8799);
const mgr = new DictationManager({
  decode: async (bytes, format) => {
    const f = await decodeToFloat32(bytes, format);
    let peak = 0, sum = 0;
    for (let i = 0; i < f.length; i++) { const a = Math.abs(f[i]); if (a > peak) peak = a; sum += f[i] * f[i]; }
    console.log(`  decoded ${(f.length / 16000).toFixed(1)}s, peak ${peak.toFixed(4)}, rms ${Math.sqrt(sum / Math.max(1, f.length)).toFixed(5)}`);
    // Emulators often get no host microphone: with TEST_AUDIO set, a silent
    // recording is replaced by that file (same length) to exercise the rest.
    if (peak < 0.01 && process.env.TEST_AUDIO) {
      const sub = await decodeToFloat32(fs.readFileSync(process.env.TEST_AUDIO), 'file');
      console.log('  (silent — using TEST_AUDIO)');
      return sub.subarray(0, Math.min(sub.length, f.length));
    }
    return f;
  },
  transcribeWav: (b64) => transcribe(b64),
  rewrite: async (t) => t,
  now: () => Date.now(),
  log: (m) => console.log(new Date().toISOString().slice(11, 19), m),
});
const handle = createDictationConnectionHandler(mgr, (m) => console.log(new Date().toISOString().slice(11, 19), m));
const server = http.createServer((_req, res) => { res.writeHead(200); res.end('dictation test server\n'); });
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (!isDictationRequest(req.url)) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => handle(ws, req.socket.remoteAddress ?? '?'));
});
prewarm().then(() => server.listen(port, () => console.log(`dictation test server on :${port}`)));
