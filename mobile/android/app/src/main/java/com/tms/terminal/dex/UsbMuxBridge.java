package com.tms.terminal.dex;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConfiguration;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.util.HashMap;
import java.util.Map;

/**
 * Cable path Fold → iPad without any network: the Fold is USB host, speaks Apple's usbmux
 * protocol (like usbmuxd on a Mac) and opens TCP-like streams to port {@link #IPAD_PORT} on the
 * iPad, where the TMS iOS app (TMSUsbRelay) collects them. Every stream that the iPad starts
 * using is spliced onto the local DeX server (127.0.0.1:8768). The bridge keeps
 * {@link #IDLE_TARGET} unused streams open so the iPad can start a connection at any time.
 *
 * Protocol reference: libimobiledevice/usbmuxd (device.c). Verified on Galaxy Z Fold7 → iPad
 * Pro 12.9 (5th gen), usbmux version 2, 2026-11-13.
 */
public final class UsbMuxBridge {
    private static final String TAG = "TMS-UsbMux";
    public static final int IPAD_PORT = 8769;
    private static final int IDLE_TARGET = 2;
    private static final String ACTION_PERMISSION = "com.tms.terminal.USBMUX_PERMISSION";

    private static final int MUX_PROTO_VERSION = 0;
    private static final int MUX_PROTO_SETUP = 2;
    private static final int MUX_PROTO_TCP = 6;
    private static final int TH_SYN = 0x02, TH_RST = 0x04, TH_ACK = 0x10;
    private static final int RX_WINDOW = 131072;
    private static final int MAX_SEGMENT = 16384;

    private static UsbMuxBridge instance;

    public static synchronized UsbMuxBridge get(Context ctx) {
        if (instance == null) instance = new UsbMuxBridge(ctx.getApplicationContext());
        return instance;
    }

    private final Context ctx;
    private final UsbManager usb;
    private Session session;
    private boolean receiverRegistered;
    private volatile String lastState = "idle";
    private String permissionAskedFor;

    private UsbMuxBridge(Context ctx) {
        this.ctx = ctx;
        this.usb = (UsbManager) ctx.getSystemService(Context.USB_SERVICE);
    }

    /** Human-readable state for the status card. */
    public String state() { return lastState; }

    public boolean isConnected() {
        Session s = session;
        return s != null && s.alive;
    }

