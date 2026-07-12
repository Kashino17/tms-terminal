/**
 * Season 2 icon system — one consistent stroke language (24px grid,
 * 1.8px stroke, round caps/joins, currentColor via `color` prop).
 * Paths ported from the Liquid-Deck mockup's inline SVG set; NO emojis.
 */
import React from 'react';
import Svg, { Path, Rect, Circle, Line } from 'react-native-svg';

export interface S2IconProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
}

type IconRenderer = (p: Required<S2IconProps>) => React.ReactElement;

function make(render: IconRenderer) {
  return function S2Icon({ size = 20, color = '#f0f2f6', strokeWidth = 1.8 }: S2IconProps) {
    return render({ size, color, strokeWidth });
  };
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none' as const,
});
const stroke = (color: string, strokeWidth: number) => ({
  stroke: color,
  strokeWidth,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const IconServer = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Rect x={3} y={4} width={18} height={7} rx={2} {...stroke(color, strokeWidth)} />
    <Rect x={3} y={13} width={18} height={7} rx={2} {...stroke(color, strokeWidth)} />
    <Path d="M7 7.5h.01M7 16.5h.01" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconTerminal = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Rect x={3} y={4} width={18} height={16} rx={3} {...stroke(color, strokeWidth)} />
    <Path d="m7 9 3 3-3 3M12.5 15H17" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconManager = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5Z" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconCloud = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="M17.5 19a4.5 4.5 0 0 0 .42-8.98 6 6 0 0 0-11.7 1.62A4 4 0 0 0 7 19Z" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconBrowser = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Circle cx={12} cy={12} r={9} {...stroke(color, strokeWidth)} />
    <Path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconMore = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Circle cx={5} cy={12} r={1.2} fill={color} />
    <Circle cx={12} cy={12} r={1.2} fill={color} />
    <Circle cx={19} cy={12} r={1.2} fill={color} />
    <Path d="M0 0" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconPlus = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="M12 5v14M5 12h14" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconGrid = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Rect x={4} y={4} width={7} height={7} rx={1.5} {...stroke(color, strokeWidth)} />
    <Rect x={13} y={4} width={7} height={7} rx={1.5} {...stroke(color, strokeWidth)} />
    <Rect x={4} y={13} width={7} height={7} rx={1.5} {...stroke(color, strokeWidth)} />
    <Rect x={13} y={13} width={7} height={7} rx={1.5} {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconList = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconStack = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Rect x={6} y={4} width={14} height={12} rx={2} {...stroke(color, strokeWidth)} />
    <Path d="M4 9v9a2 2 0 0 0 2 2h10" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconMic = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Rect x={9} y={2} width={6} height={11} rx={3} {...stroke(color, strokeWidth)} />
    <Path d="M5 10a7 7 0 0 0 14 0M12 17v4" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconSend = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="M20 4 4 11l6 2 2 6 8-15Z" {...stroke(color, strokeWidth)} />
    <Path d="m10 13 4-4" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconTrash = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 12a2 2 0 0 0 2 1.8h5a2 2 0 0 0 2-1.8l1-12" {...stroke(color, strokeWidth)} />
    <Path d="M10 11v6M14 11v6" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconTools = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7V20h3.3l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.6 2.6-2.5-.9-.9-2.5 2.6-2.6Z" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconChevronDown = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="m6 9 6 6 6-6" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconChevronRight = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="m9 6 6 6-6 6" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconClose = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="M6 6l12 12M18 6 6 18" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconSignal = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="M3 20h.01M8 20v-5M13 20v-9M18 20V6" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconPrayerMoon = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconSun = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Circle cx={12} cy={12} r={4} {...stroke(color, strokeWidth)} />
    <Path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconSearch = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Circle cx={11} cy={11} r={7} {...stroke(color, strokeWidth)} />
    <Path d="m21 21-4.3-4.3" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconEdit = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconArrowDown = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="M12 4v14m0 0 6-6m-6 6-6-6" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconBack = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="m14 6-6 6 6 6" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconEnter = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="M20 5v6a3 3 0 0 1-3 3H5m0 0 4-4m-4 4 4 4" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconDot = make(({ size, color }) => (
  <Svg {...base(size)}>
    <Circle cx={12} cy={12} r={5} fill={color} />
  </Svg>
));

export const IconBolt = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconNotes = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Rect x={5} y={3} width={14} height={18} rx={2.5} {...stroke(color, strokeWidth)} />
    <Path d="M9 8h6M9 12h6M9 16h3" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconArrowDownCircle = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Circle cx={12} cy={12} r={9} {...stroke(color, strokeWidth)} />
    <Path d="M12 8v8m0 0 3.5-3.5M12 16l-3.5-3.5" {...stroke(color, strokeWidth)} />
  </Svg>
));

export const IconChevronUp = make(({ size, color, strokeWidth }) => (
  <Svg {...base(size)}>
    <Path d="m6 15 6-6 6 6" {...stroke(color, strokeWidth)} />
  </Svg>
));
