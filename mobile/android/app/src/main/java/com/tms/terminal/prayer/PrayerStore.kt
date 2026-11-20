package com.tms.terminal.prayer

import android.content.Context
import android.content.SharedPreferences

/**
 * Einstellungen + letzter Standort für den Gebetsruf — liegen nativ, damit
 * Alarme auch ohne laufende App (nach Neustart, Tage später) planbar sind.
 * Die App schreibt sie über AdhanModule.configure().
 */
class PrayerStore(context: Context) {
    private val p: SharedPreferences = context.applicationContext.getSharedPreferences("tms_prayer", Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = p.getBoolean("enabled", false)
        set(v) { p.edit().putBoolean("enabled", v).apply() }
    var wecker: Boolean
        get() = p.getBoolean("wecker", false)
        set(v) { p.edit().putBoolean("wecker", v).apply() }
    var reciter: String
        get() = p.getString("reciter", "mishary") ?: "mishary"
        set(v) { p.edit().putString("reciter", v).apply() }

    val hasLocation: Boolean get() = p.contains("lat") && p.contains("lon")
    val lat: Double get() = java.lang.Double.longBitsToDouble(p.getLong("lat", 0L))
    val lon: Double get() = java.lang.Double.longBitsToDouble(p.getLong("lon", 0L))
    val locationLabel: String get() = p.getString("locLabel", "") ?: ""
    val locationAt: Long get() = p.getLong("locAt", 0L)
    /** Vom Nutzer gesetzter Ort (statt GPS) — wird dann nicht überschrieben. */
    val manualLocation: Boolean get() = p.getBoolean("locManual", false)

    fun setLocation(lat: Double, lon: Double, label: String?, at: Long, manual: Boolean) {
        p.edit()
            .putLong("lat", java.lang.Double.doubleToRawLongBits(lat))
            .putLong("lon", java.lang.Double.doubleToRawLongBits(lon))
            .putString("locLabel", label ?: "")
            .putLong("locAt", at)
            .putBoolean("locManual", manual)
            .apply()
    }

    // Diagnose: was zuletzt geplant wurde (zeigt die App in den Einstellungen).
    var plannedName: String
        get() = p.getString("plannedName", "") ?: ""
        set(v) { p.edit().putString("plannedName", v).apply() }
    var plannedAt: Long
        get() = p.getLong("plannedAt", 0L)
        set(v) { p.edit().putLong("plannedAt", v).apply() }
    var plannedExact: Boolean
        get() = p.getBoolean("plannedExact", false)
        set(v) { p.edit().putBoolean("plannedExact", v).apply() }
    var lastReason: String
        get() = p.getString("lastReason", "") ?: ""
        set(v) { p.edit().putString("lastReason", v).apply() }
}
