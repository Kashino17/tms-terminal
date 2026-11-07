package com.tms.terminal.bubble

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Keeps the bubble alive the way Wispr Flow does: an ongoing, silent
 * "Diktat-Bubble bereit" notification backed by a foreground service.
 *
 * Without it the bubble lived only on the accessibility binding of the big
 * app process. Samsung's background management kills/freezes that process
 * once the app sits in the background for a while, and then does NOT rebind
 * the accessibility service until the app is opened again — the bubble is
 * gone although Settings still shows it switched on. A foreground service
 * keeps the process in the "active" class, and START_STICKY brings the
 * process back after a kill, which lets Android rebind the bubble.
 *
 * Watchdog: if accessibility is on but the bubble stays unbound for
 * [KeepAliveRules.GRACE_MS], the notification says so; tapping it opens TMS,
 * which is what makes Android reconnect it.
 */
class BubbleKeepAliveService : Service() {

    companion object {
        private const val TAG = "TmsBubble"
        private const val CHANNEL_ID = "tms_bubble"
        private const val NOTIFICATION_ID = 9002
        private const val CHECK_MS = 15_000L

        /** True between a successful startForeground() and onDestroy(). */
        @Volatile var running = false
            private set

        /** Starts or stops the service to match the user's settings. Never throws. */
        fun sync(ctx: Context) {
            val app = ctx.applicationContext
            val run = KeepAliveRules.shouldRun(isAccessibilityOn(app), BubbleConfig(app).enabled)
            val intent = Intent(app, BubbleKeepAliveService::class.java)
            try {
                if (!run) { app.stopService(intent); return }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) app.startForegroundService(intent)
                else app.startService(intent)
            } catch (e: Exception) {
                // Android 12+ refuses background FGS starts in some states; the next
                // accessibility event or app start tries again.
                Log.w(TAG, "keep-alive start refused", e)
            }
        }

        fun isAccessibilityOn(ctx: Context): Boolean {
            val mine = ComponentName(ctx, DictationBubbleService::class.java)
            val list = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            return list.split(':').any { ComponentName.unflattenFromString(it) == mine }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var disconnectedSince = 0L
    private var shown: KeepAliveRules.Status? = null

    private val check = object : Runnable {
        override fun run() {
            if (!KeepAliveRules.shouldRun(isAccessibilityOn(this@BubbleKeepAliveService), BubbleConfig(this@BubbleKeepAliveService).enabled)) {
                stopSelf(); return
            }
            val now = System.currentTimeMillis()
            val connected = DictationBubbleService.instance != null // same ":bubble" process
            if (connected) disconnectedSince = 0L else if (disconnectedSince == 0L) disconnectedSince = now
            val status = KeepAliveRules.status(connected, disconnectedSince, now)
            if (status != shown) {
                if (status == KeepAliveRules.Status.DISCONNECTED) Log.w(TAG, "bubble unbound for ${now - disconnectedSince} ms")
                getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, build(status))
                shown = status
            }
            main.postDelayed(this, CHECK_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Diktat-Bubble", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Hält die Diktat-Bubble in allen Apps aktiv"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val status = KeepAliveRules.Status.READY
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, build(status), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTIFICATION_ID, build(status))
            }
            shown = status
            running = true
        } catch (e: Exception) {
            Log.w(TAG, "keep-alive startForeground failed", e)
            stopSelf()
            return START_NOT_STICKY
        }
        main.removeCallbacks(check)
        main.post(check)
        Log.i(TAG, "keep-alive running")
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun build(status: KeepAliveRules.Status): Notification {
        val open = packageManager.getLaunchIntentForPackage(packageName)
        val pi = PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val (title, text) = when (status) {
            KeepAliveRules.Status.READY -> "Diktat-Bubble bereit" to "Erscheint, sobald du in einer App tippst"
            KeepAliveRules.Status.DISCONNECTED -> "Diktat-Bubble getrennt" to "Tippen, um sie wieder zu verbinden"
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }
}
