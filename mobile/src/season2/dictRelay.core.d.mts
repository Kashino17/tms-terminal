/** Typen für dictRelay.core.mjs (siehe dort). */
export type DictSend = (msg: { type: string; payload: object }) => boolean | void;
export declare function createDictRelay(io: {
  show: (data: object) => void;
  later: (fn: () => void, ms: number) => void;
}): {
  ask(type: string, payload: object | undefined, deviceId: string | null, send: DictSend): void;
  state(from: string, deviceId: string | null, payload: object): void;
  connected(from: string, deviceId: string | null, send: DictSend): void;
};
