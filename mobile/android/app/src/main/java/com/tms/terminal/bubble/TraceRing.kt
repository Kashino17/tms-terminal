package com.tms.terminal.bubble

/** Fixed-size line buffer (newest last) for the bubble's decision protocol. */
class TraceRing(private val max: Int) {
    private val buf = ArrayDeque<String>()

    @Synchronized fun add(line: String) {
        buf.addLast(line)
        while (buf.size > max) buf.removeFirst()
    }

    @Synchronized fun load(text: String) {
        buf.clear()
        text.lineSequence().filter { it.isNotEmpty() }.forEach { add(it) }
    }

    @Synchronized fun lines(): List<String> = buf.toList()

    @Synchronized fun text(): String = buf.joinToString("") { "$it\n" }
}
