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
 * [KeepAliveRules.GRACE_MS], the notification says so; tapping it opens the
 * bubble's accessibility switch — toggling it is the only way back (see isBound).
 */
class BubbleKeepAliveService : Service() {

    companion object {
        private const val TAG = "TmsBubble"
        const val CHANNEL_ID = "tms_bubble"
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

        /** Runs in the ":bubble" process — ask the system, not the static flag. */
        @Suppress("DEPRECATION")
        fun isRunning(ctx: Context): Boolean {
            val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
            return try {
                am.getRunningServices(Int.MAX_VALUE).any {
                    it.service.className == BubbleKeepAliveService::class.java.name && it.foreground
                }
            } catch (_: Exception) { false }
        }

        /** The "Diktat-Bubble bereit" notification can actually be seen (app + channel allowed). */
        fun notificationVisible(ctx: Context): Boolean {
            if (!androidx.core.app.NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return false
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
            val ch = ctx.getSystemService(NotificationManager::class.java).getNotificationChannel(CHANNEL_ID) ?: return true
            return ch.importance != NotificationManager.IMPORTANCE_NONE
        }

        /**
         * Actually bound by Android — not just switched on. After "Stopp" in the
         * notification shade's "Aktive Apps" (or a force stop) Android keeps the
         * switch on but marks the service crashed and never rebinds it, not even
         * when TMS is opened; only switching it off and on again (or an update /
         * reboot) clears that. Works from any process: the list holds bound services.
         */
        fun isBound(ctx: Context): Boolean {
            val am = ctx.getSystemService(Context.ACCESSIBILITY_SERVICE) as android.view.accessibility.AccessibilityManager
            val mine = ComponentName(ctx, DictationBubbleService::class.java)
            return try {
                am.getEnabledAccessibilityServiceList(android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_ALL_MASK).any {
                    val si = it.resolveInfo?.serviceInfo
                    si != null && ComponentName(si.packageName, si.name) == mine
                }
            } catch (_: Exception) { false }
        }

        /**
         * The accessibility settings, with the bubble's entry highlighted where the
         * Settings app supports it. (Its own details page needs a system-only permission.)
         */
        fun settingsIntent(ctx: Context): Intent {
            val key = ComponentName(ctx, DictationBubbleService::class.java).flattenToString()
            return Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                .putExtra(":settings:fragment_args_key", key)
                .putExtra(":settings:show_fragment_args", android.os.Bundle().apply { putString(":settings:fragment_args_key", key) })
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
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
        // Stopped: opening TMS does not bring it back (see isBound) — go straight to its switch.
        val (title, text, target) = when (status) {
            KeepAliveRules.Status.READY -> Triple("Diktat-Bubble bereit", "Erscheint, sobald du in einer App tippst",
                packageManager.getLaunchIntentForPackage(packageName))
            KeepAliveRules.Status.DISCONNECTED -> Triple("Diktat-Bubble von Android gestoppt",
                "Antippen und den Schalter einmal aus- und wieder einschalten", settingsIntent(this))
        }
        val pi = PendingIntent.getActivity(this, 2, target, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
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
