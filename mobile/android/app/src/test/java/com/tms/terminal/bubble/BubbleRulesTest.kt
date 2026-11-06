package com.tms.terminal.bubble

import org.junit.Assert.*
import org.junit.Test

class BubbleRulesTest {
    private fun show(editable: Boolean = true, password: Boolean = false, own: Boolean = false, busy: Boolean = false,
                     snoozed: Long = 0, now: Long = 1000, enabled: Boolean = true) =
        BubbleRules.shouldShow(editable, password, own, busy, snoozed, now, enabled)

    @Test fun showsOnEditableField() = assertTrue(show())
    @Test fun hiddenWithoutField() = assertFalse(show(editable = false))
    @Test fun neverOverPasswordFields() = assertFalse(show(password = true))
    @Test fun notOverOwnWindows() = assertFalse(show(own = true))
    @Test fun hiddenWhileSnoozed() = assertFalse(show(snoozed = 5000, now = 1000))
    @Test fun backAfterSnooze() = assertTrue(show(snoozed = 5000, now = 5001))
    @Test fun staysWhileRecordingEvenWithoutField() = assertTrue(show(editable = false, busy = true))
    @Test fun offWhenDisabled() = assertFalse(show(enabled = false, busy = true))
    @Test fun snoozeIsFifteenMinutes() = assertEquals(1000L + 15 * 60_000L, BubbleRules.snoozeUntil(1000))
}
