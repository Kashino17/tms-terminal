package com.tms.terminal.prayer

import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.util.Log
import com.tms.terminal.AdhanAlarmReceiver
import com.tms.terminal.MainActivity
import java.util.Date

/**
 * Stellt immer genau EINEN Alarm: das nächste Gebet. Beim Klingeln, nach
 * Neustart, Update, Zeit-/Zeitzonenwechsel und bei jeder Änderung aus der App
 * wird neu gerechnet — so läuft die Kette tagelang ohne die App weiter und
 * folgt dem Ort (Zeitzone → Methode, letzter Standort → Zeiten).
 *
 * setAlarmClock: der zuverlässigste Alarm, den Android kennt (Wecker-Apps):
 * klingelt auf die Minute, auch im Doze-/Energiesparmodus.
 */
object PrayerScheduler {
    private const val TAG = "TmsPrayer"
    private const val REQ_NEXT = 41
    private const val REQ_TEST = 42

    fun reschedule(context: Context, reason: String) {
        val app = context.applicationContext
        val store = PrayerStore(app)
        store.lastReason = reason
        cancel(app, REQ_NEXT)
        refreshLocation(app, store)
        if (!store.enabled || !store.hasLocation) {
            store.plannedName = ""; store.plannedAt = 0L
            Log.i(TAG, "kein Alarm ($reason): enabled=${store.enabled} location=${store.hasLocation}")
            return
        }
        val next = try { PrayerEngine.next(app, store.lat, store.lon) } catch (e: Exception) {
            Log.w(TAG, "Rechnung fehlgeschlagen", e); null
        } ?: return
        val wecker = next.name == "Fajr" && store.wecker
        val exact = set(app, REQ_NEXT, next.at.time, alarmIntent(app, next.name, next.at, wecker, test = false))
        store.plannedName = next.name
        store.plannedAt = next.at.time
        store.plannedExact = exact
        Log.i(TAG, "geplant ($reason): ${next.name} ${Date(next.at.time)} exact=$exact")
    }

    /** Test aus den Einstellungen: derselbe Weg wie echt, in `delaySec` Sekunden. */
    fun scheduleTest(context: Context, delaySec: Int, name: String) {
        val app = context.applicationContext
        val at = System.currentTimeMillis() + delaySec * 1000L
        set(app, REQ_TEST, at, alarmIntent(app, name, Date(at), wecker = false, test = true))
    }

    fun cancelAll(context: Context) {
        cancel(context.applicationContext, REQ_NEXT)
        cancel(context.applicationContext, REQ_TEST)
        PrayerStore(context).apply { plannedName = ""; plannedAt = 0L }
    }

    fun canScheduleExact(context: Context): Boolean {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
    }

    private fun alarmIntent(context: Context, name: String, at: Date, wecker: Boolean, test: Boolean): Intent =
        Intent(context, AdhanAlarmReceiver::class.java).apply {
            action = AdhanAlarmReceiver.ACTION_FIRE
            putExtra("prayerName", name)
            putExtra("prayerAt", at.time)
            putExtra("prayerArabic", PrayerEngine.ARABIC[name] ?: "")
            putExtra("wecker", wecker)
            putExtra("test", test)
        }

    /** true = exakt (Wecker-Alarm), false = Android darf um ein paar Minuten schieben. */
    private fun set(context: Context, req: Int, at: Long, intent: Intent): Boolean {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = PendingIntent.getBroadcast(context, req, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return if (canScheduleExact(context)) {
            // Antippen des Wecker-Symbols in der Statusleiste öffnet TMS.
            val show = PendingIntent.getActivity(context, req, Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            am.setAlarmClock(AlarmManager.AlarmClockInfo(at, show), pi)
            true
        } else {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            false
        }
    }

    private fun cancel(context: Context, req: Int) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = PendingIntent.getBroadcast(context, req, Intent(context, AdhanAlarmReceiver::class.java).apply { action = AdhanAlarmReceiver.ACTION_FIRE },
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)
        if (pi != null) { am.cancel(pi); pi.cancel() }
    }

    /**
     * Letzten bekannten Standort übernehmen (kein eigenes GPS-Einschalten):
     * Android liefert ihn auch ohne laufende App, wenn „Standort: Immer
     * erlauben“ gesetzt ist — sonst bleibt der Ort von der letzten App-Öffnung.
     */
    private fun refreshLocation(context: Context, store: PrayerStore) {
        if (store.manualLocation) return
        val fine = context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!fine && !coarse) return
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return
        var best: Location? = null
        val providers = mutableListOf(LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
        if (fine) providers.add(LocationManager.GPS_PROVIDER)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) providers.add(LocationManager.FUSED_PROVIDER)
        for (prov in providers) {
            val loc = try { lm.getLastKnownLocation(prov) } catch (_: Exception) { null } ?: continue
            if (best == null || loc.time > best!!.time) best = loc
        }
        val b = best ?: return
        if (b.time <= store.locationAt) return
        // Ortsname bleibt der letzte bekannte, bis die App einen neuen schickt.
        val moved = !store.hasLocation || distanceKm(store.lat, store.lon, b.latitude, b.longitude) > 5
        store.setLocation(b.latitude, b.longitude, if (moved) "" else store.locationLabel, b.time, manual = false)
    }

    private fun distanceKm(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val r = FloatArray(1)
        Location.distanceBetween(lat1, lon1, lat2, lon2, r)
        return r[0] / 1000.0
    }
}
