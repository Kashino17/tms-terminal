package com.tms.terminal.bubble

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile

/**
 * Wispr-Flow-style dictation bubble in every app.
 *
 * Shows a small overlay while an editable (non-password) field has the input
 * focus. Tap → record (AAC-ADTS, streamed to the TMS server while speaking) →
 * ✓ → the transcript is pasted into the field focused at that moment, or put
 * on the clipboard when there is none. Hold → sleep 15 minutes.
 *
 * The microphone is used from this service directly: the system binds
 * accessibility services with BIND_INCLUDE_CAPABILITIES, so the process gets
 * foreground microphone access. Android silences (rather than fails) a
 * recording without it — the silence watchdog makes that visible.
 */
class DictationBubbleService : AccessibilityService(), BubbleOverlay.Callbacks {

    companion object {
        private const val TAG = "TmsBubble"
        private const val PUMP_MS = 2000L
        private const val LEVEL_MS = 100L
        private const val SILENCE_WATCH_MS = 2500L
        private const val RESUME_AFTER_MS = 60_000L
        private const val GIVE_UP_MS = 3 * 60_000L

        @Volatile var instance: DictationBubbleService? = null
            private set
    }

    private enum class State { IDLE, RECORDING, PROCESSING }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var worker: Handler
    private lateinit var workerThread: HandlerThread
    private lateinit var config: BubbleConfig
    private lateinit var overlay: BubbleOverlay
    private lateinit var recorder: BubbleRecorder
    private lateinit var socket: DictationSocket

    private var state = State.IDLE
    private var upload: DictationUploadK? = null
    private var recordStartedAt = 0L
    private var stoppedAt = 0L
    private var peakSinceStart = 0

