package com.tms.terminal.bubble

/** When the bubble is visible, and how long it sleeps. */
object BubbleRules {
    const val SNOOZE_MS = 15 * 60_000L

    fun shouldShow(
        editable: Boolean, password: Boolean, ownWindow: Boolean, busy: Boolean,
        snoozedUntil: Long, now: Long, enabled: Boolean, keyboardVisible: Boolean,
    ): Boolean {
        if (busy) return true               // recording / transcribing: never vanish mid-dictation
        if (!enabled) return false
        if (now < snoozedUntil) return false
        if (!keyboardVisible) return false  // only while the virtual keyboard is open
        return editable && !password && !ownWindow
    }

    fun snoozeUntil(now: Long): Long = now + SNOOZE_MS

    /** A wake from the TMS app (after the snooze began) ends it — the two run in different processes. */
    fun effectiveSnooze(snoozedUntil: Long, wakeAt: Long): Long =
        if (snoozedUntil == 0L || wakeAt >= snoozedUntil - SNOOZE_MS) 0L else snoozedUntil

    /** Write straight into the field only while keyboard + field are open in the app where ✓ was pressed. */
    fun shouldInsert(keyboardVisible: Boolean, fieldFound: Boolean, confirmedIn: String?, focusedNow: String?): Boolean =
        keyboardVisible && fieldFound && pasteAllowed(confirmedIn, focusedNow)

    /** Paste only into the app where the user pressed ✓ — otherwise clipboard. */
    fun pasteAllowed(confirmedIn: String?, focusedNow: String?): Boolean =
        confirmedIn != null && confirmedIn == focusedNow
}
