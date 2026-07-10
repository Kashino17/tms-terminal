import { useWindowDimensions } from 'react-native';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import React from 'react';

// ── Breakpoints ─────────────────────────────────────────────────────────────
// compact  : Fold cover screen, very narrow phones  (< 400dp)
// medium   : Regular smartphones                     (400–699dp)
// expanded : Fold inner screen, small tablets        (≥ 700dp)
export type Breakpoint = 'compact' | 'medium' | 'expanded';

interface ScaleFactors {
  font: number;
  spacing: number;
  icon: number;
}

const SCALE: Record<Breakpoint, ScaleFactors> = {
  compact:  { font: 0.88, spacing: 0.82, icon: 0.88 },
  medium:   { font: 1.0,  spacing: 1.0,  icon: 1.0  },
  expanded: { font: 1.3,  spacing: 1.35, icon: 1.3  },
};

// ── Pre-computed scaling functions per breakpoint (never re-created) ────────
function makeScaler(factor: number) {
  // Cache results for common sizes to avoid repeated Math.round calls
  const cache = new Map<number, number>();
  return (size: number): number => {
    let r = cache.get(size);
    if (r === undefined) {
      r = Math.round(size * factor);
      cache.set(size, r);
    }
    return r;
  };
}

const SCALERS = {
  compact: {
    rf: makeScaler(SCALE.compact.font),
    rs: makeScaler(SCALE.compact.spacing),
    ri: makeScaler(SCALE.compact.icon),
  },
  medium: {
    rf: makeScaler(SCALE.medium.font),
    rs: makeScaler(SCALE.medium.spacing),
    ri: makeScaler(SCALE.medium.icon),
  },
  expanded: {
    rf: makeScaler(SCALE.expanded.font),
    rs: makeScaler(SCALE.expanded.spacing),
    ri: makeScaler(SCALE.expanded.icon),
  },
} as const;

// ── Pre-computed layout values per breakpoint ───────────────────────────────
const LAYOUT = {
  compact:  { gridColumns: 2, listColumns: 1, panelWidth: 170, cardHeight: 82, avatarSize: 36 },
  medium:   { gridColumns: 2, listColumns: 1, panelWidth: 214, cardHeight: 94, avatarSize: 44 },
  expanded: { gridColumns: 3, listColumns: 2, panelWidth: 320, cardHeight: 120, avatarSize: 56 },
} as const;

export interface ResponsiveValues {
  breakpoint: Breakpoint;
  width: number;
  height: number;
  isExpanded: boolean;
  isCompact: boolean;
  rf: (size: number) => number;
  rs: (size: number) => number;
  ri: (size: number) => number;
  gridColumns: number;
  listColumns: number;
  panelWidth: number;
  cardHeight: number;
  avatarSize: number;
}

function getBreakpoint(width: number): Breakpoint {
  if (width < 400) return 'compact';
  if (width < 700) return 'medium';
  return 'expanded';
}

// ── Context (single subscription, stable references) ────────────────────────
const ResponsiveCtx = createContext<ResponsiveValues | null>(null);

export function ResponsiveProvider({ children }: { children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  const bp = getBreakpoint(width);

  const value = useMemo(() => {
    const scalers = SCALERS[bp];
    const layout = LAYOUT[bp];
    return {
      breakpoint: bp,
      width,
      height,
      isExpanded: bp === 'expanded',
      isCompact: bp === 'compact',
      rf: scalers.rf,
      rs: scalers.rs,
      ri: scalers.ri,
      ...layout,
    };
  }, [bp, width, height]);

  return React.createElement(ResponsiveCtx.Provider, { value }, children);
}

export function useResponsive(): ResponsiveValues {
  const ctx = useContext(ResponsiveCtx);
  if (ctx) return ctx;

  // Fallback for components outside the provider (shouldn't happen in normal use)
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { width, height } = useWindowDimensions();
  const bp = getBreakpoint(width);
  const scalers = SCALERS[bp];
  const layout = LAYOUT[bp];
  return {
    breakpoint: bp,
    width,
    height,
    isExpanded: bp === 'expanded',
    isCompact: bp === 'compact',
    rf: scalers.rf,
    rs: scalers.rs,
    ri: scalers.ri,
    ...layout,
  };
}
