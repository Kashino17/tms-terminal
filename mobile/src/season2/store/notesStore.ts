/**
 * Season 2 per-terminal notes & todos — persisted under its own key so the
 * classic stores stay untouched. Keyed by terminal tab id (stable across
 * app restarts because terminalStore persists tabs).
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface S2Note { id: string; text: string; time: string }
export interface S2Todo { id: string; text: string; done: boolean }

interface TabNotes { notes: S2Note[]; todos: S2Todo[] }

interface NotesState {
  byTab: Record<string, TabNotes>;
  addNote: (tabId: string, text: string) => void;
  deleteNote: (tabId: string, noteId: string) => void;
  addTodo: (tabId: string, text: string) => void;
  toggleTodo: (tabId: string, todoId: string) => void;
  deleteTodo: (tabId: string, todoId: string) => void;
}

const empty: TabNotes = { notes: [], todos: [] };

function timestamp(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const useNotesStore = create<NotesState>()(
  persist(
    (set) => ({
      byTab: {},
      addNote(tabId, text) {
        set((s) => {
          const cur = s.byTab[tabId] ?? empty;
          return {
            byTab: {
              ...s.byTab,
              [tabId]: { ...cur, notes: [...cur.notes, { id: `n-${Date.now()}`, text, time: timestamp() }] },
            },
          };
        });
      },
      deleteNote(tabId, noteId) {
        set((s) => {
          const cur = s.byTab[tabId] ?? empty;
          return { byTab: { ...s.byTab, [tabId]: { ...cur, notes: cur.notes.filter((n) => n.id !== noteId) } } };
        });
      },
      addTodo(tabId, text) {
        set((s) => {
          const cur = s.byTab[tabId] ?? empty;
          return {
            byTab: {
              ...s.byTab,
              [tabId]: { ...cur, todos: [...cur.todos, { id: `t-${Date.now()}`, text, done: false }] },
            },
          };
        });
      },
      toggleTodo(tabId, todoId) {
        set((s) => {
          const cur = s.byTab[tabId] ?? empty;
          return {
            byTab: {
              ...s.byTab,
              [tabId]: { ...cur, todos: cur.todos.map((t) => (t.id === todoId ? { ...t, done: !t.done } : t)) },
            },
          };
        });
      },
      deleteTodo(tabId, todoId) {
        set((s) => {
          const cur = s.byTab[tabId] ?? empty;
          return { byTab: { ...s.byTab, [tabId]: { ...cur, todos: cur.todos.filter((t) => t.id !== todoId) } } };
        });
      },
    }),
    {
      name: 'tms-s2-notes',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
