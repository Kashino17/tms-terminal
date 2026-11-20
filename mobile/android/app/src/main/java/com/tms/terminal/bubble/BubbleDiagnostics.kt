package com.tms.terminal.bubble

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import java.io.File

/**
 * Answers "why did the bubble go?" on the user's phone without adb: Android
 * keeps the last exit reasons of every process, and the ":bubble" process
 * writes its own crashes to a file.
 */
object BubbleDiagnostics {
    private const val CRASH_FILE = "bubble_last_crash.txt"

    data class Exit(val at: Long, val text: String)

    /** Most recent end of the ":bubble" process that was not a routine update (API 30+). */
    fun lastExit(ctx: Context): Exit? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val info = try {
            am.getHistoricalProcessExitReasons(ctx.packageName, 0, 30)
                .firstOrNull { it.processName.endsWith(":bubble") && ExitText.worthReporting(it.reason) }
        } catch (_: Exception) { null } ?: return null
        var text = ExitText.describe(info.reason, info.description)
        if (info.reason == android.app.ApplicationExitInfo.REASON_CRASH) lastCrash(ctx)?.let { text += " · $it" }
        return Exit(info.timestamp, text)
    }

    /** Installed in the ":bubble" process only: remember the crash, then let Android handle it. */
    fun installCrashRecorder(ctx: Context) {
        val app = ctx.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            try {
                val where = e.stackTrace.firstOrNull { it.className.startsWith("com.tms.") } ?: e.stackTrace.firstOrNull()
                File(app.filesDir, CRASH_FILE).writeText("${e.javaClass.simpleName}: ${e.message ?: ""} @ $where".take(300))
            } catch (_: Exception) {}
            previous?.uncaughtException(thread, e)
        }
    }

    private fun lastCrash(ctx: Context): String? =
        try { File(ctx.filesDir, CRASH_FILE).takeIf { it.exists() }?.readText() } catch (_: Exception) { null }
}
