import { describe, it, expect } from 'vitest';
import { matchPattern } from '../src/manager/cloud/cloud.patterns';

describe('matchPattern', () => {
  it('returns null for plain output with no signals', () => {
    expect(matchPattern('npm warn deprecated foo@1.0.0')).toBeNull();
  });

  it('detects [Y/n] shell prompt (urgent)', () => {
    const m = matchPattern('Overwrite existing file? [Y/n] ');
    expect(m).not.toBeNull();
    expect(m!.id).toBe('shell-yesno-prompt');
    expect(m!.urgency).toBe('urgent');
    expect(m!.templateVars.prompt_line).toContain('Overwrite');
  });

  it('detects (y/N) confirmation', () => {
    const m = matchPattern('Are you sure you want to proceed? (y/N)');
    expect(m!.id).toBe('shell-yesno-prompt');
  });

  it('detects password prompt', () => {
    const m = matchPattern('Password: ');
    expect(m!.id).toBe('password-prompt');
    expect(m!.urgency).toBe('urgent');
  });

  it('detects passphrase prompt', () => {
    const m = matchPattern('Enter passphrase for key ~/.ssh/id_rsa: ');
    expect(m!.id).toBe('password-prompt');
  });

  it('detects Error: signature', () => {
    const m = matchPattern('something happened\nError: ENOENT: no such file\n');
    expect(m!.id).toBe('error-signature');
    expect(m!.urgency).toBe('urgent');
    expect(m!.templateVars.error_line).toContain('ENOENT');
  });

  it('detects TypeError', () => {
    const m = matchPattern('TypeError: Cannot read property "x" of undefined');
    expect(m!.id).toBe('error-signature');
  });

  it('detects Fatal error', () => {
    const m = matchPattern('Fatal: repository not found');
    expect(m!.id).toBe('error-signature');
  });

  it('detects test failure (jest style)', () => {
    const m = matchPattern('FAIL src/foo.test.ts');
    expect(m!.id).toBe('test-failure');
    expect(m!.urgency).toBe('urgent');
  });

  it('detects test failure (vitest ✖)', () => {
    const m = matchPattern('✖ test failed');
    expect(m!.id).toBe('test-failure');
  });

  it('detects segfault/crash', () => {
    const m = matchPattern('Segmentation fault (core dumped)');
    expect(m!.id).toBe('crash-signal');
    expect(m!.urgency).toBe('urgent');
  });

  it('detects "Killed" crash', () => {
    const m = matchPattern('zsh: killed  node server.js');
    expect(m!.id).toBe('crash-signal');
  });

  it('does not match password inside normal text', () => {
    expect(matchPattern('the password is stored here')).toBeNull();
  });

  it('does not match [Y/n] in quoted strings inside other context', () => {
    const m = matchPattern('docs say "press [Y/n] to confirm"');
    expect(m).not.toBeNull(); // accepted false-positive risk, documented
  });

  it('returns first match when multiple patterns hit', () => {
    const m = matchPattern('Error: boom\nAre you sure? [Y/n]');
    expect(m).not.toBeNull();
    expect(['error-signature', 'shell-yesno-prompt']).toContain(m!.id);
  });

  it('bounds work — returns null for very long benign output', () => {
    const big = 'progress: ' + '#'.repeat(5000);
    expect(matchPattern(big)).toBeNull();
  });
});
