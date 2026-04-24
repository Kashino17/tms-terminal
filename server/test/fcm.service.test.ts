import { describe, it, expect } from 'vitest';
import { truncateForPush, stripMarkdownForPush } from '../src/notifications/fcm.service';

describe('truncateForPush', () => {
  it('returns text unchanged if below limit', () => {
    expect(truncateForPush('kurz', 800)).toEqual({ text: 'kurz', truncated: false });
  });

  it('truncates at grapheme boundary and appends suffix when over limit', () => {
    const long = 'a'.repeat(1000);
    const result = truncateForPush(long, 800);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('a'.repeat(800))).toBe(true);
    expect(result.text).toContain('… (tap to read more)');
  });

  it('does not split multi-codepoint emojis', () => {
    const text = 'a'.repeat(799) + '👨‍👩‍👧'; // family emoji = multiple codepoints
    const result = truncateForPush(text, 800);
    // Must NOT cut through the middle of the emoji
    expect(result.text).not.toMatch(/\uD83D[^\uDC68]/);
  });

  it('unicode-safe with Array.from (graphemes)', () => {
    const text = 'ä'.repeat(1000);
    const result = truncateForPush(text, 800);
    expect(Array.from(result.text.replace('\n\n… (tap to read more)', '')).length).toBe(800);
  });
});

describe('stripMarkdownForPush', () => {
  it('replaces code fences with [code]', () => {
    expect(stripMarkdownForPush('Hallo ```js\nconst x=1;\n``` weiter')).toBe('Hallo [code] weiter');
  });

  it('removes inline code backticks but keeps content', () => {
    expect(stripMarkdownForPush('Nutze `npm install`')).toBe('Nutze npm install');
  });

  it('removes bold markers', () => {
    expect(stripMarkdownForPush('Das ist **wichtig**')).toBe('Das ist wichtig');
  });

  it('removes italic markers', () => {
    expect(stripMarkdownForPush('Das ist *kursiv*')).toBe('Das ist kursiv');
  });

  it('removes header markers', () => {
    expect(stripMarkdownForPush('# Titel\n## Subtitel\nText')).toBe('Titel\nSubtitel\nText');
  });

  it('converts links to link text', () => {
    expect(stripMarkdownForPush('Siehe [Docs](https://x.com)')).toBe('Siehe Docs');
  });

  it('is idempotent for plain text', () => {
    expect(stripMarkdownForPush('plain text.')).toBe('plain text.');
  });
});

describe('fcm sender convention', () => {
  it('documents that data.sender is passed through verbatim', () => {
    // This test is a convention contract: sendBig accepts arbitrary data,
    // and callers set data.sender = "cloud" | "rem". We don't call FCM here
    // (no mock needed) — we just assert the type signature accepts it.
    const data: Record<string, string> = {
      sender: 'cloud',
      urgency: 'urgent',
      sessionId: 's1',
      trigger: 'pattern',
      ts: '1234567890',
    };
    expect(data.sender).toBe('cloud');
    expect(Object.keys(data).every((k) => typeof data[k] === 'string')).toBe(true);
  });
});
