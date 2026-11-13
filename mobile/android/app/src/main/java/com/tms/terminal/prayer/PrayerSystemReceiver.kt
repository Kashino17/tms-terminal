package com.tms.terminal.prayer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Neustart, App-Update, Uhrzeit oder Zeitzone geändert (Reisen!): den nächsten
 * Gebetsruf neu stellen. Ohne das waren nach einem Neustart alle Alarme weg.
 */
class PrayerSystemReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        PrayerScheduler.reschedule(context, intent.action ?: "system")
    }
}
