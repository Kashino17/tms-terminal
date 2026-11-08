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

    /** Password fields (from the input type the system reports at input start): no bubble there. */
    fun isPasswordInput(inputType: Int): Boolean {
        val cls = inputType and android.text.InputType.TYPE_MASK_CLASS
        val variation = inputType and android.text.InputType.TYPE_MASK_VARIATION
        return when (cls) {
            android.text.InputType.TYPE_CLASS_TEXT -> variation == android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                variation == android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
                variation == android.text.InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
            android.text.InputType.TYPE_CLASS_NUMBER -> variation == android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD
            else -> false
        }
    }

    /** The last show/hide decision in words — shown in TMS settings to diagnose on the phone. */
    fun why(busy: Boolean, configured: Boolean, enabled: Boolean, snoozed: Boolean,
            keyboard: Boolean, field: Boolean, shown: Boolean, password: Boolean = false): String = when {
        busy -> "Aufnahme läuft"
        shown -> "sichtbar"
        !configured -> "nicht eingerichtet (kein Server)"
        !enabled -> "in TMS ausgeschaltet"
        snoozed -> "schläft"
        !keyboard -> "Tastatur zu"
        password -> "Passwortfeld"
        !field -> "Tastatur offen, aber kein Eingabefeld erkannt"
        else -> "versteckt"
    }

    /**
     * After an event the bubble stays hidden: check again a few times. The keyboard
     * window and the field's focus often land a few hundred ms after the tap, and
     * then no further event comes — the bubble used to appear only after closing and
     * reopening the field. With the keyboard still closed only the first two (it may
     * just be opening). null = stop checking.
     */
    private val SETTLE_DELAYS_MS = longArrayOf(250, 450, 800, 1_500)
    fun settleDelay(attempt: Int, keyboardVisible: Boolean): Long? =
        if (!keyboardVisible && attempt >= 2) null else SETTLE_DELAYS_MS.getOrNull(attempt)

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
