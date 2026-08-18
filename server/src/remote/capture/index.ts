import { getPlatform } from '../../utils/platform';
import type { ScreenCapture } from './capture.types';
import { createDarwinCapture } from './capture.darwin';

export function createScreenCapture(): ScreenCapture {
  switch (getPlatform()) {
    case 'darwin':
      return createDarwinCapture();
    default:
      throw new Error('Fernzugriff wird auf dieser Plattform nicht unterstuetzt.');
  }
}
