package com.tms.terminal

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * BroadcastReceiver that fires at prayer time.
 * Directly launches the fullscreen AdhanActivity (like WhatsApp calls).
 */
class AdhanAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prayerName = intent.getStringExtra("prayerName") ?: "Gebet"
        val prayerTime = intent.getStringExtra("prayerTime") ?: ""
        val prayerArabic = intent.getStringExtra("prayerArabic") ?: ""
        val isWecker = intent.getBooleanExtra("wecker", false)

        // Wake up the screen
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val wakeLock = powerManager.newWakeLock(
            PowerManager.FULL_WAKE_LOCK or
            PowerManager.ACQUIRE_CAUSES_WAKEUP or
            PowerManager.ON_AFTER_RELEASE,
            "tms:adhan_wake"
        )
        wakeLock.acquire(30000) // 30 seconds max

        // Directly launch the fullscreen activity (not through notification)
        val activityIntent = Intent(context, AdhanFullscreenActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_NO_USER_ACTION or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            putExtra("prayerName", prayerName)
            putExtra("prayerTime", prayerTime)
            putExtra("prayerArabic", prayerArabic)
            putExtra("wecker", isWecker)
        }
        context.startActivity(activityIntent)

        // Also show a notification (for devices that block direct activity launch)
        showNotification(context, prayerName, prayerTime, prayerArabic, isWecker)

        // Release wake lock after a short delay
        try {
            if (wakeLock.isHeld) {
                wakeLock.release()
            }
        } catch (_: Exception) {}
    }

    private fun showNotification(context: Context, prayerName: String, prayerTime: String, prayerArabic: String, isWecker: Boolean = false) {
        val channelId = "adhan_alarm"

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId,
                "Gebetsruf Alarm",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Vollbild-Alarm bei Gebetszeit"
                setBypassDnd(true)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                enableVibration(false) // Activity handles vibration
            }
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }

        // Fullscreen intent as fallback
        val fullscreenIntent = Intent(context, AdhanFullscreenActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION
            putExtra("prayerName", prayerName)
            putExtra("prayerTime", prayerTime)
            putExtra("prayerArabic", prayerArabic)
            putExtra("wecker", isWecker)
        }
        val fullscreenPI = PendingIntent.getActivity(
            context, System.currentTimeMillis().toInt(),
            fullscreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("🕌 Gebetszeit: $prayerName")
            .setContentText("$prayerArabic — $prayerTime")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(fullscreenPI, true)
            .setContentIntent(fullscreenPI)
            .setAutoCancel(true)
            .setOngoing(true)
            .setTimeoutAfter(5 * 60 * 1000) // Auto-dismiss after 5 minutes
            .build()

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(9999, notification)
    }
}
