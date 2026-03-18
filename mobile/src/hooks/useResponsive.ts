import { useWindowDimensions } from 'react-native';
import { useMemo } from 'react';

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

export interface ResponsiveValues {
  /** Current breakpoint */
  breakpoint: Breakpoint;
  /** Screen width in dp */
  width: number;
  /** Screen height in dp */
  height: number;
  /** Is the expanded (fold inner / tablet) layout active? */
  isExpanded: boolean;
  /** Is the compact (fold cover) layout active? */
  isCompact: boolean;
  /** Scale a font size value */
  rf: (size: number) => number;
  /** Scale a spacing/padding/margin value */
  rs: (size: number) => number;
  /** Scale an icon size value */
  ri: (size: number) => number;
  /** Number of columns for grid layouts */
  gridColumns: number;
  /** Number of columns for list layouts (server list, dashboard) */
  listColumns: number;
  /** ToolRail panel width */
  panelWidth: number;
  /** Server card height */
  cardHeight: number;
  /** Avatar size */
  avatarSize: number;
}

function getBreakpoint(width: number): Breakpoint {
  if (width < 400) return 'compact';
  if (width < 700) return 'medium';
  return 'expanded';
}

export function useResponsive(): ResponsiveValues {
  const { width, height } = useWindowDimensions();

  return useMemo(() => {
    const bp = getBreakpoint(width);
    const scale = SCALE[bp];

    const rf = (size: number) => Math.round(size * scale.font);
    const rs = (size: number) => Math.round(size * scale.spacing);
    const ri = (size: number) => Math.round(size * scale.icon);

    return {
      breakpoint: bp,
      width,
      height,
      isExpanded: bp === 'expanded',
      isCompact: bp === 'compact',
      rf,
      rs,
      ri,
      gridColumns: bp === 'expanded' ? 3 : 2,
      listColumns: bp === 'expanded' ? 2 : 1,
      panelWidth: bp === 'expanded' ? 320 : bp === 'compact' ? 170 : 214,
      cardHeight: bp === 'expanded' ? 120 : bp === 'compact' ? 82 : 94,
      avatarSize: bp === 'expanded' ? 56 : bp === 'compact' ? 36 : 44,
    };
  }, [width, height]);
}
