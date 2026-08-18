import { getPlatform } from '../../utils/platform';
import type { InputInjector } from './input.types';
import { createDarwinInput } from './input.darwin';

export function createInputInjector(): InputInjector {
  switch (getPlatform()) {
    case 'darwin':
      return createDarwinInput();
    default:
      throw new Error('Fernzugriff wird auf dieser Plattform nicht unterstuetzt.');
  }
}
