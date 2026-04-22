/**
 * Accumulates streaming text and emits complete sentences when terminal
 * punctuation is seen. Preserves trailing incomplete text for the next push.
 * Used by VoiceSessionController to drive per-sentence TTS synthesis.
 */
export class SentenceBuffer {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const sentences: string[] = [];

    // Regex finds sentence terminators that are NOT preceded by a digit (so
    // "3.14" doesn't split). Matches `.` / `!` / `?` / `...` possibly followed
    // by quotes / closing brackets, then whitespace.
    const pattern = /([^\d\s][.!?]+["')\]]?)(?=\s|$)/g;

    let lastEnd = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(lastEnd, end).trim();
      if (sentence) sentences.push(sentence);
      lastEnd = end;
    }

    this.buffer = this.buffer.slice(lastEnd);
    return sentences;
  }

  /** Return remaining buffered text (call once at stream end). */
  flush(): string[] {
    const remaining = this.buffer.trim();
    this.buffer = '';
    return remaining ? [remaining] : [];
  }

  reset(): void {
    this.buffer = '';
  }
}