    private val prefsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> scheduleEvaluate() }

    // ── lifecycle ───────────────────────────────────────────────────────
    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        workerThread = HandlerThread("tms-bubble").also { it.start() }
        worker = Handler(workerThread.looper)
        config = BubbleConfig(this)
        overlay = BubbleOverlay(this, config, this)
        recorder = BubbleRecorder(this)
        socket = DictationSocket(config,
            onConnected = { worker.post { upload?.onConnected() } },
            onMessage = { msg -> worker.post { handleServer(msg) } })
        config.prefs.registerOnSharedPreferenceChangeListener(prefsListener)
        scheduleEvaluate()
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        instance = null
        if (::config.isInitialized) config.prefs.unregisterOnSharedPreferenceChangeListener(prefsListener)
        if (::recorder.isInitialized) recorder.discard()
        if (::socket.isInitialized) socket.close()
        if (::overlay.isInitialized) overlay.destroy()
        if (::workerThread.isInitialized) workerThread.quitSafely()
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        scheduleEvaluate()
    }

    // ── visibility ──────────────────────────────────────────────────────
    private val evaluate = Runnable { evaluateNow() }

    private fun scheduleEvaluate() {
        main.removeCallbacks(evaluate)
        main.postDelayed(evaluate, 150)
    }

    /** Called by the RN module after wake()/setEnabled(). */
    fun reevaluate() = main.post { evaluateNow() }

    private fun evaluateNow() {
        if (!::overlay.isInitialized) return
        val busy = state != State.IDLE
        val editable = try { TextInserter.focusedEditable(this) != null } catch (_: Exception) { false }
        val password = try { TextInserter.focusedIsPassword(this) } catch (_: Exception) { false }
        val now = System.currentTimeMillis()
        val show = config.isConfigured && BubbleRules.shouldShow(
            editable, password, ownWindow = false, busy = busy,
            snoozedUntil = config.snoozedUntil, now = now, enabled = config.enabled)
        if (!show) { overlay.show(BubbleOverlay.Mode.HIDDEN); return }
        overlay.show(when (state) {
            State.IDLE -> BubbleOverlay.Mode.BUBBLE
            State.RECORDING -> BubbleOverlay.Mode.RECORDING
            State.PROCESSING -> BubbleOverlay.Mode.PROCESSING
        })
        // Wake up on time after a snooze, even if no accessibility event comes.
        val wakeIn = config.snoozedUntil - now
        if (wakeIn > 0) main.postDelayed(evaluate, wakeIn + 200)
    }

    // ── overlay callbacks ───────────────────────────────────────────────
    override fun onTap() {
        if (state != State.IDLE) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            overlay.toast("Mikrofon-Berechtigung fehlt — TMS öffnen")
            packageManager.getLaunchIntentForPackage(packageName)?.let {
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(it)
            }
            return
        }
        val file = try { recorder.start() } catch (e: Exception) {
            Log.w(TAG, "recorder start failed", e)
            overlay.toast("Aufnahme konnte nicht gestartet werden")
            return
        }
        val u = DictationUploadK(newId(), "adts", config.enhance, fileIO(file)) {
            Base64.encodeToString(it, Base64.NO_WRAP)
        }
        upload = u
        state = State.RECORDING
        recordStartedAt = System.currentTimeMillis()
        peakSinceStart = 0
        socket.ensure()
        worker.post { u.begin() }
        overlay.show(BubbleOverlay.Mode.RECORDING)
        main.post(levelTick)
        worker.postDelayed(pumpTick, PUMP_MS)
    }

    override fun onConfirm() {
        if (state != State.RECORDING) return
        val u = upload ?: return
        main.removeCallbacks(levelTick)
        worker.removeCallbacks(pumpTick)
        if (!recorder.stop()) {
            worker.post { socket.send(JSONObject().put("type", "dictation:cancel").put("payload", JSONObject().put("id", u.id)).toString()) }
            finishWith("Aufnahme zu kurz")
            return
        }
        state = State.PROCESSING
        stoppedAt = System.currentTimeMillis()
        overlay.show(BubbleOverlay.Mode.PROCESSING)
        worker.post { if (upload === u) u.finish() }
        main.postDelayed(watchTick, 15_000)
    }

    override fun onCancel() {
        val u = upload
        if (u != null && !u.done) {
            val msg = JSONObject().put("type", "dictation:cancel").put("payload", JSONObject().put("id", u.id)).toString()
            worker.post { socket.send(msg) }
        }
        recorder.discard()
        reset()
    }

    override fun onSnooze() {
        if (state != State.IDLE) return
        config.snoozedUntil = BubbleRules.snoozeUntil(System.currentTimeMillis())
        overlay.show(BubbleOverlay.Mode.HIDDEN)
        overlay.toast("Bubble schläft 15 Minuten")
    }

    // ── recording ticks ─────────────────────────────────────────────────
    private val levelTick = object : Runnable {
        override fun run() {
            if (state != State.RECORDING) return
            val amp = recorder.level()
            if (amp > peakSinceStart) peakSinceStart = amp
            overlay.setLevel((amp / 12000f).coerceAtMost(1f))
            val elapsed = System.currentTimeMillis() - recordStartedAt
            overlay.setElapsed(elapsed)
            if (elapsed > SILENCE_WATCH_MS && peakSinceStart == 0) {
                // Android delivers silence instead of an error when it denies the mic.
                onCancel()
                overlay.toast("Mikrofon blockiert — kein Ton von Android")
                return
            }
            main.postDelayed(this, LEVEL_MS)
        }
    }

    private val pumpTick = object : Runnable {
        override fun run() {
            val u = upload ?: return
            if (state != State.RECORDING) return
            try { u.pump() } catch (e: Exception) { Log.w(TAG, "pump", e) }
            worker.postDelayed(this, PUMP_MS)
        }
    }

    /** While waiting: resume after 60s silence, give up after 3 min. */
    private val watchTick = object : Runnable {
        override fun run() {
            val u = upload ?: return
            if (state != State.PROCESSING) return
            val now = System.currentTimeMillis()
            if (now - stoppedAt > GIVE_UP_MS) { finishWith("Keine Antwort vom Server — bitte später erneut"); return }
            if (socket.isOpen && now - u.lastHeard > RESUME_AFTER_MS) {
                u.lastHeard = now
                worker.post { u.onReconnect() }
            }
            main.postDelayed(this, 15_000)
        }
    }

    // ── server ──────────────────────────────────────────────────────────
    private fun handleServer(msg: JSONObject) {
        val u = upload ?: return
        when (u.onServer(msg)) {
            Outcome.RESULT -> main.post { if (upload === u) deliver(u.text ?: "") }
            Outcome.ERROR -> main.post { if (upload === u) finishWith(u.error ?: "Transkription fehlgeschlagen") }
            Outcome.RESTART -> if (u.isEnded) u.finish()
            null -> {}
        }
    }

    private fun deliver(text: String) {
        val t = text.trim()
        if (t.isEmpty()) { finishWith("Keine Sprache erkannt"); return }
        val result = try { TextInserter.insert(this, t) } catch (e: Exception) {
            Log.w(TAG, "insert failed", e); TextInserter.Result.CLIPBOARD
        }
        finishWith(if (result == TextInserter.Result.INSERTED) "Eingefügt" else "In Zwischenablage kopiert")
    }

    private fun finishWith(message: String) {
        reset()
        overlay.toast(message)
    }

    private fun reset() {
        main.removeCallbacks(levelTick)
        main.removeCallbacks(watchTick)
        worker.removeCallbacks(pumpTick)
        recorder.deleteFile()
        upload = null
        state = State.IDLE
        socket.close()
        evaluateNow()
    }

    // ── helpers ─────────────────────────────────────────────────────────
    private fun newId() = "b" + java.lang.Long.toString(System.currentTimeMillis(), 36) +
        java.lang.Long.toString((Math.random() * 1e12).toLong(), 36)

    private fun fileIO(file: File) = object : UploadIO {
        override fun send(json: String) = socket.send(json)
        override fun fileSize() = file.length()
        override fun read(pos: Long, len: Int): ByteArray = RandomAccessFile(file, "r").use { raf ->
            val buf = ByteArray(len)
            raf.seek(pos)
            val n = raf.read(buf, 0, len)
            if (n <= 0) ByteArray(0) else if (n == len) buf else buf.copyOf(n)
        }
        override fun now() = System.currentTimeMillis()
    }
}
