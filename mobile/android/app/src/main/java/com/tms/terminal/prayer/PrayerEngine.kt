package com.tms.terminal.prayer

import android.content.Context
import com.batoulapps.adhan.CalculationParameters
import com.batoulapps.adhan.Coordinates
import com.batoulapps.adhan.HighLatitudeRule
import com.batoulapps.adhan.Madhab
import com.batoulapps.adhan.PrayerAdjustments
import com.batoulapps.adhan.PrayerTimes
import com.batoulapps.adhan.data.DateComponents
import org.json.JSONObject
import java.util.Calendar
import java.util.Date
import java.util.TimeZone

/**
 * Gebetszeiten auf dem Handy — ohne Netz, für jeden Tag und jeden Ort.
 *
 * Die Methode (Winkel, Sicherheitsminuten, Asr-Schule) wählt sich nach dem
 * Land, das Land kommt aus der Zeitzone des Handys (die stellt sich beim
 * Reisen von selbst um). Zahlen: assets/prayer_methods.json — dieselbe Datei
 * prüft scripts/prayer-methods.test.mjs gegen amtliche Zeiten.
 */
object PrayerEngine {

    /** Die fünf Gebete, die klingeln (Sonnenaufgang nicht). */
    val ALARM_PRAYERS = listOf("Fajr", "Dhuhr", "Asr", "Maghrib", "Isha")

    val ARABIC = mapOf(
        "Fajr" to "الفجر", "Sunrise" to "الشروق", "Dhuhr" to "الظهر",
        "Asr" to "العصر", "Maghrib" to "المغرب", "Isha" to "العشاء",
    )

    data class Method(val id: String, val name: String, val country: String?, val params: CalculationParameters)
    data class Day(val method: Method, val times: Map<String, Date>)
    data class Next(val name: String, val at: Date)

    @Volatile private var table: JSONObject? = null

    private fun table(context: Context): JSONObject =
        table ?: synchronized(this) {
            table ?: JSONObject(context.assets.open("prayer_methods.json").bufferedReader().use { it.readText() })
                .also { table = it }
        }

    /** Land aus der Zeitzone (z. B. Asia/Kuala_Lumpur → MY), sonst null. */
    fun countryForZone(context: Context, tz: String = TimeZone.getDefault().id): String? {
        val zones = table(context).optJSONObject("zones") ?: return null
        return zones.optString(tz, "").ifEmpty { null }
    }

    fun methodFor(context: Context, country: String?): Method {
        val t = table(context)
        val id = country?.let { t.getJSONObject("countries").optString(it, "") }?.ifEmpty { null }
            ?: t.getString("default")
        val m = t.getJSONObject("methods").getJSONObject(id)
        val fajr = m.getDouble("fajr")
        val ishaInterval = m.optInt("ishaInterval", 0)
        val p = if (ishaInterval > 0) CalculationParameters(fajr, ishaInterval)
                else CalculationParameters(fajr, m.getDouble("isha"))
        val a = m.optJSONObject("adjust")
        p.methodAdjustments = PrayerAdjustments(
            a?.optInt("fajr", 0) ?: 0, a?.optInt("sunrise", 0) ?: 0, a?.optInt("dhuhr", 0) ?: 0,
            a?.optInt("asr", 0) ?: 0, a?.optInt("maghrib", 0) ?: 0, a?.optInt("isha", 0) ?: 0,
        )
        val hanafi = t.optJSONArray("hanafi")
        var isHanafi = false
        if (country != null && hanafi != null) for (i in 0 until hanafi.length()) if (hanafi.getString(i) == country) isHanafi = true
        p.madhab = if (isHanafi) Madhab.HANAFI else Madhab.SHAFI
        // Wie Aladhans Standard („angle based“): greift nur, wo der Winkel nachts nicht erreicht wird.
        p.highLatitudeRule = HighLatitudeRule.TWILIGHT_ANGLE
        return Method(id, m.getString("name"), country, p)
    }

    /** Zeiten eines Kalendertags (in der Zeitzone des Handys). */
    fun day(context: Context, lat: Double, lon: Double, cal: Calendar, country: String? = countryForZone(context)): Day {
        val method = methodFor(context, country)
        val dc = DateComponents(cal.get(Calendar.YEAR), cal.get(Calendar.MONTH) + 1, cal.get(Calendar.DAY_OF_MONTH))
        val pt = PrayerTimes(Coordinates(lat, lon), dc, method.params)
        return Day(method, linkedMapOf(
            "Fajr" to pt.fajr, "Sunrise" to pt.sunrise, "Dhuhr" to pt.dhuhr,
            "Asr" to pt.asr, "Maghrib" to pt.maghrib, "Isha" to pt.isha,
        ))
    }

    /** Das nächste Gebet, das klingeln soll — heute oder in den nächsten Tagen. */
    fun next(context: Context, lat: Double, lon: Double, now: Date = Date()): Next? {
        val cal = Calendar.getInstance()
        cal.time = now
        for (offset in 0..2) {
            val d = day(context, lat, lon, cal)
            for (name in ALARM_PRAYERS) {
                val at = d.times[name] ?: continue
                if (at.time > now.time + 1_000) return Next(name, at)
            }
            cal.add(Calendar.DAY_OF_MONTH, 1)
        }
        return null
    }
}
