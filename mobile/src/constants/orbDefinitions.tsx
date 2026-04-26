import React from 'react';
import { Text } from 'react-native';
import { Feather } from '@expo/vector-icons';

/**
 * Orb definitions shared between the terminal screen's `OrbLayer` and the
 * Manager-Chat V2 `ToolSidebar`. The terminal screen has its own copy inline
 * (kept to avoid a risky refactor) — keep this file in sync if orbs are
 * added/removed there.
 *
 * `action` semantics:
 *   - `input:<bytes>`  send raw bytes to the active terminal as keystrokes
 *   - `clear`          dispatch a `terminal:clear` WS message
 *   - `scroll`         scroll the active pane to the bottom
 *   - `tools`          open the user's tool grid (callback)
 *   - `dpad`           toggle a directional-pad sub-flyout
 *   - `mic`            trigger voice capture (callback)
 *   - `spotlight`      open spotlight search (callback)
 *   - `manager`        open the manager chat (no-op when already in chat)
 *   - `range`          enter range-select mode on the active pane (no-op in V2)
 */
export interface OrbDef {
  label: string;
  color: string;
  action: string;
  icon: (size: number, color: string) => React.ReactNode;
}

const FREE_ICON = 22;
const MINI_ICON = 18;
const FREE_TEXT = 18;
const MINI_TEXT = 16;

export const ORB_DEFS: Record<string, OrbDef> = {
  ctrl_c: {
    label: 'Ctrl+C',
    color: '#EF4444',
    action: 'input:\x03',
    icon: (size, color) => (
      <Text style={{ fontSize: size > 44 ? FREE_TEXT : MINI_TEXT, fontWeight: '700', color, fontFamily: 'monospace' }}>^C</Text>
    ),
  },
  esc: {
    label: 'Escape',
    color: '#94A3B8',
    action: 'input:\x1b',
    icon: (size, color) => (
      <Text style={{ fontSize: size > 44 ? FREE_TEXT - 2 : MINI_TEXT - 2, fontWeight: '600', color, fontFamily: 'monospace' }}>Esc</Text>
    ),
  },
  clear: {
    label: 'Clear',
    color: '#94A3B8',
    action: 'clear',
    icon: (size, color) => <Feather name="trash-2" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  delete: {
    label: 'Delete',
    color: '#94A3B8',
    action: 'input:\x15',
    icon: (size, color) => (
      <Text style={{ fontSize: size > 44 ? FREE_TEXT : MINI_TEXT, color }}>⌫</Text>
    ),
  },
  scissors: {
    label: 'Ausschneiden',
    color: '#94A3B8',
    action: 'range',
    icon: (size, color) => <Feather name="scissors" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  scroll: {
    label: 'Scroll',
    color: '#06B6D4',
    action: 'scroll',
    icon: (size, color) => <Feather name="chevrons-down" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  enter: {
    label: 'Enter',
    color: '#94A3B8',
    action: 'input:\r',
    icon: (size, color) => <Feather name="corner-down-left" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  tools: {
    label: 'Tools',
    color: '#94A3B8',
    action: 'tools',
    icon: (size, color) => <Feather name="tool" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  spotlight: {
    label: 'Spotlight',
    color: '#94A3B8',
    action: 'spotlight',
    icon: (size, color) => <Feather name="search" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  dpad: {
    label: 'D-Pad',
    color: '#3B82F6',
    action: 'dpad',
    icon: (size, color) => <Feather name="move" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  mic: {
    label: 'Mikrofon',
    color: '#94A3B8',
    action: 'mic',
    icon: (size, color) => <Feather name="mic" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
  manager: {
    label: 'Manager',
    color: '#A78BFA',
    action: 'manager',
    icon: (size, color) => <Feather name="cpu" size={size > 44 ? FREE_ICON : MINI_ICON} color={color} />,
  },
};

/** Orbs that don't make sense inside the Manager Chat V2 sidebar. */
const SIDEBAR_HIDDEN: Set<string> = new Set(['manager', 'spotlight', 'range', 'scissors']);

/** Filter a dockOrder list down to orbs that are valid for the V2 sidebar. */
export function filterSidebarOrbs(orbIds: string[]): string[] {
  return orbIds.filter((id) => ORB_DEFS[id] && !SIDEBAR_HIDDEN.has(id));
}

/** All orb IDs known to the V2 sidebar (used by the "Add orb" picker). */
export function allSidebarOrbIds(): string[] {
  return Object.keys(ORB_DEFS).filter((id) => !SIDEBAR_HIDDEN.has(id));
}

export interface OrbActionContext {
  /** Active pane's session id, or null if no pane selected. */
  sessionId: string | null;
  /** Send raw text to the active pane (helper around terminal:input). */
  sendInput: (data: string) => void;
  /** Send terminal:clear to the active pane. */
  clearTerminal: () => void;
  /** Scroll the active pane's TerminalView to the bottom. */
  scrollToBottom: () => void;
  /** Open the tools grid flyout (parent-controlled). */
  openTools: () => void;
  /** Toggle a D-Pad arrow-key flyout. */
  toggleDpad: () => void;
  /** Trigger the mic / voice capture flow. */
  openMic: () => void;
}

/**
 * Dispatch an orb's action. Returns true if the orb fired, false if it's
 * inert in the current context (e.g. no active pane).
 */
export function executeOrb(orbId: string, ctx: OrbActionContext): boolean {
  const def = ORB_DEFS[orbId];
  if (!def) return false;

  if (def.action.startsWith('input:')) {
    if (!ctx.sessionId) return false;
    ctx.sendInput(def.action.slice(6));
    return true;
  }

  switch (def.action) {
    case 'clear':
      if (!ctx.sessionId) return false;
      ctx.clearTerminal();
      return true;
    case 'scroll':
      if (!ctx.sessionId) return false;
      ctx.scrollToBottom();
      return true;
    case 'tools':
      ctx.openTools();
      return true;
    case 'dpad':
      ctx.toggleDpad();
      return true;
    case 'mic':
      ctx.openMic();
      return true;
    default:
      return false;
  }
}
