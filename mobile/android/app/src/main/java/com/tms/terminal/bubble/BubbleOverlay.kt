package com.tms.terminal.bubble

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.animation.PathInterpolator
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.hypot

/**
 * Two TYPE_ACCESSIBILITY_OVERLAY windows that NEVER change size:
 *  - the circle window (idle / transcribing / result), and
 *  - the pill window (full pill width, only while recording) in which the
 *    circle → pill → circle morph is drawn.
 * Android animates every move of a window's left edge, and a right-docked
 * window that shrinks has to move its left edge — the circle jumped and slid
 * back. With fixed-size windows the hand-over is pixel-identical instead.
 *
 * Both are NOT_FOCUSABLE, so the text field keeps the input focus.
 * Gestures — circle: tap = record, drag = move, hold = sleep 15 min,
 *            hold while transcribing = cancel.  pill: ✕ left, ✓ right.
 */
class BubbleOverlay(
    private val ctx: Context,
    private val config: BubbleConfig,
    private val callbacks: Callbacks,
    /** Protocol line (shown under "Protokoll kopieren"). */
    private val log: (String) -> Unit = {},
) {
    interface Callbacks {
        fun onTap()
        fun onConfirm()
        fun onCancel()
        fun onSnooze()
    }

    enum class Mode { HIDDEN, BUBBLE, RECORDING, PROCESSING }

    private val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val main = Handler(Looper.getMainLooper())
    private val density = ctx.resources.displayMetrics.density
    private fun dp(v: Int) = (v * density).toInt()
    private val ease = PathInterpolator(0.2f, 0f, 0f, 1f)
    private val spring = PathInterpolator(0.34f, 1.4f, 0.64f, 1f)

    var mode = Mode.HIDDEN
        private set

    private val circle = BubbleView(ctx)
    private val pill = BubbleView(ctx)
    private val size = circle.diameter.toInt()
    private val pillW = circle.pillWidth.toInt()
    private val circleParams = overlayParams(size, size)
    private val pillParams = overlayParams(pillW, size)

    private val caption = TextView(ctx).apply {
        setTextColor(Color.argb(235, 255, 255, 255)); textSize = 12.5f
        background = GradientDrawable().apply {
            setColor(Color.argb(224, 18, 18, 24)); cornerRadius = dp(14).toFloat(); setStroke(dp(1), Color.argb(34, 255, 255, 255))
        }
        setPadding(dp(12), dp(7), dp(12), dp(7))
        alpha = 0f
    }
    private val captionParams = overlayParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT).apply {
        flags = flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    }

    private val sleepSize = dp(64)
    private val sleepTarget = TextView(ctx).apply {
        text = "z z"; textSize = 15f; gravity = Gravity.CENTER; letterSpacing = 0.05f
        setTextColor(Color.argb(220, 255, 255, 255))
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.argb(200, 18, 18, 24)); setStroke(dp(1), Color.argb(70, 255, 255, 255))
        }
        alpha = 0f
    }
    private val sleepParams = overlayParams(sleepSize, sleepSize).apply {
        flags = flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    }

    private var circleAttached = false
    private var pillAttached = false
    private var hiding = false
    private var captionAttached = false
    private var sleepAttached = false
    private var homeX = -1
    private var homeY = -1

    init {
        pill.onMorphSettled = { w -> if (w <= size + 1) handBackToCircle() }
        setupCircleTouch()
        setupPillTouch()
    }

    // ── public API ──────────────────────────────────────────────────────
    fun show(newMode: Mode) {
        if (newMode == mode && !(newMode != Mode.HIDDEN && hiding)) return
        val old = mode
        mode = newMode
        if (newMode == Mode.HIDDEN) { fadeOut(); hideSleepTarget(); return }
        // Every appearance is placed on the screen as it is now (Fold: inner ⇄ cover).
        if (homeX < 0 || old == Mode.HIDDEN || hiding) placeFromConfig()
        when (newMode) {
            Mode.RECORDING -> startPill()
            Mode.PROCESSING -> if (pillAttached) pill.setFace(BubbleView.Face.PROCESSING) else circle.setFace(BubbleView.Face.PROCESSING)
            Mode.BUBBLE -> if (pillAttached) pill.setFace(BubbleView.Face.IDLE) else circle.setFace(BubbleView.Face.IDLE)
            else -> {}
        }
        if (newMode != Mode.RECORDING && !pillAttached && (!circleAttached || hiding)) fadeInCircle(old == Mode.HIDDEN || hiding)
    }

    fun setLevel(fraction: Float) = pill.setLevel(fraction)

    fun setElapsed(ms: Long) {
        val s = ms / 1000
        pill.elapsedText = "%d:%02d".format(s / 60, s % 60)
    }

    /** Result feedback in the circle + a short caption above it. */
    fun result(kind: BubbleView.Result, message: String) {
        circle.showResult(kind)
        if (kind == BubbleView.Result.ERROR) circle.performHapticFeedback(HapticFeedbackConstants.REJECT)
        toast(message)
    }

    fun toast(message: String) {
        caption.text = message
        caption.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
        val (sw, _) = screen()
        if (homeX < 0) placeFromConfig()
        val cw = caption.measuredWidth
        val ch = caption.measuredHeight
        val centre = homeX + size / 2
        captionParams.x = (centre - cw / 2).coerceIn(dp(8), (sw - cw - dp(8)).coerceAtLeast(dp(8)))
        captionParams.y = if (homeY - ch - dp(10) > dp(24)) homeY - ch - dp(10) else homeY + size + dp(10)
        try {
            if (!captionAttached) { wm.addView(caption, captionParams); captionAttached = true }
            else wm.updateViewLayout(caption, captionParams)
        } catch (_: Exception) { captionAttached = false; return }
        caption.animate().cancel()
        caption.translationY = dp(4).toFloat()
        caption.animate().alpha(1f).translationY(0f).setDuration(180).setInterpolator(ease).start()
        main.removeCallbacks(hideCaption)
        main.postDelayed(hideCaption, if (message.length > 32) 2800 else 1500)
    }

    fun destroy() {
        main.removeCallbacksAndMessages(null)
        circle.release(); pill.release()
        detach(circle); detach(pill); detach(caption); detach(sleepTarget)
        circleAttached = false; pillAttached = false; captionAttached = false; sleepAttached = false
        mode = Mode.HIDDEN
    }

    /** Screen size changed (Fold opened/closed, rotation): move a visible circle onto it. */
    private var lastScreen: Pair<Int, Int>? = null
    fun onScreenChanged() {
        val now = screen()
        if (now == lastScreen) return
        lastScreen = now
        log("Bildschirm jetzt ${now.first}×${now.second}")
        if (mode == Mode.HIDDEN || pillAttached || !circleAttached) return
        placeFromConfig()
        resetCirclePosition()
        reportPlacement()
    }

    // ── circle ⇄ pill hand-over ─────────────────────────────────────────
    private fun anchorRight() = homeX + size / 2 > screen().first / 2

    private fun startPill() {
        val right = anchorRight()
        pill.anchorRight = right
        pill.snapTo(BubbleView.Face.IDLE, 0f)
        pillParams.x = if (right) homeX + size - pillW else homeX
        pillParams.y = homeY
        try {
            if (!pillAttached) { wm.addView(pill, pillParams); pillAttached = true } else wm.updateViewLayout(pill, pillParams)
        } catch (_: Exception) { pillAttached = false; return }
        // The pill starts as an identical circle on top; hide ours once it's drawn.
        pill.post {
            circle.animate().cancel(); circle.alpha = 0f
            pill.setFace(BubbleView.Face.RECORDING)
        }
    }

    /** The pill has morphed back into a circle: the circle window takes over. */
    private fun handBackToCircle() {
        if (!pillAttached) return
        val face = when (mode) {
            Mode.PROCESSING -> BubbleView.Face.PROCESSING
            else -> BubbleView.Face.IDLE
        }
        circle.snapTo(face, pill.spinAngle)
        if (mode == Mode.HIDDEN) { circle.alpha = 0f } else {
            if (!circleAttached) {
                circleParams.x = homeX; circleParams.y = homeY
                try { wm.addView(circle, circleParams); circleAttached = true } catch (_: Exception) { }
            }
            circle.animate().cancel(); circle.alpha = 1f; circle.scaleX = 1f; circle.scaleY = 1f
        }
        // Remove the pill one frame later, after the circle has drawn.
        circle.post { detach(pill); pillAttached = false }
    }

    // ── circle window ───────────────────────────────────────────────────
    private fun fadeInCircle(fromHidden: Boolean) {
        hiding = false
        main.removeCallbacks(finishHide)
        circle.animate().cancel()
        circleParams.x = homeX; circleParams.y = homeY
        // Trust the view, not our flag: a window the system dropped must be added again,
        // otherwise the update fails and the bubble stays away while "visible".
        circleAttached = circle.isAttachedToWindow
        try {
            if (!circleAttached) wm.addView(circle, circleParams) else wm.updateViewLayout(circle, circleParams)
            circleAttached = true
        } catch (e: Exception) {
            circleAttached = false
            log("Bubble-Fenster fehlgeschlagen: ${e.javaClass.simpleName} ${e.message?.take(80) ?: ""}")
            return
        }
        // Fully opaque right away — the animation is decoration only. On the Fold the
        // bubble process sometimes got no animation frames: a fade-in from alpha 0 then
        // stayed invisible ("Bubble bei 811,760" = still at the start scale, 300 ms later).
        circle.alpha = 1f
        if (fromHidden) {
            circle.scaleX = 0.9f; circle.scaleY = 0.9f
            circle.animate().scaleX(1f).scaleY(1f).setDuration(200).setInterpolator(spring).start()
        } else { circle.scaleX = 1f; circle.scaleY = 1f }
        main.removeCallbacks(snapCircle)
        main.postDelayed(snapCircle, 350)
        if (fromHidden) reportPlacement()
    }

    /** End state without frames: full size, opaque — whatever the animation did. */
    private val snapCircle = Runnable {
        if (mode == Mode.HIDDEN || hiding || pillAttached || !circleAttached) return@Runnable
        circle.animate().cancel()
        circle.alpha = 1f; circle.scaleX = 1f; circle.scaleY = 1f
    }

    /** Remove the hidden circle on a timer, not at the animation's end (may never come). */
    private val finishHide = Runnable {
        if (!hiding) return@Runnable
        circle.animate().cancel()
        detach(circle); circleAttached = false; hiding = false
    }

    /** Protocol: where the circle really ended up, measured after layout. */
    private fun reportPlacement() {
        main.postDelayed({
            if (mode == Mode.HIDDEN || hiding) return@postDelayed
            val (w, h) = screen()
            val x = circleParams.x; val y = circleParams.y
            val onScreen = x >= 0 && y >= 0 && x + size <= w && y + size <= h
            log("Bubble bei $x,$y · Bildschirm ${w}×$h" +
                (if (!circle.isAttachedToWindow) " · NICHT angehängt" else "") +
                (if (circle.windowVisibility != View.VISIBLE) " · Fenster unsichtbar" else "") +
                (if (circle.alpha < 0.99f) " · durchsichtig ${"%.2f".format(circle.alpha)}" else "") +
                // Started at 0.9: still there after 300 ms = no animation frames arrived.
                (if (circle.scaleX < 0.99f) " · Animation hängt" else "") +
                (if (!onScreen) " · AUSSERHALB" else ""))
        }, 300)
    }

    private fun fadeOut() {
        if (pillAttached) { detach(pill); pillAttached = false }
        if (!circleAttached) return
        hiding = true
        main.removeCallbacks(snapCircle)
        circle.animate().cancel()
        circle.animate().alpha(0f).scaleX(0.85f).scaleY(0.85f).setDuration(160).setInterpolator(ease).start()
        main.removeCallbacks(finishHide)
        main.postDelayed(finishHide, 200)
    }

    private val hideCaption = Runnable {
        caption.animate().alpha(0f).setDuration(220).setInterpolator(ease)
            .withEndAction { if (caption.alpha == 0f) { detach(caption); captionAttached = false } }.start()
    }

    // ── gestures ────────────────────────────────────────────────────────
    @SuppressLint("ClickableViewAccessibility")
    private fun setupCircleTouch() {
        val slop = ViewConfiguration.get(ctx).scaledTouchSlop
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0
        var dragging = false; var held = false
        val hold = Runnable {
            held = true
            circle.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            if (mode == Mode.BUBBLE) showSleepTarget()
        }
        circle.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startX = circleParams.x; startY = circleParams.y
                    dragging = false; held = false
                    circle.pressAnim(true)
                    if (mode == Mode.BUBBLE || mode == Mode.PROCESSING) main.postDelayed(hold, 450)
                }
                MotionEvent.ACTION_MOVE -> {
                    if (mode != Mode.BUBBLE) return@setOnTouchListener true
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (!dragging && hypot(dx, dy) > slop) {
                        dragging = true
                        main.removeCallbacks(hold)
                        showSleepTarget()
                    }
                    if (dragging) {
                        circleParams.x = startX + dx.toInt(); circleParams.y = startY + dy.toInt()
                        try { wm.updateViewLayout(circle, circleParams) } catch (_: Exception) { }
                        highlightSleep(overSleepTarget())
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    main.removeCallbacks(hold)
                    circle.pressAnim(false)
                    val cancelled = e.actionMasked == MotionEvent.ACTION_CANCEL
                    when (mode) {
                        Mode.BUBBLE -> {
                            val sleep = (held && !dragging) || (dragging && overSleepTarget())
                            hideSleepTarget()
                            when {
                                cancelled -> {}
                                sleep -> { resetCirclePosition(); callbacks.onSnooze() }
                                dragging -> settleAfterDrag()
                                else -> callbacks.onTap()
                            }
                        }
                        Mode.PROCESSING -> if (held && !cancelled) callbacks.onCancel()
                        else -> {}
                    }
                }
            }
            true
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun setupPillTouch() {
        pill.setOnTouchListener { _, e ->
            if (e.actionMasked == MotionEvent.ACTION_UP && mode == Mode.RECORDING) {
                when (pill.hitInPill(e.x)) {
                    -1 -> callbacks.onCancel()
                    1 -> callbacks.onConfirm()
                }
            }
            true
        }
    }

    private fun resetCirclePosition() {
        circleParams.x = homeX; circleParams.y = homeY
        try { if (circleAttached) wm.updateViewLayout(circle, circleParams) } catch (_: Exception) { }
    }

    private fun settleAfterDrag() {
        val (w, h) = screen()
        val (x, y) = BubbleRules.placeBubble(circleParams.x.coerceAtLeast(0), circleParams.y.coerceAtLeast(0), w, h, size, dp(24))
        homeX = x; homeY = y
        resetCirclePosition()
        config.x = homeX; config.y = homeY
    }

    private fun showSleepTarget() {
        val (w, h) = screen()
        sleepParams.x = w / 2 - sleepSize / 2
        sleepParams.y = h - dp(150)
        if (!sleepAttached) {
            try { wm.addView(sleepTarget, sleepParams); sleepAttached = true } catch (_: Exception) { return }
        }
        sleepTarget.animate().cancel()
        sleepTarget.scaleX = 0.7f; sleepTarget.scaleY = 0.7f
        sleepTarget.animate().alpha(0.75f).scaleX(1f).scaleY(1f).setDuration(200).setInterpolator(spring).start()
    }

    private var sleepHot = false
    private fun highlightSleep(hot: Boolean) {
        if (hot == sleepHot) return
        sleepHot = hot
        if (hot) circle.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        sleepTarget.animate().alpha(if (hot) 1f else 0.75f).scaleX(if (hot) 1.18f else 1f).scaleY(if (hot) 1.18f else 1f)
            .setDuration(140).setInterpolator(spring).start()
    }

    private fun hideSleepTarget() {
        sleepHot = false
        if (!sleepAttached) return
        sleepTarget.animate().alpha(0f).scaleX(0.7f).scaleY(0.7f).setDuration(140).setInterpolator(ease)
            .withEndAction { detach(sleepTarget); sleepAttached = false }.start()
    }

    private fun overSleepTarget(): Boolean {
        val cx = circleParams.x + size / 2f; val cy = circleParams.y + size / 2f
        val tx = sleepParams.x + sleepSize / 2f; val ty = sleepParams.y + sleepSize / 2f
        return abs(cx - tx) < dp(56) && abs(cy - ty) < dp(56)
    }

    private fun placeFromConfig() {
        val (w, h) = screen()
        val (x, y) = BubbleRules.placeBubble(config.x, config.y, w, h, size, dp(24))
        homeX = x; homeY = y
    }

    /**
     * Size of the panel that is on right now. The service's resources can still hold the
     * other Fold screen's metrics; the display itself always reports the active panel.
     */
    private fun screen(): Pair<Int, Int> {
        return try {
            val d = (ctx.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).getDisplay(Display.DEFAULT_DISPLAY)
            val p = Point()
            @Suppress("DEPRECATION") d.getRealSize(p)
            if (p.x > 0 && p.y > 0) Pair(p.x, p.y) else metricsSize()
        } catch (_: Exception) { metricsSize() }
    }

    private fun metricsSize(): Pair<Int, Int> =
        ctx.resources.displayMetrics.let { Pair(it.widthPixels, it.heightPixels) }

    private fun detach(v: View) {
        try { if (v.isAttachedToWindow) wm.removeView(v) } catch (_: Exception) { }
    }

    private fun overlayParams(w: Int, h: Int) = WindowManager.LayoutParams(
        w, h,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.START }
}
