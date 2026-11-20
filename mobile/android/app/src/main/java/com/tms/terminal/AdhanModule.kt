package com.tms.terminal

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.tms.terminal.prayer.PrayerEngine
import com.tms.terminal.prayer.PrayerScheduler
import com.tms.terminal.prayer.PrayerStore
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

/**
 * Gebetsruf: die App gibt Einstellungen + Standort, das Handy rechnet und plant
 * selbst (PrayerEngine/PrayerScheduler) — auch wenn die App tagelang zu ist.
 */
class AdhanModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName() = "AdhanModule"

    /** Einstellungen/Standort übernehmen und den nächsten Gebetsruf stellen.
     *  Felder (alle optional): enabled, wecker, reciter, lat, lon, label, manual. */
    @ReactMethod
    fun configure(cfg: ReadableMap, promise: Promise) {
        try {
            val store = PrayerStore(reactApplicationContext)
            if (cfg.hasKey("enabled")) store.enabled = cfg.getBoolean("enabled")
            if (cfg.hasKey("wecker")) store.wecker = cfg.getBoolean("wecker")
            if (cfg.hasKey("reciter")) store.reciter = cfg.getString("reciter") ?: "mishary"
            if (cfg.hasKey("lat") && cfg.hasKey("lon") && !cfg.isNull("lat") && !cfg.isNull("lon")) {
                val manual = cfg.hasKey("manual") && cfg.getBoolean("manual")
                store.setLocation(cfg.getDouble("lat"), cfg.getDouble("lon"),
                    if (cfg.hasKey("label")) cfg.getString("label") else null, System.currentTimeMillis(), manual)
            }
            PrayerScheduler.reschedule(reactApplicationContext, "app")
            promise.resolve(status())
        } catch (e: Exception) {
            promise.reject("ADHAN_CONFIGURE", e.message, e)
        }
    }

    /** Zeiten für heute (+ weitere Tage), genau so, wie die Alarme sie nutzen. */
    @ReactMethod
    fun getTimes(days: Int, promise: Promise) {
        try {
            val store = PrayerStore(reactApplicationContext)
            if (!store.hasLocation) { promise.resolve(null); return }
            val fmt = SimpleDateFormat("HH:mm", Locale.GERMANY)
            val dayFmt = SimpleDateFormat("yyyy-MM-dd", Locale.GERMANY)
            val list = Arguments.createArray()
            val cal = Calendar.getInstance()
            var methodName = ""; var methodId = ""; var country: String? = null
            for (i in 0 until days.coerceIn(1, 7)) {
                val d = PrayerEngine.day(reactApplicationContext, store.lat, store.lon, cal)
                methodName = d.method.name; methodId = d.method.id; country = d.method.country
                val m = Arguments.createMap()
                m.putString("date", dayFmt.format(cal.time))
                for ((k, v) in d.times) m.putString(k, fmt.format(v))
                list.pushMap(m)
                cal.add(Calendar.DAY_OF_MONTH, 1)
            }
            val out = Arguments.createMap()
            out.putArray("days", list)
            out.putString("method", methodName)
            out.putString("methodId", methodId)
            if (country != null) out.putString("country", country) else out.putNull("country")
            out.putMap("status", status())
            promise.resolve(out)
        } catch (e: Exception) {
            promise.reject("ADHAN_TIMES", e.message, e)
        }
    }

    /** Heutige Zeiten für einen Ort — dieselbe Rechnung wie die Alarme (für die Anzeige). */
    @ReactMethod
    fun timesFor(lat: Double, lon: Double, promise: Promise) {
        try {
            val d = PrayerEngine.day(reactApplicationContext, lat, lon, Calendar.getInstance())
            val fmt = SimpleDateFormat("HH:mm", Locale.GERMANY)
            val timings = Arguments.createMap()
            for ((k, v) in d.times) timings.putString(k, fmt.format(v))
            val out = Arguments.createMap()
            out.putMap("timings", timings)
            out.putString("method", d.method.name)
            out.putString("methodId", d.method.id)
            if (d.method.country != null) out.putString("country", d.method.country) else out.putNull("country")
            promise.resolve(out)
        } catch (e: Exception) {
            promise.reject("ADHAN_TIMES", e.message, e)
        }
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        try { promise.resolve(status()) } catch (e: Exception) { promise.reject("ADHAN_STATUS", e.message, e) }
    }

    /** Test: derselbe Weg wie echt, in `delaySec` Sekunden. Alte Signatur bleibt. */
    @ReactMethod
    fun scheduleAlarm(delaySec: Int, prayerName: String, prayerTime: String, prayerArabic: String, isWecker: Boolean, promise: Promise) {
        try {
            PrayerScheduler.scheduleTest(reactApplicationContext, delaySec, prayerName)
            promise.resolve(42)
        } catch (e: Exception) {
            promise.reject("ALARM_ERROR", e.message)
        }
    }

    /** Früher: alle Einzelalarme abbrechen. Jetzt plant das Handy selbst —
     *  hier nur noch neu stellen (oder nichts, wenn aus). */
    @ReactMethod
    fun cancelAllAlarms(promise: Promise) {
        try {
            PrayerScheduler.reschedule(reactApplicationContext, "cancel")
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("CANCEL_ERROR", e.message)
        }
    }

    @ReactMethod
    fun canScheduleExact(promise: Promise) {
        promise.resolve(PrayerScheduler.canScheduleExact(reactApplicationContext))
    }

    @ReactMethod
    fun requestExactAlarms(promise: Promise) {
        try {
            openSetting("exact")
            promise.resolve(false)
        } catch (e: Exception) {
            promise.reject("EXACT_REQUEST_ERROR", e.message)
        }
    }

    /** Die passende Android-Seite für eine fehlende Erlaubnis öffnen. */
    @ReactMethod
    fun openPermission(which: String, promise: Promise) {
        try { openSetting(which); promise.resolve(true) } catch (e: Exception) { promise.reject("ADHAN_PERM", e.message, e) }
    }

    private fun openSetting(which: String) {
        val ctx = reactApplicationContext
        val pkg = Uri.parse("package:${ctx.packageName}")
        val intent = when (which) {
            "exact" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkg) else null
            "overlay" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkg) else null
            "fullscreen" -> if (Build.VERSION.SDK_INT >= 34) Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg) else null
            "battery" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS) else null
            "notifications" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName) else null
            else -> null
        } ?: Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg) // Standort u. a.: App-Info
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity = currentActivity
        if (activity != null) activity.startActivity(intent) else ctx.startActivity(intent)
    }

    /** Was fehlt noch, damit der Gebetsruf zuverlässig kommt? */
    private fun status() = Arguments.createMap().apply {
        val ctx = reactApplicationContext
        val store = PrayerStore(ctx)
        putBoolean("enabled", store.enabled)
        putString("nextName", store.plannedName)
        putDouble("nextAt", store.plannedAt.toDouble())
        putBoolean("nextExact", store.plannedExact)
        putString("location", store.locationLabel)
        putDouble("locationAt", store.locationAt.toDouble())
        putBoolean("hasLocation", store.hasLocation)
        val country = PrayerEngine.countryForZone(ctx)
        if (country != null) putString("country", country) else putNull("country")
        putString("method", PrayerEngine.methodFor(ctx, country).name)
        val perms = Arguments.createMap()
        perms.putBoolean("exact", PrayerScheduler.canScheduleExact(ctx))
        perms.putBoolean("overlay", Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(ctx))
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        perms.putBoolean("fullscreen", Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent())
        perms.putBoolean("notifications", NotificationManagerCompat.from(ctx).areNotificationsEnabled())
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        perms.putBoolean("battery", Build.VERSION.SDK_INT < Build.VERSION_CODES.M || pm.isIgnoringBatteryOptimizations(ctx.packageName))
        val loc = ctx.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        perms.putBoolean("location", loc)
        perms.putBoolean("backgroundLocation", Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ctx.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED)
        putMap("perms", perms)
    }
}
