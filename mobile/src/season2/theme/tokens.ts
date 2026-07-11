/**
 * Season 2 (Liquid Glass) design tokens — ported 1:1 from the approved
 * Liquid-Deck mockup (`mockups/season2/liquid-deck/index.html` :root blocks).
 * Fully independent from the classic app's `theme.ts` — the classic UI
 * must never import from here, and season2 code must never import theme.ts.
 */
import React, { createContext, useContext } from 'react';

export type S2ThemeName = 'dark' | 'light';

export interface S2Palette {
  /** Background gradient stops (top → bottom), rendered as layered Views. */
  bgGradient: [string, string, string];
  glass: string;
  glassStrong: string;
  glassBorder: string;
  overlayRgb: string;
  text: string;
  textDim: string;
  accent: string;
  accentRgb: string;
  accentWarm: string;
  ok: string;
  warn: string;
  err: string;
  onAccent: string;
  onErr: string;
  accentInk: string;
  /** Recessed code/input wells. */
  well: string;
  /** Terminal pane surface — darkest layer, never pure black. */
  termSurface: string;
  scrim: string;
  sheen: string;
  /** expo-blur intensity (0-100) approximating the mockup's backdrop blur. */
  blurIntensity: number;
  blurTint: 'dark' | 'light';
}

/** Kindle-gray dark — NO black anywhere (user requirement). */
export const S2_DARK: S2Palette = {
  bgGradient: ['#2a2e35', '#23262c', '#1e2126'],
  glass: 'rgba(255,255,255,0.10)',
  glassStrong: 'rgba(255,255,255,0.15)',
  glassBorder: 'rgba(255,255,255,0.26)',
  overlayRgb: '255,255,255',
  text: '#f0f2f6',
  textDim: 'rgba(240,242,246,0.68)',
  accent: '#8ab8ff',
  accentRgb: '138,184,255',
  accentWarm: '#ff9f6a',
  ok: '#4ade80',
  warn: '#fbbf24',
  err: '#ffa0a0',
  onAccent: '#071021',
  onErr: '#3a1210',
  accentInk: '#d9e6ff',
  well: 'rgba(0,0,0,0.26)',
  termSurface: 'rgba(24,26,31,0.82)',
  scrim: 'rgba(26,29,34,0.5)',
  sheen: 'rgba(255,255,255,0.55)',
  blurIntensity: 40,
  blurTint: 'dark',
};

/** Outdoor light — sunlight-readable frosted glass. */
export const S2_LIGHT: S2Palette = {
  bgGradient: ['#f3f6fc', '#e7ecf5', '#dbe2ee'],
  glass: 'rgba(255,255,255,0.65)',
  glassStrong: 'rgba(255,255,255,0.82)',
  glassBorder: 'rgba(15,23,42,0.16)',
  overlayRgb: '15,23,42',
  text: '#1a1d22',
  textDim: 'rgba(26,29,34,0.62)',
  accent: '#1e4fa3',
  accentRgb: '30,79,163',
  accentWarm: '#9a4a0a',
  ok: '#157a3c',
  warn: '#92400e',
  err: '#b91c1c',
  onAccent: '#f3f7ff',
  onErr: '#fff5f5',
  accentInk: '#123059',
  well: 'rgba(15,23,42,0.06)',
  termSurface: 'rgba(252,253,255,0.90)',
  scrim: 'rgba(238,241,247,0.4)',
  sheen: 'rgba(255,255,255,0.85)',
  blurIntensity: 55,
  blurTint: 'light',
};

/** Metric system — mirrors the mockup: 8pt rhythm, one radius family,
 *  one icon ramp, ≥44pt touch targets. */
export const S2_METRICS = {
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 10, md: 16, lg: 24, pill: 999 },
  icon: { sm: 16, md: 20, lg: 24 },
  touch: 44,
  font: {
    micro: 10.5,
    caption: 12,
    label: 13.5,
    body: 15,
    section: 17,
    title: 28,
  },
  islandHeight: 40,
  dockHeight: 64,
} as const;

export interface S2Theme {
  name: S2ThemeName;
  c: S2Palette;
  m: typeof S2_METRICS;
}

export const s2Theme = (name: S2ThemeName): S2Theme => ({
  name,
  c: name === 'dark' ? S2_DARK : S2_LIGHT,
  m: S2_METRICS,
});

interface S2ThemeContextValue {
  theme: S2Theme;
  toggleTheme: () => void;
}

export const S2ThemeContext = createContext<S2ThemeContextValue>({
  theme: s2Theme('dark'),
  toggleTheme: () => {},
});

export function useS2Theme(): S2ThemeContextValue {
  return useContext(S2ThemeContext);
}
