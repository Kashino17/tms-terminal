package com.tms.terminal.bubble

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class FakeIO(var file: ByteArray = ByteArray(0)) : UploadIO {
    val sent = mutableListOf<JSONObject>()
    var online = true
    var onRead: ((Int) -> Unit)? = null
    private var reads = 0
    var t = 0L
    override fun send(json: String): Boolean { if (!online) return false; sent.add(JSONObject(json)); return true }
    override fun fileSize(): Long = file.size.toLong()
    override fun read(pos: Long, len: Int): ByteArray {
        require(pos + len <= file.size) { "read past EOF" }
        val r = file.copyOfRange(pos.toInt(), pos.toInt() + len)
        onRead?.invoke(++reads)
        return r
    }
    override fun now(): Long = t
    fun chunks() = sent.filter { it.getString("type") == "dictation:chunk" }.map {
        val p = it.getJSONObject("payload"); p.getLong("offset") to Base64.getDecoder().decode(p.getString("data")).size
    }
    fun types() = sent.map { it.getString("type") }
}

private fun msg(type: String, vararg kv: Pair<String, Any>): JSONObject {
    val p = JSONObject().put("id", "d1"); kv.forEach { p.put(it.first, it.second) }
    return JSONObject().put("type", type).put("payload", p)
}

private fun upload(io: FakeIO) = DictationUploadK("d1", "adts", false, io) { Base64.getEncoder().encodeToString(it) }

class DictationUploadKTest {
    @Test fun pumpSendsWhatTheGrowingFileHasNeverPastEof() {
        val io = FakeIO(ByteArray(10)); val u = upload(io)
        u.begin(); u.pump()
        io.file += ByteArray(5); u.pump()
        assertEquals(listOf(0L to 10, 10L to 5), io.chunks())
    }

    @Test fun backlogGoesOutInChunksOfAtMost64K() {
        val io = FakeIO(ByteArray(CHUNK_BYTES * 2 + 3)); val u = upload(io)
        u.pump()
        assertEquals(listOf(0L to CHUNK_BYTES, CHUNK_BYTES.toLong() to CHUNK_BYTES, (CHUNK_BYTES * 2).toLong() to 3), io.chunks())
    }

    @Test fun droppedWhileOfflineIsResentFromServerPosition() {
        val io = FakeIO(ByteArray(10)); val u = upload(io)
        u.begin(); u.pump()
        io.online = false; io.file += ByteArray(10); u.pump()
        io.online = true; u.onReconnect()
        assertEquals("dictation:resume", io.types().last())
        assertEquals(Outcome.RESTART, u.onServer(msg("dictation:state", "status" to "receiving", "bytes" to 10)))
        u.pump()
        assertEquals(listOf(0L to 10, 10L to 10), io.chunks())
    }

    @Test fun finishSendsRestThenEnd() {
        val io = FakeIO(ByteArray(12)); val u = upload(io)
        u.begin(); u.finish()
        assertEquals(listOf("dictation:start", "dictation:chunk", "dictation:end"), io.types())
        assertEquals(12, io.sent.last().getJSONObject("payload").getInt("totalBytes"))
    }

    @Test fun unknownRestartsFromZeroUpToThreeAttempts() {
        val io = FakeIO(ByteArray(4)); val u = upload(io)
        u.begin(); u.finish()
        repeat(2) {
            assertEquals(Outcome.RESTART, u.onServer(msg("dictation:state", "status" to "unknown", "bytes" to 0)))
            u.onServer(msg("dictation:ack", "bytes" to 0))
            u.finish()
            assertEquals("dictation:end", io.types().last())
        }
        assertEquals(3, u.attempts)
        assertEquals(Outcome.ERROR, u.onServer(msg("dictation:state", "status" to "unknown", "bytes" to 0)))
        assertNotNull(u.error)
    }

