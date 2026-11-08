package com.tms.terminal.bubble

import android.content.Context
import android.os.Handler
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The bubble's recent decisions (time, keyboard, input session, result) for
 * diagnosis on the phone: the user copies it from the TMS settings. Written by
 * the ":bubble" process only on changes, saved to a file at most once a second.
 */
class BubbleTrace(ctx: Context, private val io: Handler) {
    companion object {
        private const val FILE = "bubble_trace.txt"
        private const val MAX_LINES = 80

        /** Read from the app process (same files dir). */
        fun read(ctx: Context): String =
            try { File(ctx.filesDir, FILE).takeIf { it.exists() }?.readText() ?: "" } catch (_: Exception) { "" }
    }

    private val file = File(ctx.filesDir, FILE)
    private val ring = TraceRing(MAX_LINES).also { r -> try { if (file.exists()) r.load(file.readText()) } catch (_: Exception) {} }
    private val fmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.GERMANY)
    private val save = Runnable { try { file.writeText(ring.text()) } catch (_: Exception) {} }

    fun add(text: String) {
        ring.add("${fmt.format(Date())} $text")
        io.removeCallbacks(save)
        io.postDelayed(save, 1_000)
    }
}
