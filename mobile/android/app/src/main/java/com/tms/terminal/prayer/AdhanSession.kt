package com.tms.terminal.prayer

import java.util.concurrent.CopyOnWriteArraySet

/**
 * Der laufende Gebetsruf (einer zur Zeit) — gemeinsamer Stand für Dienst,
 * Vollbild (Sperrbildschirm) und Überlagerung (entsperrt). Alles im App-Prozess.
 */
object AdhanSession {
    enum class Phase { IDLE, RINGING, PLAYING }

    data class Info(val name: String, val at: Long, val arabic: String, val wecker: Boolean, val test: Boolean)

    @Volatile var phase: Phase = Phase.IDLE
        private set
    @Volatile var info: Info? = null
        private set

    /** Wie viele Oberflächen gerade sichtbar sind (Vollbild/Überlagerung). */
    @Volatile var visibleUis: Int = 0

    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    fun addListener(l: () -> Unit) { listeners.add(l) }
    fun removeListener(l: () -> Unit) { listeners.remove(l) }

    val active: Boolean get() = phase != Phase.IDLE

    internal fun set(phase: Phase, info: Info?) {
        this.phase = phase
        this.info = info
        listeners.forEach { try { it() } catch (_: Exception) {} }
    }
}
