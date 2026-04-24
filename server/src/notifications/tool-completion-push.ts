/**
 * Tool-completion push notifications.
 *
 * Fired whenever a tool finishes in one of two contexts:
 *   - Manager-Agent tools (write_to_terminal, send_enter, generate_image, …).
 *   - Terminal-side AI tools (Claude CLI, Codex, Gemini) — detected via
 *     PromptDetector's shell-prompt-return signal.
 *
 * Payload shape (user spec, 2026-04-24):
 *   title  = `{exitEmoji} {toolName}`
 *   body   = last OUTPUT_TAIL_CHARS chars of stdout/result
 *   data   = { type: 'tool_completion', toolName, success }
 *
 * Gated by PUSH_INSTANT_MODE (see manager.config.ts → isPushInstantMode()).
 */

import { fcmService } from './fcm.service';
import { logger } from '../utils/logger';

export const OUTPUT_TAIL_CHARS = 300;

export interface ToolCompletionPayload {
  toolName: string;
  output: string;
  success: boolean;
  source: 'manager' | 'terminal';
}

/** Pick an emoji for the title based on success. */
function exitEmoji(success: boolean): string {
  return success ? '✓' : '✗';
}

/** Slice to the last N chars, keeping grapheme-ish boundaries (newline-safe). */
function tailChars(text: string, n: number): string {
  const trimmed = text.replace(/\s+$/, '');
  if (trimmed.length <= n) return trimmed;
  const sliced = trimmed.slice(-n);
  const firstBreak = sliced.indexOf('\n');
  return firstBreak > 0 && firstBreak < 40 ? sliced.slice(firstBreak + 1) : sliced;
}

/**
 * Heuristic: is this terminal output likely a failure?
 *
 * TODO(user): Tune this list. Currently matches common unix/claude-cli/codex
 * error markers, but you may want to add domain-specific signals (e.g.
 * "timeout", "denied", "traceback") or downgrade false-positives ("warning").
 * Terminal-side has no real exit code available — we rely on text signals.
 */
export function detectFailureInTerminalOutput(output: string): boolean {
  const tail = output.slice(-500).toLowerCase();
  return (
    /\berror\b/.test(tail) ||
    /\bfailed\b/.test(tail) ||
    /\bfatal\b/.test(tail) ||
    /command not found/.test(tail) ||
    /permission denied/.test(tail)
  );
}

export function buildToolCompletionPayload(payload: ToolCompletionPayload): {
  title: string;
  body: string;
  data: Record<string, string>;
} {
  const body = tailChars(payload.output || '', OUTPUT_TAIL_CHARS) || '(keine Ausgabe)';
  return {
    title: `${exitEmoji(payload.success)} ${payload.toolName}`,
    body,
    data: {
      type: 'tool_completion',
      toolName: payload.toolName,
      source: payload.source,
      success: String(payload.success),
    },
  };
}

/** Send an FCM push for a tool completion. Fire-and-forget; caller supplies the token set. */
export function sendToolCompletionPush(
  tokens: Iterable<string>,
  payload: ToolCompletionPayload,
  onTokenInvalid?: (token: string) => void,
): void {
  const tokenList = [...tokens];
  if (tokenList.length === 0) return;
  const { title, body, data } = buildToolCompletionPayload(payload);
  logger.info(`ToolCompletion push: ${title} — "${body.slice(0, 60)}…" → ${tokenList.length} token(s)`);
  for (const token of tokenList) {
    fcmService.sendBig(token, title, body, data).catch(() => {
      onTokenInvalid?.(token);
    });
  }
}
