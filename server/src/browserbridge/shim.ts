// Materializes a directory of browser-opener shims that get prepended to the
// PTY's PATH (and set as $BROWSER). Each shim forwards http(s) URLs to the TMS
// server; anything else is passed to the real opener untouched.
// See docs/superpowers/specs/2026-07-17-terminal-browser-sync-design.md
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Runs as a standalone Node process inside the PTY, under whatever Node is on
// PATH — so it imports nothing from this project. `open`/`xdg-open`/… are
// symlinks to this file; basename(argv[1]) tells us which command we stand in
// for, so a non-URL arg can be delegated to the real binary.
const SHIM_SRC = `#!/usr/bin/env node
'use strict';
var http = require('http');
var spawn = require('child_process').spawn;
var path = require('path');
var fs = require('fs');

var cmd = path.basename(process.argv[1]);
var args = process.argv.slice(2);
var urlArg = args.find(function (a) { return a.indexOf('http://') === 0 || a.indexOf('https://') === 0; });

function realBinary(name) {
  if (name === 'open') return '/usr/bin/open'; // macOS stable path
  var shimDir = path.dirname(process.argv[1]);
  var parts = (process.env.PATH || '').split(path.delimiter);
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p || path.resolve(p) === path.resolve(shimDir)) continue;
    var cand = path.join(p, name);
    try { fs.accessSync(cand, fs.constants.X_OK); return cand; } catch (e) {}
  }
  return null;
}

function openLocally() {
  if (cmd === 'tms-open') {
    var opener = process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
    spawn(opener, args, { stdio: 'ignore', detached: true }).unref();
    process.exit(0);
    return;
  }
  var real = realBinary(cmd);
  if (!real) { process.exit(0); return; }
  var child = spawn(real, args, { stdio: 'inherit' });
  child.on('exit', function (code) { process.exit(code || 0); });
}

if (!urlArg) {
  openLocally();
} else {
  var body = JSON.stringify({
    url: urlArg,
    sessionId: process.env.TMS_SESSION_ID || '',
    secret: process.env.TMS_BROWSERBRIDGE_SECRET || '',
  });
  var req = http.request(
    { host: '127.0.0.1', port: process.env.TMS_SERVER_PORT || '8767',
      path: '/internal/open-url', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
    function (res) {
      var d = '';
      res.on('data', function (c) { d += c; });
      res.on('end', function () {
        var action = 'local';
        try { action = JSON.parse(d).action; } catch (e) {}
        if (action === 'handled') { process.exit(0); return; }
        openLocally();
      });
    }
  );
  req.on('error', openLocally); // server down → open on the PC, never swallow
  req.write(body);
  req.end();
}
`;

let cachedDir: string | null = null;

export function materializeShimDir(): string {
  if (cachedDir && fs.existsSync(path.join(cachedDir, 'tms-open'))) return cachedDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-browserbridge-'));
  const tmsOpen = path.join(dir, 'tms-open');
  fs.writeFileSync(tmsOpen, SHIM_SRC, { mode: 0o755 });
  for (const name of ['open', 'xdg-open', 'sensible-browser', 'www-browser']) {
    const link = path.join(dir, name);
    try {
      fs.symlinkSync('tms-open', link);
    } catch {
      fs.copyFileSync(tmsOpen, link);
      fs.chmodSync(link, 0o755);
    }
  }
  cachedDir = dir;
  return dir;
}
