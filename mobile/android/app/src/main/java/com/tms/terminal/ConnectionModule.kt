package com.tms.terminal

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * React Native bridge module to start/stop the ConnectionService foreground service.
 */
class ConnectionModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "ConnectionService"

    @ReactMethod
    fun start() {
        val intent = Intent(reactApplicationContext, ConnectionService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactApplicationContext.startForegroundService(intent)
        } else {
            reactApplicationContext.startService(intent)
        }
    }

    @ReactMethod
    fun stop() {
        val intent = Intent(reactApplicationContext, ConnectionService::class.java)
        reactApplicationContext.stopService(intent)
    }
}
