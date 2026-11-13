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
 * the app away, so returning to it is instant. It does NOT keep the CPU awake
 * (see onStartCommand): while the phone sleeps, the connection may drop and is
 * re-established on wake-up.
 *
 * The service shows a persistent notification so Android doesn't kill the process.
 */
class ConnectionService : Service() {

    companion object {
        const val CHANNEL_ID = "tms_connection"
        const val NOTIFICATION_ID = 9001
        private var wakeLock: PowerManager.WakeLock? = null

        /**
         * The one remaining reason to keep the CPU awake: sound from the computer
         * is playing on the phone (remote access with audio) and must not stop
         * when the screen turns off. Bounded to 4 h as a safety net.
         */
        @Synchronized
        fun setKeepAwake(context: Context, on: Boolean) {
            if (on) {
                if (wakeLock?.isHeld == true) return
                val pm = context.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TMS::RemoteSound").apply {
                    setReferenceCounted(false)
                    acquire(4 * 60 * 60 * 1000L)
                }
            } else {
                wakeLock?.let { if (it.isHeld) it.release() }
                wakeLock = null
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        startForeground(NOTIFICATION_ID, notification)

        // KEIN Wake-Lock mehr. Früher hielt hier ein PARTIAL_WAKE_LOCK die CPU
        // dauerhaft wach, „damit die WebSocket-Pings laufen" — auch nachts in der
        // Tasche (Akkustatistik: 49 Min. gehaltener Wake-Lock an einem Tag, dazu
        // Mobilfunk und Rechenzeit bei ausgeschaltetem Bildschirm). Gebraucht
        // wird das nicht: Benachrichtigungen kommen per FCM, Auto-Approve läuft
        // auf dem Server, und nach dem Aufwachen baut die App die Verbindung in
        // Sekundenbruchteilen selbst wieder auf (der Server liefert dann den
        // Rückstand). Der Dienst hält weiterhin den Prozess am Leben. Einzige
        // Ausnahme: Ton vom Rechner läuft — siehe setKeepAwake().
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
