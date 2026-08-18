import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  isRemotePath, handleRemoteConnection, QUALITY_PRESETS, packAccessUnit, computeRttMs,
} from './remote.socket';
import { logger } from '../utils/logger';
import { RemoteCaptureError } from './capture/capture.types';
import type { ScreenCapture, CaptureOptions } from './capture/capture.types';
import type { InputInjector } from './input/input.types';

/** Minimaler Ersatz fuer den WebSocket: merkt sich, was gesendet wurde. */
class FakeWs extends EventEmitter {
  sent: any[] = [];
  pings: Buffer[] = [];
  bufferedAmount = 0;
  readyState = 1;
  send(data: any) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); }
  ping(data?: Buffer) { this.pings.push(data ?? Buffer.alloc(0)); }
  close() { this.readyState = 3; this.emit('close'); }
  typed(type: string) { return this.sent.filter((m) => m && m.type === type); }
}

function fakeCapture() {
  const c = {
    started: null as CaptureOptions | null,
    stopped: false,
    keyframes: 0,
    bitrates: [] as number[],
    dataCb: (_: Buffer) => {},
    errCb: (_c: string, _m: string) => {},
    async start(o: CaptureOptions) { c.started = o; return { width: 3024, height: 1964, scale: 2 }; },
    onData(cb: (b: Buffer) => void) { c.dataCb = cb; },
    onError(cb: (code: any, m: string) => void) { c.errCb = cb; },
    requestKeyframe() { c.keyframes++; },
    setBitrate(k: number) { c.bitrates.push(k); },
    async stop() { c.stopped = true; },
  };
  return c as typeof c & ScreenCapture;
}

/** `ready` mirrors InputInjector's optional startup-readiness promise — left
 *  undefined by default, matching backends without a startup race. */
function fakeInput(ready?: Promise<void>) {
  const calls: string[] = [];
  const i: any = {
    calls,
    ready,
    moveRelative: (dx: number, dy: number) => calls.push(`rel ${dx} ${dy}`),
    moveAbsolute: (x: number, y: number) => calls.push(`abs ${x} ${y}`),
    button: (w: string, d: boolean) => calls.push(`btn ${w} ${d}`),
    scroll: (dx: number, dy: number) => calls.push(`scroll ${dx} ${dy}`),
    key: (c: string, d: boolean) => calls.push(`key ${c} ${d}`),
    text: (s: string) => calls.push(`text ${s}`),
    stop: async () => { calls.push('stop'); },
  };
  return i as typeof i & InputInjector;
}

function wire(overrides: Partial<{ enabled: boolean }> = {}) {
  const ws = new FakeWs();
  const capture = fakeCapture();
  const input = fakeInput();
  handleRemoteConnection(ws as any, {
    makeCapture: () => capture,
    makeInput: () => input,
    isEnabled: () => overrides.enabled ?? true,
  });
  return { ws, capture, input };
}

const send = (ws: FakeWs, msg: unknown) => ws.emit('message', Buffer.from(JSON.stringify(msg)), false);

test('isRemotePath erkennt nur den Fernzugriffs-Pfad', () => {
  assert.equal(isRemotePath('/remote?token=abc'), true);
  assert.equal(isRemotePath('/remote'), true);
  assert.equal(isRemotePath('/?token=abc'), false);
  assert.equal(isRemotePath('/remotely'), false);
  assert.equal(isRemotePath(undefined), false);
});

test('remote:start meldet die Bildschirmmasse zurueck', async () => {
  const { ws, capture } = wire();
  send(ws, { type: 'remote:start', payload: { maxWidth: 1600, fps: 30, bitrateKbps: 1500 } });
  await new Promise((r) => setImmediate(r));

  const started = ws.typed('remote:started');
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].payload,
    { width: 3024, height: 1964, scale: 2, fps: 30, codec: 'avc1' });
  assert.deepEqual(capture.started, { maxWidth: 1600, fps: 30, bitrateKbps: 1500 });
});

