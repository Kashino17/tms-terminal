import type { PatternMatch } from './cloud.types';

export interface SummaryOutput {
  title: string;
  body: string;
}

const MAX_BODY_CHARS = 400;

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function templateSummary(match: PatternMatch, sessionLabel: string): SummaryOutput {
  const label = sessionLabel || 'Shell';
  const vars = match.templateVars;

  switch (match.id) {
    case 'error-signature':
      return {
        title: `🔴 Error · ${label}`,
        body: clip(`Error in ${label}: ${vars.error_line ?? match.matchedLine}`, MAX_BODY_CHARS),
      };
    case 'shell-yesno-prompt':
      return {
        title: `⚠️ Bestätigung · ${label}`,
        body: clip(`${label} fragt: ${vars.prompt_line ?? match.matchedLine}`, MAX_BODY_CHARS),
      };
    case 'password-prompt':
      return {
        title: `🔐 Passwort · ${label}`,
        body: clip(`${label} will ein Passwort: ${vars.prompt_line ?? ''}`.trim(), MAX_BODY_CHARS),
      };
    case 'crash-signal':
      return {
        title: `💥 Crash · ${label}`,
        body: clip(`${label} crashed: ${vars.crash_signal ?? match.matchedLine}`, MAX_BODY_CHARS),
      };
    case 'test-failure':
      return {
        title: `🧪 Test Failure · ${label}`,
        body: clip(`Test failed in ${label}: ${vars.fail_line ?? match.matchedLine}`, MAX_BODY_CHARS),
      };
    case 'claude-prompt-waiting':
    case 'codex-prompt-waiting':
    case 'gemini-prompt-waiting': {
      const tool = match.id.split('-')[0];
      const toolName = tool.charAt(0).toUpperCase() + tool.slice(1);
      return {
        title: `🤖 ${toolName} wartet · ${label}`,
        body: clip(`${toolName} in ${label} wartet: ${vars.last_question ?? match.matchedLine}`, MAX_BODY_CHARS),
      };
    }
    default:
      return {
        title: `Cloud · ${label}`,
        body: clip(`Ereignis in ${label}: ${match.matchedLine}`, MAX_BODY_CHARS),
      };
  }
}

/** Generic template for silence-triggered info reports when LLM path fails. */
export function templateInfoSummary(sessionLabel: string, lastLine: string, chars: number): SummaryOutput {
  const label = sessionLabel || 'Shell';
  const safeLast = clip(lastLine.trim(), 200);
  return {
    title: `📋 Update · ${label}`,
    body: clip(`${label}: ${chars} chars neuer Output. Letzte Zeile: ${safeLast}`, MAX_BODY_CHARS),
  };
}
