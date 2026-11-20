package com.tms.terminal.bubble

import org.junit.Assert.*
import org.junit.Test

class TraceRingTest {
    // Keeps only the newest lines — the protocol stays small no matter how long the bubble runs.
    @Test fun keepsNewestLines() {
        val r = TraceRing(3)
        listOf("a", "b", "c", "d").forEach { r.add(it) }
        assertEquals(listOf("b", "c", "d"), r.lines())
    }

    // Reloaded after a restart of the bubble process: older protocol is not lost.
    @Test fun restoresFromText() {
        val r = TraceRing(3)
        r.load("x\ny\nz\nw\n")
        assertEquals(listOf("y", "z", "w"), r.lines())
        assertEquals("y\nz\nw\n", r.text())
    }
}
