import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface DayLog {
  date: string; // YYYY-MM-DD
  waterCount: number; // number of 500ml bottles (0-6)
  badDrinks: { type: BadDrinkType; count: number }[];
  hpGained: number;
  hpLost: number;
}

export type BadDrinkType = 'softdrink' | 'energy' | 'juice' | 'coffee' | 'alcohol';

export const BAD_DRINK_INFO: Record<BadDrinkType, { label: string; penalty: number; image: any }> = {
  softdrink: { label: 'Softdrink', penalty: 0.05, image: require('../../assets/hydra/softdrink.png') },
  energy: { label: 'Energy Drink', penalty: 0.10, image: require('../../assets/hydra/energy.png') },
  juice: { label: 'Fruchtsaft', penalty: 0.05, image: require('../../assets/hydra/juice.png') },
  coffee: { label: 'Kaffee', penalty: 0.02, image: require('../../assets/hydra/coffee.png') },
  alcohol: { label: 'Alkohol', penalty: 0.20, image: require('../../assets/hydra/alcohol.png') },
};

export const WATER_IMAGE = require('../../assets/hydra/water.png');

interface HydraState {
  totalHP: number;
  history: DayLog[];

  // Today helpers
  getToday: () => DayLog;
  getDayLog: (date: string) => DayLog | undefined;
  getMonthLogs: (year: number, month: number) => DayLog[];

  // Actions
  drinkWater: () => void;
  undoWater: () => void;
  drinkBad: (type: BadDrinkType) => void;
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ensureToday(history: DayLog[]): DayLog[] {
  const key = todayKey();
  if (history.length === 0 || history[history.length - 1].date !== key) {
    history.push({ date: key, waterCount: 0, badDrinks: [], hpGained: 0, hpLost: 0 });
  }
  return history;
}

export const useHydraStore = create<HydraState>()(
  persist(
    (set, get) => ({
      totalHP: 0,
      history: [],

      getToday() {
        const key = todayKey();
        const h = get().history;
        return h.find(d => d.date === key) ?? { date: key, waterCount: 0, badDrinks: [], hpGained: 0, hpLost: 0 };
      },

      getDayLog(date: string) {
        return get().history.find(d => d.date === date);
      },

      getMonthLogs(year: number, month: number) {
        const prefix = `${year}-${String(month).padStart(2, '0')}`;
        return get().history.filter(d => d.date.startsWith(prefix));
      },

      drinkWater() {
        set(state => {
          const history = ensureToday([...state.history]);
          const today = history[history.length - 1];

          if (today.waterCount >= 6) return state; // Max 6 bottles (3L)

          today.waterCount += 1;

          // Award HP: +1 per full liter (every 2 bottles)
          let hpGain = 0;
          if (today.waterCount % 2 === 0) {
            hpGain = 1;
            today.hpGained += 1;
          }

          return {
            history,
            totalHP: state.totalHP + hpGain,
          };
        });
      },

      undoWater() {
        set(state => {
          const history = ensureToday([...state.history]);
          const today = history[history.length - 1];

          if (today.waterCount <= 0) return state;

          // If we're undoing a liter boundary, remove the HP
          const wasOnLiterBoundary = today.waterCount % 2 === 0;
          let hpRemove = 0;
          if (wasOnLiterBoundary && today.hpGained > 0) {
            hpRemove = 1;
            today.hpGained -= 1;
          }

          today.waterCount -= 1;

          return {
            history,
            totalHP: Math.max(0, state.totalHP - hpRemove),
          };
        });
      },

      drinkBad(type: BadDrinkType) {
        set(state => {
          const history = ensureToday([...state.history]);
          const today = history[history.length - 1];
          const info = BAD_DRINK_INFO[type];

          // Find or create entry for this drink type
          const existing = today.badDrinks.find(d => d.type === type);
          if (existing) {
            existing.count += 1;
          } else {
            today.badDrinks.push({ type, count: 1 });
          }

          // Calculate HP loss: percentage of total, minimum 1
          const percentLoss = Math.floor(state.totalHP * info.penalty);
          const hpLoss = Math.max(1, percentLoss);
          today.hpLost += hpLoss;

          return {
            history,
            totalHP: state.totalHP - hpLoss, // Can go negative
          };
        });
      },
    }),
    {
      name: 'tms-hydra',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
