import * as Location from 'expo-location';

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

/** Determine next prayer from current time */
export function getNextPrayer(timings: PrayerTimes): { name: keyof PrayerTimes; time: string; remainingMs: number } | null {
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const prayerOrder: (keyof PrayerTimes)[] = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

  for (const name of prayerOrder) {
    const timeStr = timings[name]; // "HH:MM" or "HH:MM (TIMEZONE)"
    const cleanTime = timeStr.replace(/\s*\(.*\)/, '').trim();
    const [h, m] = cleanTime.split(':').map(Number);
    const prayerDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
    const diff = prayerDate.getTime() - now.getTime();
    if (diff > 0) {
      return { name, time: cleanTime, remainingMs: diff };
    }
  }

  // All prayers passed today — next is Fajr tomorrow
  const cleanFajr = timings.Fajr.replace(/\s*\(.*\)/, '').trim();
  const [fh, fm] = cleanFajr.split(':').map(Number);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, fh, fm, 0);
  return { name: 'Fajr', time: cleanFajr, remainingMs: tomorrow.getTime() - now.getTime() };
}

/** Format remaining time as "Xh Ym" or "Ym" */
export function formatRemaining(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Calculate progress between previous and next prayer (0-1) */
export function getPrayerProgress(timings: PrayerTimes): number {
  const now = new Date();
  const prayerOrder: (keyof PrayerTimes)[] = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

  const toMinutes = (timeStr: string) => {
    const clean = timeStr.replace(/\s*\(.*\)/, '').trim();
    const [h, m] = clean.split(':').map(Number);
    return h * 60 + m;
  };

  const nowMin = now.getHours() * 60 + now.getMinutes();

  for (let i = 0; i < prayerOrder.length; i++) {
    const nextMin = toMinutes(timings[prayerOrder[i]]);
    if (nowMin < nextMin) {
      const prevMin = i > 0 ? toMinutes(timings[prayerOrder[i - 1]]) : 0;
      const total = nextMin - prevMin;
      if (total <= 0) return 0;
      return (nowMin - prevMin) / total;
    }
  }
  return 1;
}

/** Check if a prayer time has passed today */
export function hasPassed(timeStr: string): boolean {
  const clean = timeStr.replace(/\s*\(.*\)/, '').trim();
  const [h, m] = clean.split(':').map(Number);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= h * 60 + m;
}