    @Test fun repeatedUnknownBeforeAckCountsOnce() {
        val u = upload(FakeIO(ByteArray(4)))
        u.onServer(msg("dictation:ack", "bytes" to 0))
        u.onServer(msg("dictation:state", "status" to "unknown", "bytes" to 0))
        assertNull(u.onServer(msg("dictation:state", "status" to "unknown", "bytes" to 0)))
        assertEquals(2, u.attempts)
    }

    @Test fun resultDeliveredOnce() {
        val u = upload(FakeIO())
        assertEquals(Outcome.RESULT, u.onServer(msg("dictation:result", "text" to "hallo")))
        assertEquals("hallo", u.text)
        assertNull(u.onServer(msg("dictation:result", "text" to "hallo")))
        assertNull(u.onServer(msg("dictation:state", "status" to "done", "bytes" to 0, "text" to "hallo")))
    }

    @Test fun stateDoneDeliversStoredText() {
        val u = upload(FakeIO())
        assertEquals(Outcome.RESULT, u.onServer(msg("dictation:state", "status" to "done", "bytes" to 3, "text" to "fertig")))
        assertEquals("fertig", u.text)
    }

    @Test fun serverErrorIsFinal() {
        val u = upload(FakeIO())
        assertEquals(Outcome.ERROR, u.onServer(msg("dictation:error", "message" to "kaputt")))
        assertEquals("kaputt", u.error)
    }

    @Test fun otherIdsIgnoredOwnMessagesAreSignOfLife() {
        val io = FakeIO(); val u = upload(io)
        val other = JSONObject().put("type", "dictation:result").put("payload", JSONObject().put("id", "x").put("text", "y"))
        assertNull(u.onServer(other)); assertNull(u.text)
        io.t = 42; u.onServer(msg("dictation:progress"))
        assertEquals(42L, u.lastHeard)
    }

    @Test fun resetDuringReadDoesNotMislabelOffsets() {
        val io = FakeIO(ByteArray(CHUNK_BYTES * 3) { (it / CHUNK_BYTES + 1).toByte() })
        val u = upload(io)
        u.begin()
        io.onRead = { n -> if (n == 2) u.onServer(msg("dictation:state", "status" to "unknown", "bytes" to 0)) }
        u.pump(); u.pump()
        for (m in io.sent.filter { it.getString("type") == "dictation:chunk" }) {
            val p = m.getJSONObject("payload")
            val bytes = Base64.getDecoder().decode(p.getString("data"))
            val off = p.getLong("offset").toInt()
            assertArrayEquals("chunk at $off", io.file.copyOfRange(off, off + bytes.size), bytes)
        }
    }

    @Test fun ackSeenFlipsOnFirstAck() {
        val u = upload(FakeIO())
        assertFalse(u.ackSeen)
        u.onServer(msg("dictation:ack", "bytes" to 0))
        assertTrue(u.ackSeen)
    }

    // The bubble opens its socket on demand: a start sent before the socket was
    // open is simply repeated on connect — not counted as a lost session.
    @Test fun connectBeforeAnyAckResendsStartWithoutUsingAnAttempt() {
        val io = FakeIO(ByteArray(4)); io.online = false
        val u = upload(io)
        u.begin()
        io.online = true
        u.onConnected()
        assertEquals("dictation:start", io.types().last())
        assertEquals(1, u.attempts)
        u.onServer(msg("dictation:ack", "bytes" to 0))
        u.onConnected()
        assertEquals("dictation:resume", io.types().last())
    }

    // Review I2: ✓ pressed while still offline — on connect the start AND the
    // whole recording + end must go out, not just the start.
    @Test fun connectAfterStopSendsStartRestAndEnd() {
        val io = FakeIO(ByteArray(10)); io.online = false
        val u = upload(io)
        u.begin(); u.finish()
        assertTrue(io.sent.isEmpty())
        io.online = true
        u.onConnected()
        assertEquals(listOf("dictation:start", "dictation:chunk", "dictation:end"), io.types())
    }
}
