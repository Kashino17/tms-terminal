/**
 * Ehrlicher Ping: Median der letzten N Rohmessungen. Die frühere EMA (α 0,3)
 * glättete Ausreißer weg und hinkte einem Wechsel ins Relais lange hinterher.
 * JavaScript, damit scripts/rtt.test.mjs es unter node:test prüft.
 */
export class RttWindow {
  constructor(size = 5) { this.size = size; this.values = []; }
  push(ms) {
    this.values.push(ms);
    if (this.values.length > this.size) this.values.shift();
  }
  median() {
    if (!this.values.length) return undefined;
    const v = [...this.values].sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
  }
}
