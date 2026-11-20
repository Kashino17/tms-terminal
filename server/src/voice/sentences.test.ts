import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, MAX_SENTENCE } from './sentences';

test('Sätze werden an Satzzeichen getrennt', () => {
  assert.deepEqual(splitSentences('Die Analyse hat fünf Lücken gefunden. Alle fünf sind behoben! Fehlt noch etwas? Ja, zwei Dinge.'),
    ['Die Analyse hat fünf Lücken gefunden.', 'Alle fünf sind behoben! Fehlt noch etwas? Ja, zwei Dinge.']);
});

test('Abkürzungen, Versionen und Zahlen zerreißen keinen Satz', () => {
  assert.deepEqual(splitSentences('Die App v1.149.0 ist gebaut, z. B. für das Fold. Das dauerte ca. 1,5 s pro Satz.'),
    ['Die App v1.149.0 ist gebaut, z. B. für das Fold.', 'Das dauerte ca. 1,5 s pro Satz.']);
  assert.deepEqual(splitSentences('Am 3. November lief Nr. 7 durch. Danach war Ruhe im Protokoll.'),
    ['Am 3. November lief Nr. 7 durch.', 'Danach war Ruhe im Protokoll.']);
});

test('sehr kurze Sätze hängen sich an — jeder Aufruf kostet über eine Sekunde', () => {
  assert.deepEqual(splitSentences('Ja. Das stimmt. Die Messung auf dem Gerät zeigt genau dieses Bild.'),
    ['Ja. Das stimmt. Die Messung auf dem Gerät zeigt genau dieses Bild.']);
  assert.deepEqual(splitSentences('Die Messung auf dem Gerät zeigt genau dieses Bild. Ja.'),
    ['Die Messung auf dem Gerät zeigt genau dieses Bild. Ja.'], 'auch am Ende');
});

test('ein überlanger Satz wird an einem Komma geteilt, nie mitten im Wort', () => {
  const long = 'Der Server reichte seine eigene Umgebung an jedes Terminal weiter, und aus einer Claude-Sitzung heraus gestartet trug er deren Kennzeichen, '
    + 'sodass jede neue Sitzung in einem TMS-Terminal sich für eine Unter-Sitzung hielt, keinen Verlauf speicherte und sich später nicht fortsetzen ließ, was erst jetzt auffiel.';
  const parts = splitSentences(long);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= MAX_SENTENCE), parts.map((p) => p.length).join(','));
  assert.equal(parts.join(' '), long, 'kein Wort geht verloren');
  assert.ok(parts.slice(0, -1).every((p) => /[,;]$/.test(p)), 'Schnitt nach einem Komma');
});

test('ohne Satzzeichen und ohne Komma: am Leerzeichen', () => {
  const words = Array.from({ length: 80 }, (_, i) => 'wort' + i).join(' ');
  const parts = splitSentences(words);
  assert.ok(parts.every((p) => p.length <= MAX_SENTENCE));
  assert.equal(parts.join(' '), words);
});

test('Leeres und Leerraum', () => {
  assert.deepEqual(splitSentences('   '), []);
  assert.deepEqual(splitSentences('  Ein   Satz\n mit Umbruch.  '), ['Ein Satz mit Umbruch.']);
});
