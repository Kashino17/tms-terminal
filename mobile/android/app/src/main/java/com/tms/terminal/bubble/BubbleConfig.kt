package com.tms.terminal.bubble

import android.content.Context
import android.content.SharedPreferences

/** Bubble settings, written by the RN app (DictationBubbleModule) and read by the service. */
class BubbleConfig(context: Context) {
    val prefs: SharedPreferences = context.getSharedPreferences("tms_bubble", Context.MODE_PRIVATE)

    val host: String get() = prefs.getString("host", "") ?: ""
    val port: Int get() = prefs.getInt("port", 8767)
    val token: String get() = prefs.getString("token", "") ?: ""
    val enhance: Boolean get() = prefs.getBoolean("enhance", false)
    var enabled: Boolean
        get() = prefs.getBoolean("enabled", true)
        set(v) { prefs.edit().putBoolean("enabled", v).apply() }
    var snoozedUntil: Long
        get() = prefs.getLong("snoozedUntil", 0L)
        set(v) { prefs.edit().putLong("snoozedUntil", v).apply() }
    var x: Int
        get() = prefs.getInt("x", -1)
        set(v) { prefs.edit().putInt("x", v).apply() }
    var y: Int
        get() = prefs.getInt("y", -1)
        set(v) { prefs.edit().putInt("y", v).apply() }

    val isConfigured: Boolean get() = host.isNotEmpty() && token.isNotEmpty()

    fun configure(host: String, port: Int, token: String, enhance: Boolean) {
        prefs.edit().putString("host", host).putInt("port", port).putString("token", token)
            .putBoolean("enhance", enhance).apply()
    }
}
