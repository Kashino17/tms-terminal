import { logger } from '../utils/logger';
import type { VoicePhase, TtsChunk, PauseState, VoiceEmitter } from './voice.types';
import { SentenceBuffer } from './voice.sentences';
import { pickAckAudio } from './voice.ack-audio';

export interface VoiceSessionDeps {
  registry: {
    getActive: () => {
      id: string;
      chatStream: (
        messages: Array<{ role: string; content: string }>,
        systemPrompt: string,
        onChunk: (token: string) => void,
      ) => Promise<string>;
    };
  };
  whisper: {
    transcribe: (audio: Buffer) => Promise<string>;
  };
  tts: {
    synthesizeChunked: (
      text: string,
      onChunk: (info: { idx: number; sentence: string; audio: Buffer }) => void,
      emotionPrompt?: string,
    ) => Promise<void>;
  };
  emit: VoiceEmitter;
  systemPrompt: string;
}

/** Regex that matches a leading `[Ton: <tone>]` tag produced by the voice-mode
 *  system prompt. Case-insensitive on "Ton"; allows surrounding whitespace and
 *  an optional trailing newline. The extracted group 1 is the tone descriptor. */
const EMOTION_TAG_RE = /^\s*\[\s*Ton\s*:\s*([^\]\n]+?)\s*\]\s*\n?/i;
const EMOTION_TAG_MAX_WAIT_CHARS = 160;

const AUTO_PAUSE_TIMEOUT_MS = 5 * 60_000;

export class VoiceSessionController {
  private phase: VoicePhase = 'idle';
  private audioBuffer: Buffer[] = [];
  private ttsQueue: TtsChunk[] = [];
  private pauseState: PauseState | null = null;
  private autoPauseTimer: NodeJS.Timeout | null = null;
  private currentStreamAbort: AbortController | null = null;
  private active = false;
  // Echo-suppression: guards against loudspeaker feedback where TTS bleeds
  // back into the mic. ECHO_WINDOW_MS covers WS RTT + whisper latency.
  // Warning fires at most once per ECHO_WARN_WINDOW_MS (60s) after
  // ECHO_WARN_THRESHOLD suppressions, so the user sees headphone advice
  // only when the loop is genuinely sustained.
  private lastTtsChunkAt = 0;
  private echoSuppressTimestamps: number[] = [];
  private lastEchoWarningAt = 0;
  private readonly ECHO_WINDOW_MS = 800;
  private readonly ECHO_WARN_WINDOW_MS = 60_000;
  private readonly ECHO_WARN_THRESHOLD = 3;

  constructor(private deps: VoiceSessionDeps) {}

  start(): void {
    this.active = true;
    this.reset();
    this.setPhase('listening');
  }

  ingestAudio(chunk: Buffer): void {
    if (this.phase !== 'listening' && this.phase !== 'paused') return;
    this.audioBuffer.push(chunk);
  }

