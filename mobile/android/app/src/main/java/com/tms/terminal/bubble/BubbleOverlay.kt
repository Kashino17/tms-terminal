package com.tms.terminal.bubble

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.tms.terminal.R
import kotlin.math.abs
import kotlin.math.hypot

/**
 * The floating UI: a small translucent bubble, the recording pill
 * (✕ · level · time · ✓), a short toast, and the sleep target at the bottom.
 * All windows are TYPE_ACCESSIBILITY_OVERLAY + NOT_FOCUSABLE, so the text
 * field keeps the input focus while the user dictates.
 */
class BubbleOverlay(
    private val ctx: Context,
    private val config: BubbleConfig,
    private val callbacks: Callbacks,
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

    var mode = Mode.HIDDEN
        private set

    // ── views ───────────────────────────────────────────────────────────
    private val root = FrameLayout(ctx)
    private val bubble = FrameLayout(ctx).apply {
        background = pill(Color.argb(200, 28, 28, 36), dp(16).toFloat(), Color.argb(60, 255, 255, 255))
        addView(ImageView(ctx).apply {
            setImageResource(R.drawable.bubble_wave)
            imageTintList = ColorStateList.valueOf(Color.argb(235, 255, 255, 255))
        }, FrameLayout.LayoutParams(dp(26), dp(26), Gravity.CENTER))
        alpha = 0.9f
    }
    private val level = LevelView(ctx)
    private val timer = TextView(ctx).apply {
        setTextColor(Color.WHITE); textSize = 13f; text = "0:00"
        setPadding(dp(6), 0, dp(6), 0)
    }
    private val cancelBtn = roundButton("✕", Color.argb(70, 255, 255, 255)) { callbacks.onCancel() }
    private val confirmBtn = roundButton("✓", Color.rgb(76, 141, 255)) { callbacks.onConfirm() }
    private val spinner = ProgressBar(ctx).apply {
        isIndeterminate = true
        indeterminateTintList = ColorStateList.valueOf(Color.WHITE)
        visibility = View.GONE
    }
    private val panel = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        background = pill(Color.argb(235, 24, 24, 30), dp(26).toFloat(), Color.argb(50, 255, 255, 255))
        setPadding(dp(6), dp(6), dp(6), dp(6))
        addView(cancelBtn, LinearLayout.LayoutParams(dp(40), dp(40)))
        addView(level, LinearLayout.LayoutParams(dp(54), dp(28)).apply { leftMargin = dp(8) })
        addView(timer)
        addView(spinner, LinearLayout.LayoutParams(dp(28), dp(28)).apply { rightMargin = dp(6) })
        addView(confirmBtn, LinearLayout.LayoutParams(dp(40), dp(40)))
    }
    private val toast = TextView(ctx).apply {
        setTextColor(Color.WHITE); textSize = 13f
        background = pill(Color.argb(235, 24, 24, 30), dp(14).toFloat(), Color.argb(50, 255, 255, 255))
        setPadding(dp(14), dp(9), dp(14), dp(9))
    }
    private val sleepTarget = TextView(ctx).apply {
        text = "Zz"; textSize = 20f; gravity = Gravity.CENTER
        setTextColor(Color.WHITE)
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.argb(150, 20, 20, 26)); setStroke(dp(2), Color.argb(170, 255, 255, 255))
        }
    }

    private val params = overlayParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT)
    private val toastParams = overlayParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT).apply {
        flags = flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    }
    private val sleepParams = overlayParams(dp(72), dp(72)).apply {
        flags = flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    }
    private var rootAttached = false
    private var toastAttached = false
    private var sleepAttached = false

    init {
        setupBubbleTouch()
    }

    // ── public API ──────────────────────────────────────────────────────
    fun show(newMode: Mode) {
        if (newMode == mode) return
        mode = newMode
        if (newMode == Mode.HIDDEN) { detach(root); rootAttached = false; hideSleepTarget(); return }
        root.removeAllViews()
        when (newMode) {
            Mode.BUBBLE -> root.addView(bubble, FrameLayout.LayoutParams(dp(52), dp(52)))
            Mode.RECORDING, Mode.PROCESSING -> {
                val processing = newMode == Mode.PROCESSING
                spinner.visibility = if (processing) View.VISIBLE else View.GONE
                confirmBtn.visibility = if (processing) View.GONE else View.VISIBLE
                level.visibility = if (processing) View.GONE else View.VISIBLE
                if (processing) timer.text = "Transkribiere…"
                root.addView(panel)
            }
            else -> {}
        }
        if (!rootAttached) {
            placeFromConfig()
            wm.addView(root, params)
            rootAttached = true
        } else {
            wm.updateViewLayout(root, params)
        }
        root.post { clampIntoScreen() }
    }

    fun setLevel(fraction: Float) = level.setLevel(fraction)

    fun setElapsed(ms: Long) {
        if (mode != Mode.RECORDING) return
        val s = ms / 1000
        timer.text = "%d:%02d".format(s / 60, s % 60)
    }

    fun toast(message: String) {
        toast.text = message
        val screen = ctx.resources.displayMetrics
        toastParams.x = 0
        toastParams.y = (params.y - dp(56)).coerceAtLeast(dp(24))
        toastParams.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
        if (!toastAttached) { wm.addView(toast, toastParams); toastAttached = true } else wm.updateViewLayout(toast, toastParams)
        main.removeCallbacks(hideToast)
        main.postDelayed(hideToast, if (message.length > 40) 3200 else 1900)
        if (screen.heightPixels <= 0) return
    }

    fun destroy() {
        main.removeCallbacksAndMessages(null)
        detach(root); detach(toast); detach(sleepTarget)
        rootAttached = false; toastAttached = false; sleepAttached = false
        mode = Mode.HIDDEN
    }

    // ── gestures: tap = record, drag = move, hold = sleep ──────────────
    @SuppressLint("ClickableViewAccessibility")
    private fun setupBubbleTouch() {
        val slop = ViewConfiguration.get(ctx).scaledTouchSlop
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0
        var dragging = false; var held = false
        val hold = Runnable {
            held = true
            bubble.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            showSleepTarget()
        }
        bubble.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startX = params.x; startY = params.y
                    dragging = false; held = false
                    main.postDelayed(hold, 450)
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (!dragging && hypot(dx, dy) > slop) {
                        dragging = true
                        main.removeCallbacks(hold)
                        showSleepTarget()
                    }
                    if (dragging) {
                        params.x = startX + dx.toInt(); params.y = startY + dy.toInt()
                        wm.updateViewLayout(root, params)
                        sleepTarget.alpha = if (overSleepTarget()) 1f else 0.55f
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    main.removeCallbacks(hold)
                    val sleep = (held && !dragging) || (dragging && overSleepTarget())
                    hideSleepTarget()
                    when {
                        e.actionMasked == MotionEvent.ACTION_CANCEL -> {}
                        sleep -> { params.x = startX; params.y = startY; callbacks.onSnooze() }
                        dragging -> { clampIntoScreen(); config.x = params.x; config.y = params.y }
                        else -> callbacks.onTap()
                    }
                }
            }
            true
        }
    }

    private fun showSleepTarget() {
        val m = ctx.resources.displayMetrics
        sleepParams.gravity = Gravity.TOP or Gravity.START
        sleepParams.x = m.widthPixels / 2 - dp(36)
        sleepParams.y = m.heightPixels - dp(150)
        sleepTarget.alpha = 0.55f
        if (!sleepAttached) { wm.addView(sleepTarget, sleepParams); sleepAttached = true }
    }

    private fun hideSleepTarget() {
        if (sleepAttached) { detach(sleepTarget); sleepAttached = false }
    }

    private fun overSleepTarget(): Boolean {
        val cx = params.x + root.width / 2f; val cy = params.y + root.height / 2f
        val tx = sleepParams.x + dp(36).toFloat(); val ty = sleepParams.y + dp(36).toFloat()
        return abs(cx - tx) < dp(60) && abs(cy - ty) < dp(60)
    }

    // ── helpers ─────────────────────────────────────────────────────────
    private val hideToast = Runnable { if (toastAttached) { detach(toast); toastAttached = false } }

    private fun placeFromConfig() {
        val m = ctx.resources.displayMetrics
        params.gravity = Gravity.TOP or Gravity.START
        params.x = if (config.x >= 0) config.x else m.widthPixels - dp(52) - dp(12)
        params.y = if (config.y >= 0) config.y else (m.heightPixels * 0.42f).toInt()
    }

    private fun clampIntoScreen() {
        if (!rootAttached) return
        val m = ctx.resources.displayMetrics
        val w = root.width.takeIf { it > 0 } ?: dp(52)
        val h = root.height.takeIf { it > 0 } ?: dp(52)
        params.x = params.x.coerceIn(0, (m.widthPixels - w).coerceAtLeast(0))
        params.y = params.y.coerceIn(dp(24), (m.heightPixels - h - dp(24)).coerceAtLeast(dp(24)))
        wm.updateViewLayout(root, params)
    }

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

    private fun pill(fill: Int, radius: Float, stroke: Int) = GradientDrawable().apply {
        setColor(fill); cornerRadius = radius; setStroke(dp(1), stroke)
    }

    private fun roundButton(label: String, fill: Int, onClick: () -> Unit) = TextView(ctx).apply {
        text = label; textSize = 18f; gravity = Gravity.CENTER; setTextColor(Color.WHITE)
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(fill) }
        setOnClickListener { onClick() }
    }

    /** Five bars that follow the microphone level. */
    private class LevelView(ctx: Context) : View(ctx) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
        private val shape = floatArrayOf(0.45f, 0.8f, 1f, 0.7f, 0.5f)
        private var level = 0f
        private val rect = RectF()
        fun setLevel(f: Float) { level = level * 0.5f + f.coerceIn(0f, 1f) * 0.5f; invalidate() }
        override fun onDraw(c: Canvas) {
            val n = shape.size
            val gap = width / (n * 2f)
            val bw = gap
            for (i in 0 until n) {
                val h = height * (0.18f + 0.82f * level * shape[i])
                val x = gap / 2 + i * 2 * gap
                rect.set(x, (height - h) / 2, x + bw, (height + h) / 2)
                c.drawRoundRect(rect, bw / 2, bw / 2, paint)
            }
        }
    }
}
