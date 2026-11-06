package com.tms.terminal.bubble

import org.junit.Assert.*
import org.junit.Test

class BubbleRulesTest {
    private fun show(editable: Boolean = true, password: Boolean = false, own: Boolean = false, busy: Boolean = false,
                     snoozed: Long = 0, now: Long = 1000, enabled: Boolean = true, keyboard: Boolean = true) =
        BubbleRules.shouldShow(editable, password, own, busy, snoozed, now, enabled, keyboard)

    // User: only while the virtual keyboard is open; it vanishes with the keyboard…
    @Test fun hiddenWhenKeyboardClosed() = assertFalse(show(keyboard = false))
    // …except a dictation that is already running, which must finish normally.
    @Test fun runningDictationSurvivesKeyboardClosing() = assertTrue(show(keyboard = false, editable = false, busy = true))

    // Insert straight into the field only while keyboard + field are open in the
    // same app; otherwise (keyboard closed / no field / other app) clipboard.
    @Test fun insertsOnlyWithKeyboardAndFieldInSameApp() {
        assertTrue(BubbleRules.shouldInsert(keyboardVisible = true, fieldFound = true, confirmedIn = "a", focusedNow = "a"))
        assertFalse(BubbleRules.shouldInsert(keyboardVisible = false, fieldFound = true, confirmedIn = "a", focusedNow = "a"))
        assertFalse(BubbleRules.shouldInsert(keyboardVisible = true, fieldFound = false, confirmedIn = "a", focusedNow = null))
        assertFalse(BubbleRules.shouldInsert(keyboardVisible = true, fieldFound = true, confirmedIn = "a", focusedNow = "b"))
    }

    @Test fun showsOnEditableField() = assertTrue(show())
    @Test fun hiddenWithoutField() = assertFalse(show(editable = false))
    @Test fun neverOverPasswordFields() = assertFalse(show(password = true))
    @Test fun notOverOwnWindows() = assertFalse(show(own = true))
    @Test fun hiddenWhileSnoozed() = assertFalse(show(snoozed = 5000, now = 1000))
    @Test fun backAfterSnooze() = assertTrue(show(snoozed = 5000, now = 5001))
    @Test fun staysWhileRecordingEvenWithoutField() = assertTrue(show(editable = false, busy = true))
    @Test fun offWhenDisabled() = assertFalse(show(enabled = false))
    // Review I8: switching the bubble off mid-recording must not hide the pill
    // while the microphone keeps running.
    @Test fun runningDictationStaysVisibleEvenIfDisabled() = assertTrue(show(enabled = false, busy = true))

    // Review I4: never paste into another app's field after an app switch.
    @Test fun pastesOnlyIntoTheAppWhereTheUserConfirmed() {
        assertTrue(BubbleRules.pasteAllowed("com.whatsapp", "com.whatsapp"))
        assertFalse(BubbleRules.pasteAllowed("com.whatsapp", "com.android.chrome"))
        assertFalse(BubbleRules.pasteAllowed(null, "com.android.chrome"))
        assertFalse(BubbleRules.pasteAllowed("com.whatsapp", null))
    }
    @Test fun snoozeIsFifteenMinutes() = assertEquals(1000L + 15 * 60_000L, BubbleRules.snoozeUntil(1000))
}
