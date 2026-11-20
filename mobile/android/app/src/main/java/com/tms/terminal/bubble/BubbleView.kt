package com.tms.terminal.bubble

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PathMeasure
import android.graphics.RectF
import android.graphics.Typeface
import android.view.View
import android.view.animation.DecelerateInterpolator
import android.view.animation.PathInterpolator
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * The whole bubble, drawn in one view so state changes are animations, not
 * layout jumps. The view is always exactly as wide as what it draws; the
 * overlay resizes its window every frame of a morph ([onWidthChanged]).
 *
 *   IDLE        ●  three soft bars
 *   RECORDING   ( ✕  ▁▃▆▃▂▅▇▄▂  0:07  ◉✓ )   live waveform from the mic
 *   PROCESSING  ●  thin arc spinning around the rim
 *   result      ●  check / clipboard glyph drawn in, or a short shake
 */
class BubbleView(context: Context) : View(context) {

    enum class Face { IDLE, RECORDING, PROCESSING }
    enum class Result { INSERTED, CLIPBOARD, ERROR }

    private val density = resources.displayMetrics.density
    private fun dp(v: Float) = v * density

    val diameter = dp(46f)
    val pillWidth = dp(204f)

    /**
     * Called once a morph has settled (circle or pill). The window keeps the
     * full pill width WHILE morphing — resizing it per frame lagged the view
     * by one frame, and the content slid over the screen edge.
     */
    var onMorphSettled: ((Int) -> Unit)? = null

    /** The shape is pinned to this side of the view (the bubble's screen side). */
    var anchorRight = true

    var face = Face.IDLE
        private set

    // ── animated values ────────────────────────────────────────────────
    private var morph = 0f          // 0 = circle, 1 = pill
    private var content = 0f        // recording contents fade
    private var spin = 0f           // processing arc angle
    private var spinAlpha = 0f
    private var resultProgress = 0f // glyph draw-in
    private var resultKind: Result? = null
    private var shake = 0f
    private var press = 1f
    private var phase = 0f          // idle/processing breathing

    private var morphAnim: ValueAnimator? = null
    private var contentAnim: ValueAnimator? = null
    private var spinAnim: ValueAnimator? = null
    private var resultAnim: ValueAnimator? = null
    private var frameAnim: ValueAnimator? = null

    // ── waveform ───────────────────────────────────────────────────────
    private val bars = 22
    private val history = FloatArray(bars)
    private var head = 0
    private var lastPush = 0L
    private var level = 0f
    var elapsedText = "0:00"

