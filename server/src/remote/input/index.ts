import { getPlatform } from '../../utils/platform';
import type { InputInjector } from './input.types';

export function createInputInjector(): InputInjector {
  switch (getPlatform()) {
    default:
      throw new Error('Fernzugriff wird auf dieser Plattform nicht unterstuetzt.');
  }
}
