/**
 * Client side of the streamed-dictation protocol (server/src/audio/dictation.ts).
 *
 * The recording file grows while the user speaks; `pump()` sends whatever is
 * new as byte-offset chunks. Offsets make every send idempotent on the server,
 * so the recovery rule is simple: after a reconnect ask the server how many
 * bytes it has (`resume` → `state`) and continue from there. The file is kept
 * until a result (or a final error) arrives, so a server restart just means
 * uploading it again.
 *
 * Pure logic with injected IO — no React Native imports, unit-tested in node.
 */

/** Below the socket's large-send threshold, so pings keep flowing between chunks. */
export const CHUNK_BYTES = 64 * 1024;
const MAX_ATTEMPTS = 3;

export interface DictationIO {
  /** false when the socket is not open (the message was NOT sent). */
  send(msg: object): boolean;
  fileSize(): Promise<number>;
  readBase64(position: number, length: number): Promise<string>;
  now(): number;
}

export type DictationOutcome = 'result' | 'error' | 'restart' | null;

interface ServerMsg { type: string; payload?: { id?: string; [k: string]: any } }

function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export class DictationUpload {
  text: string | null = null;
  error: string | null = null;
  attempts = 1;
  ackSeen = false;
  lastHeard: number;
  private sent = 0;
  private ended = false;
  private totalBytes: number | null = null;
  private pumping: Promise<void> | null = null;

  constructor(
    readonly id: string,
    readonly format: 'adts' | 'file',
    readonly enhance: boolean,
    private io: DictationIO,
  ) {
    this.lastHeard = io.now();
  }

  get done(): boolean { return this.text !== null || this.error !== null; }

  begin(): void {
    this.io.send({ type: 'dictation:start', payload: { id: this.id, format: this.format, enhance: this.enhance } });
  }

  /** Send bytes [sent, fileSize). Serialized: a pump already running is awaited instead. */
  pump(): Promise<void> {
    if (!this.pumping) {
      this.pumping = this.pumpOnce().finally(() => { this.pumping = null; });
    }
    return this.pumping;
  }

  private async pumpOnce(): Promise<void> {
    if (this.done) return;
    const size = this.totalBytes ?? (await this.io.fileSize());
    while (this.sent < size && !this.done) {
      const len = Math.min(CHUNK_BYTES, size - this.sent);
      const data = await this.io.readBase64(this.sent, len);
      const got = base64Bytes(data);
      if (got <= 0) return;
      if (!this.io.send({ type: 'dictation:chunk', payload: { id: this.id, offset: this.sent, data } })) return;
      this.sent += got;
    }
  }

  /** Recording stopped: send the rest, then `end`. Safe to call again after a restart. */
  async finish(): Promise<void> {
    this.ended = true;
    if (this.totalBytes === null) this.totalBytes = await this.io.fileSize();
    await this.pump();
    if (this.done || this.sent < this.totalBytes) return; // offline — resumed later
    this.io.send({ type: 'dictation:end', payload: { id: this.id, totalBytes: this.totalBytes } });
  }

  get isEnded(): boolean { return this.ended; }

  onReconnect(): void {
    if (this.done) return;
    this.io.send({ type: 'dictation:resume', payload: { id: this.id } });
  }

  onServer(msg: ServerMsg): DictationOutcome {
    const p = msg.payload;
    if (!p || p.id !== this.id) return null;
    this.lastHeard = this.io.now();
    switch (msg.type) {
      case 'dictation:ack':
        this.ackSeen = true;
        return null;
      case 'dictation:result':
        if (this.done) return null;
        this.text = typeof p.text === 'string' ? p.text : '';
        return 'result';
      case 'dictation:error':
        if (this.done) return null;
        this.error = typeof p.message === 'string' && p.message ? p.message : 'Transkription fehlgeschlagen';
        return 'error';
      case 'dictation:state':
        this.ackSeen = true;
        if (this.done) return null;
        switch (p.status) {
          case 'done':
            this.text = typeof p.text === 'string' ? p.text : '';
            return 'result';
          case 'error':
            this.error = typeof p.message === 'string' && p.message ? p.message : 'Transkription fehlgeschlagen';
            return 'error';
          case 'receiving':
            // Authoritative server position: continue from there.
            this.sent = typeof p.bytes === 'number' ? p.bytes : 0;
            return 'restart';
          case 'unknown':
            if (this.attempts >= MAX_ATTEMPTS) {
              this.error = 'Transkription fehlgeschlagen (Server hat die Aufnahme verloren)';
              return 'error';
            }
            this.attempts += 1;
            this.sent = 0;
            this.begin();
            return 'restart';
          default:
            return null; // processing — keep waiting
        }
      default:
        return null;
    }
  }
}
