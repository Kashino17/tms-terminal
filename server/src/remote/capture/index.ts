import { getPlatform } from '../../utils/platform';
import type { ScreenCapture } from './capture.types';
import { createDarwinCapture } from './capture.darwin';
import { createWin32Capture } from './capture.win32';

export function createScreenCapture(): ScreenCapture {
  switch (getPlatform()) {
    case 'darwin':
      return createDarwinCapture();
    case 'win32':
      return createWin32Capture();
    default:
      throw new Error('Fernzugriff wird auf dieser Plattform nicht unterstuetzt.');
  }
}
