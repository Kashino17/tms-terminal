import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'tms:paneGroups';

/**
 * A saved pane configuration: a named set of terminal sessionIds that the user
 * can recall to populate the multi-spotlight in one tap.
 *
 * Slot order is preserved (the array index = pane slot). `null` entries mean
 * "empty pane slot" — useful when a group was saved in 2-up or 4-up mode with
 * some panes empty.
 */
export interface PaneGroup {
  id: string;
  name: string;
  /** sessionIds in order; null entries = empty pane slot */
  terminals: (string | null)[];
  createdAt: number;
}

interface PaneGroupsState {
  /** Groups keyed by serverId (each connected TMS server has its own sets). */
  groups: Record<string, PaneGroup[]>;
  /** Currently active group ID per serverId (or null when nothing loaded). */
  activeId: Record<string, string | null>;
  loaded: boolean;

  load: () => Promise<void>;
  getGroups: (serverId: string) => PaneGroup[];
  getActive: (serverId: string) => string | null;
  setActive: (serverId: string, groupId: string | null) => void;
  /** Save the current pane layout as a new group. Returns the new group's ID. */
  saveGroup: (serverId: string, name: string, terminals: (string | null)[]) => string;
  removeGroup: (serverId: string, groupId: string) => void;
  renameGroup: (serverId: string, groupId: string, name: string) => void;
}

function persist(state: { groups: Record<string, PaneGroup[]>; activeId: Record<string, string | null> }) {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {});
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export const usePaneGroupsStore = create<PaneGroupsState>((set, get) => ({
  groups: {},
  activeId: {},
  loaded: false,

  async load() {
    if (get().loaded) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        set({
          groups: parsed.groups || {},
          activeId: parsed.activeId || {},
          loaded: true,
        });
      } else {
        set({ loaded: true });
      }
    } catch {
      set({ loaded: true });
    }
  },

  getGroups(serverId) {
    return get().groups[serverId] || [];
  },

  getActive(serverId) {
    return get().activeId[serverId] ?? null;
  },

  setActive(serverId, groupId) {
    const activeId = { ...get().activeId, [serverId]: groupId };
    set({ activeId });
    persist({ groups: get().groups, activeId });
  },

  saveGroup(serverId, name, terminals) {
    const id = makeId();
    const newGroup: PaneGroup = {
      id,
      name: name.trim() || 'Unnamed',
      terminals: [...terminals],
      createdAt: Date.now(),
    };
    const groups = { ...get().groups };
    groups[serverId] = [...(groups[serverId] || []), newGroup];
    const activeId = { ...get().activeId, [serverId]: id };
    set({ groups, activeId });
    persist({ groups, activeId });
    return id;
  },

  removeGroup(serverId, groupId) {
    const groups = { ...get().groups };
    groups[serverId] = (groups[serverId] || []).filter((g) => g.id !== groupId);
    const activeId = { ...get().activeId };
    if (activeId[serverId] === groupId) {
      activeId[serverId] = groups[serverId][0]?.id ?? null;
    }
    set({ groups, activeId });
    persist({ groups, activeId });
  },

  renameGroup(serverId, groupId, name) {
    const groups = { ...get().groups };
    groups[serverId] = (groups[serverId] || []).map((g) =>
      g.id === groupId ? { ...g, name: name.trim() || g.name } : g,
    );
    set({ groups });
    persist({ groups, activeId: get().activeId });
  },
}));
