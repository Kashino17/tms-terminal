package com.tms.terminal

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.tms.terminal.dex.DeXShellServer
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * React Native bridge module for the Samsung Galaxy Fold 7 DeX USB-C Host.
 *
 * Responsibilities:
 *  - Monitors USB cable & USB-Tethering (CDC-NCM / RNDIS) state on the Fold 7
 *  - Ensures port 8768 is always answering /dex/status for the iPad auto-discovery
 *  - Spawns or queries the privileged DeXShellServer (UID 2000 via app_process)
 *  - Provides 1-tap USB-Tethering activation
 */
class DeXHostModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "TMSDeXHost"
        private const val ACTION_USB_STATE = "android.hardware.usb.action.USB_STATE"
        private var standbyServer: DeXShellServer? = null
    }

    @Volatile
    private var usbPlugged: Boolean = false

    @Volatile
    private var usbNcmActive: Boolean = false

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == ACTION_USB_STATE) {
                val connected = intent.extras?.getBoolean("connected") ?: false
                val ncm = intent.extras?.getBoolean("ncm") ?: false
                val rndis = intent.extras?.getBoolean("rndis") ?: false
                usbPlugged = connected
                usbNcmActive = ncm || rndis
                ensureDiscoveryServerRunning()
                emitUsbEvent()
            }
        }
    }

    init {
        try {
            val filter = IntentFilter(ACTION_USB_STATE)
            val sticky = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                reactContext.registerReceiver(usbReceiver, filter, Context.RECEIVER_EXPORTED)
            } else {
                reactContext.registerReceiver(usbReceiver, filter)
            }
            if (sticky != null) {
                usbPlugged = sticky.extras?.getBoolean("connected") ?: false
                usbNcmActive = (sticky.extras?.getBoolean("ncm") ?: false) ||
                        (sticky.extras?.getBoolean("rndis") ?: false)
            }
            ensureDiscoveryServerRunning()
        } catch ( ignored: Throwable) {}
    }

    override fun getName(): String = NAME

    private fun ensureDiscoveryServerRunning() {
        Thread {
            val existing = queryLocalDeXServer()
            if (existing != null) return@Thread
            synchronized(DeXHostModule::class.java) {
                if (standbyServer == null || !standbyServer!!.isRunning) {
                    standbyServer = DeXShellServer(DeXShellServer.DEFAULT_PORT, false, reactContext.applicationContext)
                    standbyServer!!.startAsync()
                }
            }
        }.start()
    }

    private fun queryLocalDeXServer(): JSONObject? {
        return try {
            val url = URL("http://127.0.0.1:${DeXShellServer.DEFAULT_PORT}/dex/status")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 350
                readTimeout = 350
                requestMethod = "GET"
            }
            if (conn.responseCode == 200) {
                val text = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
                JSONObject(text)
            } else {
                null
            }
        } catch (t: Throwable) {
            null
        }
    }

    private fun buildShellStartCommand(): String {
        val apkPath = reactContext.applicationInfo.sourceDir
        return "CLASSPATH=\"$apkPath\" nohup app_process / com.tms.terminal.dex.DeXShellServer --port ${DeXShellServer.DEFAULT_PORT} >/dev/null 2>&1 &"
    }

    private fun emitUsbEvent() {
        try {
            if (!reactContext.hasActiveReactInstance()) return
            val usbIps = DeXShellServer.detectUsbInterfaces()
            val map = Arguments.createMap().apply {
                putBoolean("usbPlugged", usbPlugged)
                putBoolean("usbTethering", usbNcmActive || usbIps.isNotEmpty())
                putString("usbIp", usbIps.values.firstOrNull())
            }
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("DeXUsbStateChanged", map)
        } catch (ignored: Throwable) {}
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        Thread {
            try {
                val usbIps = DeXShellServer.detectUsbInterfaces()
                val srv = queryLocalDeXServer()
                val privileged = srv?.optBoolean("privileged", false) ?: false
                val running = srv?.optBoolean("ok", false) ?: false
                val primaryIp = usbIps.values.firstOrNull()

                val res = Arguments.createMap().apply {
                    putBoolean("running", running)
                    putBoolean("privileged", privileged)
                    putBoolean("usbPlugged", usbPlugged || primaryIp != null)
                    putBoolean("usbTethering", usbNcmActive || primaryIp != null)
                    putString("usbIp", primaryIp)
                    putInt("port", DeXShellServer.DEFAULT_PORT)
                    putInt("displayId", srv?.optInt("displayId", -1) ?: -1)
                    putInt("width", srv?.optInt("width", 2048) ?: 2048)
                    putInt("height", srv?.optInt("height", 1536) ?: 1536)
                    putInt("connectedClients", srv?.optInt("connectedClients", 0) ?: 0)
                    putString("adbCommand", "adb shell '${buildShellStartCommand()}'")
                }
                promise.resolve(res)
            } catch (t: Throwable) {
                promise.reject("DEX_STATUS_ERR", t.message, t)
            }
        }.start()
    }

    @ReactMethod
    fun startEngine(promise: Promise) {
        Thread {
            try {
                val current = queryLocalDeXServer()
                if (current != null && current.optBoolean("privileged", false)) {
                    val res = Arguments.createMap().apply {
                        putBoolean("ok", true)
                        putBoolean("privileged", true)
                        putString("mode", "already_running")
                    }
                    promise.resolve(res)
                    return@Thread
                }

                // Release port 8768 from standby server so privileged app_process can bind it
                synchronized(DeXHostModule::class.java) {
                    standbyServer?.stop()
                    standbyServer = null
                }
                Thread.sleep(120)

                val cmd = buildShellStartCommand()
                // Try launching via local wireless ADB (if tcpip 5555 is open) or root/sh
                val candidates = listOf(
                    arrayOf("sh", "-c", "adb connect 127.0.0.1:5555 >/dev/null 2>&1; adb -s 127.0.0.1:5555 shell \"$cmd\""),
                    arrayOf("su", "-c", cmd),
                    arrayOf("sh", "-c", cmd)
                )
                for (execArgs in candidates) {
                    try {
                        val p = Runtime.getRuntime().exec(execArgs)
                        p.waitFor()
                    } catch (ignored: Throwable) {}
                    Thread.sleep(250)
                    val check = queryLocalDeXServer()
                    if (check != null && check.optBoolean("ok", false)) {
                        break
                    }
                }

                // Ensure at least standby discovery is up if privileged daemon didn't bind
                var after = queryLocalDeXServer()
                if (after == null) {
                    ensureDiscoveryServerRunning()
                    Thread.sleep(150)
                    after = queryLocalDeXServer()
                }

                val isPriv = after?.optBoolean("privileged", false) ?: false
                val res = Arguments.createMap().apply {
                    putBoolean("ok", after != null)
                    putBoolean("privileged", isPriv)
                    putString("adbCommand", "adb shell '$cmd'")
                }
                promise.resolve(res)
            } catch (t: Throwable) {
                promise.reject("DEX_START_ERR", t.message, t)
            }
        }.start()
    }

    @ReactMethod
    fun openTetherSettings(promise: Promise) {
        try {
            // Try shell auto-enable first if available
            Thread {
                try {
                    Runtime.getRuntime().exec(arrayOf("sh", "-c", "cmd connectivity start-tethering usb || svc usb setFunctions ncm")).waitFor()
                } catch (ignored: Throwable) {}
            }.start()

            val intent = Intent().apply {
                component = ComponentName("com.android.settings", "com.android.settings.TetherSettings")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            try {
                reactContext.startActivity(intent)
            } catch (e: Throwable) {
                val fallback = Intent(android.provider.Settings.ACTION_WIRELESS_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(fallback)
            }
            promise.resolve(true)
        } catch (t: Throwable) {
            promise.reject("TETHER_SETTINGS_ERR", t.message, t)
        }
    }

    @ReactMethod
    fun addListener(eventName: String?) {
        // Required for RN NativeEventEmitter
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for RN NativeEventEmitter
    }
}
