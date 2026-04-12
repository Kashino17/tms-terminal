import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface OrbPosition { xPct: number; yPct: number }

interface OrbGroupData {
  id: string;
  label: string;
  vertical: boolean;
  orbIds: string[];
  position: OrbPosition;
}

interface ToolSection {
  id: string;
  title: string;
  toolIds: string[];
}

interface OrbLayoutState {
  freeOrbs: Record<string, OrbPosition>;
  groups: OrbGroupData[];
  removedOrbIds: string[];
  dockOrder: string[];
  toolSections: ToolSection[];

  setOrbPosition: (id: string, pos: OrbPosition) => void;
  setGroupPosition: (groupId: string, pos: OrbPosition) => void;
  toggleGroupOrientation: (groupId: string) => void;
  removeOrb: (id: string) => void;
  restoreOrb: (id: string, pos: OrbPosition) => void;
  createGroup: (orbId1: string, orbId2: string, position: OrbPosition) => void;
  addOrbToGroup: (groupId: string, orbId: string) => void;
  removeOrbFromGroup: (groupId: string, orbId: string) => void;
  reorderInGroup: (groupId: string, fromIdx: number, toIdx: number) => void;
  reorderDock: (from: number, to: number) => void;
  addToDock: (orbId: string) => void;
  removeFromDock: (orbId: string) => void;
  updateToolSections: (sections: ToolSection[]) => void;
  resetLayout: () => void;
}

const DEFAULT_FREE_ORBS: Record<string, OrbPosition> = {
  dpad: { xPct: 0.03, yPct: 0.78 },
  mic: { xPct: 0.85, yPct: 0.78 },
  manager: { xPct: 0.15, yPct: 0.78 },
};

const DEFAULT_GROUPS: OrbGroupData[] = [
  {
    id: 'aktionen',
    label: 'Aktionen',
    vertical: false,
    orbIds: ['ctrl_c', 'esc', 'clear', 'delete', 'scissors'],
    position: { xPct: 0.03, yPct: 0.88 },
  },
  {
    id: 'navigation',
    label: 'Navigation',
    vertical: false,
    orbIds: ['scroll', 'enter', 'tools', 'spotlight'],
    position: { xPct: 0.50, yPct: 0.88 },
  },
];

const DEFAULT_TOOL_SECTIONS: ToolSection[] = [
  { id: 'monitoring', title: 'Monitoring', toolIds: ['ports', 'processes'] },
  { id: 'cloud', title: 'Cloud & Daten', toolIds: ['sql', 'render', 'vercel', 'supabase'] },
  { id: 'ai', title: 'AI & Workflow', toolIds: ['autoApprove', 'snippets', 'autopilot', 'watchers'] },
  { id: 'files', title: 'Dateien & Medien', toolIds: ['files', 'screenshots', 'drawing', 'browser'] },
];

const DEFAULT_DOCK_ORDER = [
  'ctrl_c', 'esc', 'clear', 'delete', 'scissors',
  'scroll', 'enter', 'tools', 'spotlight',
  'dpad', 'mic', 'manager',
];

const INITIAL_STATE = {
  freeOrbs: DEFAULT_FREE_ORBS,
  groups: DEFAULT_GROUPS,
  removedOrbIds: [] as string[],
  dockOrder: DEFAULT_DOCK_ORDER,
  toolSections: DEFAULT_TOOL_SECTIONS,
};

