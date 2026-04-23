package com.tms.terminal

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Native notification module that supports a dynamic large icon (agent avatar).
 * expo-notifications only supports static icons set at build time — this module
 * allows setting a per-notification avatar image from a file URI.
 */
class AgentNotificationModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val CHANNEL_ID = "manager-responses"
        const val SHORTCUT_ID = "agent-manager-conversation"
        const val NOTIFICATION_ID_BASE = 5000
        private var notificationCounter = 0
    }

    override fun getName(): String = "AgentNotification"

    @ReactMethod
    fun show(title: String, body: String, avatarUri: String?, messageId: String?) {
        ensureChannel()

        val nm = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val agentName = title.replace("💬 ", "")

        // Launch app when tapping — extras carry navigation intent
        val launchIntent = reactContext.packageManager.getLaunchIntentForPackage(reactContext.packageName)?.apply {
            putExtra("notificationType", "manager_reply")
            if (messageId != null) putExtra("messageId", messageId)
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }

        // Unique requestCode per notification so previous extras don't leak into new taps
        val pendingIntent = PendingIntent.getActivity(
            reactContext,
            (NOTIFICATION_ID_BASE + notificationCounter),
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // Load and crop avatar
        val avatarBitmap = loadBitmap(avatarUri)
        val circularAvatar = avatarBitmap?.let { makeCircular(it) }

        // Build the Person object for the agent (with avatar icon)
        val agentPerson = Person.Builder()
            .setName(agentName)
            .setKey("agent-manager")
            .apply {
                if (circularAvatar != null) {
                    setIcon(IconCompat.createWithBitmap(circularAvatar))
                }
            }
            .build()

        // Register a dynamic shortcut for conversation-style notifications (Android 11+)
        // This makes the avatar appear in the collapsed notification view
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                val sm = reactContext.getSystemService(ShortcutManager::class.java)
                val shortcutIntent = Intent(reactContext, MainActivity::class.java).apply {
                    action = Intent.ACTION_VIEW
                }
                val shortcutBuilder = ShortcutInfo.Builder(reactContext, SHORTCUT_ID)
                    .setShortLabel(agentName)
                    .setLongLived(true)
                    .setIntent(shortcutIntent)
                    .setPerson(
                        android.app.Person.Builder()
                            .setName(agentName)
                            .setKey("agent-manager")
                            .apply {
                                if (circularAvatar != null) {
                                    setIcon(Icon.createWithBitmap(circularAvatar))
                                }
                            }
                            .build()
                    )
                sm?.pushDynamicShortcut(shortcutBuilder.build())
            } catch (_: Exception) {}
        }

        // MessagingStyle with the agent as sender — shows avatar in both collapsed and expanded
        val style = NotificationCompat.MessagingStyle(
            Person.Builder().setName("User").build()
        )
            .setConversationTitle(null) // 1-on-1 conversation (no group title)
            .addMessage(body, System.currentTimeMillis(), agentPerson)

        val builder = NotificationCompat.Builder(reactContext, CHANNEL_ID)
            .setContentTitle(agentName)
            .setContentText(body)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setStyle(style)
            .setShortcutId(SHORTCUT_ID)
            .setSound(android.provider.Settings.System.DEFAULT_NOTIFICATION_URI)
            .setVibrate(longArrayOf(0, 80, 120, 80, 200, 300))

        // Also set large icon explicitly for devices that don't support conversation style
        if (circularAvatar != null) {
            builder.setLargeIcon(circularAvatar)
        }

        notificationCounter++
        nm.notify(NOTIFICATION_ID_BASE + notificationCounter, builder.build())
    }

    @ReactMethod
    fun consumeLaunchExtras(promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.resolve(null)
            return
        }
        val intent = activity.intent
        val type = intent?.getStringExtra("notificationType")
        if (type == null) {
            promise.resolve(null)
            return
        }
        val messageId = intent.getStringExtra("messageId")
        val result = Arguments.createMap().apply {
            putString("notificationType", type)
            if (messageId != null) putString("messageId", messageId)
        }
        // Clear so the same tap doesn't re-trigger when React re-mounts
        intent.removeExtra("notificationType")
        intent.removeExtra("messageId")
        promise.resolve(result)
    }

    private fun loadBitmap(uriString: String?): Bitmap? {
        if (uriString.isNullOrBlank()) return null
        return try {
            val uri = Uri.parse(uriString)
            if (uri.scheme == "file" || uri.scheme == null) {
                // Local file path
                val path = uri.path ?: uriString
                BitmapFactory.decodeFile(path)
            } else {
                // Content URI
                val stream = reactContext.contentResolver.openInputStream(uri)
                val bmp = BitmapFactory.decodeStream(stream)
                stream?.close()
                bmp
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun makeCircular(bitmap: Bitmap): Bitmap {
        val size = minOf(bitmap.width, bitmap.height)
        val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(output)
        val paint = android.graphics.Paint().apply {
            isAntiAlias = true
        }
        val rect = android.graphics.Rect(0, 0, size, size)
        val rectF = android.graphics.RectF(rect)

        canvas.drawOval(rectF, paint)
        paint.xfermode = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.SRC_IN)

        // Center-crop the source
        val srcLeft = (bitmap.width - size) / 2
        val srcTop = (bitmap.height - size) / 2
        val srcRect = android.graphics.Rect(srcLeft, srcTop, srcLeft + size, srcTop + size)
        canvas.drawBitmap(bitmap, srcRect, rect, paint)

        return output
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            // Delete old channel if it exists (vibration pattern is immutable after creation)
            nm.deleteNotificationChannel(CHANNEL_ID)

            val channel = NotificationChannel(
                CHANNEL_ID,
                "Manager Agent",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Benachrichtigungen vom Manager-Agent"
                enableVibration(true)
                // Signature pattern: short-short-pause-long (like a double-tap then hold)
                // [delay, vib, pause, vib, pause, vib]
                // 0ms wait, 80ms buzz, 120ms pause, 80ms buzz, 200ms pause, 300ms buzz
                vibrationPattern = longArrayOf(0, 80, 120, 80, 200, 300)
            }
            nm.createNotificationChannel(channel)
        }
    }
}
