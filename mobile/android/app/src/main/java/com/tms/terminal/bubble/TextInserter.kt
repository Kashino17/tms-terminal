package com.tms.terminal.bubble

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Puts the transcript where the user is typing — or, if no input field is
 * focused any more, only on the clipboard (the user pastes it later).
 *
 * Paste first: it goes through the target app's own input handling and works
 * in WebViews/Compose, where ACTION_SET_TEXT would replace the whole content.
 */
object TextInserter {
    enum class Result { INSERTED, CLIPBOARD }

    fun insert(service: AccessibilityService, text: String): Result {
        val clipboard = service.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val node = focusedEditable(service)
        if (node == null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("TMS Diktat", text))
            return Result.CLIPBOARD
        }
        val showingHint = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && node.isShowingHintText
        val current = if (showingHint) "" else node.text?.toString() ?: ""
        val (merged, cursor) = mergeAtSelection(current, node.textSelectionStart, node.textSelectionEnd, text)
        val start = minOf(node.textSelectionStart, node.textSelectionEnd).let { if (it < 0) current.length else it.coerceAtMost(current.length) }
        val piece = merged.substring(start, cursor)

        clipboard.setPrimaryClip(ClipData.newPlainText("TMS Diktat", piece))
        if (node.performAction(AccessibilityNodeInfo.ACTION_PASTE)) {
            // Leave the plain transcript (without the joining space) on the clipboard.
            Handler(Looper.getMainLooper()).postDelayed({
                clipboard.setPrimaryClip(ClipData.newPlainText("TMS Diktat", text))
            }, 600)
            return Result.INSERTED
        }
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, merged)
        }
        clipboard.setPrimaryClip(ClipData.newPlainText("TMS Diktat", text))
        if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            val sel = Bundle().apply {
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
            }
            node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)
            return Result.INSERTED
        }
        return Result.CLIPBOARD
    }

    /** The input-focused node, if it is an editable, non-password field. */
    fun focusedEditable(service: AccessibilityService): AccessibilityNodeInfo? {
        val candidates = mutableListOf<AccessibilityNodeInfo>()
        service.rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.let { candidates.add(it) }
        if (candidates.isEmpty()) {
            for (w in service.windows) {
                w.root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.let { candidates.add(it) }
            }
        }
        return candidates.firstOrNull { it.isEditable && !it.isPassword }
    }

    fun focusedIsPassword(service: AccessibilityService): Boolean =
        service.rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.isPassword == true
}