test('remote:started wartet, bis der Eingabe-Helfer seine Bereitschaft meldet', async () => {
  const ws = new FakeWs();
  const capture = fakeCapture();
  let resolveReady: () => void = () => {};
  const readyPromise = new Promise<void>((r) => { resolveReady = r; });
  const input = fakeInput(readyPromise);
  handleRemoteConnection(ws as any, {
    makeCapture: () => capture,
    makeInput: () => input,
    isEnabled: () => true,
  });

  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  assert.equal(ws.typed('remote:started').length, 0,
    'noch keine stumme Zusicherung, solange der Helfer nicht bereit ist');

  resolveReady();
  await new Promise((r) => setImmediate(r));
  assert.equal(ws.typed('remote:started').length, 1, 'jetzt, wo der Helfer bereit ist');
});

test('scheitert die Eingabe-Bereitschaft, bekommt der Client remote:error statt eine haengende Verbindung', async () => {
  const ws = new FakeWs();
  const capture = fakeCapture();
  // Ein bereits abgelehntes Versprechen ist hier absichtlich: es soll erst spaeter
  // (beim await in start()) behandelt werden — der Vorab-catch unterdrueckt nur
  // die "unhandledRejection"-Meldung von Node, das Ablehnungsergebnis bleibt gleich.
  const readyRejected = Promise.reject(new Error('Bedienungshilfen sind nicht freigegeben'));
  readyRejected.catch(() => {});
  const input = fakeInput(readyRejected);
  handleRemoteConnection(ws as any, {
    makeCapture: () => capture,
    makeInput: () => input,
    isEnabled: () => true,
  });

  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));

  assert.equal(ws.typed('remote:started').length, 0, 'keine stumme Verbindung');
  const err = ws.typed('remote:error')[0];
  assert.equal(err.payload.code, 'capture_unavailable');
  assert.match(err.payload.message, /Bedienungshilfen/);
});

test('ist der Fernzugriff abgeschaltet, kommt ein Fehler statt einer Aufnahme', async () => {
  const { ws, capture } = wire({ enabled: false });
  send(ws, { type: 'remote:start', payload: { maxWidth: 1600, fps: 30, bitrateKbps: 1500 } });
  await new Promise((r) => setImmediate(r));

  assert.equal(ws.typed('remote:started').length, 0);
  assert.equal(ws.typed('remote:error')[0].payload.code, 'disabled');
  assert.equal(capture.started, null, 'die Aufnahme darf gar nicht erst anlaufen');
});

test('remote:keyframe fordert ein Vollbild an', async () => {
  const { ws, capture } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  send(ws, { type: 'remote:keyframe' });

  assert.equal(capture.keyframes, 1);
});

test('remote:stop haelt Aufnahme und Eingabe an', async () => {
  const { ws, capture, input } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  send(ws, { type: 'remote:stop' });
  await new Promise((r) => setImmediate(r));

  assert.equal(capture.stopped, true);
  assert.ok(input.calls.includes('stop'));
  assert.equal(ws.typed('remote:stopped').length, 1);
});

test('faellt die Verbindung weg, bleibt kein Helfer zurueck', async () => {
  const { ws, capture, input } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  ws.close();
  await new Promise((r) => setImmediate(r));

  assert.equal(capture.stopped, true, 'kein verwaister Aufnahmeprozess');
  assert.ok(input.calls.includes('stop'));
});

test('ein Aufnahmefehler wird als remote:error weitergereicht', async () => {
  const { ws, capture } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  capture.errCb('permission_screen', 'Bildschirmaufnahme nicht freigegeben');

  const err = ws.typed('remote:error')[0];
  assert.equal(err.payload.code, 'permission_screen');
});

test('kaputte Nachrichten legen die Verbindung nicht lahm', async () => {
  const { ws } = wire();
  ws.emit('message', Buffer.from('kein json'), false);
  ws.emit('message', Buffer.from('{"type":"gibtsnicht"}'), false);
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));

  assert.equal(ws.typed('remote:started').length, 1, 'danach geht es normal weiter');
});

test('ein Socket-Fehler bringt den Prozess nicht zum Absturz und raeumt die Sitzung ab', async () => {
  const { ws, capture, input } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));

  // EventEmitter throws synchronously for an 'error' event with no listener —
  // if handleRemoteConnection did not register one, this line itself would throw.
  ws.emit('error', new Error('ECONNRESET'));
  await new Promise((r) => setImmediate(r));

  assert.equal(capture.stopped, true, 'kein verwaister Aufnahmeprozess nach Socket-Fehler');
  assert.ok(input.calls.includes('stop'));
});

