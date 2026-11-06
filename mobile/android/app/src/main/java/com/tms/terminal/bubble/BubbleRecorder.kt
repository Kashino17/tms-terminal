package com.tms.terminal.bubble

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

/**
 * AAC-ADTS 16 kHz mono 96 kbit/s — exactly the in-app format (useDictation.ts),
 * so the server's streaming path is shared. ADTS frames stand alone, so the
 * file can be uploaded while it grows.
 */
class BubbleRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    var file: File? = null
        private set

    fun start(): File {
        val f = File(context.cacheDir, "bubble-${System.currentTimeMillis()}.aac")
        @Suppress("DEPRECATION")
        val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else MediaRecorder()
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.AAC_ADTS)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioSamplingRate(16000)
            r.setAudioChannels(1)
            r.setAudioEncodingBitRate(96000)
            r.setOutputFile(f.absolutePath)
            r.prepare()
            r.start()
        } catch (e: Exception) {
            r.release()
            f.delete()
            throw e
        }
        recorder = r
        file = f
        return f
    }

    /** Peak amplitude (0..32767) since the last call; 0 when not recording. */
    fun level(): Int = try { recorder?.maxAmplitude ?: 0 } catch (_: Exception) { 0 }

    /** Stops recording. false = Android had no audio at all (a tap too short). */
    fun stop(): Boolean {
        val r = recorder ?: return false
        recorder = null
        return try { r.stop(); true } catch (_: RuntimeException) { false } finally { r.release() }
    }

    fun discard() {
        stop()
        file?.delete()
        file = null
    }

    fun deleteFile() {
        file?.delete()
        file = null
    }
}
