package com.tms.terminal

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.view.KeyEvent
import android.view.WindowManager
import com.tms.terminal.prayer.AdhanCallView
import com.tms.terminal.prayer.AdhanOverlay
import com.tms.terminal.prayer.AdhanRingService
import com.tms.terminal.prayer.AdhanSession

/**
 * Gebetsruf über dem Sperrbildschirm — ohne Entsperren (wie ein Anruf).
 * Den Ton und die Entscheidung hält AdhanRingService; dieses Fenster zeigt nur.
 * Zurück tut nichts; Lautstärketasten = Stumm; die Sperrtaste fängt der Dienst.
 * Verlässt man es entsperrt (Home-Geste), liegt sofort die Überlagerung darüber.
 */
class AdhanFullscreenActivity : Activity() {
    private val onChange: () -> Unit = { runOnUiThread { render() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        @Suppress("DEPRECATION")
        window.addFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        )
        AdhanSession.addListener(onChange)
        render()
    }

    private fun render() {
        if (!AdhanSession.active) { finish(); return }
        setContentView(AdhanCallView.create(this,
            onLoud = { AdhanRingService.send(this, AdhanRingService.ACTION_LOUD) },
            onSilence = { AdhanRingService.send(this, AdhanRingService.ACTION_SILENCE) }))
    }

    override fun onResume() {
        super.onResume()
        AdhanSession.visibleUis++
        if (!AdhanSession.active) finish()
    }

    override fun onPause() {
        AdhanSession.visibleUis = (AdhanSession.visibleUis - 1).coerceAtLeast(0)
        super.onPause()
    }

    override fun onStop() {
        super.onStop()
        // Entsperrt weggewischt, während es noch läuft: über allem weiter.
        val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (AdhanSession.active && !isFinishing && pm.isInteractive && !km.isKeyguardLocked) {
            AdhanOverlay.show(this)
        }
    }

    override fun onDestroy() {
        AdhanSession.removeListener(onChange)
        super.onDestroy()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_MUTE) {
            AdhanRingService.send(this, AdhanRingService.ACTION_SILENCE)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    @Deprecated("Zurück schließt den Gebetsruf nicht")
    override fun onBackPressed() { /* bewusst nichts */ }
}
