package com.tms.terminal.prayer

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.tms.terminal.AdhanFullscreenActivity
import com.tms.terminal.R

/**
 * Der klingelnde Gebetsruf — wie ein eingehender Anruf.
 *
 *  - Gesperrt / Bildschirm aus: Vollbild über dem Sperrbildschirm (über die
 *    Vollbild-Benachrichtigung, der einzige Weg, den Android dafür erlaubt).
 *  - Entsperrt: Fenster über allem (AdhanOverlay), kein App-Wechsel.
 *  - „Stumm“, Sperrtaste, Lautstärketasten → aus. „Laut“ → Azān bis zum Ende.
 *  - Klingeln ohne Antwort endet nach 5 Minuten.
 */
class AdhanRingService : Service() {
    companion object {
        const val ACTION_START = "com.tms.terminal.adhan.START"
        const val ACTION_LOUD = "com.tms.terminal.adhan.LOUD"
        const val ACTION_SILENCE = "com.tms.terminal.adhan.SILENCE"
        const val ACTION_PRESENT = "com.tms.terminal.adhan.PRESENT"
        private const val CHANNEL = "adhan_call"
        private const val NOTIF_ID = 9999
        private const val RING_TIMEOUT_MS = 5 * 60_000L
        private const val TAG = "TmsAdhan"

        fun start(context: Context, info: AdhanSession.Info) {
            val i = Intent(context, AdhanRingService::class.java).apply {
                action = ACTION_START
                putExtra("name", info.name); putExtra("at", info.at); putExtra("arabic", info.arabic)
                putExtra("wecker", info.wecker); putExtra("test", info.test)
            }
            ContextCompat.startForegroundService(context, i)
        }

        fun send(context: Context, action: String) {
            if (!AdhanSession.active && action != ACTION_START) return
            context.startService(Intent(context, AdhanRingService::class.java).apply { this.action = action })
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var receiverOn = false
    private val ringTimeout = Runnable { silence("timeout") }

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            when (i.action) {
                // Sperrtaste = ablehnen (wie bei einem Anruf). Nur wenn der
                // Gebetsruf gerade zu sehen war — nicht beim Einschlafen davor.
                Intent.ACTION_SCREEN_OFF -> if (AdhanSession.visibleUis > 0 || AdhanOverlay.showing) silence("power")
                // Entsperrt, während er klingelt: ab jetzt über allem.
                Intent.ACTION_USER_PRESENT -> present()
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> begin(intent)
            ACTION_LOUD -> loud()
            ACTION_SILENCE -> silence("user")
            ACTION_PRESENT -> present()
            else -> if (!AdhanSession.active) stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun begin(intent: Intent) {
        if (AdhanSession.active) cleanup(keepService = true) // ein neuer ersetzt den alten
        val info = AdhanSession.Info(
            intent.getStringExtra("name") ?: "Gebet", intent.getLongExtra("at", System.currentTimeMillis()),
            intent.getStringExtra("arabic") ?: "", intent.getBooleanExtra("wecker", false), intent.getBooleanExtra("test", false))
        AdhanSession.set(if (info.wecker) AdhanSession.Phase.PLAYING else AdhanSession.Phase.RINGING, info)
        val notif = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIF_ID, notif)
        }
        if (!receiverOn) {
            val f = IntentFilter().apply { addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_USER_PRESENT) }
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenReceiver, f, Context.RECEIVER_NOT_EXPORTED)
            else registerReceiver(screenReceiver, f)
            receiverOn = true
        }
        if (info.wecker) playAudio() else { vibrate(); main.postDelayed(ringTimeout, RING_TIMEOUT_MS) }
        present()
    }

    /** Oberfläche zeigen: gesperrt → Vollbild (über die Benachrichtigung),
     *  entsperrt → Fenster über allem. */
    private fun present() {
        if (!AdhanSession.active) return
        val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        val locked = km.isKeyguardLocked || !pm.isInteractive
        if (!locked && AdhanOverlay.allowed(this)) {
            AdhanOverlay.show(this)
        } else if (locked) {
            // Die Vollbild-Benachrichtigung öffnet das Vollbild selbst; zusätzlich
            // direkt versuchen (geht, solange „Über anderen Apps“ erlaubt ist).
            try { startActivity(fullscreenIntent()) } catch (_: Exception) {}
        }
    }

    private fun loud() {
        if (!AdhanSession.active) return
        main.removeCallbacks(ringTimeout)
        stopVibration()
        AdhanSession.set(AdhanSession.Phase.PLAYING, AdhanSession.info)
        updateNotification()
        playAudio()
    }

    private fun playAudio() {
        val reciter = PrayerStore(this).reciter
        val res = when (reciter) { "nafees" -> R.raw.ahmad_nafees; "mansour" -> R.raw.mansour_zahrani; else -> R.raw.mishary_alafasy }
        try {
            player?.release()
            val mp = MediaPlayer()
            mp.setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM) // Wecker-Lautstärke, klingelt auch im Lautlos-Modus
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            resources.openRawResourceFd(res).use { afd -> mp.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length) }
            mp.setOnCompletionListener { silence("done") }
            mp.setOnErrorListener { _, _, _ -> silence("error"); true }
            mp.prepare()
            mp.start()
            player = mp
        } catch (e: Exception) {
            Log.w(TAG, "Azān ließ sich nicht abspielen", e)
            silence("error")
        }
    }

    private fun silence(why: String) {
        Log.i(TAG, "Ende: $why")
        cleanup(keepService = false)
    }

    private fun cleanup(keepService: Boolean) {
        main.removeCallbacks(ringTimeout)
        stopVibration()
        try { player?.stop() } catch (_: Exception) {}
        player?.release(); player = null
        AdhanOverlay.hide()
        AdhanSession.set(AdhanSession.Phase.IDLE, null) // das Vollbild schließt sich daraufhin selbst
        if (!keepService) {
            if (receiverOn) { try { unregisterReceiver(screenReceiver) } catch (_: Exception) {}; receiverOn = false }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
            stopSelf()
        }
    }

    override fun onDestroy() {
        if (AdhanSession.active) cleanup(keepService = true)
        if (receiverOn) { try { unregisterReceiver(screenReceiver) } catch (_: Exception) {}; receiverOn = false }
        super.onDestroy()
    }

    private fun vibrate() {
        val v = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
            else @Suppress("DEPRECATION") (getSystemService(Context.VIBRATOR_SERVICE) as Vibrator)
        vibrator = v
        val pattern = longArrayOf(0, 600, 400, 600, 400, 600, 1400)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            v.vibrate(VibrationEffect.createWaveform(pattern, 0), AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build())
        } else @Suppress("DEPRECATION") v.vibrate(pattern, 0)
    }

    private fun stopVibration() { try { vibrator?.cancel() } catch (_: Exception) {}; vibrator = null }

    private fun fullscreenIntent() = Intent(this, AdhanFullscreenActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION
    }

    private fun pending(action: String, req: Int) = PendingIntent.getService(this, req,
        Intent(this, AdhanRingService::class.java).apply { this.action = action },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private fun buildNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Gebetsruf", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Klingelt zur Gebetszeit wie ein Anruf"
                setSound(null, null) // Ton und Vibration macht der Dienst selbst
                enableVibration(false)
                setBypassDnd(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            })
        }
        val info = AdhanSession.info
        val full = PendingIntent.getActivity(this, 0, fullscreenIntent(), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val playing = AdhanSession.phase == AdhanSession.Phase.PLAYING
        val b = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(if (playing) "Azān — ${info?.name ?: ""}" else "Gebetszeit: ${info?.name ?: ""}")
            .setContentText(info?.arabic ?: "")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(full, true)
            .setContentIntent(full)
            .addAction(0, if (playing) "Beenden" else "Stumm", pending(ACTION_SILENCE, 1))
        if (!playing) b.addAction(0, "Laut", pending(ACTION_LOUD, 2))
        return b.build()
    }

    private fun updateNotification() {
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, buildNotification())
    }
}
