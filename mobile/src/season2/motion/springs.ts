/**
 * Season 2 motion tokens — the mockup's spring family for Reanimated.
 * snappy = chrome (dock pill, island, presses); gentle = large surfaces
 * (sheets, morph bodies). Exit timing accelerates out and never bounces.
 */
import { WithSpringConfig, WithTimingConfig, Easing } from 'react-native-reanimated';

/** ~300ms with a rubbery overshoot — cubic-bezier(0.34,1.56,0.64,1) feel. */
export const SPRING_SNAPPY: WithSpringConfig = {
  damping: 14,
  stiffness: 220,
  mass: 0.9,
  overshootClamping: false,
};

/** ~450ms, softer settle — cubic-bezier(0.30,1.36,0.52,1) feel. */
export const SPRING_GENTLE: WithSpringConfig = {
  damping: 18,
  stiffness: 140,
  mass: 1,
  overshootClamping: false,
};

/** Fast accelerate-out for closing/dismissing. */
export const TIMING_EXIT: WithTimingConfig = {
  duration: 240,
  easing: Easing.bezier(0.4, 0, 0.7, 0.2),
};

/** Quick fades (content cross-fades inside morphs). */
export const TIMING_FADE: WithTimingConfig = {
  duration: 200,
  easing: Easing.out(Easing.quad),
};
