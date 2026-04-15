import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Audio } from 'expo-av';
import { Feather } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system';
import { colors, fonts } from '../theme';

interface VoiceMessagePlayerProps {
  audioBase64: string;
  duration: number; // seconds
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VoiceMessagePlayer({ audioBase64, duration }: VoiceMessagePlayerProps) {
  const soundRef = useRef<Audio.Sound | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0); // seconds
  const [totalDuration, setTotalDuration] = useState(duration || 0);
  const [isLoaded, setIsLoaded] = useState(false);
  const fileRef = useRef<string | null>(null);

  // Write base64 to temp file and load sound
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        // Write to temp file
        const filePath = FileSystem.cacheDirectory + `tts_${Date.now()}.wav`;
        await FileSystem.writeAsStringAsync(filePath, audioBase64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        fileRef.current = filePath;

        if (cancelled) return;

        // Load sound
        const { sound, status } = await Audio.Sound.createAsync(
          { uri: filePath },
          { shouldPlay: false },
          onPlaybackStatusUpdate,
        );
        soundRef.current = sound;

        if (status.isLoaded && status.durationMillis) {
          setTotalDuration(status.durationMillis / 1000);
        }
        setIsLoaded(true);
      } catch (err) {
        console.warn('[VoicePlayer] Load failed:', err);
      }
    };

    load();

    return () => {
      cancelled = true;
      soundRef.current?.unloadAsync().catch(() => {});
      if (fileRef.current) {
        FileSystem.deleteAsync(fileRef.current, { idempotent: true }).catch(() => {});
      }
    };
  }, [audioBase64]);

  const onPlaybackStatusUpdate = useCallback((status: any) => {
    if (!status.isLoaded) return;
    setPosition((status.positionMillis ?? 0) / 1000);
    if (status.durationMillis) {
      setTotalDuration(status.durationMillis / 1000);
    }
    if (status.didJustFinish) {
      setIsPlaying(false);
      setPosition(0);
      soundRef.current?.setPositionAsync(0).catch(() => {});
    }
  }, []);

  const togglePlay = useCallback(async () => {
    if (!soundRef.current || !isLoaded) return;

    if (isPlaying) {
      await soundRef.current.pauseAsync();
      setIsPlaying(false);
    } else {
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      await soundRef.current.playAsync();
      setIsPlaying(true);
    }
  }, [isPlaying, isLoaded]);

  const seek = useCallback(async (ratio: number) => {
    if (!soundRef.current || !isLoaded || totalDuration <= 0) return;
    const newPos = Math.max(0, Math.min(ratio, 1)) * totalDuration * 1000;
    await soundRef.current.setPositionAsync(newPos);
    setPosition(newPos / 1000);
  }, [isLoaded, totalDuration]);

  const progress = totalDuration > 0 ? position / totalDuration : 0;

  // Generate fake waveform bars (visual only, like WhatsApp)
  const bars = 28;
  const waveform = useRef(
    Array.from({ length: bars }, () => 0.15 + Math.random() * 0.85)
  ).current;

  return (
    <View style={s.container}>
      {/* Play/Pause button */}
      <TouchableOpacity style={s.playBtn} onPress={togglePlay} activeOpacity={0.7}>
        <Feather
          name={isPlaying ? 'pause' : 'play'}
          size={18}
          color="#F8FAFC"
          style={!isPlaying ? { marginLeft: 2 } : undefined}
        />
      </TouchableOpacity>

      {/* Waveform + progress */}
      <TouchableOpacity
        style={s.waveContainer}
        activeOpacity={1}
        onPress={(e) => {
          const { locationX } = e.nativeEvent;
          const width = 200; // approximate
          seek(locationX / width);
        }}
      >
        <View style={s.waveform}>
          {waveform.map((h, i) => {
            const barProgress = i / bars;
            const isActive = barProgress <= progress;
            return (
              <View
                key={i}
                style={[
                  s.bar,
                  {
                    height: h * 24,
                    backgroundColor: isActive ? '#3B82F6' : 'rgba(148,163,184,0.25)',
                  },
                ]}
              />
            );
          })}
        </View>
      </TouchableOpacity>

      {/* Time */}
      <Text style={s.time}>
        {isPlaying || position > 0
          ? formatTime(position)
          : formatTime(totalDuration)}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(30,41,59,0.6)',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 6,
    gap: 8,
    marginTop: 6,
    marginBottom: 2,
  },
  playBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#3B82F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  waveContainer: {
    flex: 1,
    height: 28,
    justifyContent: 'center',
  },
  waveform: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1.5,
    height: 24,
  },
  bar: {
    flex: 1,
    borderRadius: 1.5,
    minWidth: 2,
  },
  time: {
    fontSize: 11,
    fontFamily: fonts.mono,
    color: '#94A3B8',
    fontVariant: ['tabular-nums'],
    width: 36,
    textAlign: 'right',
  },
});