test('C1: ein RemoteCaptureError aus der Aufnahme traegt seinen Code bis zum Client durch, statt zu capture_unavailable zu verflachen', async () => {
  const ws = new FakeWs();
  handleRemoteConnection(ws as any, {
    makeCapture: () => ({
      async start() { throw new RemoteCaptureError('permission_screen', 'Bildschirmaufnahme ist nicht freigegeben'); },
      onData() {}, onError() {}, requestKeyframe() {}, setBitrate() {}, async stop() {},
    }) as unknown as ScreenCapture,
    makeInput: fakeInput,
    isEnabled: () => true,
  });

  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));

  const err = ws.typed('remote:error')[0];
  assert.equal(err.payload.code, 'permission_screen',
    'ohne den mitgetragenen Code haette der Client hier faelschlich "Auf dem PC fehlt ffmpeg" gesehen');
  assert.match(err.payload.message, /Bildschirmaufnahme/);
});

test('C1: ein Fehler OHNE bekannten Code landet weiterhin sinnvoll als capture_unavailable', async () => {
  const ws = new FakeWs();
  handleRemoteConnection(ws as any, {
    makeCapture: () => ({
      async start() { throw new Error('Helfer antwortet nicht (Zeitlimit ueberschritten)'); },
      onData() {}, onError() {}, requestKeyframe() {}, setBitrate() {}, async stop() {},
    }) as unknown as ScreenCapture,
    makeInput: fakeInput,
    isEnabled: () => true,
  });

  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));

  assert.equal(ws.typed('remote:error')[0].payload.code, 'capture_unavailable');
});

test('wirft die Aufnahme-Fabrik synchron, bekommt der Client capture_unavailable statt Schweigen', async () => {
  const ws = new FakeWs();
  handleRemoteConnection(ws as any, {
    makeCapture: () => { throw new Error('kein Bildschirmzugriff'); },
    makeInput: fakeInput,
    isEnabled: () => true,
  });

  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));

  assert.equal(ws.typed('remote:started').length, 0, 'keine stumme Verbindung');
  const err = ws.typed('remote:error')[0];
  assert.equal(err.payload.code, 'capture_unavailable');
});

test('zwei remote:start unmittelbar nacheinander hinterlassen keine unbeendete Aufnahme', async () => {
  const ws = new FakeWs();
  const captures: ReturnType<typeof fakeCapture>[] = [];
  const makeCapture = () => {
    const c = fakeCapture();
    captures.push(c);
    return c;
  };
  handleRemoteConnection(ws as any, { makeCapture, makeInput: fakeInput, isEnabled: () => true });

  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.scharf });
  await new Promise((r) => setImmediate(r));

  assert.equal(captures.length, 2, 'zwei Aufnahme-Instanzen wurden angelegt');
  assert.equal(captures[0].stopped, true, 'die erste Aufnahme wurde beendet, nicht verwaist');
  assert.equal(captures[1].stopped, false, 'die zweite (aktuelle) Aufnahme laeuft noch');
  assert.equal(ws.typed('remote:started').length, 2, 'genau eine laufende Sitzung am Ende — beide Starts wurden bestaetigt');
});

