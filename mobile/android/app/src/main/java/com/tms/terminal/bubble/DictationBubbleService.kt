package com.tms.terminal.bubble

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.content.Intent
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
    private var trace: BubbleTrace? = null

    private var state = State.IDLE
    @Volatile private var upload: DictationUploadK? = null
    private var recordStartedAt = 0L
    private var stoppedAt = 0L
    private var peakSinceStart = 0
    /** App the user was typing in when pressing ✓ — the transcript only goes back there. */
    private var confirmedInPackage: String? = null
    @Volatile private var destroyed = false

    private var lastKeepAliveTry = 0L

    // ── input sessions (Android 13+) ────────────────────────────────────
    // The system reports every text-input start/end in any app to the service
    // (flagInputMethodEditor), with the field's type — the same signal the keyboard
    // gets. Searching the app's view tree for a focused field instead was the root
    // cause of the bubble not appearing: web apps report that focus late or never.
    /** True once Android handed us an input method — the input-session signal is available. */
    @Volatile private var inputSignal = false
    @Volatile private var inputActive = false
    @Volatile private var inputPassword = false
    @Volatile private var inputPackage: String? = null

    override fun onCreateInputMethod(): android.accessibilityservice.InputMethod {
        inputSignal = true
        return SessionWatcher()
    }

    @androidx.annotation.RequiresApi(33)
    private inner class SessionWatcher : android.accessibilityservice.InputMethod(this) {
        override fun onStartInput(attribute: android.view.inputmethod.EditorInfo, restarting: Boolean) {
            super.onStartInput(attribute, restarting)
            inputActive = true
            inputPassword = BubbleRules.isPasswordInput(attribute.inputType)
            inputPackage = attribute.packageName
            trace?.add("Eingabe beginnt ${attribute.packageName}${if (inputPassword) " (Passwort)" else ""}${if (restarting) " (neu)" else ""}")
            main.post { if (!destroyed) scheduleEvaluate() }
        }

        // Tapping into a field moves the cursor — also when the field already had focus
        // and only the keyboard comes back (no focus event then).
        override fun onUpdateSelection(oldSelStart: Int, oldSelEnd: Int, newSelStart: Int, newSelEnd: Int,
                                       candidatesStart: Int, candidatesEnd: Int) {
            super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)
            main.post { if (!destroyed && overlay.mode == BubbleOverlay.Mode.HIDDEN) { lastTrigger = "Cursor"; scheduleEvaluate() } }
        }

        override fun onFinishInput() {
            super.onFinishInput()
            inputActive = false
            inputPassword = false
            trace?.add("Eingabe endet")
            main.post { if (!destroyed) scheduleEvaluate() }
        }
    }

    // ── lifecycle ───────────────────────────────────────────────────────
    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        workerThread = HandlerThread("tms-bubble").also { it.start() }
        worker = Handler(workerThread.looper)
        trace = BubbleTrace(this, worker).also { it.add("verbunden (Android ${android.os.Build.VERSION.SDK_INT})") }
        // Without the cache every keyboard check asks the system for the real window list.
        // The cache only refreshes on window reports — the very reports that are late or
        // missing when the keyboard opens, so a re-check would read the stale list again.
        if (android.os.Build.VERSION.SDK_INT >= 33) try { setCacheEnabled(false) } catch (_: Exception) {}
        config = BubbleConfig(this)
        overlay = BubbleOverlay(this, config, this) { trace?.add(it) }
        recorder = BubbleRecorder(this)
        socket = DictationSocket(config,
            onConnected = { onWorker { upload?.onConnected() } },
            onMessage = { msg -> onWorker { handleServer(msg) } })
        Log.i(TAG, "bubble connected")
        ensureKeepAlive(force = true)
        scheduleEvaluate()
    }

    /** User switched the accessibility service off — the keep-alive notification goes too. */
    override fun onUnbind(intent: Intent?): Boolean {
        Log.i(TAG, "bubble unbound by system")
        stopService(Intent(this, BubbleKeepAliveService::class.java))
        return super.onUnbind(intent)
    }

    /** Wispr-style foreground service; retried on later events if Android refused the start. */
    private fun ensureKeepAlive(force: Boolean = false) {
        if (BubbleKeepAliveService.running || !config.enabled) return
        val now = System.currentTimeMillis()
        if (!force && now - lastKeepAliveTry < 30_000L) return
        lastKeepAliveTry = now
        BubbleKeepAliveService.sync(this)
    }

    override fun onInterrupt() {}

    /** Fold opened/closed or rotated: keep a visible bubble on the screen that is on now. */
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        if (!destroyed && ::overlay.isInitialized) overlay.onScreenChanged()
    }

    override fun onDestroy() {
        destroyed = true
        instance = null
        if (::recorder.isInitialized) recorder.discard()
        if (::socket.isInitialized) socket.close()
        if (::overlay.isInitialized) overlay.destroy()
        if (::workerThread.isInitialized) workerThread.quitSafely()
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    /** What triggered the next check — for the protocol only. */
    private var lastTrigger = ""

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event != null) lastTrigger = "${event.eventType.toString(16)}/${event.packageName ?: "-"}"
        // The keyboard announces itself before it shows up in the window list — logged so
        // the protocol shows whether the list ever caught up.
        if (event?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.className?.toString()?.endsWith("SoftInputWindow") == true) {
            trace?.add("Tastatur meldet sich ${event.packageName}")
        }
        if (com.tms.terminal.BuildConfig.DEBUG && event != null) Log.d(TAG, "ev ${AccessibilityEvent.eventTypeToString(event.eventType)} ${event.packageName} ${event.className} wc=${event.windowChanges}")
        scheduleEvaluate()
    }

    /** Worker task that can never take the app process down (the service runs in it). */
    private fun onWorker(block: () -> Unit) {
        worker.post {
            try { block() } catch (e: Exception) { Log.w(TAG, "worker task failed", e) }
        }
    }

    private fun onMain(block: () -> Unit) {
        main.post { if (!destroyed) block() }
    }

    // ── visibility ──────────────────────────────────────────────────────
    private val evaluate = Runnable { evaluateNow() }
    /** Re-checks done since the last event (see BubbleRules.settleDelay). */
    private var settleAttempt = 0

    private fun scheduleEvaluate() {
        settleAttempt = 0
        main.removeCallbacks(evaluate)
        main.postDelayed(evaluate, 150)
    }

    private var lastWhy = ""
    /** Stores the decision for the settings page — only on change, so typing costs no writes. */
    private fun record(why: String, now: Long) {
        if (why == lastWhy) return
        lastWhy = why
        trace?.add("Prüfung #$settleAttempt nach $lastTrigger: $why")
        try { config.recordCheck(why, now) } catch (_: Exception) {}
    }

    /** Still hidden although it might belong on screen: look again shortly. */
    private fun scheduleSettle(keyboard: Boolean) {
        val awaitingKeyboard = inputSignal && inputActive && !inputPassword && !keyboard
        val d = BubbleRules.settleDelay(settleAttempt++, keyboard, awaitingKeyboard) ?: return
        main.removeCallbacks(evaluate)
        main.postDelayed(evaluate, d)
    }

    private fun evaluateNow() {
        if (destroyed || !::overlay.isInitialized) return
        ensureKeepAlive()
        val busy = state != State.IDLE
        val now = System.currentTimeMillis()
        val snoozedUntil = config.snoozedUntil
        val enabled = config.enabled
        val keyboard = try { TextInserter.keyboardVisible(this) } catch (_: Exception) { false }
        val needField = !busy && config.isConfigured && enabled && now >= snoozedUntil && keyboard
        // Keyboard open = the user is typing. Only a password field keeps the bubble away;
        // that comes from the system's input session (Android 13+). Older Android: the
        // view-tree search (focusedEditable() returns null for password fields).
        val editable = needField && if (inputSignal) !(inputActive && inputPassword)
            else try { TextInserter.focusedEditable(this) != null } catch (_: Exception) { false }
        val show = (busy || config.isConfigured) && BubbleRules.shouldShow(
            editable, password = false, ownWindow = false, busy = busy,
            snoozedUntil = snoozedUntil, now = now, enabled = enabled,
            keyboardVisible = keyboard)
        if (com.tms.terminal.BuildConfig.DEBUG) Log.d(TAG, "eval a=$settleAttempt kb=$keyboard field=$editable input=$inputActive/$inputPackage pw=$inputPassword show=$show")
        record(BubbleRules.why(busy, config.isConfigured, enabled, now < snoozedUntil, keyboard, editable, show,
            password = inputSignal && inputActive && inputPassword), now)
        if (!show) {
            overlay.show(BubbleOverlay.Mode.HIDDEN)
            // Only worth another look when nothing but keyboard/field kept it hidden.
            if (!busy && config.isConfigured && enabled && now >= snoozedUntil) scheduleSettle(keyboard)
            return
        }
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
        onWorker { u.begin() }
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
            sendCancel(u)
            finishWith("Aufnahme zu kurz")
            return
        }
        confirmedInPackage = try { TextInserter.focusedEditable(this)?.packageName?.toString() } catch (_: Exception) { null }
            ?: inputPackage.takeIf { inputActive }
        state = State.PROCESSING
        stoppedAt = System.currentTimeMillis()
        u.lastHeard = stoppedAt
        overlay.show(BubbleOverlay.Mode.PROCESSING)
        onWorker { if (upload === u) u.finish() }
        main.postDelayed(watchTick, 15_000)
    }

    override fun onCancel() {
        upload?.let { if (!it.done) sendCancel(it) }
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
                overlay.result(BubbleView.Result.ERROR, "Mikrofon blockiert — kein Ton von Android")
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
            // Give up only when the server has been silent that long — it heartbeats
            // every 5 s while it works, so a long transcription is never cut off.
            if (now - u.lastHeard > GIVE_UP_MS) { finishWith("Keine Antwort vom Server — bitte später erneut"); return }
            if (socket.isOpen && now - u.lastHeard > RESUME_AFTER_MS) {
                u.lastHeard = now
                onWorker { u.onReconnect() }
            }
            main.postDelayed(this, 15_000)
        }
    }

    // ── server ──────────────────────────────────────────────────────────
    private fun handleServer(msg: JSONObject) {
        val u = upload ?: return
        when (u.onServer(msg)) {
            Outcome.RESULT -> onMain { if (upload === u) deliver(u.text ?: "") }
            Outcome.ERROR -> onMain { if (upload === u) finishWith(u.error ?: "Transkription fehlgeschlagen") }
            Outcome.RESTART -> if (u.isEnded) u.finish()
            null -> {}
        }
    }

    private fun deliver(text: String) {
        val t = text.trim()
        if (t.isEmpty()) { finishWith("Keine Sprache erkannt"); return }
        val result = try { TextInserter.insert(this, t, confirmedInPackage) } catch (e: Exception) {
            Log.w(TAG, "insert failed", e)
            TextInserter.copyOnly(this, t) // never lose the transcript
            TextInserter.Result.CLIPBOARD
        }
        if (destroyed) return
        reset()
        if (result == TextInserter.Result.INSERTED) overlay.result(BubbleView.Result.INSERTED, "Eingefügt")
        else overlay.result(BubbleView.Result.CLIPBOARD, "In Zwischenablage")
    }

    /** Ends the dictation with a problem: short shake + caption. */
    private fun finishWith(message: String) {
        if (destroyed) return
        reset()
        overlay.result(BubbleView.Result.ERROR, message)
    }

    /** Sent right away on this thread (OkHttp send is thread-safe) — before reset() closes the socket. */
    private fun sendCancel(u: DictationUploadK) {
        socket.send(JSONObject().put("type", "dictation:cancel").put("payload", JSONObject().put("id", u.id)).toString())
    }

    private fun reset() {
        main.removeCallbacks(levelTick)
        main.removeCallbacks(watchTick)
        worker.removeCallbacks(pumpTick)
        recorder.discard() // also stops a recorder that is still running (error during recording)
        upload = null
        confirmedInPackage = null
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
        override fun read(pos: Long, len: Int): ByteArray = if (!file.exists()) ByteArray(0) else RandomAccessFile(file, "r").use { raf ->
            val buf = ByteArray(len)
            raf.seek(pos)
            val n = raf.read(buf, 0, len)
            if (n <= 0) ByteArray(0) else if (n == len) buf else buf.copyOf(n)
        }
        override fun now() = System.currentTimeMillis()
    }
}