  async endUserTurn(): Promise<void> {
    // Phase-guard: paused → treat as interjection capture
    if (this.phase === 'paused') {
      if (this.audioBuffer.length === 0) return;
      const audio = Buffer.concat(this.audioBuffer);
      this.audioBuffer = [];
      try {
        const text = await this.deps.whisper.transcribe(audio);
        if (text.trim()) {
          this.deps.emit({ type: 'voice:transcript', payload: { text, final: true } });
          this.addInterjection(text);
        }
      } catch (err) {
        logger.warn(`Voice: interjection transcribe failed — ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    if (this.phase !== 'listening' || this.audioBuffer.length === 0) return;

    try {
      const sinceTts = Date.now() - this.lastTtsChunkAt;
      if (this.lastTtsChunkAt > 0 && sinceTts < this.ECHO_WINDOW_MS) {
        logger.info(`Voice: echo suppressed (${sinceTts}ms since last tts chunk)`);
        this.audioBuffer = [];
        this.trackEchoSuppression();
        this.setPhase('listening');
        return;
      }

      this.setPhase('transcribing');
      const audio = Buffer.concat(this.audioBuffer);
      this.audioBuffer = [];
      const userText = await this.deps.whisper.transcribe(audio);
      if (!userText.trim()) {
        this.setPhase('listening');
        return;
      }
      this.deps.emit({ type: 'voice:transcript', payload: { text: userText, final: true } });

      this.setPhase('thinking');
      const messages = [{ role: 'user', content: userText }];

      this.currentStreamAbort = new AbortController();
      const { emotionPrompt, sentences: pendingSentences } = await this.streamWithEmotionTag(
        messages,
      );

      if (pendingSentences.length === 0) {
        this.setPhase('listening');
        return;
      }

      this.setPhase('speaking');
      await this.synthesizeAndEmit(pendingSentences, emotionPrompt);

      if ((this.phase as VoicePhase) !== 'paused') {
        this.setPhase('listening');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Voice: turn failed — ${msg}`);
      this.deps.emit({ type: 'voice:error', payload: { message: msg, recoverable: true } });
      this.setPhase('listening');
    }
  }

  pause(): void {
    if (this.phase === 'thinking' || this.phase === 'tool_call') {
      // Nothing yet said → treat as cancel
      this.cancel();
      return;
    }
    if (this.phase !== 'speaking') return;

    const nextUnsent = this.ttsQueue.findIndex((c) => !c.sent);
    this.pauseState = {
      resumeCursor: nextUnsent >= 0 ? nextUnsent : this.ttsQueue.length,
      remainingText: this.ttsQueue
        .slice(Math.max(0, nextUnsent))
        .map((c) => c.sentence)
        .join(' '),
      pausedAt: Date.now(),
    };
    this.setPhase('paused');

    const ack = pickAckAudio('pause');
    if (ack) {
      this.deps.emit({ type: 'voice:ack_audio', payload: { kind: 'pause', audio: ack.toString('base64') } });
    }

    this.autoPauseTimer = setTimeout(() => {
      logger.info('Voice: auto-timeout after 5min pause → cancel');
      this.cancel();
    }, AUTO_PAUSE_TIMEOUT_MS);
  }

  async resume(strategy: 'clean' | 'with_interjection' = 'clean'): Promise<void> {
    if (this.phase !== 'paused' || !this.pauseState) return;
    if (this.autoPauseTimer) { clearTimeout(this.autoPauseTimer); this.autoPauseTimer = null; }

    const ack = pickAckAudio('resume');
    if (ack) {
      this.deps.emit({ type: 'voice:ack_audio', payload: { kind: 'resume', audio: ack.toString('base64') } });
    }

    this.setPhase('speaking');

    if (strategy === 'with_interjection' && this.pauseState.interjection) {
      const alreadySpoken = this.ttsQueue.slice(0, this.pauseState.resumeCursor).map((c) => c.sentence).join(' ');
      const interjection = this.pauseState.interjection;
      this.ttsQueue = this.ttsQueue.slice(0, this.pauseState.resumeCursor);
      this.pauseState = null;

      const messages = [
        { role: 'assistant', content: alreadySpoken },
        { role: 'user', content: `${interjection}\n(Bitte fortsetzen mit Berücksichtigung meines Einwands.)` },
      ];
      const { emotionPrompt, sentences: newSentences } =
        await this.streamWithEmotionTag(messages);
      await this.synthesizeAndEmit(newSentences, emotionPrompt);
    } else {
      // Clean resume: re-emit queue from cursor.
      const cursor = this.pauseState.resumeCursor;
      this.pauseState = null;
      const lastIdx = this.ttsQueue.length - 1;
      for (let i = cursor; i < this.ttsQueue.length; i++) {
        const c = this.ttsQueue[i];
        this.deps.emit({
          type: 'voice:tts_chunk',
          payload: {
            chunkIdx: c.idx,
            audio: c.audio.toString('base64'),
            sentence: c.sentence,
            isLast: i === lastIdx,
          },
        });
        c.sent = true;
        this.lastTtsChunkAt = Date.now();
      }
    }

    if (this.phase !== 'paused') this.setPhase('listening');
  }

  /** Transcript received during paused state — buffered for sub-behavior (c). */
  addInterjection(text: string): void {
    if (this.phase !== 'paused' || !this.pauseState) return;
    if (text.trim().length < 20 && !text.includes('?')) return; // sub-behavior (b): ignore short
    this.pauseState.interjection = text;
  }

  cancel(): void {
    this.currentStreamAbort?.abort();
    if (this.autoPauseTimer) { clearTimeout(this.autoPauseTimer); this.autoPauseTimer = null; }
    this.reset();
    this.setPhase('listening');
  }

  stop(): void {
    this.active = false;
    this.currentStreamAbort?.abort();
    if (this.autoPauseTimer) { clearTimeout(this.autoPauseTimer); this.autoPauseTimer = null; }
    this.reset();
    this.setPhase('idle');
  }

  isBusy(): boolean {
    return this.phase === 'thinking' || this.phase === 'speaking' || this.phase === 'tool_call';
  }

  /**
   * Run chatStream while peeling off the leading `[Ton: …]` tag that the
   * voice-mode system prompt instructs the LLM to produce. The tag is
   * extracted without ever being emitted on `voice:ai_delta` (so mobile
   * never shows it) and without being pushed through the SentenceBuffer
   * (so TTS never speaks it). Returns both the extracted tone and the
   * sentences that feed synthesizeAndEmit.
   *
   * If the LLM forgets the tag, after EMOTION_TAG_MAX_WAIT_CHARS of
   * buffered output we give up and flush the buffer through the normal
   * path — output is never dropped.
   */
  private async streamWithEmotionTag(
    messages: Array<{ role: string; content: string }>,
  ): Promise<{ emotionPrompt: string; sentences: string[] }> {
    const sentenceBuf = new SentenceBuffer();
    const sentences: string[] = [];
    let emotionPrompt = '';
    let prefixBuf = '';
    let tagResolved = false;

    const handleResolvedText = (text: string) => {
      if (!text) return;
      this.deps.emit({ type: 'voice:ai_delta', payload: { text } });
      sentences.push(...sentenceBuf.push(text));
    };

    await this.deps.registry.getActive().chatStream(
      messages,
      this.deps.systemPrompt,
      (token) => {
        if (tagResolved) {
          handleResolvedText(token);
          return;
        }

        prefixBuf += token;
        const match = prefixBuf.match(EMOTION_TAG_RE);
        if (match) {
          emotionPrompt = match[1].trim();
          const remainder = prefixBuf.slice(match[0].length);
          tagResolved = true;
          handleResolvedText(remainder);
          return;
        }

        // No tag found yet — has the LLM likely ignored the instruction?
        if (prefixBuf.length >= EMOTION_TAG_MAX_WAIT_CHARS) {
          tagResolved = true;
          handleResolvedText(prefixBuf);
        }
      },
    );
    sentences.push(...sentenceBuf.flush());

    // Stream ended without ever resolving — flush whatever we buffered.
    if (!tagResolved && prefixBuf) {
      this.deps.emit({ type: 'voice:ai_delta', payload: { text: prefixBuf } });
      sentences.push(...sentenceBuf.push(prefixBuf));
      sentences.push(...sentenceBuf.flush());
    }

    if (emotionPrompt) {
      logger.info(`Voice: emotion prompt = "${emotionPrompt}"`);
    }
    return { emotionPrompt, sentences };
  }

  private async synthesizeAndEmit(sentences: string[], emotionPrompt?: string): Promise<void> {
    const baseIdx = this.ttsQueue.length;
    await this.deps.tts.synthesizeChunked(sentences.join(' '), (info) => {
      const chunk: TtsChunk = {
        idx: baseIdx + info.idx,
        sentence: info.sentence,
        audio: info.audio,
        sent: false,
      };
      this.ttsQueue.push(chunk);

      if (this.phase === 'paused') return; // don't emit during pause

      this.deps.emit({
        type: 'voice:tts_chunk',
        payload: {
          chunkIdx: chunk.idx,
          audio: chunk.audio.toString('base64'),
          sentence: chunk.sentence,
          isLast: false, // updated below for final
        },
      });
      chunk.sent = true;
      this.lastTtsChunkAt = Date.now();
    }, emotionPrompt);

    // Mark the final chunk as last via an end-marker event.
    const last = this.ttsQueue[this.ttsQueue.length - 1];
    if (last && last.sent) {
      this.deps.emit({
        type: 'voice:tts_chunk',
        payload: {
          chunkIdx: last.idx,
          audio: '',
          sentence: '',
          isLast: true,
        },
      });
    }
  }

  private trackEchoSuppression(): void {
    const now = Date.now();
    this.echoSuppressTimestamps = this.echoSuppressTimestamps.filter(
      (t) => now - t < this.ECHO_WARN_WINDOW_MS,
    );
    this.echoSuppressTimestamps.push(now);

    if (
      this.echoSuppressTimestamps.length >= this.ECHO_WARN_THRESHOLD &&
      now - this.lastEchoWarningAt > this.ECHO_WARN_WINDOW_MS
    ) {
      this.lastEchoWarningAt = now;
      this.deps.emit({
        type: 'voice:error',
        payload: {
          message: 'Kopfhörer empfohlen — Lautsprecher verursacht Echo',
          recoverable: true,
        },
      });
    }
  }

  private setPhase(phase: VoicePhase): void {
    this.phase = phase;
    this.deps.emit({ type: 'voice:phase', payload: { phase } });
  }

  private reset(): void {
    this.audioBuffer = [];
    this.ttsQueue = [];
    this.pauseState = null;
    this.currentStreamAbort = null;
    this.lastTtsChunkAt = 0;
  }
}
