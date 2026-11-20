package com.tms.terminal.bubble

import android.app.ApplicationExitInfo

/** Why Android ended the ":bubble" process, in words the user (and the next debug session) can act on. */
object ExitText {
    fun worthReporting(reason: Int): Boolean = reason != ApplicationExitInfo.REASON_PACKAGE_UPDATED

    fun describe(reason: Int, description: String?): String {
        val text = when (reason) {
            ApplicationExitInfo.REASON_USER_REQUESTED -> "Von Hand gestoppt („Aktive Apps“ → Stopp oder „Stopp erzwingen“)"
            ApplicationExitInfo.REASON_CRASH, ApplicationExitInfo.REASON_CRASH_NATIVE -> "Abgestürzt (Fehler in der Bubble)"
            ApplicationExitInfo.REASON_ANR -> "Hing fest und wurde beendet"
            ApplicationExitInfo.REASON_LOW_MEMORY -> "Vom System beendet: Speicher knapp"
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "Vom System beendet: zu viel Akku/CPU"
            ApplicationExitInfo.REASON_FREEZER -> "Vom System eingefroren und beendet"
            ApplicationExitInfo.REASON_SIGNALED -> "Vom System beendet (Signal)"
            ApplicationExitInfo.REASON_OTHER -> "Vom System beendet"
            ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "Beendet: Berechtigung geändert"
            ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "Beendet: abhängiger Prozess beendet"
            ApplicationExitInfo.REASON_USER_STOPPED -> "Beendet: Nutzerprofil gestoppt"
            ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "Start fehlgeschlagen"
            ApplicationExitInfo.REASON_EXIT_SELF -> "Hat sich selbst beendet"
            ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "Neu gestartet: Update"
            else -> "Beendet (Grund $reason)"
        }
        val raw = description?.trim()?.takeIf { it.isNotEmpty() }?.take(90) ?: return text
        return "$text · $raw"
    }
}
