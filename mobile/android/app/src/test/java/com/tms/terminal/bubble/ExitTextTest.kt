package com.tms.terminal.bubble

import android.app.ApplicationExitInfo
import org.junit.Assert.*
import org.junit.Test

class ExitTextTest {
    // "Stopp" in "Aktive Apps" / "Stopp erzwingen": the one cause no app can undo by itself.
    @Test fun stopByUserIsNamedAsSuch() {
        val t = ExitText.describe(ApplicationExitInfo.REASON_USER_REQUESTED, "fully stop com.tms.terminal/0 by user request")
        assertTrue(t, t.startsWith("Von Hand gestoppt"))
        assertTrue(t, t.contains("fully stop"))  // raw system text kept for diagnosis
    }

    @Test fun crashPointsAtTheBubble() =
        assertTrue(ExitText.describe(ApplicationExitInfo.REASON_CRASH, null).startsWith("Abgestürzt"))

    @Test fun systemKillsSaySystem() {
        assertTrue(ExitText.describe(ApplicationExitInfo.REASON_LOW_MEMORY, null).startsWith("Vom System"))
        assertTrue(ExitText.describe(ApplicationExitInfo.REASON_OTHER, "too many empty").contains("too many empty"))
    }

    // Updates restart the process on purpose — not worth reporting.
    @Test fun updatesAreNotReported() {
        assertFalse(ExitText.worthReporting(ApplicationExitInfo.REASON_PACKAGE_UPDATED))
        assertTrue(ExitText.worthReporting(ApplicationExitInfo.REASON_USER_REQUESTED))
    }

    @Test fun longSystemTextIsCut() =
        assertTrue(ExitText.describe(ApplicationExitInfo.REASON_OTHER, "x".repeat(500)).length < 200)
}
