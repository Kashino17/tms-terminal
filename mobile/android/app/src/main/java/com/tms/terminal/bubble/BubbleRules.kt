package com.tms.terminal.bubble

/** When the bubble is visible, and how long it sleeps. */
object BubbleRules {
    const val SNOOZE_MS = 15 * 60_000L

    fun shouldShow(
        editable: Boolean, password: Boolean, ownWindow: Boolean, busy: Boolean,
        snoozedUntil: Long, now: Long, enabled: Boolean,
    ): Boolean {
        if (busy) return true               // recording / transcribing: never vanish mid-dictation
        if (!enabled) return false
        if (now < snoozedUntil) return false
        return editable && !password && !ownWindow
    }

    fun snoozeUntil(now: Long): Long = now + SNOOZE_MS

    /** Paste only into the app where the user pressed ✓ — otherwise clipboard. */
    fun pasteAllowed(confirmedIn: String?, focusedNow: String?): Boolean =
        confirmedIn != null && confirmedIn == focusedNow
}
