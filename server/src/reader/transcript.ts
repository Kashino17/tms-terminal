/**
 * Reads Claude Code's own conversation log (JSONL) and returns what the reader
 * in the app shows: the last finished answers, each with the instruction that
 * led to it.
 *
 * Why the log and not the terminal picture: on the phone a terminal is ~45
 * columns wide — tables arrive chopped up, long paragraphs wrapped mid-word.
 * The log has the answer exactly as written (Markdown).
 *
 * Line shapes verified against real logs (Claude Code 2.1.3xx):
 *   {type:'user', message:{content:'text' | [{type:'text'}|{type:'tool_result'}]}, isMeta?}
 *   {type:'assistant', message:{stop_reason:'tool_use'|'end_turn', content:[{type:'text'|'thinking'|'tool_use'}]}}
 *   isSidechain:true marks sub-agent traffic. Everything else is bookkeeping.
 */
export interface Answer {
  /** What the user typed for this round; '' when the round was not started by typing. */
  prompt: string;
  /** The answer as Markdown. */
  md: string;
  /** When the answer was written (ms since epoch), 0 if unknown. */
  at: number;
}
export interface ParsedTranscript {
  answers: Answer[];
  /** A round is running right now: its answer does not exist yet. */
  open: boolean;
}

export const MAX_ANSWERS = 12;
export const MAX_ANSWER_CHARS = 60_000;
const MAX_PROMPT_CHARS = 4_000;

interface Round { prompt: string; finals: string[]; lastText: string; at: number; ended: boolean }

function textOf(content: unknown): { text: string; hasToolResult: boolean } {
  if (typeof content === 'string') return { text: content, hasToolResult: false };
  if (!Array.isArray(content)) return { text: '', hasToolResult: false };
  const parts: string[] = [];
  let hasToolResult = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const block = b as { type?: string; text?: unknown };
    if (block.type === 'tool_result') hasToolResult = true;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return { text: parts.join('\n\n'), hasToolResult };
}

/** '' unless a person typed it: no slash-command echoes, no injected notices. */
function typedPrompt(raw: string): string {
  const t = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t || t.startsWith('<')) return '';
  return t.length > MAX_PROMPT_CHARS ? t.slice(0, MAX_PROMPT_CHARS) + ' …' : t;
}

/** Slash commands and their output: they do not start a round at all. */
const LOCAL_COMMAND = /^\s*<(command-name|command-message|local-command-stdout|local-command-stderr|local-command-caveat)\b/;

export function parseAnswers(jsonl: string): ParsedTranscript {
  const rounds: Round[] = [];
  let cur: Round | null = null;

  for (const line of jsonl.split('\n')) {
    // Cheap pre-filter: logs carry megabytes of bookkeeping lines.
    const isUser = line.includes('"type":"user"');
    if (!isUser && !line.includes('"type":"assistant"')) continue;
    let o: { type?: string; isSidechain?: boolean; isMeta?: boolean; timestamp?: string; message?: { stop_reason?: string; content?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.isSidechain || !o.message) continue;

    if (o.type === 'user') {
      const { text, hasToolResult } = textOf(o.message.content);
      if (hasToolResult) continue; // a tool answering — the round goes on
      if (LOCAL_COMMAND.test(text)) continue;
      cur = { prompt: o.isMeta ? '' : typedPrompt(text), finals: [], lastText: '', at: 0, ended: false };
      rounds.push(cur);
      continue;
    }

    if (o.type === 'assistant') {
      const { text } = textOf(o.message.content);
      if (!cur) { cur = { prompt: '', finals: [], lastText: '', at: 0, ended: false }; rounds.push(cur); }
      if (o.message.stop_reason === 'end_turn') cur.ended = true; // also on a thinking-only line
      if (!text.trim()) continue;
      const at = o.timestamp ? Date.parse(o.timestamp) || 0 : 0;
      if (o.message.stop_reason === 'end_turn') { cur.finals.push(text.trim()); cur.at = at; }
      else { cur.lastText = text.trim(); if (!cur.finals.length) cur.at = at; }
    }
  }

  const answers: Answer[] = [];
  let open = false;
  rounds.forEach((r, i) => {
    const isLast = i === rounds.length - 1;
    if (r.finals.length) { answers.push({ prompt: r.prompt, md: r.finals.join('\n\n'), at: r.at }); return; }
    if (isLast) { open = !r.ended; return; } // still running: no answer yet
    // Interrupted and followed by a new instruction: what was said last counts.
    if (r.lastText) answers.push({ prompt: r.prompt, md: r.lastText, at: r.at });
  });

  const tail = answers.slice(-MAX_ANSWERS).map((a) => (a.md.length > MAX_ANSWER_CHARS
    ? { ...a, md: a.md.slice(0, MAX_ANSWER_CHARS) + '\n\n… (gekürzt)' }
    : a));
  return { answers: tail, open };
}
