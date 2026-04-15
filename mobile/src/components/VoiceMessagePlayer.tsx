import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  LayoutChangeEvent,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Audio } from 'expo-av';
import { Feather } from '@expo/vector-icons';
import { colors, fonts } from '../theme';

interface VoiceMessagePlayerProps {
  audioUrl: string;
  duration: number;
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VoiceMessagePlayer({ audioUrl, duration }: VoiceMessagePlayerProps) {
  const soundRef = useRef<Audio.Sound | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [totalDuration, setTotalDuration] = useState(duration || 0);
  const [isLoaded, setIsLoaded] = useState(false);
  const waveWidthRef = useRef(200);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        if (cancelled) return;
        const { sound, status } = await Audio.Sound.createAsync(
          { uri: audioUrl },
          { shouldPlay: false, isLooping: false, progressUpdateIntervalMillis: 100 },
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
    };
  }, [audioUrl]);

  const onPlaybackStatusUpdate = useCallback((status: any) => {
    if (!status.isLoaded) return;
    setPosition((status.positionMillis ?? 0) / 1000);
    if (status.durationMillis) setTotalDuration(status.durationMillis / 1000);
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
    const clamped = Math.max(0, Math.min(ratio, 1));
    await soundRef.current.setPositionAsync(clamped * totalDuration * 1000);
    setPosition(clamped * totalDuration);
  }, [isLoaded, totalDuration]);

  const skipForward = useCallback(async () => {
    if (!soundRef.current || !isLoaded) return;
    const newPos = Math.min(position + 5, totalDuration);
    await soundRef.current.setPositionAsync(newPos * 1000);
    setPosition(newPos);
  }, [isLoaded, position, totalDuration]);

  const skipBack = useCallback(async () => {
    if (!soundRef.current || !isLoaded) return;
    const newPos = Math.max(position - 5, 0);
    await soundRef.current.setPositionAsync(newPos * 1000);
    setPosition(newPos);
  }, [isLoaded, position]);

  const progress = totalDuration > 0 ? position / totalDuration : 0;

  const bars = 36;
  const waveform = useRef(
    Array.from({ length: bars }, () => 0.12 + Math.random() * 0.88)
  ).current;

  return (
    <View style={s.container}>
      {/* Top row: play + waveform + time */}
      <View style={s.topRow}>
        {/* Skip back 5s */}
        <TouchableOpacity onPress={skipBack} hitSlop={8} style={s.skipBtn}>
          <Feather name="rotate-ccw" size={13} color="#64748B" />
        </TouchableOpacity>

        {/* Play/Pause */}
        <TouchableOpacity style={s.playBtn} onPress={togglePlay} activeOpacity={0.7}>
          <Feather
            name={isPlaying ? 'pause' : 'play'}
            size={20}
            color="#F8FAFC"
            style={!isPlaying ? { marginLeft: 2 } : undefined}
          />
        </TouchableOpacity>

        {/* Skip forward 5s */}
        <TouchableOpacity onPress={skipForward} hitSlop={8} style={s.skipBtn}>
          <Feather name="rotate-cw" size={13} color="#64748B" />
        </TouchableOpacity>

        {/* Waveform */}
        <TouchableOpacity
          style={s.waveContainer}
          activeOpacity={1}
          onLayout={(e: LayoutChangeEvent) => { waveWidthRef.current = e.nativeEvent.layout.width; }}
          onPress={(e) => seek(e.nativeEvent.locationX / waveWidthRef.current)}
        >
          <View style={s.waveform}>
            {waveform.map((h, i) => {
              const barPos = i / bars;
              const isActive = barPos <= progress;
              return (
                <View
                  key={i}
                  style={[
                    s.bar,
                    {
                      height: h * 28,
                      backgroundColor: isActive ? '#3B82F6' : 'rgba(148,163,184,0.2)',
                    },
                  ]}
                />
              );
            })}
          </View>
          {/* Progress dot */}
          <View style={[s.progressDot, { left: `${Math.min(progress * 100, 100)}%` }]} />
        </TouchableOpacity>

        {/* Time */}
        <Text style={s.time}>
          {isPlaying || position > 0 ? formatTime(position) : formatTime(totalDuration)}
        </Text>
      </View>

      {/* Playback speed indicator */}
      {isPlaying && (
        <View style={s.playingIndicator}>
          <View style={s.playingDot} />
          <Text style={s.playingText}>Wird abgespielt</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(30,41,59,0.5)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.12)',
    paddingVertical: 10,
    paddingHorizontal: 10,
    marginTop: 6,
    marginBottom: 2,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  skipBtn: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#3B82F6',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#3B82F6',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  waveContainer: {
    flex: 1,
    height: 32,
    justifyContent: 'center',
    position: 'relative',
  },
  waveform: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1.2,
    height: 28,
  },
  bar: {
    flex: 1,
    borderRadius: 1.5,
    minWidth: 2,
  },
  progressDot: {
    position: 'absolute',
    top: '50%',
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#3B82F6',
    marginTop: -5,
    marginLeft: -5,
    shadowColor: '#3B82F6',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 4,
    elevation: 3,
  },
  time: {
    fontSize: 11,
    fontFamily: fonts.mono,
    color: '#94A3B8',
    fontVariant: ['tabular-nums'],
    width: 34,
    textAlign: 'right',
  },
  playingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 6,
    paddingLeft: 54,
  },
  playingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#3B82F6',
  },
  playingText: {
    fontSize: 10,
    color: '#64748B',
    fontWeight: '500',
  },
});
