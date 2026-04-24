import { describe, it, expect } from 'vitest';
import { templateSummary } from '../src/manager/cloud/cloud.summarizer';
import type { PatternMatch } from '../src/manager/cloud/cloud.types';

describe('templateSummary', () => {
  it('formats error-signature', () => {
    const match: PatternMatch = {
      id: 'error-signature',
      urgency: 'urgent',
      matchedLine: 'Error: ENOENT',
      templateVars: { error_line: 'Error: ENOENT: no such file' },
    };
    const result = templateSummary(match, 'Shell 1');
    expect(result.title).toContain('Shell 1');
    expect(result.body).toContain('ENOENT');
    expect(result.body).toMatch(/error|Error|Fehler/i);
  });

  it('formats shell-yesno-prompt', () => {
    const match: PatternMatch = {
      id: 'shell-yesno-prompt',
      urgency: 'urgent',
      matchedLine: 'Overwrite? [Y/n]',
      templateVars: { prompt_line: 'Overwrite existing? [Y/n]' },
    };
    const result = templateSummary(match, 'tms-terminal');
    expect(result.title).toContain('tms-terminal');
    expect(result.body).toContain('Overwrite');
  });

  it('formats password-prompt', () => {
    const match: PatternMatch = {
      id: 'password-prompt',
      urgency: 'urgent',
      matchedLine: 'Password:',
      templateVars: { prompt_line: 'Password:' },
    };
    const result = templateSummary(match, 'Shell 2');
    expect(result.body).toMatch(/Passwort|password/i);
  });

  it('formats crash-signal', () => {
    const match: PatternMatch = {
      id: 'crash-signal',
      urgency: 'urgent',
      matchedLine: 'Segmentation fault',
      templateVars: { crash_signal: 'Segmentation fault' },
    };
    const result = templateSummary(match, 'Shell 3');
    expect(result.body).toMatch(/crash|gecrasht|Segmentation/i);
  });

  it('formats test-failure', () => {
    const match: PatternMatch = {
      id: 'test-failure',
      urgency: 'urgent',
      matchedLine: 'FAIL src/foo.test.ts',
      templateVars: { fail_line: 'FAIL src/foo.test.ts' },
    };
    const result = templateSummary(match, 'Shell 1');
    expect(result.body).toContain('foo.test.ts');
  });

  it('falls back to generic title for unknown pattern id', () => {
    const match = {
      id: 'unknown-id-xxx' as any,
      urgency: 'urgent' as const,
      matchedLine: 'whatever',
      templateVars: {},
    };
    const result = templateSummary(match as PatternMatch, 'Shell X');
    expect(result.title).toBeTruthy();
    expect(result.body).toBeTruthy();
  });

  it('truncates very long templateVars to prevent push-body overflow', () => {
    const match: PatternMatch = {
      id: 'error-signature',
      urgency: 'urgent',
      matchedLine: 'Error: x',
      templateVars: { error_line: 'Error: ' + 'x'.repeat(2000) },
    };
    const result = templateSummary(match, 'Shell 1');
    expect(result.body.length).toBeLessThanOrEqual(500);
  });
});
