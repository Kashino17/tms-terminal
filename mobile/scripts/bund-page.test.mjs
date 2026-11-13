// Bund-Seite: Desk nur aufgeklappt (breit + volle Grundhöhe); die Tastatur
// blendet die Seitenleiste NICHT aus, der geteilte Bildschirm bekommt keine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../mockups/season2/liquid-deck/bund.js'), 'utf8');
const body = src.match(/function deskWanted\(width, baseHeight\) \{([^}]*)\}/);
assert.ok(body, 'deskWanted fehlt in bund.js');
const deskWanted = new Function('width', 'baseHeight', body[1]);

test('aufgeklappt (875×970) → Desk', () => assert.equal(deskWanted(875, 970), true));
test('aufgeklappt mit Tastatur: Grundhöhe bleibt 970 → Desk bleibt', () => assert.equal(deskWanted(875, 970), true));
test('geteilter Bildschirm (875×460 von Anfang an) → kein Desk', () => assert.equal(deskWanted(875, 460), false));
test('zugeklappt (412×915) → kein Desk', () => assert.equal(deskWanted(412, 915), false));

test('Build bündelt bund.css und bund.js ein', () => {
  const build = readFileSync(join(here, 'build-season2-html.js'), 'utf8');
  assert.match(build, /<link rel="stylesheet" href="bund\.css">/);
  assert.match(build, /<script src="bund\.js"><\/script>/);
});
