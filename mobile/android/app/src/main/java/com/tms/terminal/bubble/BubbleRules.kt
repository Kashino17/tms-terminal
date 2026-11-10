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

    /**
     * Does the bubble need its per-frame clock? Only while something actually
     * moves: the waveform (recording), the breathing bars and arc (processing),
     * or the arc still fading out. An idle bubble is a still image — redrawing
     * it every frame kept the display at full refresh rate for nothing.
     */
    fun needsFrameClock(recording: Boolean, processing: Boolean, spinAlpha: Float): Boolean =
        recording || processing || spinAlpha > 0.01f

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

    /**
     * awaitingKeyboard: a field is in use (system input session) but the keyboard is not
     * in the window list yet. The keyboard announces itself first and lands in the list
     * later with its own "window added" report — on Samsung that report comes late or
     * never, and the bubble stayed hidden until the field was reopened. So keep looking
     * every second for ~10 s instead of waiting for it.
     */
    private const val KEYBOARD_POLL_MS = 1_000L
    private const val KEYBOARD_POLLS = 7
    fun settleDelay(attempt: Int, keyboardVisible: Boolean, awaitingKeyboard: Boolean = false): Long? = when {
        awaitingKeyboard -> SETTLE_DELAYS_MS.getOrNull(attempt)
            ?: if (attempt < SETTLE_DELAYS_MS.size + KEYBOARD_POLLS) KEYBOARD_POLL_MS else null
        !keyboardVisible && attempt >= 2 -> null
        else -> SETTLE_DELAYS_MS.getOrNull(attempt)
    }

    /** A wake from the TMS app (after the snooze began) ends it — the two run in different processes. */
    fun effectiveSnooze(snoozedUntil: Long, wakeAt: Long): Long =
        if (snoozedUntil == 0L || wakeAt >= snoozedUntil - SNOOZE_MS) 0L else snoozedUntil

    /** Write straight into the field only while keyboard + field are open in the app where ✓ was pressed. */
    fun shouldInsert(keyboardVisible: Boolean, fieldFound: Boolean, confirmedIn: String?, focusedNow: String?): Boolean =
        keyboardVisible && fieldFound && pasteAllowed(confirmedIn, focusedNow)

    /** Paste only into the app where the user pressed ✓ — otherwise clipboard. */
    fun pasteAllowed(confirmedIn: String?, focusedNow: String?): Boolean =
        confirmedIn != null && confirmedIn == focusedNow

    /**
     * Where the bubble goes on the screen as it is NOW. The Fold switches between a wide
     * inner and a narrow cover screen; a spot computed or saved on one lay outside the
     * other — the bubble was "visible" off-screen. savedX/Y < 0 = never moved.
     */
    fun placeBubble(savedX: Int, savedY: Int, screenW: Int, screenH: Int, size: Int, margin: Int): Pair<Int, Int> {
        val maxX = (screenW - size).coerceAtLeast(0)
        val maxY = (screenH - size - margin).coerceAtLeast(margin)
        val x = if (savedX >= 0) savedX.coerceIn(0, maxX) else (maxX - margin / 2).coerceAtLeast(0)
        val y = if (savedY >= 0) savedY.coerceIn(margin, maxY) else (screenH * 0.42f).toInt().coerceIn(margin, maxY)
        return Pair(x, y)
    }
}
