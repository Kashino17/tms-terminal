import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

export interface TranscriptionResult {
  text: string;
  error?: string;
  language?: string;
}

export class TranscriptionService {
  private whisperModel = process.env.WHISPER_MODEL || 'tiny';
  private whisperBin = process.env.WHISPER_BIN || 'whisper';

  async transcribe(filePath: string): Promise<TranscriptionResult> {
    if (!fs.existsSync(filePath)) {
      return { text: '', error: 'File not found' };
    }

    try {
      const result = await execFileAsync(this.whisperBin, [
        filePath,
        '--model', this.whisperModel,
        '--output_format', 'json',
        '--language', 'auto',
      ]);

      // whisper CLI with --output_format json outputs JSON to stdout
      const jsonStr = result.stdout?.trim() || '';
      if (!jsonStr) {
        return { text: '' };
      }

      const parsed = JSON.parse(jsonStr);
      const text = parsed.text?.trim() || '';

      return { text, language: parsed.language };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Transcription failed for ${filePath}: ${errorMsg}`);
      return { text: '', error: errorMsg };
    }
  }

  async transcribeMultiple(filePaths: string[]): Promise<Map<string, TranscriptionResult>> {
    const results = new Map<string, TranscriptionResult>();

    for (const filePath of filePaths) {
      const result = await this.transcribe(filePath);
      results.set(filePath, result);
    }

    return results;
  }
}

export const transcriptionService = new TranscriptionService();
