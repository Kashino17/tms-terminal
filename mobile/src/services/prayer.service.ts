import * as Location from 'expo-location';
// Die Rechenlogik liegt in prayer.core.mjs, damit mobile/scripts/prayer.test.mjs
// sie ohne React Native pruefen kann. Hier nur re-exportiert — eine Quelle.
import {
  stripZone, toLocalDate, getNextPrayer, minutesUntil, formatRemaining,
  getPrayerProgress, hasPassed, PRAYER_ORDER, ADHAN_PRAYERS,
} from './prayer.core.mjs';

export {
  stripZone, toLocalDate, getNextPrayer, minutesUntil, formatRemaining,
  getPrayerProgress, hasPassed, PRAYER_ORDER, ADHAN_PRAYERS,
};

export interface PrayerTimes {
  Fajr: string;
  Sunrise: string;
  Dhuhr: string;
  Asr: string;
  Maghrib: string;
  Isha: string;
}

export interface PrayerData {
  timings: PrayerTimes;
  date: {
    readable: string;
    hijri: {
      day: string;
      month: { en: string; ar: string };
      year: string;
    };
  };
  meta: {
    method: { name: string };
  };
}

export interface LocationInfo {
  latitude: number;
  longitude: number;
  city?: string;
  country?: string;
}

const PRAYER_NAMES: Record<keyof PrayerTimes, { de: string; ar: string; emoji: string }> = {
  Fajr: { de: 'Fajr', ar: 'الفجر', emoji: '🌙' },
  Sunrise: { de: 'Sunrise', ar: 'الشروق', emoji: '🌅' },
  Dhuhr: { de: 'Dhuhr', ar: 'الظهر', emoji: '☀️' },
  Asr: { de: 'Asr', ar: 'العصر', emoji: '🌤️' },
  Maghrib: { de: 'Maghrib', ar: 'المغرب', emoji: '🌇' },
  Isha: { de: 'Isha', ar: 'العشاء', emoji: '🌙' },
};

export { PRAYER_NAMES };

/** Get current GPS location + reverse geocode for city name */
// Cache for reverse geocoding — only re-geocode if position changed significantly
let lastGeocode: { lat: number; lon: number; city?: string; country?: string } | null = null;

export async function getCurrentLocation(): Promise<LocationInfo | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;

    // 1. Try last known position first (instant, no GPS wait)
    let loc = await Location.getLastKnownPositionAsync();

    // 2. If no last known or it's too old (>30min), get fresh position
    if (!loc || (Date.now() - loc.timestamp) > 30 * 60 * 1000) {
      loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Low, // Low accuracy = fast (500m is fine for prayer times)
      });
    }

    if (!loc) return null;

    const lat = loc.coords.latitude;
    const lon = loc.coords.longitude;

    // 3. Only reverse-geocode if position changed significantly (>1km)
    let city = lastGeocode?.city;
    let country = lastGeocode?.country;
    const needGeocode = !lastGeocode ||
      Math.abs(lat - lastGeocode.lat) > 0.01 ||
      Math.abs(lon - lastGeocode.lon) > 0.01;

    if (needGeocode) {
      try {
        const [geo] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
        if (geo) {
          city = geo.city ?? geo.subregion ?? undefined;
          country = geo.country ?? undefined;
          lastGeocode = { lat, lon, city, country };
        }
      } catch {}
    }

    return { latitude: lat, longitude: lon, city, country };
  } catch {
    return null;
  }
}

/** Fetch prayer times from Aladhan API (free, no key needed) */
export async function fetchPrayerTimes(
  latitude: number,
  longitude: number,
  method = 3, // MWL (Muslim World League)
): Promise<PrayerData | null> {
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await fetch(
      `https://api.aladhan.com/v1/timings/${timestamp}?latitude=${latitude}&longitude=${longitude}&method=${method}`,
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 200) return null;
    return json.data as PrayerData;
  } catch {
    return null;
  }
}

// getNextPrayer, formatRemaining, getPrayerProgress und hasPassed stehen ab jetzt
// in prayer.core.mjs und werden oben re-exportiert. Grund: sie brauchen weder React
// Native noch das Netz, sind aber genau die Logik, die jetzt in zwei Layouts
// (V1-Screen und V2-WebView) gebraucht wird — einmal getestet, beide benutzt.
//
// Hinweis zur Zeitzone: die API liefert "HH:MM (Europe/Berlin)", gelesen wird die
// Uhrzeit als LOKALE Zeit des Geraets. In der Praxis stimmt das, weil der Server die
// Zeiten fuer den angefragten Ort in dessen Zone zurueckgibt. Bewusst so, siehe
// docs/superpowers/specs/2026-10-01-qol-features-v2-gebetszeiten-design.md B-6.

/** Ist diese Uhrzeit heute schon vorbei? (duerftes Argument weicht fuer die Tests) */
export type PassedFn = typeof hasPassed;
