// Dictionary relay between the settings page and the machine that transcribes.
//
// The page asks (`dict:get`) or changes something (`dict:add|update|remove`);
// that machine answers with `dict:state`. This decides what the page is told
// when the answer does not come:
//
//  - no dictation machine, or the request could not be sent → "offline"
//    (and the request is repeated once the connection is back);
//  - sent, but the machine has never answered within 4s → it predates the
//    dictionary: "needs an update". A machine that answered once is never
//    called outdated — then the line is just slow.
//
// Pure logic, shared by React Native and the test (scripts/dict-relay.test.mjs).

const ANSWER_WAIT_MS = 4000;

/**
 * @param {{ show: (data: object) => void, later: (fn: () => void, ms: number) => void }} io
 *   show: tell the page; later: a timer.
 */
export function createDictRelay(io) {
  const answered = new Set();   // devices that have sent a dict:state
  let wanted = false;           // a request could not be delivered yet

  return {
    /**
     * The page sent `type`. `deviceId` is the dictation machine (null: none),
     * `send` delivers to it and returns false when its socket is not open.
     */
    ask(type, payload, deviceId, send) {
      if (!deviceId) { io.show({ offline: true }); return; }
      if (send({ type, payload: payload || {} }) === false) {
        wanted = true;
        io.show({ offline: true });
        return;
      }
      if (type === 'dict:get' && !answered.has(deviceId)) {
        io.later(() => { if (!answered.has(deviceId)) io.show({ unsupported: true }); }, ANSWER_WAIT_MS);
      }
    },
    /** `dict:state` arrived from device `from`; only the dictation machine counts. */
    state(from, deviceId, payload) {
      if (!deviceId || from !== deviceId) return;
      answered.add(from);
      wanted = false;
      io.show(payload);
    },
    /** Device `from` is connected (again): ask now if an earlier request got lost. */
    connected(from, deviceId, send) {
      if (!wanted || !deviceId || from !== deviceId) return;
      wanted = send({ type: 'dict:get', payload: {} }) === false;
    },
  };
}
