import { Audio } from 'expo-av';

interface QueueItem {
  audio: string;
  sentence: string | null;
}

/**
 * Queue of base64-encoded WAV chunks. Plays sequentially. Can be paused
 * (stays on the current chunk) and resumed. New chunks arriving during pause
 * wait in the queue until resume. Each chunk can carry sentence metadata that
 * fires through onChunkStart when the chunk begins playing.
 */
export class AudioPlayerQueue {
  private queue: QueueItem[] = [];
  private current: Audio.Sound | null = null;
  private paused = false;
  private playing = false;
  private onFinished?: () => void;
  private onChunkStart?: (sentence: string) => void;

  setOnFinished(cb?: () => void) { this.onFinished = cb; }
  setOnChunkStart(cb?: (sentence: string) => void) { this.onChunkStart = cb; }

  async enqueue(base64Wav: string, sentence: string | null = null): Promise<void> {
    this.queue.push({ audio: base64Wav, sentence });
    if (!this.playing && !this.paused) {
      await this.playNext();
    }
  }

  async pause(): Promise<void> {
    this.paused = true;
    if (this.current) {
      try { await this.current.pauseAsync(); } catch {}
    }
  }

  async resume(): Promise<void> {
    this.paused = false;
    if (this.current) {
      try { await this.current.playAsync(); } catch {}
    } else if (this.queue.length > 0) {
      await this.playNext();
    }
  }

  async stop(): Promise<void> {
    this.paused = false;
    this.playing = false;
    this.queue = [];
    if (this.current) {
      try { await this.current.unloadAsync(); } catch {}
      this.current = null;
    }
  }

  queueLength(): number { return this.queue.length; }
  isPlaying(): boolean { return this.playing; }
  isPaused(): boolean { return this.paused; }
  /** Queue is empty AND no chunk currently playing. Safe signal for "audio is done". */
  isIdle(): boolean { return !this.playing && this.queue.length === 0; }

  private async playNext(): Promise<void> {
    if (this.paused || this.queue.length === 0) {
      this.playing = false;
      this.onFinished?.();
      return;
    }
    this.playing = true;
    const next = this.queue.shift()!;
    try {
      if (this.current) {
        try { await this.current.unloadAsync(); } catch {}
      }
      const uri = `data:audio/wav;base64,${next.audio}`;
      const { sound } = await Audio.Sound.createAsync({ uri });
      this.current = sound;
      // Fire the chunk-start callback synchronously with sound.playAsync()
      // so the karaoke highlight advances in lockstep with audible playback.
      if (next.sentence && this.onChunkStart) {
        this.onChunkStart(next.sentence);
      }
      await sound.playAsync();
      sound.setOnPlaybackStatusUpdate((status) => {
        if ('didJustFinish' in status && status.didJustFinish) {
          this.playNext();
        }
      });
    } catch (e) {
      // Bad chunk — skip to next.
      this.playNext();
    }
  }
}
