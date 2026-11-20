package com.tms.terminal.bubble

/** When the keep-alive service runs, and when it reports a lost bubble. */
object KeepAliveRules {
    /** Android rebinds a killed accessibility service within about a second; longer means it gave up. */
    const val GRACE_MS = 60_000L

    enum class Status { READY, DISCONNECTED }

    fun shouldRun(accessibilityOn: Boolean, bubbleEnabled: Boolean): Boolean = accessibilityOn && bubbleEnabled

    fun status(connected: Boolean, disconnectedSince: Long, now: Long): Status =
        if (connected || now - disconnectedSince < GRACE_MS) Status.READY else Status.DISCONNECTED
}
