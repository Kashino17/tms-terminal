/**
 * Plays the cloned voice on the phone: pieces of MP3 arrive one sentence at a
 * time from the Mac (speech:audio) and are played back to back. The order and
 * the bookkeeping live in queue.core.mjs; this file only turns a piece into
 * sound (expo-av) and cleans up after it.
 */
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { createSpeechQueue, type SpeechPiece, type SpeechPlayer } from './queue.core.mjs';

export interface RemVoiceRun {
  reqId: string;
  push(piece: SpeechPiece): void;
  stop(): void;
}

export function startRemVoice(opts: {
  reqId: string;
  onPart: (index: number) => void;
  onPlayed: (seq: number) => void;
  onDone: () => void;
  onError: (message: string) => void;
}): RemVoiceRun {
  // Speak even with the ringer muted and keep going with the screen off.
  Audio.setAudioModeAsync({ playsInSilentModeIOS: true, staysActiveInBackground: true, shouldDuckAndroid: true }).catch(() => {});

  const load = async (piece: SpeechPiece): Promise<SpeechPlayer> => {
    const uri = `${FileSystem.cacheDirectory}tms-voice-${opts.reqId}-${piece.seq}.mp3`;
    await FileSystem.writeAsStringAsync(uri, piece.audio, { encoding: FileSystem.EncodingType.Base64 });
    const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: false });
    let ended = false;
    return {
      play(onEnd) {
        const end = (): void => { if (!ended) { ended = true; onEnd(); } };
        sound.setOnPlaybackStatusUpdate((st) => {
          if (!st.isLoaded) { if ('error' in st && st.error) end(); return; }
          if (st.didJustFinish) end();
        });
        sound.playAsync().catch(end); // a piece that will not play must not stop the rest
      },
      unload() {
        ended = true;
        sound.setOnPlaybackStatusUpdate(null);
        sound.unloadAsync().catch(() => {});
        FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      },
    };
  };

  const queue = createSpeechQueue({ load, onPart: opts.onPart, onPlayed: opts.onPlayed, onDone: opts.onDone, onError: opts.onError });
  return { reqId: opts.reqId, push: (piece) => queue.push(piece), stop: () => queue.stop() };
}