export const useOrbLayoutStore = create<OrbLayoutState>()(
  persist(
    (set, get) => ({
      ...INITIAL_STATE,

      setOrbPosition(id, pos) {
        set({ freeOrbs: { ...get().freeOrbs, [id]: pos } });
      },

      setGroupPosition(groupId, pos) {
        set({
          groups: get().groups.map((g) =>
            g.id === groupId ? { ...g, position: pos } : g,
          ),
        });
      },

      toggleGroupOrientation(groupId) {
        set({
          groups: get().groups.map((g) =>
            g.id === groupId ? { ...g, vertical: !g.vertical } : g,
          ),
        });
      },

      removeOrb(id) {
        const state = get();

        // Check if orb is in a group
        const groupIdx = state.groups.findIndex((g) => g.orbIds.includes(id));
        if (groupIdx !== -1) {
          const group = state.groups[groupIdx];
          const remaining = group.orbIds.filter((o) => o !== id);

          let updatedGroups: OrbGroupData[];
          let updatedFree = { ...state.freeOrbs };

          if (remaining.length <= 1) {
            // Dissolve group — remaining orb becomes free
            if (remaining.length === 1) {
              updatedFree[remaining[0]] = group.position;
            }
            updatedGroups = state.groups.filter((_, i) => i !== groupIdx);
          } else {
            updatedGroups = state.groups.map((g, i) =>
              i === groupIdx ? { ...g, orbIds: remaining } : g,
            );
          }

          set({
            groups: updatedGroups,
            freeOrbs: updatedFree,
            removedOrbIds: [...state.removedOrbIds, id],
          });
          return;
        }

        // Orb is free
        const { [id]: _, ...restFree } = state.freeOrbs;
        set({
          freeOrbs: restFree,
          removedOrbIds: [...state.removedOrbIds, id],
        });
      },

      restoreOrb(id, pos) {
        set({
          removedOrbIds: get().removedOrbIds.filter((o) => o !== id),
          freeOrbs: { ...get().freeOrbs, [id]: pos },
        });
      },

      createGroup(orbId1, orbId2, position) {
        const state = get();
        const { [orbId1]: _, [orbId2]: __, ...restFree } = state.freeOrbs;
        const newGroup: OrbGroupData = {
          id: 'grp_' + Date.now(),
          label: '',
          vertical: false,
          orbIds: [orbId1, orbId2],
          position,
        };
        set({
          freeOrbs: restFree,
          groups: [...state.groups, newGroup],
        });
      },

      addOrbToGroup(groupId, orbId) {
        const state = get();
        const { [orbId]: _, ...restFree } = state.freeOrbs;
        set({
          freeOrbs: restFree,
          groups: state.groups.map((g) =>
            g.id === groupId ? { ...g, orbIds: [...g.orbIds, orbId] } : g,
          ),
        });
      },

      removeOrbFromGroup(groupId, orbId) {
        const state = get();
        const group = state.groups.find((g) => g.id === groupId);
        if (!group) return;

        const remaining = group.orbIds.filter((o) => o !== orbId);
        const updatedFree = { ...state.freeOrbs, [orbId]: group.position };

        if (remaining.length <= 1) {
          // Dissolve group — remaining orb becomes free
          if (remaining.length === 1) {
            updatedFree[remaining[0]] = group.position;
          }
          set({
            groups: state.groups.filter((g) => g.id !== groupId),
            freeOrbs: updatedFree,
          });
        } else {
          set({
            groups: state.groups.map((g) =>
              g.id === groupId ? { ...g, orbIds: remaining } : g,
            ),
            freeOrbs: updatedFree,
          });
        }
      },

      reorderInGroup(groupId, fromIdx, toIdx) {
        set({
          groups: get().groups.map((g) => {
            if (g.id !== groupId) return g;
            const orbIds = [...g.orbIds];
            const [moved] = orbIds.splice(fromIdx, 1);
            orbIds.splice(toIdx, 0, moved);
            return { ...g, orbIds };
          }),
        });
      },

      reorderDock(from, to) {
        const dockOrder = [...get().dockOrder];
        const [moved] = dockOrder.splice(from, 1);
        dockOrder.splice(to, 0, moved);
        set({ dockOrder });
      },

      addToDock(orbId) {
        const { dockOrder } = get();
        if (!dockOrder.includes(orbId)) {
          set({ dockOrder: [...dockOrder, orbId] });
        }
      },

      removeFromDock(orbId) {
        set({ dockOrder: get().dockOrder.filter(id => id !== orbId) });
      },

      updateToolSections(sections) {
        set({ toolSections: sections });
      },

      resetLayout() {
        set({ ...INITIAL_STATE });
      },
    }),
    {
      name: 'tms-orb-layout',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

export type { OrbPosition, OrbGroupData, ToolSection, OrbLayoutState };
