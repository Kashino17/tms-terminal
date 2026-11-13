package com.tms.terminal.dex;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.media.MediaRecorder;
import android.os.Build;

import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * System sound of the Fold → iPad speakers while the DeX cable monitor runs.
 *
 * Captures the whole device output via REMOTE_SUBMIX (the way scrcpy does it as shell: while the
 * submix is recorded, Android stops playing that sound on the phone itself), encodes Opus 48 kHz
 * stereo and sends it in the remote protocol's sound packets: 0x02, 4-byte timestamp (ms), Opus
 * frame — which the viewer already decodes with WebCodecs. Needs the privileged (shell) process.
 */
final class DeXAudioCapture {
    private static final int RATE = 48000;
    private static final int CHANNELS = 2;

    private final Context ctx;
    private final OutputStream out;
    private final Object writeLock;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final boolean pcm;
    private Thread thread;

    /**
     * @param pcm raw PCM packets (0x03 + ts + s16le stereo 48 kHz) instead of Opus (0x02).
     *            iOS WKWebView has no usable WebCodecs AudioDecoder for Opus, so the iPad asks
     *            for PCM; over the USB cable ~1.5 Mbit/s is nothing.
     */
    DeXAudioCapture(Context ctx, OutputStream out, Object writeLock, boolean pcm) {
        this.ctx = ctx;
        this.out = out;
        this.writeLock = writeLock;
        this.pcm = pcm;
    }

    void start() {
        if (!running.compareAndSet(false, true)) return;
        thread = new Thread(this::run, "TMS-DeX-Audio");
        thread.setDaemon(true);
        thread.start();
    }

    void stop() {
        running.set(false);
        if (thread != null) thread.interrupt();
    }

    private void run() {
        AudioRecord rec = null;
        MediaCodec enc = null;
        try {
            AudioFormat fmt = new AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(RATE)
                    .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                    .build();
            int minBuf = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
            AudioRecord.Builder b = new AudioRecord.Builder()
                    .setAudioSource(MediaRecorder.AudioSource.REMOTE_SUBMIX)
                    .setAudioFormat(fmt)
                    .setBufferSizeInBytes(Math.max(minBuf, 8 * 1024) * 4);
            if (Build.VERSION.SDK_INT >= 31 && ctx != null) b.setContext(ctx);
            rec = b.build();
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("AudioRecord not initialized");

            if (pcm) {
                rec.startRecording();
                System.out.println("[TMS-DeX] audio capture running (REMOTE_SUBMIX → PCM)");
                long t0 = System.nanoTime();
                byte[] buf = new byte[3840]; // 20 ms
                while (running.get()) {
                    int n = rec.read(buf, 0, buf.length);
                    if (n < 0) throw new IllegalStateException("AudioRecord.read " + n);
                    if (n == 0) continue;
                    byte[] pkt = new byte[5 + n];
                    long ts = ((System.nanoTime() - t0) / 1_000_000L) & 0xFFFFFFFFL;
                    pkt[0] = 0x03;
                    pkt[1] = (byte) (ts >>> 24);
                    pkt[2] = (byte) (ts >>> 16);
                    pkt[3] = (byte) (ts >>> 8);
                    pkt[4] = (byte) ts;
                    System.arraycopy(buf, 0, pkt, 5, n);
                    DeXShellServer.sendWsFrame(out, writeLock, 0x2, pkt);
                }
                return;
            }

            MediaFormat mf = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, RATE, CHANNELS);
            mf.setInteger(MediaFormat.KEY_BIT_RATE, 128000);
            enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
            enc.configure(mf, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            enc.start();
            rec.startRecording();
            System.out.println("[TMS-DeX] audio capture running (REMOTE_SUBMIX → Opus)");

            long t0 = System.nanoTime();
            long samplesIn = 0;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            byte[] pcm = new byte[3840]; // 20 ms stereo 16-bit
            while (running.get()) {
                int inIdx = enc.dequeueInputBuffer(10_000);
                if (inIdx >= 0) {
                    ByteBuffer ib = enc.getInputBuffer(inIdx);
                    int want = Math.min(pcm.length, ib.remaining());
                    int n = rec.read(pcm, 0, want);
                    if (n < 0) throw new IllegalStateException("AudioRecord.read " + n);
                    ib.put(pcm, 0, n);
                    long ptsUs = samplesIn * 1_000_000L / RATE;
                    samplesIn += n / (2 * CHANNELS);
                    enc.queueInputBuffer(inIdx, 0, n, ptsUs, 0);
                }
                int outIdx;
                while ((outIdx = enc.dequeueOutputBuffer(info, 0)) >= 0) {
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
                        ByteBuffer ob = enc.getOutputBuffer(outIdx);
                        byte[] pkt = new byte[5 + info.size];
                        long ts = ((System.nanoTime() - t0) / 1_000_000L) & 0xFFFFFFFFL;
                        pkt[0] = 0x02;
                        pkt[1] = (byte) (ts >>> 24);
                        pkt[2] = (byte) (ts >>> 16);
                        pkt[3] = (byte) (ts >>> 8);
                        pkt[4] = (byte) ts;
                        ob.position(info.offset);
                        ob.get(pkt, 5, info.size);
                        DeXShellServer.sendWsFrame(out, writeLock, 0x2, pkt);
                    }
                    enc.releaseOutputBuffer(outIdx, false);
                }
            }
        } catch (Throwable t) {
            if (running.get()) System.err.println("[TMS-DeX] audio capture failed: " + t);
        } finally {
            running.set(false);
            if (rec != null) { try { rec.stop(); } catch (Throwable ignored) {} try { rec.release(); } catch (Throwable ignored) {} }
            if (enc != null) { try { enc.stop(); } catch (Throwable ignored) {} try { enc.release(); } catch (Throwable ignored) {} }
        }
    }
}
