package com.tms.terminal

import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
// SQLite for reading AsyncStorage
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.TypedValue
import android.view.Gravity
import android.view.WindowManager
import android.os.Handler
import android.os.Looper
import android.widget.*
import androidx.appcompat.app.AppCompatActivity

class AdhanFullscreenActivity : AppCompatActivity() {

    private var vibrator: Vibrator? = null
    private var mediaPlayer: MediaPlayer? = null

    // Map prayer names to background drawable resources
    private val backgrounds = mapOf(
        "Fajr" to R.drawable.adhan_fajr,
        "Sunrise" to R.drawable.adhan_sunrise,
        "Dhuhr" to R.drawable.adhan_dhuhr,
        "Asr" to R.drawable.adhan_asr,
        "Maghrib" to R.drawable.adhan_maghrib,
        "Isha" to R.drawable.adhan_isha,
    )

    // Map adhan selection IDs to raw audio resources
    private val adhanAudio = mapOf(
        "mishary" to R.raw.mishary_alafasy,
        "nafees" to R.raw.ahmad_nafees,
        "mansour" to R.raw.mansour_zahrani,
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Show over lockscreen
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            km.requestDismissKeyguard(this, null)
        }
        @Suppress("DEPRECATION")
        window.addFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
            WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD or
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        )

        val prayerName = intent.getStringExtra("prayerName") ?: "Asr"
        val prayerTime = intent.getStringExtra("prayerTime") ?: ""
        val prayerArabic = intent.getStringExtra("prayerArabic") ?: ""
        val isWecker = intent.getBooleanExtra("wecker", false)

        // Start vibration
        vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        // Repeating vibration pattern until user dismisses (repeat from index 0)
        val pattern = longArrayOf(0, 500, 300, 500, 300, 500, 1000)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0)) // 0 = repeat from start
        } else {
            @Suppress("DEPRECATION")
            vibrator?.vibrate(pattern, 0)
        }

        // Auto-dismiss after 5 minutes if user doesn't interact
        Handler(Looper.getMainLooper()).postDelayed({
            if (!isFinishing) {
                dismissAlert()
            }
        }, 5 * 60 * 1000)

        // ── Build UI ────────────────────────────────────────────────────────
        val root = FrameLayout(this)

        // Background image
        val bgImage = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            val bgRes = backgrounds[prayerName] ?: R.drawable.adhan_asr
            setImageResource(bgRes)
        }
        root.addView(bgImage, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))

        // Dark gradient overlay (bottom heavy for text readability)
        val overlay = ImageView(this).apply {
            background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(
                    Color.parseColor("#40000000"),
                    Color.parseColor("#80000000"),
                    Color.parseColor("#CC000000"),
                    Color.parseColor("#F0000000"),
                )
            )
        }
        root.addView(overlay, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))

        // Content
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM
            setPadding(dp(32), dp(40), dp(32), dp(48))
        }

        // Top label
        val label = TextView(this).apply {
            text = "GEBETSZEIT"
            setTextColor(Color.parseColor("#A0FFFFFF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
            letterSpacing = 0.25f
        }
        content.addView(label, lp().apply { topMargin = dp(0); bottomMargin = dp(80) })

        // Spacer to push content down
        val spacer = android.widget.Space(this)
        content.addView(spacer, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
        ))

        // Prayer name (large)
        val name = TextView(this).apply {
            text = prayerName
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 38f)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
            setShadowLayer(8f, 0f, 2f, Color.parseColor("#80000000"))
        }
        content.addView(name, lp().apply { bottomMargin = dp(4) })

        // Arabic name
        val arabic = TextView(this).apply {
            text = prayerArabic
            setTextColor(Color.parseColor("#B0FFFFFF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            gravity = Gravity.CENTER
        }
        content.addView(arabic, lp().apply { bottomMargin = dp(12) })

        // Time (big, monospace)
        val time = TextView(this).apply {
            text = prayerTime
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 48f)
            typeface = Typeface.create("monospace", Typeface.BOLD)
            gravity = Gravity.CENTER
            setShadowLayer(12f, 0f, 3f, Color.parseColor("#80000000"))
        }
        content.addView(time, lp().apply { bottomMargin = dp(40) })

        if (isWecker) {
            // Wecker mode: no buttons, play adhan immediately, finish when done
            vibrator?.cancel()
            cancelNotification()
            val selectedId = readSelectedAdhanId()
            val audioRes = adhanAudio[selectedId] ?: adhanAudio["mishary"]
            try {
                if (audioRes != null) {
                    mediaPlayer = MediaPlayer.create(this, audioRes)
                    mediaPlayer?.setOnCompletionListener {
                        it.release()
                        mediaPlayer = null
                        finish()
                    }
                    mediaPlayer?.start()
                }
            } catch (_: Exception) {
                finish()
            }
        } else {
            // Normal mode: show Stumm/Laut buttons
            val btnRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
            }

            val silentBg = GradientDrawable().apply {
                setColor(Color.parseColor("#80000000"))
                cornerRadius = dp(20).toFloat()
                setStroke(dp(1), Color.parseColor("#40FFFFFF"))
            }
            val silentBtn = Button(this).apply {
                text = "🔇  Stumm"
                setTextColor(Color.parseColor("#CCFFFFFF"))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                background = silentBg
                isAllCaps = false
                setPadding(dp(16), dp(16), dp(16), dp(16))
                setOnClickListener { dismissAlert() }
            }
            btnRow.addView(silentBtn, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = dp(8)
            })

            val loudBg = GradientDrawable().apply {
                setColor(Color.parseColor("#10B981"))
                cornerRadius = dp(20).toFloat()
            }
            val loudBtn = Button(this).apply {
                text = "🔊  Laut"
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                background = loudBg
                isAllCaps = false
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                setPadding(dp(16), dp(16), dp(16), dp(16))
                setOnClickListener { playAdhanAndDismiss() }
            }
            btnRow.addView(loudBtn, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(8)
            })

            content.addView(btnRow, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ))
        }

        root.addView(content, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))

        setContentView(root)
    }

    private fun readSelectedAdhanId(): String {
        var selectedId = "mishary"
        try {
            val db = android.database.sqlite.SQLiteDatabase.openDatabase(
                applicationContext.getDatabasePath("RKStorage").absolutePath,
                null, android.database.sqlite.SQLiteDatabase.OPEN_READONLY
            )
            val cursor = db.rawQuery(
                "SELECT value FROM catalystLocalStorage WHERE key = ?",
                arrayOf("tms-adhan-selected")
            )
            if (cursor.moveToFirst()) {
                val value = cursor.getString(0)
                selectedId = value.replace("\"", "").trim()
            }
            cursor.close()
            db.close()
        } catch (_: Exception) {
            selectedId = "mishary"
        }
        return selectedId
    }

    private fun playAdhanAndDismiss() {
        vibrator?.cancel()
        cancelNotification()

        val selectedId = readSelectedAdhanId()
        val audioRes = adhanAudio[selectedId] ?: adhanAudio["mishary"]
        try {
            if (audioRes != null) {
                mediaPlayer = MediaPlayer.create(this, audioRes)
                mediaPlayer?.setOnCompletionListener {
                    it.release()
                    mediaPlayer = null
                }
                mediaPlayer?.start()
            }
        } catch (_: Exception) {}

        // Close the fullscreen activity — audio continues playing in background
        finish()
    }

    private fun dismissAlert() {
        vibrator?.cancel()
        cancelNotification()
        finish()
    }

    private fun cancelNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(9999)
    }

    override fun onDestroy() {
        vibrator?.cancel()
        // DON'T stop mediaPlayer here — let it play in background
        super.onDestroy()
    }

    override fun onBackPressed() {
        dismissAlert()
    }

    private fun dp(value: Int): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics
        ).toInt()
    }

    private fun lp() = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
    )
}
