import { describe, it, expect } from 'vitest';
import {
  buildToolCompletionPayload,
  detectFailureInTerminalOutput,
  OUTPUT_TAIL_CHARS,
} from '../src/notifications/tool-completion-push';

describe('buildToolCompletionPayload', () => {
  it('prefixes title with ✓ on success', () => {
    const p = buildToolCompletionPayload({
      toolName: 'write_to_terminal',
      output: 'done',
      success: true,
      source: 'manager',
    });
    expect(p.title).toBe('✓ write_to_terminal');
    expect(p.body).toBe('done');
  });

  it('prefixes title with ✗ on failure', () => {
    const p = buildToolCompletionPayload({
      toolName: 'git_info',
      output: 'Fehler: Repo not found',
      success: false,
      source: 'manager',
    });
    expect(p.title).toBe('✗ git_info');
    expect(p.body).toContain('Fehler');
  });

  it(`truncates output to last ${OUTPUT_TAIL_CHARS} chars`, () => {
    const longOutput = 'A'.repeat(1000) + '\n' + 'B'.repeat(1000);
    const p = buildToolCompletionPayload({
      toolName: 'Claude',
      output: longOutput,
      success: true,
      source: 'terminal',
    });
    expect(p.body.length).toBeLessThanOrEqual(OUTPUT_TAIL_CHARS);
  });

  it('falls back to placeholder body when output empty', () => {
    const p = buildToolCompletionPayload({
      toolName: 'send_enter',
      output: '',
      success: true,
      source: 'manager',
    });
    expect(p.body).toBe('(keine Ausgabe)');
  });

  it('emits type + source + success flags in data payload', () => {
    const p = buildToolCompletionPayload({
      toolName: 'Codex',
      output: 'ok',
      success: true,
      source: 'terminal',
    });
    expect(p.data).toEqual({
      type: 'tool_completion',
      toolName: 'Codex',
      source: 'terminal',
      success: 'true',
    });
  });
});

describe('detectFailureInTerminalOutput', () => {
  it('returns true on "error"', () => {
    expect(detectFailureInTerminalOutput('fatal: error writing output')).toBe(true);
  });

  it('returns true on "command not found"', () => {
    expect(detectFailureInTerminalOutput('zsh: command not found: xyz')).toBe(true);
  });

  it('returns false on plain success output', () => {
    expect(detectFailureInTerminalOutput('Build succeeded.\nWrote 12 files.')).toBe(false);
  });

  it('only inspects tail (last 500 chars) — early error text is ignored', () => {
    const earlyError = 'error at start\n' + 'x'.repeat(600) + '\nall good';
    expect(detectFailureInTerminalOutput(earlyError)).toBe(false);
  });
});
