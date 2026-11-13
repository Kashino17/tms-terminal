package com.tms.terminal.bubble

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * Dictation-only WebSocket (`?role=dictation`) to the TMS server. Open only
 * while a dictation is in flight; reconnects with backoff while wanted.
 */
class DictationSocket(
    private val config: BubbleConfig,
    private val onConnected: () -> Unit,
    private val onMessage: (JSONObject) -> Unit,
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var ws: WebSocket? = null
    @Volatile private var open = false
    @Volatile private var wanted = false
    private var backoffMs = 1000L

    val isOpen: Boolean get() = open

    fun ensure() {
        wanted = true
        if (ws == null) connect()
    }

    fun close() {
        wanted = false
        main.removeCallbacksAndMessages(null)
        ws?.close(1000, null)
        ws = null
        open = false
    }

    fun send(text: String): Boolean = open && (ws?.send(text) ?: false)

    private fun connect() {
        if (!wanted || !config.isConfigured) return
        val url = "ws://${config.host}:${config.port}/?token=${URLEncoder.encode(config.token, "UTF-8")}&role=dictation"
        ws = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket !== ws) return
                open = true
                backoffMs = 1000L
                onConnected()
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== ws) return
                try { onMessage(JSONObject(text)) } catch (_: Exception) { /* not ours */ }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dropped(webSocket)
        })
    }

    private fun dropped(webSocket: WebSocket) {
        if (webSocket !== ws) return
        open = false
        ws = null
        if (!wanted) return
        val delay = backoffMs
        backoffMs = minOf(backoffMs * 2, 10_000L)
        main.postDelayed({ if (ws == null) connect() }, delay)
    }
}
