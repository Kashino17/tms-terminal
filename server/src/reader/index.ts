/** The reader's one entry point: the last answers of the Claude session in a terminal. */
import { parseAnswers, type Answer } from './transcript';
import { listProcesses, findTranscript, readTail, claudeConfigDir, type NoTranscript } from './locate';

export interface ReaderResult { answers: Answer[]; open: boolean; reason?: NoTranscript | 'error' }

/** Enough for the last dozen answers even in very long sessions. */
const TAIL_BYTES = 8 * 1024 * 1024;

/** Terminal → the log last read there: still readable after Claude was quit. */
const lastFile = new Map<string, string>();

export async function readAnswers(sessionId: string, shellPid: number): Promise<ReaderResult> {
  try {
    const found = findTranscript(shellPid, await listProcesses(), claudeConfigDir());
    let file: string | undefined;
    if ('file' in found) { file = found.file; lastFile.set(sessionId, file); }
    else if (found.reason === 'no-claude') file = lastFile.get(sessionId);
    if (!file) return { answers: [], open: false, reason: 'reason' in found ? found.reason : 'no-claude' };
    const parsed = parseAnswers(readTail(file, TAIL_BYTES));
    return parsed.answers.length || parsed.open ? parsed : { ...parsed, reason: 'empty' };
  } catch {
    return { answers: [], open: false, reason: 'error' };
  }
}

export function forgetReader(sessionId: string): void { lastFile.delete(sessionId); }
