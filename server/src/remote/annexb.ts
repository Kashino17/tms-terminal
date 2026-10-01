/**
 * Splits a raw H.264 Annex-B byte stream into access units (one per frame).
 *
 * A frame's last NAL only ends where the next start code begins, so a strict
 * splitter would hold every frame until the following one arrives — 33 ms of
 * pure latency at 30 fps. Hence the idle flush: if no new bytes arrive for
 * `idleMs`, the open access unit is considered complete. Time is passed in so
 * this stays testable without waiting.
 *
 * Both platform encoders are configured for a single slice per frame, which is
 * what makes "VCL NAL seen" equal "frame complete".
 */
export interface AccessUnit { data: Buffer; keyframe: boolean }

export interface AnnexBSplitter {
  push(chunk: Buffer, nowMs: number): AccessUnit[];
  tick(nowMs: number): AccessUnit[];
}

const IDR = 5;
const NON_IDR = 1;
const SPS = 7;

/** Index of the next 00 00 01 at or after `from`, or -1. */
function indexOfStart(buf: Buffer, from: number): number {
  for (let i = from; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) return i;
  }
  return -1;
}

export function createAnnexBSplitter(idleMs = 6): AnnexBSplitter {
  let carry: Buffer = Buffer.alloc(0);
  let pending: Buffer[] = [];
  let keyframe = false;
  let lastByteAt = 0;

  function flush(): AccessUnit | null {
    if (!pending.length) return null;
    const au: AccessUnit = { data: Buffer.concat(pending), keyframe };
    pending = [];
    keyframe = false;
    return au;
  }

  /** Adds one complete NAL (start code included) and reports a finished unit. */
  function consume(nalUnit: Buffer): AccessUnit | null {
    const start = nalUnit[2] === 1 ? 3 : 4; // 00 00 01 vs 00 00 00 01
    const type = nalUnit[start] & 0x1f;

    // A new parameter set begins the next frame — close the current one first.
    const out = type === SPS && pending.length ? flush() : null;

    pending.push(nalUnit);
    if (type === IDR) keyframe = true;

    // Single slice per frame: the VCL NAL is the last one of its access unit.
    if (type === IDR || type === NON_IDR) return out ?? flush();
    return out;
  }

  return {
    push(chunk, nowMs) {
      lastByteAt = nowMs;
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;

      const out: AccessUnit[] = [];
      let i = indexOfStart(carry, 0);
      if (i < 0) return out;

      // If previous byte is zero, it's a 4-byte start code (00 00 00 01).
      if (i > 0 && carry[i - 1] === 0) i--;

      let next = indexOfStart(carry, i + 3);
      while (next >= 0) {
        // A 4-byte start code shows up as 00 00 01 preceded by a zero byte.
        const end = next > i && carry[next - 1] === 0 ? next - 1 : next;
        const au = consume(carry.subarray(i, end));
        if (au) out.push(au);
        i = end;
        next = indexOfStart(carry, i + 3);
      }
      carry = carry.subarray(i);
      return out;
    },

    tick(nowMs) {
      if (!carry.length && !pending.length) return [];
      if (nowMs - lastByteAt < idleMs) return [];
      if (carry.length) {
        const au = consume(carry);
        carry = Buffer.alloc(0);
        if (au) return [au];
      }
      const rest = flush();
      return rest ? [rest] : [];
    },
  };
}
