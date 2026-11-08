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

    // The app and the bubble live in different processes: "wake" from TMS is a timestamp
    // the bubble compares with its own snooze, instead of writing the bubble's state.
    @Test fun wakeFromAppEndsAnEarlierSnooze() {
        val until = BubbleRules.snoozeUntil(1_000)
        assertEquals(0L, BubbleRules.effectiveSnooze(until, wakeAt = 2_000))
    }
    @Test fun oldWakeDoesNotCancelANewerSnooze() {
        val until = BubbleRules.snoozeUntil(5_000)
        assertEquals(until, BubbleRules.effectiveSnooze(until, wakeAt = 2_000))
    }
    @Test fun noSnoozeStaysNoSnooze() = assertEquals(0L, BubbleRules.effectiveSnooze(0, wakeAt = 0))

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

    // The keyboard window and the field's focus often arrive a few hundred ms after the
    // tap — re-check a few times instead of waiting for the next event (that never comes).
    @Test fun hiddenBubbleIsRecheckedSeveralTimesThenStops() {
        val delays = generateSequence(0) { it + 1 }.map { BubbleRules.settleDelay(it, keyboardVisible = true) }.takeWhile { it != null }.toList()
        assertTrue(delays.size >= 3)
        assertTrue((delays.sumOf { it!! }) in 1_500L..4_000L)
        assertNull(BubbleRules.settleDelay(delays.size, keyboardVisible = true))
    }

    // Keyboard still closed (most app switches): only a short look for a keyboard that is
    // just opening — app switching must not cost battery.
    @Test fun withoutKeyboardOnlyAShortRecheck() {
        assertNotNull(BubbleRules.settleDelay(0, keyboardVisible = false))
        assertNull(BubbleRules.settleDelay(2, keyboardVisible = false))
    }

    // Diagnosis on the phone: the last decision in words, most specific cause first.
    @Test fun whyNamesTheBlockingCause() {
        fun why(busy: Boolean = false, configured: Boolean = true, enabled: Boolean = true, snoozed: Boolean = false,
                keyboard: Boolean = true, field: Boolean = true, shown: Boolean = true) =
            BubbleRules.why(busy, configured, enabled, snoozed, keyboard, field, shown)
        assertEquals("sichtbar", why())
        assertEquals("Aufnahme läuft", why(busy = true, keyboard = false))
        assertEquals("nicht eingerichtet (kein Server)", why(configured = false, shown = false))
        assertEquals("in TMS ausgeschaltet", why(enabled = false, shown = false))
        assertEquals("schläft", why(snoozed = true, shown = false))
        assertEquals("Tastatur zu", why(keyboard = false, field = false, shown = false))
        assertEquals("Tastatur offen, aber kein Eingabefeld erkannt", why(field = false, shown = false))
    }
}
