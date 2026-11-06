import { getPlatform } from '../../utils/platform';
import type { InputInjector } from './input.types';
import { createDarwinInput } from './input.darwin';
import { createWin32Input } from './input.win32';

export function createInputInjector(): InputInjector {
  switch (getPlatform()) {
    case 'darwin':
      return createDarwinInput();
    case 'win32':
      return createWin32Input();
    default:
      throw new Error('Fernzugriff wird auf dieser Plattform nicht unterstuetzt.');
  }
}
