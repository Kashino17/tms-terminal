import type { CloudPatternId, PatternMatch } from './cloud.types';

interface PatternDef {
  id: CloudPatternId;
  urgency: 'urgent' | 'info';
  regex: RegExp;
  extract: (chunk: string, match: RegExpMatchArray) => Record<string, string>;
}

const PATTERNS: PatternDef[] = [
  {
    id: 'error-signature',
    urgency: 'urgent',
    regex: /^(Error|Fatal|TypeError|ReferenceError|SyntaxError|RangeError):\s*(.+)$/m,
    extract: (_chunk, m) => ({ error_line: `${m[1]}: ${m[2].trim()}`.slice(0, 200) }),
  },
  {
    id: 'crash-signal',
    urgency: 'urgent',
    regex: /(Segmentation fault|core dumped|zsh: killed|bash: killed|SIGKILL received)/i,
    extract: (_chunk, m) => ({ crash_signal: m[1] }),
  },
  {
    id: 'test-failure',
    urgency: 'urgent',
    regex: /^(FAIL\s+\S+|✖\s+.+|×\s+.+|Tests:\s+\d+\s+failed)/m,
    extract: (_chunk, m) => ({ fail_line: m[1].slice(0, 200) }),
  },
  {
    id: 'password-prompt',
    urgency: 'urgent',
    regex: /^(Password|Enter passphrase[^:]*|[Pp]assword for [^:]+):\s*$/m,
    extract: (_chunk, m) => ({ prompt_line: m[0].trim() }),
  },
  {
    id: 'shell-yesno-prompt',
    urgency: 'urgent',
    regex: /\[Y\/n\]|\(y\/N\)|\(Y\/n\)|Are you sure\?/i,
    extract: (chunk, _m) => {
      const lastLine = chunk.split('\n').filter((l) => l.trim()).pop() ?? '';
      return { prompt_line: lastLine.trim().slice(0, 200) };
    },
  },
];

/**
 * Match a chunk of cleaned terminal output against all known patterns.
 * Returns the first match (by catalog order) or null.
 *
 * Caller must pass ANSI-stripped text. Runs in O(n*k) where n = chunk length,
 * k = number of patterns. All regexes are bounded.
 */
export function matchPattern(chunk: string): PatternMatch | null {
  // Safety: cap chunk length we scan to avoid pathological regex time on huge buffers
  const scanable = chunk.length > 8000 ? chunk.slice(-8000) : chunk;

  for (const p of PATTERNS) {
    const m = scanable.match(p.regex);
    if (m) {
      return {
        id: p.id,
        urgency: p.urgency,
        matchedLine: m[0].slice(0, 500),
        templateVars: p.extract(scanable, m),
      };
    }
  }
  return null;
}

/** Exposed for tests and introspection. */
export function listPatterns(): ReadonlyArray<{ id: CloudPatternId; urgency: string }> {
  return PATTERNS.map((p) => ({ id: p.id, urgency: p.urgency }));
}
