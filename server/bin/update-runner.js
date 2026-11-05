#!/usr/bin/env node
'use strict';
/**
 * Update-Ablauf für Windows — dieselben drei Phasen wie das Bash-Skript in
 * cli.js (Mac/Linux), aber in Node, weil es unter Windows kein bash gibt
 * (bzw. nur das von WSL, das weder C:\-Pfade noch das Windows-node kennt).
 * Ohne das schlug `tms-terminal update` unter Windows IMMER fehl, und der
 * Windows-Server blieb auf einem alten Stand stehen.
 *
 *   1. holen, installieren, NEBEN dem laufenden Server bauen (darf scheitern)
 *   2. kurz stoppen, dist tauschen, starten
 *   3. kommt er nicht hoch: zurück auf das alte dist
 *
 * Aufruf (losgelöst von cli.js): node update-runner.js <paths.json>
 * `runUpdate(paths, deps)` ist rein — alle Aktionen kommen über deps (Tests).
 */
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');

function runUpdate(p, d) {
  const abort = (msg) => { d.say(`ABBRUCH: ${msg} Der Server laeuft unveraendert weiter.`); return false; };

  // ── Phase 1: alles, was scheitern darf. Der Server laeuft dabei weiter. ──
  d.say('Hole neuen Stand...');
  if (!d.run('git pull')) return abort('git pull fehlgeschlagen.');
  d.say('Installiere Abhaengigkeiten...');
  if (!d.run('npm install --no-audit --no-fund')) return abort('npm install fehlgeschlagen.');
  d.say('Baue neben dem laufenden Server...');
  d.remove(p.newDist); d.remove(p.newTsbuildinfo);
  if (!d.run(`npx tsc --outDir "${p.newDist}" --tsBuildInfoFile "${p.newTsbuildinfo}"`)) {
    d.remove(p.newDist); d.remove(p.newTsbuildinfo);
    return abort('Build fehlgeschlagen.');
  }
  if (!d.exists(p.newIndex)) {
    d.remove(p.newDist); d.remove(p.newTsbuildinfo);
    return abort('Der Build hat keinen Einstiegspunkt erzeugt.');
  }
  d.say('Fertig gebaut. Erst JETZT wird der Server angefasst.');

  // ── Phase 2: der kurze Tausch. ──
  d.node(['stop']);
  d.sleep(1000);
  d.remove(p.oldDist);
  if (d.exists(p.dist)) d.rename(p.dist, p.oldDist);
  d.rename(p.newDist, p.dist);
  if (!d.exists(p.dist)) {
    d.say('Tausch fehlgeschlagen — rolle zurueck.');
    if (d.exists(p.oldDist)) d.rename(p.oldDist, p.dist);
    d.node(['start', '--background']);
    return false;
  }
  if (d.exists(p.newTsbuildinfo)) { d.remove(p.tsbuildinfo); d.rename(p.newTsbuildinfo, p.tsbuildinfo); }
  d.say('Starte Server...');
  d.node(['start', '--background']);

  // ── Phase 3: kommt er wirklich hoch? ──
  d.sleep(3000);
  if (d.node(['status', '--quiet'])) {
    d.say('Server laeuft wieder. Update fertig.');
    d.remove(p.oldDist);
    return true;
  }
  d.say('Der neue Server kommt nicht hoch — ZURUECK auf den alten Stand.');
  d.node(['stop']);
  d.sleep(1000);
  d.remove(p.dist);
  if (d.exists(p.oldDist)) d.rename(p.oldDist, p.dist);
  d.node(['start', '--background']);
  d.say('Zurueckgerollt. Der Fehler steht im Server-Log (tms-terminal logs).');
  return false;
}

/** Echte Aktionen: Befehle in p.root, Ausgabe ins Update-Log. */
function realDeps(p) {
  const log = (s) => { try { fs.appendFileSync(p.log, s.endsWith('\n') ? s : s + '\n'); } catch { /* kein Log, kein Abbruch */ } };
  return {
    run(cmd) {
      log(`> ${cmd}`);
      try {
        const out = execSync(cmd, { cwd: p.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        if (out) log(out);
        return true;
      } catch (e) {
        log(String((e && (e.stdout || '') + (e.stderr || '')) || e));
        return false;
      }
    },
    node(args) {
      const r = spawnSync(process.execPath, [p.cli, ...args], { cwd: p.root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
      if (r.stdout) log(r.stdout);
      if (r.stderr) log(r.stderr);
      return r.status === 0;
    },
    exists: (f) => fs.existsSync(f),
    remove(f) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* best effort */ } },
    rename(a, b) { try { fs.renameSync(a, b); } catch (e) { log(`mv ${a} -> ${b}: ${e && e.message}`); } },
    say: (m) => log(`[${new Date().toISOString()}] ${m}`),
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  };
}

module.exports = { runUpdate, realDeps };

if (require.main === module) {
  const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  try { fs.writeFileSync(p.log, ''); } catch { /* ignore */ }
  const deps = realDeps(p);
  deps.say('Update gestartet (Windows)');
  process.exit(runUpdate(p, deps) ? 0 : 1);
}