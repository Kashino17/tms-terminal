package com.tms.terminal

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Opens the Android package installer for a downloaded update.
 *
 * Replaces expo-intent-launcher for this: that one starts the installer with
 * startActivityForResult and refuses every further start
 * (ActivityAlreadyStartedException) until a result comes back — when none
 * does, the installer stayed blocked for the rest of the session
 * ("Installer ließ sich nicht öffnen"). A plain startActivity has no such state.
 */
class ApkInstallerModule(rc: ReactApplicationContext) : ReactContextBaseJavaModule(rc) {

    override fun getName(): String = "ApkInstaller"

    /** May TMS install apps? (Android 8+: per-app "Install unknown apps".) */
    @ReactMethod
    fun canInstall(promise: Promise) {
        val ok = Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            reactApplicationContext.packageManager.canRequestPackageInstalls()
        promise.resolve(ok)
    }

    /** Opens the system page where TMS gets "Install unknown apps". */
    @ReactMethod
    fun openInstallPermission(promise: Promise) {
        try {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + reactApplicationContext.packageName))
            else Intent(Settings.ACTION_SECURITY_SETTINGS)
            start(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("E_PERMISSION_SCREEN", e.message ?: e.javaClass.simpleName, e)
        }
    }

    /** Opens the installer for a content:// URI (from expo-file-system's FileProvider). */
    @ReactMethod
    fun install(contentUri: String, promise: Promise) {
        try {
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(Uri.parse(contentUri), "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            start(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("E_INSTALLER", e.message ?: e.javaClass.simpleName, e)
        }
    }

    private fun start(intent: Intent) {
        val activity = currentActivity
        if (activity != null) activity.startActivity(intent)
        else reactApplicationContext.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
