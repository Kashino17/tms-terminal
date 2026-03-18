import React, { useEffect, useRef, useMemo } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, fonts, fontSizes, spacing } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

const BANNER_HEIGHT = 34;

export interface RestoreState {
  total: number;    // total sessions to restore
  pending: number;  // still waiting for reattach/recreate
}

interface Props {
  restoreState: RestoreState | null;
}

export function ReconnectBanner({ restoreState }: Props) {
  const { rf, rs, ri } = useResponsive();
  const heightAnim = useRef(new Animated.Value(0)).current;
  const visible = restoreState !== null;
  const done = restoreState?.pending === 0;

  useEffect(() => {
    Animated.timing(heightAnim, {
      toValue: visible ? BANNER_HEIGHT : 0,
      duration: 220,
      useNativeDriver: false, // height cannot use native driver
    }).start();
  }, [visible]);

  if (!restoreState && !visible) return null;

  return (
    <Animated.View style={[styles.wrapper, { height: heightAnim }]}>
      <View style={[styles.banner, { gap: rs(spacing.xs) }, done && styles.bannerDone]}>
        <Feather
          name={done ? 'check-circle' : 'refresh-cw'}
          size={ri(12)}
          color={done ? colors.accent : colors.warning}
        />
        <Text style={[styles.text, { fontSize: rf(fontSizes.xs) }]}>
          {done
            ? `${restoreState!.total} session${restoreState!.total !== 1 ? 's' : ''} restored`
            : `Restoring ${restoreState!.pending} of ${restoreState!.total} session${restoreState!.total !== 1 ? 's' : ''}…`
          }
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    overflow: 'hidden',
    backgroundColor: colors.bg,
  },
  banner: {
    height: BANNER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bannerDone: {
    borderBottomColor: colors.accent + '44',
  },
  text: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    fontFamily: fonts.mono,
  },
});
