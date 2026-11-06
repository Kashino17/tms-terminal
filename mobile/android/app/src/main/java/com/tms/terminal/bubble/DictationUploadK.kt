package com.tms.terminal.bubble

import org.json.JSONObject

/**
 * Kotlin port of mobile/src/season2/hooks/dictationClient.ts — the client side
 * of the streamed-dictation protocol (server/src/audio/dictation.ts).
 *
 * The recording file grows while the user speaks; pump() sends whatever is new
 * as byte-offset chunks. Offsets make every send idempotent on the server, so
 * recovery is: after a reconnect ask where the server stands (resume → state)
 * and continue from there; a server that lost the session gets the kept file
 * again (≤ 3 attempts).
 *
 * Threading: pump()/finish() run on one worker thread, onServer() on the
 * socket thread. State is guarded by `this`; file reads happen outside the lock
 * and an epoch counter rejects a read that started before a reset.
 */
const val CHUNK_BYTES = 64 * 1024
private const val MAX_ATTEMPTS = 3

interface UploadIO {
    /** false when the socket is not open (the message was NOT sent). */
    fun send(json: String): Boolean
    fun fileSize(): Long
    fun read(pos: Long, len: Int): ByteArray
    fun now(): Long
}

enum class Outcome { RESULT, ERROR, RESTART }

class DictationUploadK(
    val id: String,
    private val format: String,
    private val enhance: Boolean,
    private val io: UploadIO,
    private val b64: (ByteArray) -> String,
) {
    @Volatile var text: String? = null; private set
    @Volatile var error: String? = null; private set
    @Volatile var attempts = 1; private set
    @Volatile var ackSeen = false; private set
    @Volatile var lastHeard: Long = io.now()
    @Volatile var isEnded = false; private set

    private var sent = 0L
    private var epoch = 0
    private var awaitingRestart = false
    private var totalBytes: Long? = null
    private val pumpLock = Any()

    val done: Boolean get() = text != null || error != null

    private fun payload() = JSONObject().put("id", id)
    private fun out(type: String, p: JSONObject) = io.send(JSONObject().put("type", type).put("payload", p).toString())

    fun begin() {
        out("dictation:start", payload().put("format", format).put("enhance", enhance))
    }

    /** Send bytes [sent, fileSize). Serialized: a second caller waits and then pumps itself. */
    fun pump() { synchronized(pumpLock) { pumpLocked() } }

    private fun pumpLocked() {
        if (done) return
        val size = totalBytes ?: io.fileSize()
        while (!done) {
            val (pos, ep) = synchronized(this) { sent to epoch }
            if (pos >= size) return
            val data = io.read(pos, minOf(CHUNK_BYTES.toLong(), size - pos).toInt())
            if (data.isEmpty()) return
            val step = synchronized(this) {
                when {
                    ep != epoch -> Step.RETRY // reset meanwhile — re-read from the new position
                    !out("dictation:chunk", payload().put("offset", pos).put("data", b64(data))) -> Step.OFFLINE
                    else -> { sent = pos + data.size; Step.SENT }
                }
            }
            if (step == Step.OFFLINE) return
        }
    }

    private enum class Step { SENT, RETRY, OFFLINE }

    /** Recording stopped: send the rest, then `end`. Safe to call again after a restart. */
    fun finish() {
        isEnded = true
        if (totalBytes == null) totalBytes = io.fileSize()
        val total = totalBytes!!
        while (true) {
            val before = synchronized(this) { sent }
            pump()
            if (done) return
            val now = synchronized(this) { sent }
            if (now >= total) break
            if (now == before) return // offline — resumed later
        }
        out("dictation:end", payload().put("totalBytes", total))
    }

    /** Socket (re)opened: a start that never got through is repeated, otherwise ask where we stand. */
    fun onConnected() {
        if (done) return
        if (!ackSeen) {
            begin()
            if (isEnded) finish() // ✓ was pressed while offline: send the rest + end now
        } else onReconnect()
    }

    fun onReconnect() {
        if (done) return
        out("dictation:resume", payload())
    }

    @Synchronized
    fun onServer(msg: JSONObject): Outcome? {
        val p = msg.optJSONObject("payload") ?: return null
        if (p.optString("id") != id) return null
        lastHeard = io.now()
        when (msg.optString("type")) {
            "dictation:ack" -> { ackSeen = true; awaitingRestart = false; return null }
            "dictation:result" -> {
                if (done) return null
                text = p.optString("text", ""); return Outcome.RESULT
            }
            "dictation:error" -> {
                if (done) return null
                error = p.optString("message").ifEmpty { "Transkription fehlgeschlagen" }; return Outcome.ERROR
            }
            "dictation:state" -> {
                ackSeen = true
                if (done) return null
                return when (p.optString("status")) {
                    "done" -> { text = p.optString("text", ""); Outcome.RESULT }
                    "error" -> { error = p.optString("message").ifEmpty { "Transkription fehlgeschlagen" }; Outcome.ERROR }
                    "receiving" -> { awaitingRestart = false; resetTo(p.optLong("bytes", 0)); Outcome.RESTART }
                    "unknown" -> {
                        if (awaitingRestart) return null
                        if (attempts >= MAX_ATTEMPTS) {
                            error = "Transkription fehlgeschlagen (Server hat die Aufnahme verloren)"; Outcome.ERROR
                        } else {
                            attempts += 1; resetTo(0); awaitingRestart = true; begin(); Outcome.RESTART
                        }
                    }
                    else -> null // processing — keep waiting
                }
            }
        }
        return null
    }

    private fun resetTo(bytes: Long) { sent = bytes; epoch += 1 }
}
