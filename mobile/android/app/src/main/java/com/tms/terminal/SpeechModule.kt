package com.tms.terminal

import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Locale

/**
 * Reads an answer aloud (reader mode) with the phone's own speech engine —
 * no network, no server load.
 *
 * Every part (heading, paragraph, list item) is spoken as its own utterance,
 * so the page can mark what is being read. Events "TmsSpeech":
 *   { index }  this part starts now
 *   { done }   everything was read
 *   { error }  the engine failed
 */
class SpeechModule(rc: ReactApplicationContext) : ReactContextBaseJavaModule(rc) {

    override fun getName(): String = "TmsSpeech"

    private var tts: TextToSpeech? = null
    private var ready = false
    private var pending: (() -> Unit)? = null
    /** Raised with every speak/stop: callbacks of an older run are ignored. */
    @Volatile private var run = 0

    private fun emit(fill: (WritableMap) -> Unit) {
        try {
            val map = Arguments.createMap()
            fill(map)
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("TmsSpeech", map)
        } catch (_: Throwable) { /* JS side gone */ }
    }

    /** Required by NativeEventEmitter on the JS side. */
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    @ReactMethod
    fun speak(parts: ReadableArray, german: Boolean, promise: Promise) {
        val texts = (0 until parts.size()).map { (parts.getString(it) ?: "").trim() }
        val myRun = ++run
        val start: () -> Unit = start@{
            val engine = tts
            if (engine == null) { promise.reject("no_engine", "speech engine unavailable"); return@start }
            if (myRun != run) { promise.resolve(false); return@start } // stopped or replaced meanwhile
            val locale = if (german) Locale.GERMAN else Locale.getDefault()
            val lang = engine.setLanguage(locale)
            if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) {
                promise.reject("no_voice", "no voice for " + locale.toLanguageTag())
                return@start
            }
            engine.stop()
            // One long paragraph may exceed what the engine takes at once.
            val max = (TextToSpeech.getMaxSpeechInputLength() - 100).coerceIn(500, 3500)
            val queue = ArrayList<Pair<String, String>>() // utterance id → text
            texts.forEachIndexed { index, text ->
                var rest = text
                var piece = 0
                while (rest.isNotEmpty()) {
                    var cut = rest.length
                    if (cut > max) {
                        cut = rest.lastIndexOf(' ', max)
                        if (cut < max / 2) cut = max
                    }
                    queue.add("$myRun:$index:$piece" to rest.substring(0, cut))
                    rest = rest.substring(cut).trim()
                    piece++
                }
            }
            if (queue.isEmpty()) { promise.resolve(false); emit { it.putBoolean("done", true) }; return@start }
            val lastId = queue.last().first
            engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(id: String?) {
                    val f = (id ?: "").split(":")
                    if (f.size == 3 && f[0] == run.toString() && f[2] == "0") emit { it.putInt("index", f[1].toIntOrNull() ?: 0) }
                }
                override fun onDone(id: String?) {
                    if (id == lastId && myRun == run) emit { it.putBoolean("done", true) }
                }
                @Deprecated("Deprecated in Java")
                override fun onError(id: String?) {
                    if ((id ?: "").startsWith("$run:")) { run++; emit { it.putString("error", "engine") } }
                }
            })
            for ((id, text) in queue) engine.speak(text, TextToSpeech.QUEUE_ADD, null, id)
            promise.resolve(true)
        }
        if (ready) { start(); return }
        pending = start
        if (tts == null) {
            tts = TextToSpeech(reactApplicationContext.applicationContext) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    ready = true
                } else {
                    try { tts?.shutdown() } catch (_: Throwable) {}
                    tts = null
                }
                val go = pending
                pending = null
                go?.invoke()
            }
        }
    }

    @ReactMethod
    fun stop() {
        run++
        pending = null
        try { tts?.stop() } catch (_: Throwable) {}
    }

    override fun invalidate() {
        run++
        try { tts?.stop(); tts?.shutdown() } catch (_: Throwable) {}
        tts = null
        ready = false
        super.invalidate()
    }
}
