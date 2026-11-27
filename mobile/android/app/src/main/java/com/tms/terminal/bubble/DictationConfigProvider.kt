package com.tms.terminal.bubble

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri

/**
 * Hands the dictation server settings (the same ones the bubble uses) to TMS Keyboard.
 * Guarded by the signature permission com.tms.permission.DICTATION_CONFIG: only apps
 * signed with the TMS release key can read it. Read-only, one row.
 */
class DictationConfigProvider : ContentProvider() {
    override fun onCreate() = true

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?,
                       selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val config = BubbleConfig(context!!)
        return MatrixCursor(arrayOf("host", "port", "token", "enhance")).apply {
            if (config.isConfigured) addRow(arrayOf<Any>(config.host, config.port, config.token, if (config.enhance) 1 else 0))
        }
    }

    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
