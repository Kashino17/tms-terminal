// Gebetszeiten-Methode nach Ort — dieselben Regeln wie PrayerEngine.kt (Android).
// Quelle der Zahlen: android/app/src/main/assets/prayer_methods.json (eine Datei
// für App und Test). Hier ohne React Native, damit es sich mit node prüfen lässt.

/** Land aus der Zeitzone des Handys (stellt sich beim Reisen von selbst um). */
export function countryForZone(zones, tz) {
  return (tz && zones[tz]) || null;
}

/** Offizielle Methode des Landes, sonst die Standardmethode. */
export function methodFor(table, country) {
  const id = (country && table.countries[country]) || table.default;
  return { id, ...table.methods[id] };
}

/** Rechenwerte (unabhängig von der Bibliothek) — die Kotlin-Seite baut daraus
 *  CalculationParameters von adhan-java, der Test die von adhan-js. */
export function paramsFor(table, country) {
  const m = methodFor(table, country);
  return {
    method: m.id,
    name: m.name,
    fajr: m.fajr,
    isha: m.isha ?? 0,
    ishaInterval: m.ishaInterval ?? 0,
    adjust: { fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0, ...(m.adjust || {}) },
    hanafi: !!(country && table.hanafi.includes(country)),
    // Hohe Breiten (Sommer): Fajr/Isha nach Dämmerungswinkel-Anteil der Nacht
    // begrenzen — wie Aladhans Standard „angle based“. Wirkt nur, wo der Winkel
    // nachts nicht erreicht wird; sonst ändert es nichts.
    highLatitude: 'twilightangle',
  };
}
