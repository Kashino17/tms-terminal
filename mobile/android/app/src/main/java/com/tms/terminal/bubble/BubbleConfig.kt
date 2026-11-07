package com.tms.terminal.bubble

import android.content.Context
import android.content.SharedPreferences

/**
 * Bubble settings shared between two processes:
 *  - the TMS app process (DictationBubbleModule) owns "tms_bubble":
 *    server, token, enabled, wakeAt;
 *  - the small ":bubble" process (accessibility + keep-alive service) owns
 *    "tms_bubble_state": snooze and position.
 * Each process writes only its own file, so neither overwrites the other's
 * keys. MODE_MULTI_PROCESS makes every access re-check the file on disk, so
 * changes from the other process are picked up (a cheap stat when unchanged).
 */
class BubbleConfig(private val context: Context) {
    @Suppress("DEPRECATION")
    private fun open(name: String): SharedPreferences =
        context.getSharedPreferences(name, Context.MODE_PRIVATE or Context.MODE_MULTI_PROCESS)

    private val app: SharedPreferences get() = open("tms_bubble")
    private val state: SharedPreferences get() = open("tms_bubble_state")

    val host: String get() = app.getString("host", "") ?: ""
    val port: Int get() = app.getInt("port", 8767)
    val token: String get() = app.getString("token", "") ?: ""
    val enhance: Boolean get() = app.getBoolean("enhance", false)
    var enabled: Boolean
        get() = app.getBoolean("enabled", true)
        set(v) { app.edit().putBoolean("enabled", v).apply() }

    /** Effective snooze end (0 = awake). Written by the bubble; the app ends it via [wake]. */
    var snoozedUntil: Long
        get() = BubbleRules.effectiveSnooze(state.getLong("snoozedUntil", 0L), app.getLong("wakeAt", 0L))
        set(v) { state.edit().putLong("snoozedUntil", v).apply() }

    /** Called from the app process: ends a running snooze without touching the bubble's file. */
    fun wake() { app.edit().putLong("wakeAt", System.currentTimeMillis()).apply() }

    // Position: older versions kept it in "tms_bubble" — read that as the default once.
    var x: Int
        get() = state.getInt("x", app.getInt("x", -1))
        set(v) { state.edit().putInt("x", v).apply() }
    var y: Int
        get() = state.getInt("y", app.getInt("y", -1))
        set(v) { state.edit().putInt("y", v).apply() }

    val isConfigured: Boolean get() = host.isNotEmpty() && token.isNotEmpty()

    fun configure(host: String, port: Int, token: String, enhance: Boolean) {
        app.edit().putString("host", host).putInt("port", port).putString("token", token)
            .putBoolean("enhance", enhance).apply()
    }
}
