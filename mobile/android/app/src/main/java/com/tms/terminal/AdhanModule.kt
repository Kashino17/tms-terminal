package com.tms.terminal

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

/**
 * Native module that schedules exact alarms via AlarmManager
 * to trigger the fullscreen AdhanActivity over the lockscreen.
 */
class AdhanModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName() = "AdhanModule"

    /**
     * Fester Slot je Gebet.
     *
     * Vorher stand hier (prayerName + prayerTime).hashCode() — und in
     * cancelAllAlarms() (name + "00:00").hashCode(). Zwei verschiedene Codes aus
     * zwei verschiedenen Formeln: der Abbruch konnte nie einen Alarm treffen, also
     * blieb nach jedem Umplanen der alte stehen. Ein hashCode() haengt ausserdem
     * an der Kotlin-Version, also gaeng ein Update stillschweigend schief.
     */
    private fun slotFor(name: String): Int = when (name) {
        "Fajr" -> 1
        "Dhuhr" -> 2
        "Asr" -> 3
        "Maghrib" -> 4
        "Isha" -> 5
        "Test" -> 6
        else -> 0
    }

    private fun prayerIntent(context: Context, name: String, time: String, arabic: String, wecker: Boolean): Intent =
        Intent(context, AdhanAlarmReceiver::class.java).apply {
            putExtra("prayerName", name)
            putExtra("prayerTime", time)
            putExtra("prayerArabic", arabic)
            putExtra("wecker", wecker)
        }

    @ReactMethod
    fun scheduleAlarm(delaySec: Int, prayerName: String, prayerTime: String, prayerArabic: String, isWecker: Boolean, promise: Promise) {
        try {
            val context = reactApplicationContext
            val intent = prayerIntent(context, prayerName, prayerTime, prayerArabic, isWecker)

            val requestCode = slotFor(prayerName)
            val pendingIntent = PendingIntent.getBroadcast(
                context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val triggerAt = System.currentTimeMillis() + (delaySec * 1000L)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (alarmManager.canScheduleExactAlarms()) {
                    alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
                } else {
                    // Ohne die Freigabe bleibt AlarmManager nur ungenau. Der Wecker
                    // klingelt dann ein paar Minuten spaet, aber er klingelt — die
                    // Oberflaeche fragt die Freigabe ab, statt still zu fallen.
                    alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
                }
            } else {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
            }

            promise.resolve(requestCode)
        } catch (e: Exception) {
            promise.reject("ALARM_ERROR", e.message)
        }
    }

    @ReactMethod
    fun cancelAllAlarms(promise: Promise) {
        try {
            val context = reactApplicationContext
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val prayers = listOf("Fajr", "Dhuhr", "Asr", "Maghrib", "Isha", "Test")
            for (name in prayers) {
                // FLAG_NO_CREATE: nur abbrechen, was wirklich existiert. Sonst legt
                // getBroadcast() hier schon einen leeren PendingIntent an.
                val pi = PendingIntent.getBroadcast(
                    context, slotFor(name), prayerIntent(context, name, "", "", false),
                    PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
                )
                if (pi != null) {
                    alarmManager.cancel(pi)
                    pi.cancel()
                }
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("CANCEL_ERROR", e.message)
        }
    }

    /** Darf die App exakte Alarme stellen? Ab Android 12 nicht mehr automatisch. */
    @ReactMethod
    fun canScheduleExact(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                promise.resolve(true)
                return
            }
            val am = reactApplicationContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            promise.resolve(am.canScheduleExactAlarms())
        } catch (e: Exception) {
            promise.reject("EXACT_CHECK_ERROR", e.message)
        }
    }

    /** Oeffnet Androids "Alarme & Erinnerungen" fuer diese App und sagt, ob es geklappt hat. */
    @ReactMethod
    fun requestExactAlarms(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                promise.resolve(true)
                return
            }
            val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                data = Uri.parse("package:${reactApplicationContext.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactApplicationContext.startActivity(intent)
            // startActivity kehrt sofort zurueck — die Freigabe setzt der Nutzer
            // auf der Systemseite. canScheduleExact() sagt danach die Wahrheit.
            promise.resolve(false)
        } catch (e: Exception) {
            promise.reject("EXACT_REQUEST_ERROR", e.message)
        }
    }
}