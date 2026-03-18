import { Platform } from 'react-native';

// ── Color Palette (Slate-based, professional) ────────────────────────────────
export const colors = {
  bg:           '#0F172A',   // Slate-900 — main background
  surface:      '#1B2336',   // Cards, panels
  surfaceAlt:   '#243044',   // Toolbars, elevated surfaces
  primary:      '#3B82F6',   // Blue-500 — primary accent
  accent:       '#22C55E',   // Green-500 — success / connected
  text:         '#F8FAFC',   // Slate-50 — primary text
  textMuted:    '#94A3B8',   // Slate-400 — secondary text
  textDim:      '#64748B',   // Slate-500 — tertiary text
  border:       '#334155',   // Slate-700 — default border
  borderStrong: '#475569',   // Slate-600 — emphasized border
  destructive:  '#EF4444',   // Red-500
  warning:      '#F59E0B',   // Amber-500
  info:         '#06B6D4',   // Cyan-500
} as const;

// ── Spacing ──────────────────────────────────────────────────────────────────
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

// ── Touch Targets ────────────────────────────────────────────────────────────
export const touchTarget = {
  min: 44,   // Apple HIG minimum
} as const;

// ── Fonts ────────────────────────────────────────────────────────────────────
export const fonts = {
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  ui: undefined as string | undefined,   // System default
} as const;

// ── Font Sizes ───────────────────────────────────────────────────────────────
export const fontSizes = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
} as const;
