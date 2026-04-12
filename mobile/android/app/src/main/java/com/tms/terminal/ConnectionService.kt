package com.tms.terminal

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the app process alive when the user swipes
 * the app away. This ensures the React Native runtime (and thus the WebSocket
 * connection to the TMS Terminal server) stays active.
 *
 * The service shows a persistent notification so Android doesn't kill the process.
 */
class ConnectionService : Service() {

    companion object {
        const val CHANNEL_ID = "tms_connection"
        const val NOTIFICATION_ID = 9001
        private var wakeLock: PowerManager.WakeLock? = null
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        startForeground(NOTIFICATION_ID, notification)

        // Acquire a partial wake lock to keep CPU alive for WebSocket pings
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "TMS::ConnectionWakeLock"
            ).apply {
                acquire()
            }
        }

        // If the system kills this service, restart it
        return START_STICKY
    }

    override fun onDestroy() {
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        wakeLock = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // Also restart when the user swipes the app away
    override fun onTaskRemoved(rootIntent: Intent?) {
        // Service continues running (START_STICKY + foreground = survives swipe-away)
        super.onTaskRemoved(rootIntent)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Server-Verbindung",
                NotificationManager.IMPORTANCE_LOW // Low = no sound, shows in status bar
            ).apply {
                description = "Hält die Verbindung zum TMS Terminal Server aktiv"
                setShowBadge(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        // Tapping the notification opens the app
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("TMS Terminal")
            .setContentText("Verbindung aktiv")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }
}
