import { getPlatform } from '../../utils/platform';
import type { ScreenCapture } from './capture.types';

export function createScreenCapture(): ScreenCapture {
  switch (getPlatform()) {
    default:
      throw new Error('Fernzugriff wird auf dieser Plattform nicht unterstuetzt.');
  }
}
