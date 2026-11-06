package com.tms.terminal.bubble

/**
 * Insert [insert] into [text] at the selection (replacing a selected range),
 * like typing would. A space is put in front when the text before the cursor
 * does not already end in whitespace. Returns the new text and the cursor
 * position after the inserted text. A negative selection means "unknown" →
 * append at the end.
 */
fun mergeAtSelection(text: String, selStart: Int, selEnd: Int, insert: String): Pair<String, Int> {
    val n = text.length
    var a = if (selStart < 0) n else selStart.coerceIn(0, n)
    var b = if (selEnd < 0) n else selEnd.coerceIn(0, n)
    if (a > b) { val t = a; a = b; b = t }
    val before = text.substring(0, a)
    val needsSpace = before.isNotEmpty() && !before.last().isWhitespace() && insert.isNotEmpty() && !insert.first().isWhitespace()
    val piece = if (needsSpace) " $insert" else insert
    return (before + piece + text.substring(b)) to (a + piece.length)
}

/** The text a paste must insert so the result equals [mergeAtSelection] (incl. the joining space). */
fun insertedPiece(text: String, selStart: Int, selEnd: Int, insert: String): String {
    val n = text.length
    val a = if (selStart < 0) n else selStart.coerceIn(0, n)
    val b = if (selEnd < 0) n else selEnd.coerceIn(0, n)
    val before = text.substring(0, minOf(a, b))
    val needsSpace = before.isNotEmpty() && !before.last().isWhitespace() && insert.isNotEmpty() && !insert.first().isWhitespace()
    return if (needsSpace) " $insert" else insert
}
