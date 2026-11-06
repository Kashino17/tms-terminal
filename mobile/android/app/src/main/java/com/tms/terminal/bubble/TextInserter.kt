package com.tms.terminal.bubble

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo

/**
 * Puts the transcript where the user is typing — directly, WITHOUT the
 * clipboard. Only when the keyboard is closed / no field is open any more
 * (or the user switched apps) does it go to the clipboard instead.
 */
object TextInserter {
    enum class Result { INSERTED, CLIPBOARD }

    private const val TAG = "TmsBubble"
    private const val MAX_NODES = 4000

    fun copyOnly(service: AccessibilityService, text: String) {
        val clipboard = service.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("TMS Diktat", text))
    }

    /** [allowedPackage]: the app where the user pressed ✓. */
    fun insert(service: AccessibilityService, text: String, allowedPackage: String?): Result {
        val node = focusedEditable(service)
        val keyboard = keyboardVisible(service)
        if (!BubbleRules.shouldInsert(keyboard, node != null, allowedPackage, node?.packageName?.toString())) {
            Log.i(TAG, "insert: clipboard (keyboard=$keyboard field=${node != null} pkg=${node?.packageName} confirmed=$allowedPackage)")
            copyOnly(service, text)
            return Result.CLIPBOARD
        }
        node!!
        val showingHint = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && node.isShowingHintText
        val current = if (showingHint) "" else node.text?.toString() ?: ""
        val (merged, cursor) = mergeAtSelection(current, node.textSelectionStart, node.textSelectionEnd, text)

        // 1) Write the text into the field directly — no clipboard involved.
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, merged)
        }
        if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            val sel = Bundle().apply {
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
            }
            node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)
            Log.i(TAG, "insert: setText ok (${node.className} ${node.packageName})")
            return Result.INSERTED
        }
        // 2) Some fields refuse SET_TEXT — paste is the only other way in.
        val piece = insertedPiece(current, node.textSelectionStart, node.textSelectionEnd, text)
        copyOnly(service, piece)
        if (node.performAction(AccessibilityNodeInfo.ACTION_PASTE)) {
            Log.i(TAG, "insert: paste fallback (${node.className} ${node.packageName})")
            return Result.INSERTED
        }
        Log.i(TAG, "insert: field refused both, clipboard")
        copyOnly(service, text)
        return Result.CLIPBOARD
    }

    /** The virtual keyboard is on screen. */
    fun keyboardVisible(service: AccessibilityService): Boolean =
        service.windows.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }

    /**
     * The focused editable, non-password field. findFocus(FOCUS_INPUT) is not
     * enough: for web content (Chrome, WebViews — incl. TMS's own input line)
     * it returns the outer FrameLayout, while the real focused input is a
     * virtual node deeper in the tree. Fall back to searching for it.
     */
    fun focusedEditable(service: AccessibilityService): AccessibilityNodeInfo? {
        val roots = buildList {
            service.rootInActiveWindow?.let { add(it) }
            for (w in service.windows) {
                if (w.type == AccessibilityWindowInfo.TYPE_APPLICATION) w.root?.let { add(it) }
            }
        }
        for (root in roots) {
            val f = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            if (f != null && f.isEditable) return if (f.isPassword) null else f
        }
        for (root in roots) {
            val f = findFocusedEditable(root)
            if (f != null) return if (f.isPassword) null else f
        }
        return null
    }

    fun focusedIsPassword(service: AccessibilityService): Boolean {
        val root = service.rootInActiveWindow ?: return false
        val f = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (f != null && f.isEditable) return f.isPassword
        return findFocusedEditable(root)?.isPassword == true
    }

    private fun findFocusedEditable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.addLast(root)
        var seen = 0
        while (stack.isNotEmpty() && seen < MAX_NODES) {
            val n = stack.removeLast()
            seen++
            if (n.isEditable && n.isFocused) return n
            for (i in n.childCount - 1 downTo 0) n.getChild(i)?.let { stack.addLast(it) }
        }
        return null
    }
}
