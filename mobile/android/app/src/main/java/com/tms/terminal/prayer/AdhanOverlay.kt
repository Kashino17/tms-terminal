package com.tms.terminal.prayer

import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager

/**
 * Entsperrtes Handy: der Gebetsruf liegt als Fenster ÜBER allem (jede App,
 * auch der Startbildschirm nach der Home-Geste) — wie ein eingehender Anruf,
 * nur ohne dass man ihn wegwischen kann. Weg nur über „Stumm“/„Laut→Beenden“,
 * Sperrtaste oder Lautstärketasten. Braucht „Über anderen Apps einblenden“.
 */
object AdhanOverlay {
    private val main = Handler(Looper.getMainLooper())
    private var view: View? = null
    private var wm: WindowManager? = null
    private val onChange: () -> Unit = { main.post { refresh() } }
    private var appContext: Context? = null

    val showing: Boolean get() = view != null

    fun allowed(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)

    fun show(context: Context) = main.post {
        if (!AdhanSession.active || view != null || !allowed(context)) return@post
        val app = context.applicationContext
        appContext = app
        val w = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                   else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, type,
            // Fokussierbar (kein FLAG_NOT_FOCUSABLE): nimmt Tasten an und sperrt
            // die App darunter, bis der Gebetsruf beendet ist.
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.OPAQUE,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        val v = build(app)
        try {
            w.addView(v, lp)
            wm = w
            view = v
            AdhanSession.visibleUis++
            AdhanSession.addListener(onChange)
            v.requestFocus()
        } catch (_: Exception) { /* keine Berechtigung mehr — dann nur die Benachrichtigung */ }
    }

    fun hide() = main.post {
        val v = view ?: return@post
        AdhanSession.removeListener(onChange)
        try { wm?.removeViewImmediate(v) } catch (_: Exception) {}
        view = null
        AdhanSession.visibleUis = (AdhanSession.visibleUis - 1).coerceAtLeast(0)
    }

    /** Stand geändert (Klingeln → Azān läuft, oder vorbei). */
    private fun refresh() {
        val v = view ?: return
        if (!AdhanSession.active) { hide(); return }
        val app = appContext ?: return
        val nv = build(app)
        try {
            val lp = v.layoutParams
            wm?.removeViewImmediate(v)
            wm?.addView(nv, lp)
            view = nv
            nv.requestFocus()
        } catch (_: Exception) {}
    }

    private fun build(app: Context): View {
        val v = AdhanCallView.create(app,
            onLoud = { AdhanRingService.send(app, AdhanRingService.ACTION_LOUD) },
            onSilence = { AdhanRingService.send(app, AdhanRingService.ACTION_SILENCE) })
        v.isFocusable = true
        v.isFocusableInTouchMode = true
        v.setOnKeyListener { _, code, ev ->
            when (code) {
                KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN, KeyEvent.KEYCODE_VOLUME_MUTE -> {
                    if (ev.action == KeyEvent.ACTION_DOWN) AdhanRingService.send(app, AdhanRingService.ACTION_SILENCE)
                    true
                }
                KeyEvent.KEYCODE_BACK -> true // Zurück tut nichts
                else -> false
            }
        }
        return v
    }
}
