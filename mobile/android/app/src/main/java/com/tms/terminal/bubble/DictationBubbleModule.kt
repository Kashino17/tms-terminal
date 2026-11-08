package com.tms.terminal.bubble

import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
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
        map.putBoolean("bound", BubbleKeepAliveService.isBound(rc))
        map.putBoolean("keepAlive", BubbleKeepAliveService.isRunning(rc))
        map.putBoolean("notifications", BubbleKeepAliveService.notificationVisible(rc))
        if (config.lastCheckAt > 0) {
            map.putDouble("lastCheckAt", config.lastCheckAt.toDouble())
            map.putString("lastCheck", config.lastCheck)
        }
        BubbleDiagnostics.lastExit(rc)?.let {
            map.putDouble("lastExitAt", it.at.toDouble())
            map.putString("lastExit", it.text)
        }
        promise.resolve(map)
    }

    @ReactMethod
    fun openAccessibilitySettings() {
        rc.startActivity(BubbleKeepAliveService.settingsIntent(rc))
    }

    /** From the foreground app Android always allows the start (Samsung may refuse it in the background). */
    @ReactMethod
    fun startKeepAlive() {
        BubbleKeepAliveService.sync(rc)
    }

    /** App notifications off → app page; only our channel blocked → that channel's page. */
    @ReactMethod
    fun openNotificationSettings() {
        val pkg = rc.packageName
        val channelBlocked = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            NotificationManagerCompat.from(rc).areNotificationsEnabled() &&
            !BubbleKeepAliveService.notificationVisible(rc)
        val intent = when {
            channelBlocked -> Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, pkg).putExtra(Settings.EXTRA_CHANNEL_ID, BubbleKeepAliveService.CHANNEL_ID)
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
            else -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:$pkg"))
        }
        rc.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    @ReactMethod
    fun setEnabled(enabled: Boolean) {
        config.enabled = enabled
        BubbleKeepAliveService.sync(rc) // the bubble itself picks the change up on its next event
    }

    @ReactMethod
    fun wake() {
        config.wake()
    }
}
