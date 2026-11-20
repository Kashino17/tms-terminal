package com.tms.terminal.prayer

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.tms.terminal.R
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Die Anruf-Oberfläche des Gebetsrufs — dieselbe im Vollbild (Sperrbildschirm)
 * und in der Überlagerung (entsperrt). Klingeln: „Stumm“ / „Laut“. Läuft der
 * Azān: nur „Beenden“. Sperrtaste und Lautstärketasten = Stumm (wie ein Anruf).
 */
object AdhanCallView {
    private val backgrounds = mapOf(
        "Fajr" to R.drawable.adhan_fajr, "Sunrise" to R.drawable.adhan_sunrise, "Dhuhr" to R.drawable.adhan_dhuhr,
        "Asr" to R.drawable.adhan_asr, "Maghrib" to R.drawable.adhan_maghrib, "Isha" to R.drawable.adhan_isha,
    )

    fun create(context: Context, onLoud: () -> Unit, onSilence: () -> Unit): View {
        val info = AdhanSession.info
        val phase = AdhanSession.phase
        val name = info?.name ?: "Gebet"
        fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), context.resources.displayMetrics).toInt()
        fun lp() = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

        val root = FrameLayout(context)
        root.setBackgroundColor(Color.BLACK)
        root.addView(ImageView(context).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            setImageResource(backgrounds[name] ?: R.drawable.adhan_asr)
        }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        root.addView(View(context).apply {
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(
                Color.parseColor("#40000000"), Color.parseColor("#80000000"),
                Color.parseColor("#CC000000"), Color.parseColor("#F0000000")))
        }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

        val content = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM
            setPadding(dp(32), dp(56), dp(32), dp(56))
        }
        content.addView(TextView(context).apply {
            text = if (phase == AdhanSession.Phase.PLAYING) "AZĀN" else "GEBETSZEIT"
            setTextColor(Color.parseColor("#A0FFFFFF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
            letterSpacing = 0.25f
        }, lp())
        content.addView(android.widget.Space(context), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        content.addView(TextView(context).apply {
            text = name
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 40f)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
            setShadowLayer(8f, 0f, 2f, Color.parseColor("#80000000"))
        }, lp().apply { bottomMargin = dp(4) })
        content.addView(TextView(context).apply {
            text = info?.arabic ?: ""
            setTextColor(Color.parseColor("#B0FFFFFF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
            gravity = Gravity.CENTER
        }, lp().apply { bottomMargin = dp(12) })
        content.addView(TextView(context).apply {
            text = if (info != null) SimpleDateFormat("HH:mm", Locale.GERMANY).format(Date(info.at)) else ""
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 52f)
            typeface = Typeface.create("monospace", Typeface.BOLD)
            gravity = Gravity.CENTER
            setShadowLayer(12f, 0f, 3f, Color.parseColor("#80000000"))
        }, lp().apply { bottomMargin = dp(36) })

        val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        fun button(label: String, fill: String, stroke: String?, bold: Boolean, onClick: () -> Unit) = Button(context).apply {
            text = label
            isAllCaps = false
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            typeface = Typeface.create(Typeface.DEFAULT, if (bold) Typeface.BOLD else Typeface.NORMAL)
            background = GradientDrawable().apply {
                setColor(Color.parseColor(fill)); cornerRadius = dp(28).toFloat()
                if (stroke != null) setStroke(dp(1), Color.parseColor(stroke))
            }
            minHeight = dp(60)
            setPadding(dp(16), dp(18), dp(16), dp(18))
            setOnClickListener { onClick() }
        }
        if (phase == AdhanSession.Phase.PLAYING) {
            row.addView(button("Beenden", "#99000000", "#60FFFFFF", false, onSilence),
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        } else {
            row.addView(button("🔇  Stumm", "#99000000", "#60FFFFFF", false, onSilence),
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(10) })
            row.addView(button("🔊  Laut", "#10B981", null, true, onLoud),
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(10) })
        }
        content.addView(row, lp())
        content.addView(TextView(context).apply {
            text = "Sperrtaste oder Lautstärke = Stumm"
            setTextColor(Color.parseColor("#80FFFFFF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            gravity = Gravity.CENTER
        }, lp().apply { topMargin = dp(14) })

        root.addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        return root
    }
}
