/** The server's one title store (see titles.store.ts). */
import * as path from 'node:path';
import { config } from '../config';
import { TitleStore } from './titles.store';

export const titleStore = new TitleStore(path.join(config.configDir, 'titles.json'));
