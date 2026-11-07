package com.tms.terminal.bubble

import org.junit.Assert.*
import org.junit.Test

class KeepAliveRulesTest {
    // Runs only while the user wants the bubble: accessibility switched on AND bubble enabled in TMS.
    @Test fun runsWhenAccessibilityOnAndBubbleEnabled() = assertTrue(KeepAliveRules.shouldRun(accessibilityOn = true, bubbleEnabled = true))
    @Test fun stopsWhenAccessibilitySwitchedOff() = assertFalse(KeepAliveRules.shouldRun(accessibilityOn = false, bubbleEnabled = true))
    @Test fun stopsWhenBubbleSwitchedOffInApp() = assertFalse(KeepAliveRules.shouldRun(accessibilityOn = true, bubbleEnabled = false))

    @Test fun readyWhileConnected() =
        assertEquals(KeepAliveRules.Status.READY, KeepAliveRules.status(connected = true, disconnectedSince = 0, now = 999_999))

    // Android rebinds a killed accessibility service within ~1 s — no alarm for that.
    @Test fun shortGapIsNotReported() =
        assertEquals(KeepAliveRules.Status.READY, KeepAliveRules.status(connected = false, disconnectedSince = 10_000, now = 10_000 + KeepAliveRules.GRACE_MS - 1))

    // Samsung: "enabled in Settings, but never rebound" — exactly the vanished-bubble state.
    @Test fun longGapIsReported() =
        assertEquals(KeepAliveRules.Status.DISCONNECTED, KeepAliveRules.status(connected = false, disconnectedSince = 10_000, now = 10_000 + KeepAliveRules.GRACE_MS))
}