    // ── paints ─────────────────────────────────────────────────────────
    private val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(224, 18, 18, 24) }
    private val rim = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeWidth = dp(1f); color = Color.argb(34, 255, 255, 255)
    }
    private val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; strokeCap = Paint.Cap.ROUND }
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; color = Color.WHITE
    }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(150, 255, 255, 255); textSize = dp(11.5f)
        typeface = Typeface.create(Typeface.MONOSPACE, Typeface.NORMAL)
    }
    private val confirmFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val rect = RectF()
    private val path = Path()
    private val segment = Path()

    private val ease = PathInterpolator(0.2f, 0f, 0f, 1f)          // standard emphasized
    private val spring = PathInterpolator(0.34f, 1.36f, 0.64f, 1f)  // gentle overshoot

    // ── public API ─────────────────────────────────────────────────────
    fun currentWidth(): Int = (diameter + (pillWidth - diameter) * morph).toInt()

    /** Jump straight to a face's resting look (used when another view hands over). */
    fun snapTo(f: Face, spinAngle: Float) {
        listOf(morphAnim, contentAnim, spinAnim).forEach { it?.cancel() }
        face = f
        morph = if (f == Face.RECORDING) 1f else 0f
        content = morph
        spinAlpha = if (f == Face.PROCESSING) 1f else 0f
        spin = spinAngle
        ensureFrames()
        invalidate()
    }

    val spinAngle: Float get() = spin

    fun setFace(f: Face) {
        if (f == face) return
        val from = face
        face = f
        when (f) {
            Face.RECORDING -> {
                history.fill(0f); level = 0f; elapsedText = "0:00"
                resultKind = null
                stopSpin()
                animateMorph(1f, 340, spring)
                animateContent(1f, 220, delay = 110)
            }
            Face.PROCESSING -> {
                animateContent(0f, 120)
                animateMorph(0f, 300, ease)
                startSpin()
            }
            Face.IDLE -> {
                if (from == Face.RECORDING) { animateContent(0f, 120); animateMorph(0f, 280, ease) }
                stopSpin()
            }
        }
        ensureFrames()
    }

    fun setLevel(fraction: Float) {
        level = fraction.coerceIn(0f, 1f)
        val now = System.currentTimeMillis()
        if (now - lastPush >= 90) {
            // Perceptual curve: quiet speech still moves the bars.
            history[head] = Math.pow(level.toDouble(), 0.6).toFloat()
            head = (head + 1) % bars
            lastPush = now
        }
    }

    fun showResult(kind: Result) {
        resultKind = kind
        resultAnim?.cancel()
        if (kind == Result.ERROR) {
            resultAnim = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = 420
                addUpdateListener {
                    val t = it.animatedFraction
                    shake = sin(t * Math.PI * 6).toFloat() * dp(5f) * (1 - t)
                    invalidate()
                }
                start()
            }
            return
        }
        resultAnim = ValueAnimator.ofFloat(0f, 1f, 1f, 0f).apply {
            duration = 1500
            interpolator = DecelerateInterpolator()
            addUpdateListener { resultProgress = it.animatedValue as Float; invalidate() }
            start()
        }
    }

    fun pressAnim(down: Boolean) {
        ValueAnimator.ofFloat(press, if (down) 0.92f else 1f).apply {
            duration = if (down) 90 else 220
            interpolator = if (down) ease else spring
            addUpdateListener { press = it.animatedValue as Float; invalidate() }
            start()
        }
    }

    /** Which control a tap at [x] hits in the recording pill. */
    fun hitInPill(x: Float): Int {
        val w = currentWidth().toFloat()
        val lx = x - originX(w)
        return when {
            lx < 0f || lx > w -> 0
            lx < diameter -> -1             // ✕
            lx > w - diameter -> 1          // ✓
            else -> 0
        }
    }

    private fun originX(drawW: Float) = if (anchorRight) width - drawW else 0f

    fun release() {
        listOf(morphAnim, contentAnim, spinAnim, resultAnim, frameAnim).forEach { it?.cancel() }
    }

    // ── animation plumbing ─────────────────────────────────────────────
    private fun animateMorph(to: Float, ms: Long, interp: android.animation.TimeInterpolator) {
        morphAnim?.cancel()
        morphAnim = ValueAnimator.ofFloat(morph, to).apply {
            duration = ms; interpolator = interp
            addUpdateListener {
                morph = (it.animatedValue as Float).coerceAtLeast(0f)
                invalidate()
            }
            addListener(object : android.animation.AnimatorListenerAdapter() {
                override fun onAnimationEnd(a: android.animation.Animator) {
                    if (morphAnim === a) onMorphSettled?.invoke(currentWidth())
                }
            })
            start()
        }
    }

    private fun animateContent(to: Float, ms: Long, delay: Long = 0) {
        contentAnim?.cancel()
        contentAnim = ValueAnimator.ofFloat(content, to).apply {
            duration = ms; startDelay = delay
            addUpdateListener { content = it.animatedValue as Float; invalidate() }
            start()
        }
    }

    private fun startSpin() {
        spinAnim?.cancel()
        spinAnim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 260
            addUpdateListener { spinAlpha = it.animatedValue as Float }
            start()
        }
    }

    private fun stopSpin() {
        spinAnim?.cancel()
        spinAnim = ValueAnimator.ofFloat(spinAlpha, 0f).apply {
            duration = 180
            addUpdateListener { spinAlpha = it.animatedValue as Float; invalidate() }
            start()
        }
    }

    private fun needsFrames() =
        BubbleRules.needsFrameClock(face == Face.RECORDING, face == Face.PROCESSING, spinAlpha)

    /**
     * One frame clock for spin, breathing and the scrolling waveform. It stops
     * itself as soon as nothing moves any more (see BubbleRules.needsFrameClock):
     * left running, an idle bubble redrew at the full display rate for as long
     * as it was on screen.
     */
    private fun ensureFrames() {
        if (!needsFrames()) return
        if (frameAnim?.isRunning == true) return
        frameAnim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 1000
            repeatCount = ValueAnimator.INFINITE
            addUpdateListener {
                if (!needsFrames()) {
                    // Not from inside the update callback: cancel on the next loop turn.
                    post { if (!needsFrames()) { frameAnim?.cancel(); frameAnim = null } }
                    return@addUpdateListener
                }
                spin = (spin + 6.5f) % 360f
                phase += 0.06f
                invalidate()
            }
            start()
        }
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        release()
    }

    // ── drawing ────────────────────────────────────────────────────────
    override fun onDraw(c: Canvas) {
        val w = currentWidth().toFloat().coerceAtMost(width.toFloat())
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return
        c.save()
        c.translate(originX(w) + shake, 0f)
        c.scale(press, press, w / 2, h / 2)

        // Body: circle that stretches into a pill.
        val r = h / 2
        rect.set(dp(0.5f), dp(0.5f), w - dp(0.5f), h - dp(0.5f))
        c.drawRoundRect(rect, r, r, bg)
        c.drawRoundRect(rect, r, r, rim)

        val cx = w / 2
        val cy = h / 2
        val circleContent = 1f - content

        // Idle / processing glyph: three soft bars (they breathe while processing).
        val glyphAlpha = if (resultKind != null && resultKind != Result.ERROR) (1f - resultProgress) else 1f
        if (circleContent > 0.01f && morph < 0.6f) {
            val a = (circleContent * glyphAlpha * (1f - morph / 0.6f)).coerceIn(0f, 1f)
            ink.alpha = (a * 235).toInt()
            ink.strokeWidth = dp(3f)
            val heights = floatArrayOf(9f, 17f, 11f)
            for (i in 0..2) {
                val breathe = if (face == Face.PROCESSING) 0.55f + 0.45f * sin(phase * 2.2f + i * 1.1f).toFloat().let { (it + 1f) / 2f } else 1f
                val bh = dp(heights[i]) * breathe
                val x = cx + (i - 1) * dp(6.5f)
                c.drawLine(x, cy - bh / 2, x, cy + bh / 2, ink)
            }
        }

        // Processing: thin arc spinning just inside the rim.
        if (spinAlpha > 0.01f) {
            line.strokeWidth = dp(1.6f)
            line.alpha = (spinAlpha * 220).toInt()
            val inset = dp(4f)
            rect.set(cx - r + inset, cy - r + inset, cx + r - inset, cy + r - inset)
            c.drawArc(rect, spin, 92f, false, line)
            line.alpha = (spinAlpha * 60).toInt()
            c.drawArc(rect, spin + 180f, 40f, false, line)
        }

        // Result glyph drawn in the circle.
        val kind = resultKind
        if (kind != null && kind != Result.ERROR && resultProgress > 0f && morph < 0.2f) {
            line.strokeWidth = dp(2.2f)
            line.alpha = (min(1f, resultProgress * 1.6f) * 255).toInt()
            path.reset()
            if (kind == Result.INSERTED) {
                path.moveTo(cx - dp(7f), cy + dp(0.5f))
                path.lineTo(cx - dp(2f), cy + dp(5.5f))
                path.lineTo(cx + dp(8f), cy - dp(5.5f))
            } else {
                // Clipboard: board + clip.
                path.addRoundRect(RectF(cx - dp(6.5f), cy - dp(6f), cx + dp(6.5f), cy + dp(8f)), dp(2f), dp(2f), Path.Direction.CW)
                path.moveTo(cx - dp(3f), cy - dp(6f)); path.lineTo(cx - dp(3f), cy - dp(8.5f))
                path.lineTo(cx + dp(3f), cy - dp(8.5f)); path.lineTo(cx + dp(3f), cy - dp(6f))
            }
            drawTrimmed(c, path, min(1f, resultProgress * 1.4f))
        }

        // Recording pill contents.
        if (content > 0.01f && morph > 0.5f) {
            val a = content
            // ✕
            line.strokeWidth = dp(1.8f)
            line.alpha = (a * 150).toInt()
            val xL = r
            val s = dp(5f)
            c.drawLine(xL - s, cy - s, xL + s, cy + s, line)
            c.drawLine(xL - s, cy + s, xL + s, cy - s, line)

            // ✓ button: white disc with a dark check.
            val xR = w - r
            confirmFill.alpha = (a * 255).toInt()
            c.drawCircle(xR, cy, dp(16f), confirmFill)
            line.color = Color.rgb(18, 18, 24)
            line.alpha = (a * 255).toInt()
            line.strokeWidth = dp(2.2f)
            path.reset()
            path.moveTo(xR - dp(6f), cy + dp(0.5f)); path.lineTo(xR - dp(1.8f), cy + dp(4.6f)); path.lineTo(xR + dp(6.5f), cy - dp(4.5f))
            c.drawPath(path, line)
            line.color = Color.WHITE

            // Timer, right-aligned before the ✓.
            text.alpha = (a * 150).toInt()
            val tw = text.measureText(elapsedText)
            val timerRight = xR - dp(16f) - dp(10f)
            c.drawText(elapsedText, timerRight - tw, cy + dp(4f), text)

            // Waveform: newest bar on the right, scrolling left.
            val left = xL + s + dp(12f)
            val right = timerRight - tw - dp(10f)
            val span = max(0f, right - left)
            val step = span / bars
            ink.strokeWidth = min(dp(2.4f), step * 0.55f)
            for (i in 0 until bars) {
                val v = history[(head + i) % bars]
                val bh = dp(3f) + v * (h * 0.52f)
                val x = left + step * (i + 0.5f)
                // Fade the oldest bars in from the left.
                val edge = min(1f, (i + 1) / 5f)
                ink.alpha = (a * edge * 235).toInt()
                c.drawLine(x, cy - bh / 2, x, cy + bh / 2, ink)
            }
        }
        c.restore()
    }

    private fun drawTrimmed(c: Canvas, p: Path, t: Float) {
        val pm = PathMeasure(p, false)
        do {
            segment.reset()
            pm.getSegment(0f, pm.length * t, segment, true)
            c.drawPath(segment, line)
        } while (pm.nextContour())
    }
}
