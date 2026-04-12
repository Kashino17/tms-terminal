import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Animated, Easing, Vibration } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fonts } from '../theme';

interface AdhanAlertProps {
  visible: boolean;
  prayerName: string;
  prayerTime: string;
  prayerArabic: string;
  wecker?: boolean;
  onLoud: () => void;
  onSilent: () => void;
}

export function AdhanAlert({ visible, prayerName, prayerTime, prayerArabic, wecker, onLoud, onSilent }: AdhanAlertProps) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(300)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Wecker mode: auto-play adhan, dismiss when done
  useEffect(() => {
    if (visible && wecker) {
      Vibration.cancel();
      onLoud();
    }
  }, [visible, wecker]);

  useEffect(() => {
    if (visible) {
      // Vibrate like a phone call (skip in wecker mode — adhan plays immediately)
      if (!wecker) {
        Vibration.vibrate([0, 500, 200, 500, 200, 500], true);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      }

      // Entrance animation
      slideAnim.setValue(300);
      fadeAnim.setValue(0);
      Animated.parallel([
        Animated.spring(slideAnim, { toValue: 0, tension: 60, friction: 10, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
      ]).start();

      // Pulse animation for the icon
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.15, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ]),
      );
      pulse.start();

      return () => {
        Vibration.cancel();
        pulse.stop();
      };
    }
  }, [visible]);

  if (!visible) return null;

  return (
    <Modal transparent visible animationType="none" statusBarTranslucent>
      <Animated.View style={[s.overlay, { opacity: fadeAnim }]}>
        <Animated.View style={[s.card, { transform: [{ translateY: slideAnim }] }]}>
          {/* Prayer icon with pulse */}
          <Animated.View style={[s.iconWrap, { transform: [{ scale: pulseAnim }] }]}>
            <View style={s.iconCircle}>
              <Feather name="sun" size={32} color="#10B981" />
            </View>
            <View style={s.iconRing} />
            <View style={s.iconRing2} />
          </Animated.View>

          {/* Prayer info */}
          <Text style={s.label}>Gebetszeit</Text>
          <Text style={s.prayerName}>{prayerName}</Text>
          <Text style={s.prayerArabic}>{prayerArabic}</Text>
          <Text style={s.prayerTime}>{prayerTime}</Text>

          {/* Action buttons (hidden in wecker mode) */}
          {!wecker && (
            <View style={s.actions}>
              <TouchableOpacity
                style={s.silentBtn}
                onPress={() => { Vibration.cancel(); onSilent(); }}
                activeOpacity={0.7}
              >
                <Feather name="volume-x" size={24} color="#94A3B8" />
                <Text style={s.silentText}>Stumm</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={s.loudBtn}
                onPress={() => { Vibration.cancel(); onLoud(); }}
                activeOpacity={0.7}
              >
                <Feather name="volume-2" size={24} color="#fff" />
                <Text style={s.loudText}>Laut</Text>
              </TouchableOpacity>
            </View>
          )}
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 30,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#1B2336',
    borderRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.15)',
    padding: 30,
    alignItems: 'center',
    elevation: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
  },
  iconWrap: {
    width: 80,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(16,185,129,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  iconRing: {
    position: 'absolute',
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.15)',
  },
  iconRing2: {
    position: 'absolute',
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.08)',
  },
  label: {
    fontSize: 10,
    color: '#10B981',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    fontWeight: '700',
    marginBottom: 6,
  },
  prayerName: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.text,
    marginBottom: 4,
  },
  prayerArabic: {
    fontSize: 20,
    color: '#64748B',
    marginBottom: 6,
  },
  prayerTime: {
    fontSize: 32,
    fontWeight: '700',
    fontFamily: fonts.mono,
    color: '#10B981',
    marginBottom: 30,
  },
  actions: {
    flexDirection: 'row',
    gap: 16,
    width: '100%',
  },
  silentBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: '#243044',
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
    gap: 4,
  },
  silentText: {
    fontSize: 12,
    color: '#94A3B8',
    fontWeight: '600',
  },
  loudBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: '#10B981',
    alignItems: 'center',
    gap: 4,
  },
  loudText: {
    fontSize: 12,
    color: '#fff',
    fontWeight: '700',
  },
});
