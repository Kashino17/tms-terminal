package com.tms.terminal

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
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

    @ReactMethod
    fun scheduleAlarm(delaySec: Int, prayerName: String, prayerTime: String, prayerArabic: String, isWecker: Boolean, promise: Promise) {
        try {
            val context = reactApplicationContext
            val intent = Intent(context, AdhanAlarmReceiver::class.java).apply {
                putExtra("prayerName", prayerName)
                putExtra("prayerTime", prayerTime)
                putExtra("prayerArabic", prayerArabic)
                putExtra("wecker", isWecker)
            }

            val requestCode = (prayerName + prayerTime).hashCode()
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
            // Cancel known prayer alarms
            val prayers = listOf("Fajr", "Dhuhr", "Asr", "Maghrib", "Isha", "Test")
            for (name in prayers) {
                val intent = Intent(context, AdhanAlarmReceiver::class.java)
                val code = (name + "00:00").hashCode()
                val pi = PendingIntent.getBroadcast(
                    context, code, intent,
                    PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
                )
                pi?.let { alarmManager.cancel(it) }
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("CANCEL_ERROR", e.message)
        }
    }
}
