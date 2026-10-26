import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** Berechnungsmethoden der Aladhan-API. 3 = Muslim World League ist der Standard. */
export const PRAYER_METHODS = [
  { id: 3, name: 'MWL', full: 'Muslim World League' },
  { id: 2, name: 'ISNA', full: 'Islamic Society of North America' },
  { id: 5, name: 'Egypt', full: 'Egyptian General Authority of Survey' },
  { id: 4, name: 'Makkah', full: 'Umm al-Qura, Makkah' },
  { id: 1, name: 'Karachi', full: 'University of Islamic Sciences, Karachi' },
] as const;

export const DEFAULT_PRAYER_METHOD = 3;

export interface PrayerLocation {
  latitude: number;
  longitude: number;
  label: string;
}

interface PrayerState {
  /** Berechnungsmethode, in beiden Layouts und beiden Screens dieselbe. */
  method: number;
  /** Von Hand gewaehlter Ort. Null = GPS. */
  location: PrayerLocation | null;
  setMethod: (method: number) => void;
  setLocation: (location: PrayerLocation | null) => void;
}

export const usePrayerStore = create<PrayerState>()(
  persist(
    (set) => ({
      method: DEFAULT_PRAYER_METHOD,
      location: null,
      setMethod(method) { set({ method }); },
      setLocation(location) { set({ location }); },
    }),
    {
      name: 'tms-prayer',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

/** Anzeigename einer Methode, fuer Chips und Kopfzeilen. */
export function prayerMethodName(id: number): string {
  return PRAYER_METHODS.find((m) => m.id === id)?.name ?? 'MWL';
}