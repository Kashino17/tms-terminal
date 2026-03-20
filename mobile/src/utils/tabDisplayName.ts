import type { TerminalTab } from '../types/terminal.types';

/** Returns the display name for a tab: custom title if set, last folder from CWD, or fallback title. */
export function tabDisplayName(tab: TerminalTab): string {
  if (tab.customTitle) return tab.title;
  if (tab.lastCwd) {
    const parts = tab.lastCwd.replace(/\/+$/, '').split('/');
    const last = parts[parts.length - 1];
    if (last) return last === '~' ? '~' : last;
  }
  return tab.title;
}