test('ein verspaeteter Fehler der ersetzten Aufnahme raeumt nicht die neue Sitzung ab', async () => {
  const ws = new FakeWs();
  const captures: ReturnType<typeof fakeCapture>[] = [];
  const makeCapture = () => {
    const c = fakeCapture();
    captures.push(c);
    return c;
  };
  handleRemoteConnection(ws as any, { makeCapture, makeInput: fakeInput, isEnabled: () => true });

  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  assert.equal(captures.length, 1, 'Sitzung A ist gestartet');
  const [captureA] = captures;

  // remote:start fuer B einreihen und unmittelbar danach — noch bevor B
  // verarbeitet wurde — den (verspaeteten) Fehler von A auslösen.
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.sparsam });
  captureA.errCb('helper_crashed', 'Aufnahmeprozess abgestuerzt');
  await new Promise((r) => setImmediate(r));

  assert.equal(captures.length, 2, 'Sitzung B wurde angelegt');
  const [, captureB] = captures;

  assert.equal(captureA.stopped, true, 'die alte Sitzung A ist beendet');
  assert.equal(captureB.stopped, false, 'die neue Sitzung B laeuft unangetastet weiter');

  const started = ws.typed('remote:started');
  assert.equal(
    started.filter((m) => m.payload.fps === QUALITY_PRESETS.sparsam.fps).length,
    1,
    'genau ein remote:started fuer B',
  );
  assert.equal(ws.typed('remote:stopped').length, 0, 'kein stilles Abraeumen von B danach');
});

test('packAccessUnit setzt Kennzeichen und Zeitstempel in den Kopf', () => {
  const nutzdaten = Buffer.from([9, 9, 9]);
  const voll = packAccessUnit({ data: nutzdaten, keyframe: true }, 1000);
  assert.equal(voll[0], 0x81, 'Typ 1 mit gesetztem Vollbild-Bit');
  assert.equal(voll.readUInt32BE(1), 1000);
  assert.deepEqual(voll.subarray(5), nutzdaten);

  const zwischen = packAccessUnit({ data: nutzdaten, keyframe: false }, 66);
  assert.equal(zwischen[0], 0x01, 'ohne Vollbild-Bit');
  assert.equal(zwischen.readUInt32BE(1), 66);
});

test('Bilddaten gehen unkomprimiert als Binaerframe raus', async () => {
  const { ws, capture } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  ws.sent.length = 0;

  // Ein Vollbild, gefolgt vom Anfang des naechsten Bildes (das erst den Abschluss ausloest).
  const nal = (t: number) => Buffer.concat([Buffer.from([0, 0, 0, 1, 0x60 | t]), Buffer.alloc(4, 0xaa)]);
  capture.dataCb(Buffer.concat([nal(7), nal(8), nal(5)]));
  capture.dataCb(nal(1));

  const binaer = ws.sent.filter((m) => Buffer.isBuffer(m));
  assert.equal(binaer.length, 1, 'genau eine fertige Access Unit');
  assert.equal(binaer[0][0], 0x81, 'als Vollbild gekennzeichnet');
});

test('bei vollem Sendepuffer fallen Zwischenbilder weg, Vollbilder nicht', async () => {
  const { ws, capture } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  ws.sent.length = 0;
  ws.bufferedAmount = 900 * 1024;                       // ueber der Verwurfsschwelle

  const nal = (t: number) => Buffer.concat([Buffer.from([0, 0, 0, 1, 0x60 | t]), Buffer.alloc(4, 0xaa)]);
  capture.dataCb(Buffer.concat([nal(1), nal(1)]));       // zwei Zwischenbilder
  assert.equal(ws.sent.filter((m) => Buffer.isBuffer(m)).length, 0, 'Zwischenbilder verworfen');

  capture.dataCb(Buffer.concat([nal(7), nal(8), nal(5), nal(1)]));
  assert.ok(ws.sent.filter((m) => Buffer.isBuffer(m)).length >= 1, 'das Vollbild kommt durch');
});

test('Eingabe-Ereignisse landen beim Injektor', async () => {
  const { ws, input } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));

  send(ws, { t: 'd', dx: 10, dy: -4 });
  send(ws, { t: 'b', b: 'r', d: true });
  send(ws, { t: 's', dx: 0, dy: -3 });
  send(ws, { t: 'k', c: 'KeyA', d: true, mods: { s: false, c: false, a: false, m: true } });
  send(ws, { t: 'x', s: 'Hallo' });
  send(ws, { t: 'm', x: 0.5, y: 0.25 });

  assert.deepEqual(input.calls, [
    'rel 10 -4', 'btn right true', 'scroll 0 -3', 'key KeyA true', 'text Hallo', 'abs 0.5 0.25',
  ]);
});

test('Eingaben ohne laufende Sitzung werden verworfen', () => {
  const { ws, input } = wire();
  send(ws, { t: 'd', dx: 10, dy: 10 });
  assert.deepEqual(input.calls, [], 'ohne Aufnahme gibt es nichts zu steuern');
});