    /** Idempotent: registers for attach/detach and connects to an already attached iPad. */
    public synchronized void start() {
        if (!receiverRegistered) {
            IntentFilter f = new IntentFilter();
            f.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
            f.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
            f.addAction(ACTION_PERMISSION);
            if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(receiver, f, Context.RECEIVER_EXPORTED);
            else ctx.registerReceiver(receiver, f);
            receiverRegistered = true;
        }
        scan();
    }

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            String a = i.getAction();
            if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(a)) {
                UsbDevice d = i.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                synchronized (UsbMuxBridge.this) { permissionAskedFor = null; }
                Session s = session;
                if (s != null && d != null && d.getDeviceName().equals(s.device.getDeviceName())) {
                    s.close("detached");
                }
                return;
            }
            scan();
        }
    };

    /** Finds an Apple device with a usbmux interface; asks for permission or starts a session. */
    public synchronized void scan() {
        if (session != null && session.alive) return;
        Log.i(TAG, "scan: " + usb.getDeviceList().size() + " usb device(s)");
        for (UsbDevice d : usb.getDeviceList().values()) {
            Log.i(TAG, "scan: " + d.getDeviceName() + " " + Integer.toHexString(d.getVendorId())
                    + " perm=" + usb.hasPermission(d) + " mux=" + (findMux(d) != null));
            if (d.getVendorId() != 0x05ac || findMux(d) == null) continue;
            if (!usb.hasPermission(d)) {
                lastState = "permission";
                // Status polling calls scan() every few seconds: ask once per plug-in, not per poll.
                if (d.getDeviceName().equals(permissionAskedFor)) return;
                permissionAskedFor = d.getDeviceName();
                Intent pi = new Intent(ACTION_PERMISSION).setPackage(ctx.getPackageName());
                int flags = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
                usb.requestPermission(d, PendingIntent.getBroadcast(ctx, 0, pi, flags));
                Log.i(TAG, "permission requested for " + d.getDeviceName());
                return;
            }
            session = new Session(d);
            Thread t = new Thread(session::run, "TMS-UsbMux");
            t.setDaemon(true);
            t.start();
            return;
        }
        lastState = "no-ipad";
    }

    /** Returns {config, interface} holding the Apple USB Multiplexor (class 255/254/2). */
    private static Object[] findMux(UsbDevice d) {
        for (int c = 0; c < d.getConfigurationCount(); c++) {
            UsbConfiguration cfg = d.getConfiguration(c);
            for (int i = 0; i < cfg.getInterfaceCount(); i++) {
                UsbInterface itf = cfg.getInterface(i);
                if (itf.getInterfaceClass() == 255 && itf.getInterfaceSubclass() == 254
                        && itf.getInterfaceProtocol() == 2) {
                    return new Object[]{cfg, itf};
                }
            }
        }
        return null;
    }

    // ── One USB session with one iPad ────────────────────────────────────────

    private final class Session {
        final UsbDevice device;
        volatile boolean alive = true;
        UsbDeviceConnection conn;
        UsbEndpoint epIn, epOut;
        boolean v2;
        int txSeq = 0, rxSeq = 0xFFFF;
        final Object writeLock = new Object();
        final Map<Integer, Stream> streams = new HashMap<>();
        int nextPort = 0x4000;
        int dialFailures = 1;

        Session(UsbDevice device) { this.device = device; }

        void run() {
            try {
                lastState = "opening";
                Object[] mux = findMux(device);
                UsbConfiguration cfg = (UsbConfiguration) mux[0];
                UsbInterface itf = (UsbInterface) mux[1];
                conn = usb.openDevice(device);
                if (conn == null) throw new IllegalStateException("openDevice failed");
                // Android's MTP host grabs the PTP interface on attach; detach everything like
                // usbmuxd does, otherwise switching to the mux configuration fails.
                for (int c = 0; c < device.getConfigurationCount(); c++) {
                    UsbConfiguration any = device.getConfiguration(c);
                    for (int i = 0; i < any.getInterfaceCount(); i++) {
                        UsbInterface x = any.getInterface(i);
                        if (x.getAlternateSetting() != 0) continue;
                        if (conn.claimInterface(x, true)) conn.releaseInterface(x);
                    }
                }
                boolean set = false;
                for (int t = 0; t < 6 && !set; t++) {
                    set = conn.setConfiguration(cfg);
                    if (!set) Thread.sleep(300);
                }
                if (!set) throw new IllegalStateException("setConfiguration failed");
                if (!conn.claimInterface(itf, true)) throw new IllegalStateException("claimInterface failed");
                for (int e = 0; e < itf.getEndpointCount(); e++) {
                    UsbEndpoint ep = itf.getEndpoint(e);
                    if (ep.getType() != UsbConstants.USB_ENDPOINT_XFER_BULK) continue;
                    if (ep.getDirection() == UsbConstants.USB_DIR_IN) epIn = ep; else epOut = ep;
                }
                if (epIn == null || epOut == null) throw new IllegalStateException("no bulk endpoints");

                ByteBuffer ver = ByteBuffer.allocate(12);
                ver.putInt(2).putInt(0).putInt(0);
                sendMux(MUX_PROTO_VERSION, ver.array());
                byte[] reply = readPacket();
                if (reply == null || ByteBuffer.wrap(reply).getInt(0) != MUX_PROTO_VERSION) {
                    throw new IllegalStateException("no usbmux version reply");
                }
                v2 = ByteBuffer.wrap(reply).getInt(8) >= 2;
                if (v2) {
                    synchronized (writeLock) { txSeq = 0; rxSeq = 0xFFFF; }
                    sendMux(MUX_PROTO_SETUP, new byte[]{0x07});
                }
                lastState = "connected";
                Log.i(TAG, "usbmux up (v" + (v2 ? 2 : 1) + ")");

                Thread keeper = new Thread(this::keepIdlePool, "TMS-UsbMux-Pool");
                keeper.setDaemon(true);
                keeper.start();

                while (alive) {
                    byte[] p = readPacket();
                    if (p == null) continue;
                    onPacket(p);
                }
            } catch (Throwable t) {
                Log.w(TAG, "session ended: " + t);
                lastState = "error: " + t.getMessage();
            } finally {
                close("ended");
            }
        }

        /** Keeps IDLE_TARGET unused streams dialed to the iPad; redials when they get used or die. */
        void keepIdlePool() {
            while (alive) {
                int idle = 0;
                synchronized (streams) {
                    for (Stream s : streams.values()) if (!s.used && !s.closed) idle++;
                }
                if (idle < IDLE_TARGET) {
                    Stream s = dial();
                    if (s != null && !s.awaitEstablished(1500)) {
                        // RST or timeout: iPad app not listening yet — back off.
                        if (dialFailures++ % 10 == 0) {
                            Log.i(TAG, "dial :" + IPAD_PORT + " " + (s.closed ? "refused (RST)" : "timeout")
                                    + " — TMS app on the iPad not open?");
                        }
                        s.close(false);
                        sleep(1000);
                    } else if (s != null) {
                        if (dialFailures > 0) Log.i(TAG, "dial :" + IPAD_PORT + " ok, iPad relay reachable");
                        dialFailures = 0;
                    }
                    continue;
                }
                sleep(250);
            }
        }

        Stream dial() {
            Stream s;
            synchronized (streams) {
                nextPort = nextPort >= 0xFFF0 ? 0x4000 : nextPort + 1;
                s = new Stream(this, nextPort);
                streams.put(s.sport, s);
            }
            s.sendTcp(TH_SYN, null);
            return s;
        }

        void onPacket(byte[] p) {
            ByteBuffer bb = ByteBuffer.wrap(p);
            int proto = bb.getInt(0);
            int hdr = v2 ? 16 : 8;
            if (v2 && p.length >= 16) {
                synchronized (writeLock) { rxSeq = bb.getShort(12) & 0xffff; }
            }
            if (proto != MUX_PROTO_TCP || p.length < hdr + 20) return;
            ByteBuffer th = ByteBuffer.wrap(p, hdr, p.length - hdr);
            int sport = th.getShort(hdr) & 0xffff;      // device's source = iPad port
            int dport = th.getShort(hdr + 2) & 0xffff;  // our port
            long seq = th.getInt(hdr + 4) & 0xffffffffL;
            long ack = th.getInt(hdr + 8) & 0xffffffffL;
            int off = ((p[hdr + 12] & 0xff) >> 4) * 4;
            int flags = p[hdr + 13] & 0xff;
            int win = (th.getShort(hdr + 14) & 0xffff) << 8;
            Stream s;
            synchronized (streams) { s = streams.get(dport); }
            if (s == null || sport != IPAD_PORT) return;
            int dataOff = hdr + off;
            int dataLen = p.length - dataOff;
            s.onTcp(flags, seq, ack, win, p, dataOff, dataLen);
        }

        void sendMux(int proto, byte[] payload) {
            synchronized (writeLock) {
                if (conn == null) return;
                int hdr = v2 ? 16 : 8;
                ByteBuffer b = ByteBuffer.allocate(hdr + payload.length);
                b.putInt(proto).putInt(hdr + payload.length);
                if (v2) {
                    b.putInt(0xfeedface).putShort((short) txSeq).putShort((short) rxSeq);
                    txSeq = (txSeq + 1) & 0xffff;
                }
                b.put(payload);
                byte[] a = b.array();
                int sent = 0;
                while (sent < a.length) {
                    int n = conn.bulkTransfer(epOut, a, sent, a.length - sent, 5000);
                    if (n <= 0) { close("usb write failed"); return; }
                    sent += n;
                }
                if (a.length % epOut.getMaxPacketSize() == 0) conn.bulkTransfer(epOut, new byte[0], 0, 1000);
            }
        }

        private final byte[] rbuf = new byte[65536];
        private final ByteArrayOutputStream pending = new ByteArrayOutputStream();

        /** Reads exactly one mux packet (the device may split or batch packets across transfers). */
        byte[] readPacket() {
            while (alive) {
                byte[] have = pending.toByteArray();
                if (have.length >= 8) {
                    int len = ByteBuffer.wrap(have).getInt(4);
                    if (len < 8 || len > 1 << 20) { close("bad mux length " + len); return null; }
                    if (have.length >= len) {
                        byte[] pkt = new byte[len];
                        System.arraycopy(have, 0, pkt, 0, len);
                        pending.reset();
                        pending.write(have, len, have.length - len);
                        return pkt;
                    }
                }
                UsbDeviceConnection c = conn;
                if (c == null) return null;
                int n = c.bulkTransfer(epIn, rbuf, rbuf.length, 1000);
                if (n > 0) pending.write(rbuf, 0, n);
                else if (n < 0 && !deviceStillAttached()) { close("device gone"); return null; }
            }
            return null;
        }

        boolean deviceStillAttached() {
            return usb.getDeviceList().containsKey(device.getDeviceName());
        }

        void close(String why) {
            if (!alive) return;
            alive = false;
            Log.i(TAG, "close session: " + why);
            Stream[] all;
            synchronized (streams) { all = streams.values().toArray(new Stream[0]); streams.clear(); }
            for (Stream s : all) s.close(false);
            synchronized (writeLock) {
                if (conn != null) { try { conn.close(); } catch (Throwable ignored) {} conn = null; }
            }
            synchronized (UsbMuxBridge.this) {
                if (session == this) session = null;
                lastState = "idle";
            }
        }
    }

    // ── One TCP-over-usbmux stream, spliced to the local DeX server ──────────

    private static final class Stream {
        final Session sess;
        final int sport;
        long txSeq = 0, txAcked = 0, rxAck = 0;
        int peerWin = RX_WINDOW;
        boolean established, closed, used;
        Socket local;

        Stream(Session sess, int sport) { this.sess = sess; this.sport = sport; }

        synchronized boolean awaitEstablished(long ms) {
            long end = System.currentTimeMillis() + ms;
            while (!established && !closed) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) break;
                try { wait(left); } catch (InterruptedException e) { return false; }
            }
            return established && !closed;
        }

        void sendTcp(int flags, byte[] data) {
            int dl = data == null ? 0 : data.length;
            ByteBuffer t = ByteBuffer.allocate(20 + dl);
            long seq, ack;
            synchronized (this) { seq = txSeq; ack = rxAck; }
            t.putShort((short) sport).putShort((short) IPAD_PORT);
            t.putInt((int) seq).putInt((int) ack);
            t.put((byte) 0x50).put((byte) flags);
            t.putShort((short) (RX_WINDOW >> 8)).putShort((short) 0).putShort((short) 0);
            if (dl > 0) t.put(data);
            sess.sendMux(MUX_PROTO_TCP, t.array());
        }

        void onTcp(int flags, long seq, long ack, int win, byte[] p, int off, int len) {
            if ((flags & TH_RST) != 0) {
                synchronized (this) { if ((flags & TH_ACK) != 0) txAcked = Math.max(txAcked, ack); }
                close(false);
                return;
            }
            if (!established) {
                if ((flags & (TH_SYN | TH_ACK)) == (TH_SYN | TH_ACK)) {
                    synchronized (this) {
                        txSeq = 1; txAcked = 1; rxAck = seq + 1; peerWin = win;
                        established = true;
                        notifyAll();
                    }
                    sendTcp(TH_ACK, null);
                }
                return;
            }
            synchronized (this) {
                txAcked = Math.max(txAcked, ack);
                peerWin = win;
                notifyAll();
            }
            if (len <= 0) return;
            synchronized (this) { rxAck += len; }
            sendTcp(TH_ACK, null);
            try {
                if (!used) {
                    String head = new String(p, off, Math.min(len, 80), java.nio.charset.StandardCharsets.US_ASCII);
                    int nl = head.indexOf('\r');
                    Log.i(TAG, "stream " + sport + " request: " + (nl > 0 ? head.substring(0, nl) : head));
                    startSplice();
                }
                Socket l = local;
                if (l != null) {
                    OutputStream o = l.getOutputStream();
                    o.write(p, off, len);
                    o.flush();
                }
            } catch (Throwable t) {
                close(true);
            }
        }

        /** First bytes from the iPad: connect to the local DeX server and pump its replies back. */
        void startSplice() throws Exception {
            used = true;
            Log.i(TAG, "stream " + sport + " in use → splicing to local DeX server");
            Socket l = new Socket();
            l.setTcpNoDelay(true);
            l.connect(new InetSocketAddress("127.0.0.1", DeXShellServer.DEFAULT_PORT), 1500);
            local = l;
            Thread pump = new Thread(() -> {
                byte[] buf = new byte[MAX_SEGMENT];
                try {
                    InputStream in = l.getInputStream();
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        int sent = 0;
                        while (sent < n) {
                            int chunk;
                            synchronized (this) {
                                while (!closed && (txSeq - txAcked) >= peerWin) wait(1000);
                                if (closed) return;
                                chunk = (int) Math.min(n - sent, Math.max(1, peerWin - (txSeq - txAcked)));
                            }
                            byte[] seg = new byte[chunk];
                            System.arraycopy(buf, sent, seg, 0, chunk);
                            sendTcp(TH_ACK, seg);
                            synchronized (this) { txSeq += chunk; }
                            sent += chunk;
                        }
                    }
                } catch (Throwable ignored) {
                } finally {
                    // usbmux has no FIN, only RST. An RST that overtakes unread data makes iOS drop
                    // it (a status reply would vanish), so wait until the iPad acked everything.
                    drainThenClose();
                }
            }, "TMS-UsbMux-Pump");
            pump.setDaemon(true);
            pump.start();
        }

        void drainThenClose() {
            synchronized (this) {
                long end = System.currentTimeMillis() + 3000;
                while (!closed && txAcked < txSeq) {
                    long left = end - System.currentTimeMillis();
                    if (left <= 0) break;
                    try { wait(left); } catch (InterruptedException e) { break; }
                }
            }
            sleep(150);
            Log.i(TAG, "stream " + sport + " done: sent " + (txSeq - 1) + " B, iPad acked " + (txAcked - 1) + " B");
            close(true);
        }

        void close(boolean sendRst) {
            synchronized (this) {
                if (closed) return;
                closed = true;
                notifyAll();
            }
            if (sendRst && established) sendTcp(TH_RST, null);
            if (local != null) { try { local.close(); } catch (Throwable ignored) {} }
            synchronized (sess.streams) { sess.streams.remove(sport); }
        }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) {}
    }
}
