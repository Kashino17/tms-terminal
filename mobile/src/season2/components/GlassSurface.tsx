/**
 * Season 2 glass surface — BlurView-backed frosted panel with the mockup's
 * hairline border and top sheen line. `strong` raises fill opacity (sheets,
 * island); `noBlur` falls back to a translucent solid (cheap surfaces or
 * where Android blur costs too much — visually calibrated per theme).
 */
import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { BlurView } from 'expo-blur';
import { useS2Theme } from '../theme/tokens';

interface GlassSurfaceProps {
  children?: React.ReactNode;
  strong?: boolean;
  noBlur?: boolean;
  sheen?: boolean;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

export function GlassSurface({
  children,
  strong = false,
  noBlur = false,
  sheen = true,
  radius,
  style,
}: GlassSurfaceProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const borderRadius = radius ?? m.radius.md;
  const fill = strong ? c.glassStrong : c.glass;

  const frame: ViewStyle = {
    borderRadius,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: c.glassBorder,
    overflow: 'hidden',
  };

  return (
    <View style={[frame, style]}>
      {noBlur ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: strong ? c.glassStrong : c.glass, opacity: 1 }]} />
      ) : (
        <BlurView
          intensity={c.blurIntensity + (strong ? 12 : 0)}
          tint={c.blurTint}
          style={StyleSheet.absoluteFill}
        />
      )}
      {/* Fill tint over the blur so the surface reads as frosted, not clear. */}
      {!noBlur && <View style={[StyleSheet.absoluteFill, { backgroundColor: fill }]} />}
      {/* Top sheen — the mockup's 1px light-reflection line. */}
      {sheen && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            left: '14%',
            right: '14%',
            height: StyleSheet.hairlineWidth * 2,
            backgroundColor: c.sheen,
            opacity: 0.6,
          }}
        />
      )}
      {children}
    </View>
  );
}