test('ist der Fernzugriff serverseitig abgeschaltet, weist die Verbindung sofort ab', () => {
  const { ws, capture } = wire({ enabled: false });
  assert.equal(ws.typed('remote:error')[0]?.payload.code, 'disabled',
    'kein Warten auf ein remote:start noetig');
  assert.equal(ws.readyState, 3, 'die Verbindung wird geschlossen, nicht nur beantwortet');
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  assert.equal(capture.started, null, 'auch ein nachtraeglicher remote:start aendert daran nichts');
});

test('N2: eine abgeschaltete Verbindung hat trotzdem einen Fehler-Zuhoerer — sonst wirft ein Socket-Fehler den ganzen Server um', () => {
  const { ws } = wire({ enabled: false });
  // EventEmitter wirft synchron fuer ein 'error'-Ereignis ohne Zuhoerer —
  // wenn handleRemoteConnection auf dem fruehen Abweisungs-Pfad keinen
  // registriert haette, waere genau diese Zeile der Beweis (sie wuerfe).
  assert.doesNotThrow(() => ws.emit('error', new Error('ECONNRESET')));
});

test('computeRttMs liest den Sende-Zeitstempel aus der Ping-Nutzlast', () => {
  assert.equal(computeRttMs(Buffer.from('1000'), 1045), 45);
  assert.equal(computeRttMs(Buffer.from('kein-zeitstempel'), 1045), null,
    'Unfug wird nicht als Umlaufzeit gemeldet');
  assert.equal(computeRttMs(Buffer.from('2000'), 1990), 0,
    'negative Werte (Uhrensprung) werden auf 0 gekappt, nicht negativ gemeldet');
});

test('N3: eine leere Ping-Nutzlast (z.B. vom serverweiten Heartbeat ohne Payload) ist keine Umlaufzeit', () => {
  // Number('') ist 0, und Number.isFinite(0) ist true — ohne die eigene
  // Laengenpruefung rutschte das durch und meldete rttMs als ungefaehr
  // Date.now() selbst (der leere Pong des 15s-Heartbeats in ws.server.ts).
  assert.equal(computeRttMs(Buffer.alloc(0), Date.now()), null);
});

test('remote:status meldet eine echte Umlaufzeit statt einer festen Null', async (t) => {
  // 'Date' mitgefaked, sonst laeuft die echte Wanduhr waehrend tick() nicht
  // mit — computeRttMs wuerde dann trotz tick() praktisch 0ms sehen.
  // 'setImmediate' bleibt real: der Mikrotask-Flush unten haengt daran.
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });

  const { ws } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));

  assert.equal(ws.pings.length, 1, 'ein Ping direkt beim Start, nicht erst nach einer Sekunde');
  const sentAt = Number(ws.pings[0].toString());
  assert.ok(Number.isFinite(sentAt), 'der Sende-Zeitstempel steckt in der Ping-Nutzlast');

  t.mock.timers.tick(37);                             // "Netzlaufzeit" bis die Antwort eintrifft
  ws.emit('pong', Buffer.from(String(sentAt)));

  ws.sent.length = 0;
  t.mock.timers.tick(1000);                            // der naechste remote:status-Takt

  const status = ws.typed('remote:status')[0];
  assert.ok(status, 'remote:status ist angekommen');
  assert.equal(status.payload.rttMs, 37, 'die gemessene Umlaufzeit steckt jetzt im Status, nicht 0');
});

test('remote:started wird mit der Quell-IP protokolliert', async (t) => {
  const calls: string[] = [];
  t.mock.method(logger, 'info', (msg: string) => { calls.push(msg); });

  const ws = new FakeWs();
  const capture = fakeCapture();
  handleRemoteConnection(ws as any, {
    makeCapture: () => capture,
    makeInput: fakeInput,
    isEnabled: () => true,
  }, '203.0.113.7');

  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));

  assert.ok(calls.some((m) => m.includes('203.0.113.7')),
    'Abschnitt 9 der Spezifikation verlangt Zeit und Quell-IP im Protokoll');
});
