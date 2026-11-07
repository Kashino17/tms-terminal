package com.tms.terminal.bubble

import android.content.Intent
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/** RN bridge: the app hands the bubble its server + token and shows its status. */
class DictationBubbleModule(private val rc: ReactApplicationContext) : ReactContextBaseJavaModule(rc) {
    override fun getName(): String = "DictationBubble"

    private val config by lazy { BubbleConfig(rc) }

    @ReactMethod
    fun configure(host: String, port: Int, token: String, enhance: Boolean) {
        config.configure(host, port, token, enhance)
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        val map = Arguments.createMap()
        map.putBoolean("serviceOn", BubbleKeepAliveService.isAccessibilityOn(rc))
        map.putBoolean("enabled", config.enabled)
        map.putDouble("snoozedUntil", config.snoozedUntil.toDouble())
        promise.resolve(map)
    }

    @ReactMethod
    fun openAccessibilitySettings() {
        rc.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    @ReactMethod
    fun setEnabled(enabled: Boolean) {
        config.enabled = enabled
        BubbleKeepAliveService.sync(rc)
        DictationBubbleService.instance?.reevaluate()
    }

    @ReactMethod
    fun wake() {
        config.snoozedUntil = 0
        DictationBubbleService.instance?.reevaluate()
    }
}
