/**
 * Reihenfolge der Nachrichten im WebRoot.
 *
 * In onMessage() steckt ein Guard, der alles Server-abhaengige ohne Verbindung
 * stillschweigend verwirft:
 *
 *   if (!wsService || !server) return;
 *
 * Gebetszeiten brauchen keinen Server — und genau deshalb sind sie im neuen
 * Layout bisher eine Attrappe: jede `adhan:`-Nachricht waere hinter diesem Guard
 * gelandet und einfach verschwunden. Der Test haelt die Reihenfolge fest, damit
 * das beim naechsten Umbau nicht wieder passiert.
 *
 * Texttest auf der Quelle, wie webview-origin.test.mjs — kein laufendes Fenster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '../src/season2/SeasonTwoWebRoot.tsx');
const source = readFileSync(SRC, 'utf8');

/** Position der Guard-Zeile im Quelltext. */
function guardIndex() {
  const i = source.indexOf('if (!wsService || !server) return;');
  assert.notEqual(i, -1, 'der Verbindungs-Guard fehlt — wenn er weg ist, muss auch dieser Test weg');
  return i;
}

test('jede adhan-Nachricht wird VOR dem Verbindungs-Guard behandelt', () => {
  const guard = guardIndex();
  const cases = [...source.matchAll(/case '(adhan:[a-z]+)'/g)];
  assert.ok(cases.length >= 7, `erwartet mindestens 7 adhan-Faelle, gefunden ${cases.length}`);

  for (const m of cases) {
    assert.ok(
      m.index < guard,
      `case '${m[1]}' steht HINTER dem Guard — ohne Verbindung waere die Nachricht stillschweigend weg`,
    );
  }
});

test('server:switch bleibt hinter dem Guard — dort IST eine Verbindung noetig', () => {
  // Gegenteil des adhan-Tests: das Umstellen auf einen anderen Server braucht den
  // aktiven WebSocket. Es falsch nach vorn zu ziehen wuerde auf server === null
  // laufen. Der Test steht hier, damit niemand beim Aufraeumen beide gleichzieht.
  const guard = guardIndex();
  const serverSwitch = source.indexOf("case 'server:switch'");
  assert.notEqual(serverSwitch, -1, "case 'server:switch' fehlt");
  assert.ok(serverSwitch > guard, 'server:switch gehoert HINTER den Guard');
});

test('die acht Nachrichten der Spec sind alle da', () => {
  for (const name of [
    'adhan:toggle', 'adhan:wecker', 'adhan:reciter', 'adhan:location',
    'adhan:method', 'adhan:preview', 'adhan:test', 'adhan:perms',
  ]) {
    assert.ok(
      source.includes(`case '${name}'`),
      `case '${name}' fehlt in onMessage — die Seite sendet sie, die App versteht sie nicht`,
    );
  }
});