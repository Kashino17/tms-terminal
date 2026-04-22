import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';
import { synthesize } from '../audio/tts-sidecar';

const ACK_DIR = path.join(os.homedir(), '.tms-terminal', 'voice-samples');

const PAUSE_VARIANTS = [
  'Okay, ich höre zu.',
  'Moment, kurz warte.',
  'Mm-hmm, was gibt\'s?',
];

const RESUME_VARIANTS = [
  'Ah, wo war ich stehen geblieben...',
  'Also, wie gesagt...',
  'Genau, weiter im Text.',
];

/** Generate all ack audio variants if they don't exist on disk. Called once at server start. */
export async function ensureAckAudios(): Promise<void> {
  if (!fs.existsSync(ACK_DIR)) {
    fs.mkdirSync(ACK_DIR, { recursive: true, mode: 0o700 });
  }

  const jobs: Array<Promise<void>> = [];
  PAUSE_VARIANTS.forEach((text, i) => {
    const filePath = path.join(ACK_DIR, `pause-ack-${i + 1}.wav`);
    if (!fs.existsSync(filePath)) jobs.push(synthesizeAndSave(text, filePath));
  });
  RESUME_VARIANTS.forEach((text, i) => {
    const filePath = path.join(ACK_DIR, `resume-ack-${i + 1}.wav`);
    if (!fs.existsSync(filePath)) jobs.push(synthesizeAndSave(text, filePath));
  });

  if (jobs.length === 0) {
    logger.info(`Voice: ack audios already cached (${PAUSE_VARIANTS.length + RESUME_VARIANTS.length} files)`);
    return;
  }

  logger.info(`Voice: generating ${jobs.length} ack audio variant(s)...`);
  try {
    await Promise.all(jobs);
    logger.info('Voice: ack audios ready');
  } catch (err) {
    logger.warn(`Voice: ack audio generation failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function synthesizeAndSave(text: string, filePath: string): Promise<void> {
  const result = await synthesize(text);
  const audioBuffer = Buffer.from(result.audioBase64, 'base64');
  fs.writeFileSync(filePath, audioBuffer, { mode: 0o600 });
  logger.info(`Voice: saved ${path.basename(filePath)} (${(audioBuffer.length / 1024).toFixed(1)} KB)`);
}

/** Pick a random ack-audio WAV buffer from the pool of the given kind. */
export function pickAckAudio(kind: 'pause' | 'resume'): Buffer | null {
  const variants = kind === 'pause' ? PAUSE_VARIANTS.length : RESUME_VARIANTS.length;
  const idx = Math.floor(Math.random() * variants) + 1;
  const filePath = path.join(ACK_DIR, `${kind}-ack-${idx}.wav`);
  try {
    return fs.readFileSync(filePath);
  } catch {
    logger.warn(`Voice: ack audio missing at ${filePath}`);
    return null;
  }
}
