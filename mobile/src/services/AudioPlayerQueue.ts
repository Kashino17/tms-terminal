import { Audio } from 'expo-av';

/**
 * Queue of base64-encoded WAV chunks. Plays sequentially. Can be paused
 * (stays on the current chunk) and resumed. New chunks arriving during pause
 * wait in the queue until resume.
 */
export class AudioPlayerQueue {
  private queue: string[] = [];
  private current: Audio.Sound | null = null;
  private paused = false;
  private playing = false;
  private onFinished?: () => void;

  setOnFinished(cb: () => void) { this.onFinished = cb; }

  async enqueue(base64Wav: string): Promise<void> {
    this.queue.push(base64Wav);
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
      const uri = `data:audio/wav;base64,${next}`;
      const { sound } = await Audio.Sound.createAsync({ uri });
      this.current = sound;
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
