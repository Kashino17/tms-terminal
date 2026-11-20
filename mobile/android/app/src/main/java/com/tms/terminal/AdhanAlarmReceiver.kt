package com.tms.terminal

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.tms.terminal.prayer.AdhanRingService
import com.tms.terminal.prayer.AdhanSession
import com.tms.terminal.prayer.PrayerScheduler
import com.tms.terminal.prayer.PrayerStore

/**
 * Gebetszeit: den klingelnden Dienst starten (Anruf-Oberfläche, Ton) und
 * sofort das nächste Gebet stellen — die Kette braucht die App nicht.
 */
class AdhanAlarmReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_FIRE = "com.tms.terminal.adhan.FIRE"
        /** Kommt ein Alarm viel zu spät (Handy war aus), nicht mehr klingeln. */
        private const val STALE_MS = 20 * 60_000L
    }

    override fun onReceive(context: Context, intent: Intent) {
        val test = intent.getBooleanExtra("test", false)
        val name = intent.getStringExtra("prayerName") ?: "Gebet"
        val at = intent.getLongExtra("prayerAt", System.currentTimeMillis())
        val store = PrayerStore(context)
        val late = System.currentTimeMillis() - at > STALE_MS
        if (test || (store.enabled && !late)) {
            try {
                AdhanRingService.start(context, AdhanSession.Info(
                    name, at, intent.getStringExtra("prayerArabic") ?: "", intent.getBooleanExtra("wecker", false), test))
            } catch (e: Exception) {
                Log.w("TmsAdhan", "Dienst ließ sich nicht starten", e)
            }
        }
        if (!test) PrayerScheduler.reschedule(context, "fired:$name")
    }
}
