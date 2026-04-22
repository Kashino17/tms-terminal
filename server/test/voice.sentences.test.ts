import { describe, it, expect } from 'vitest';
import { SentenceBuffer } from '../src/manager/voice.sentences';

describe('SentenceBuffer', () => {
  it('emits no sentences while no terminal punctuation seen', () => {
    const buf = new SentenceBuffer();
    expect(buf.push('Hallo du')).toEqual([]);
    expect(buf.push(' bist')).toEqual([]);
  });

  it('emits a sentence when period is seen', () => {
    const buf = new SentenceBuffer();
    buf.push('Hallo du bist');
    expect(buf.push(' schön.')).toEqual(['Hallo du bist schön.']);
  });

  it('emits multiple sentences from one push', () => {
    const buf = new SentenceBuffer();
    expect(buf.push('Eins. Zwei! Drei?')).toEqual(['Eins.', 'Zwei!', 'Drei?']);
  });

  it('leaves trailing incomplete sentence in buffer', () => {
    const buf = new SentenceBuffer();
    expect(buf.push('Eins. Zwei')).toEqual(['Eins.']);
    expect(buf.push(' ist da.')).toEqual(['Zwei ist da.']);
  });

  it('flushes remaining text via flush()', () => {
    const buf = new SentenceBuffer();
    buf.push('Hallo');
    expect(buf.flush()).toEqual(['Hallo']);
    expect(buf.flush()).toEqual([]); // already flushed
  });

  it('ignores decimal points inside numbers', () => {
    const buf = new SentenceBuffer();
    expect(buf.push('Die Zahl ist 3.14 und endet hier.')).toEqual([
      'Die Zahl ist 3.14 und endet hier.',
    ]);
  });

  it('handles ellipsis as single break', () => {
    const buf = new SentenceBuffer();
    expect(buf.push('Also... ich denke nach.')).toEqual([
      'Also...',
      'ich denke nach.',
    ]);
  });
});
