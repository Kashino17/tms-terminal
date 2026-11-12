package com.tms.terminal.dex;

import android.content.Context;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.Surface;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * TMS Terminal — Standalone DeX Virtual Display & H.264 Server for Samsung Galaxy Fold 7 (One UI 8 / Android 16).
 *
 * Can run in two ways:
 *  1) Privileged Shell Mode (UID 2000 via app_process):
 *     CLASSPATH=$(pm path com.tms.terminal | cut -d: -f2) app_process / com.tms.terminal.dex.DeXShellServer
 *     Creates a trusted system-decorated VirtualDisplay that natively triggers Samsung DeX on One UI 8,
 *     encodes it via hardware MediaCodec (H.264 Annex-B), and injects multi-touch/mouse/keyboard events
 *     directly onto the DeX displayId via InputManager.
 *  2) In-App Discovery & Standby Mode (started by DeXHostModule inside the app process):
 *     Answers /dex/status probes over the USB-C tethering interface so the iPad immediately detects
 *     the Fold 7 when plugged in via USB-C.
 */
@android.annotation.SuppressLint({"BlockedPrivateApi", "DiscouragedPrivateApi", "PrivateApi", "SoonBlockedPrivateApi"})
@SuppressWarnings({"deprecation"})
public final class DeXShellServer {

    public static final int DEFAULT_PORT = 8768;

    // One UI 8 / Android 16 VirtualDisplay flags to trigger native Samsung DeX desktop mode
    private static final int VIRTUAL_DISPLAY_FLAG_PUBLIC = 1 << 0;
    private static final int VIRTUAL_DISPLAY_FLAG_PRESENTATION = 1 << 1;
    private static final int VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY = 1 << 3;
    private static final int VIRTUAL_DISPLAY_FLAG_SUPPORTS_TOUCH = 1 << 6;
    private static final int VIRTUAL_DISPLAY_FLAG_ROTATES_WITH_CONTENT = 1 << 7;
    private static final int VIRTUAL_DISPLAY_FLAG_DESTROY_CONTENT_ON_REMOVAL = 1 << 8;
    private static final int VIRTUAL_DISPLAY_FLAG_SHOULD_SHOW_SYSTEM_DECORATIONS = 1 << 9;
    private static final int VIRTUAL_DISPLAY_FLAG_TRUSTED = 1 << 10;
    private static final int VIRTUAL_DISPLAY_FLAG_OWN_DISPLAY_GROUP = 1 << 11;
    private static final int VIRTUAL_DISPLAY_FLAG_ALWAYS_UNLOCKED = 1 << 12;

    private static final int DEX_VIRTUAL_DISPLAY_FLAGS =
            VIRTUAL_DISPLAY_FLAG_PUBLIC
            | VIRTUAL_DISPLAY_FLAG_PRESENTATION
            | VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY
            | VIRTUAL_DISPLAY_FLAG_SUPPORTS_TOUCH
            | VIRTUAL_DISPLAY_FLAG_ROTATES_WITH_CONTENT
            | VIRTUAL_DISPLAY_FLAG_DESTROY_CONTENT_ON_REMOVAL
            | VIRTUAL_DISPLAY_FLAG_SHOULD_SHOW_SYSTEM_DECORATIONS
            | VIRTUAL_DISPLAY_FLAG_TRUSTED
            | VIRTUAL_DISPLAY_FLAG_OWN_DISPLAY_GROUP
            | VIRTUAL_DISPLAY_FLAG_ALWAYS_UNLOCKED;

    private final int port;
    private final boolean privilegedMode;
    private final Context appContext;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private ServerSocket serverSocket;

    private volatile int activeDisplayId = -1;
    private volatile int currentWidth = 2048;
    private volatile int currentHeight = 1536;
    private volatile int currentDpi = 220;
    private volatile int connectedClients = 0;

    public DeXShellServer(int port, boolean privilegedMode, Context appContext) {
        this.port = port;
        this.privilegedMode = privilegedMode;
        this.appContext = appContext;
    }

    public static void main(String[] args) {
        int port = DEFAULT_PORT;
        for (int i = 0; i < args.length; i++) {
            if ("--port".equals(args[i]) && i + 1 < args.length) {
                try {
                    port = Integer.parseInt(args[i + 1]);
                } catch (NumberFormatException ignored) {}
            }
        }

        if (Looper.getMainLooper() == null) {
            Looper.prepareMainLooper();
        }

        System.out.println("[TMS-DeX] Starting DeXShellServer on port " + port + " (uid=" + android.os.Process.myUid() + ")");
        DeXShellServer server = new DeXShellServer(port, true, createSystemContext());
        Thread roles = new Thread(DeXShellServer::watchUsbRoleForIpad, "TMS-DeX-UsbRole");
        roles.setDaemon(true);
        roles.start();
        server.startBlocking();
    }

    /**
     * iPad cable monitor needs the Fold to be USB host. Two dual-role ports usually come up with
     * the iPad as host, so on every new plug-in we flip our data role to host (keeping the power
     * role, so the iPad keeps charging the Fold). If no Apple device enumerates within 5 s — a
     * charger, a Mac, a PC — we flip back and leave that connection alone until the next plug-in.
     * Runs only in the privileged (shell) process: changing port roles needs MANAGE_USB.
     */
    private static void watchUsbRoleForIpad() {
        boolean handled = false;
        while (true) {
            try {
                String d = runShell("dumpsys usb");
                String[] st = parsePortStatus(d);
                if (st == null || !"true".equals(st[1])) {
                    handled = false;
                } else if (!handled) {
                    handled = true;
                    if ("device".equals(st[4])) {
                        String port = st[0], power = st[3];
                        System.out.println("[TMS-DeX] USB plug-in as device → trying host role for iPad");
                        runShell("dumpsys usb set-port-roles " + port + " " + power + " host");
                        boolean apple = false;
                        for (int i = 0; i < 10 && !apple; i++) {
                            Thread.sleep(500);
                            apple = runShell("dumpsys usb").contains("manufacturer_name=Apple");
                        }
                        if (!apple) {
                            System.out.println("[TMS-DeX] no Apple device as host → reverting to device role");
                            runShell("dumpsys usb set-port-roles " + port + " " + power + " device");
                        } else {
                            System.out.println("[TMS-DeX] iPad attached, staying USB host");
                        }
                    }
                }
                Thread.sleep(1500);
            } catch (Throwable t) {
                try { Thread.sleep(3000); } catch (InterruptedException ignored) {}
            }
        }
    }

    /** Returns {portId, connected, mode, powerRole, dataRole} of the first USB-C port, or null. */
    static String[] parsePortStatus(String dump) {
        java.util.regex.Matcher id = java.util.regex.Pattern.compile("\\bid=(port\\d+)").matcher(dump);
        int s = dump.indexOf("status={");
        if (!id.find() || s < 0) return null;
        String block = dump.substring(s, Math.min(dump.length(), s + 400));
        return new String[]{
                id.group(1),
                field(block, "connected"),
                field(block, "current_mode"),
                field(block, "power_role"),
                field(block, "data_role"),
        };
    }

    private static String field(String block, String key) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\b" + key + "=(\\w+)").matcher(block);
        return m.find() ? m.group(1) : "";
    }

    private static String runShell(String cmd) throws IOException, InterruptedException {
        Process p = Runtime.getRuntime().exec(new String[]{"sh", "-c", cmd});
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        InputStream in = p.getInputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        p.waitFor();
        return bo.toString("UTF-8");
    }

    private static Context createSystemContext() {
        try {
            Class<?> atClass = Class.forName("android.app.ActivityThread");
            Method systemMain = atClass.getDeclaredMethod("systemMain");
            systemMain.setAccessible(true);
            Object at = systemMain.invoke(null);
            Method getSystemContext = atClass.getDeclaredMethod("getSystemContext");
            getSystemContext.setAccessible(true);
            return (Context) getSystemContext.invoke(at);
        } catch (Throwable t) {
            System.err.println("[TMS-DeX] Could not acquire systemContext via ActivityThread: " + t.getMessage());
            return null;
        }
    }

    /**
     * DisplayManager whose context claims to be com.android.shell. Under app_process we run as
     * UID 2000 with the "android" system context, and createVirtualDisplay rejects that with
     * "packageName must match the owner uid" (same workaround as scrcpy's FakeContext).
     */
    /** Context that identifies as com.android.shell (UID 2000), for APIs that check the caller. */
    static Context shellContext(Context base) {
        if (base == null || !isPrivilegedProcess()) return base;
        return new android.content.ContextWrapper(base) {
            @Override public String getPackageName() { return "com.android.shell"; }
            @Override public String getOpPackageName() { return "com.android.shell"; }
            @Override public Context getApplicationContext() { return this; }
            @Override public android.content.AttributionSource getAttributionSource() {
                return new android.content.AttributionSource.Builder(2000)
                        .setPackageName("com.android.shell").build();
            }
        };
    }

    private static DisplayManager shellDisplayManager(Context base) {
        if (!isPrivilegedProcess()) return null;
        try {
            Context fake = shellContext(base);
            Constructor<DisplayManager> ctor = DisplayManager.class.getDeclaredConstructor(Context.class);
            ctor.setAccessible(true);
            return ctor.newInstance(fake);
        } catch (Throwable t) {
            System.err.println("[TMS-DeX] shellDisplayManager failed: " + t);
            return null;
        }
    }

    private static boolean isPrivilegedProcess() {
        int uid = android.os.Process.myUid();
        return uid == 2000 || uid == 0;
    }

    /** Asks a running in-app standby server on this port to release it (privileged takeover). */
    private static void requestStandbyYield(int port) {
        try {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                    new java.net.URL("http://127.0.0.1:" + port + "/dex/yield").openConnection();
            c.setConnectTimeout(400);
            c.setReadTimeout(400);
            c.getResponseCode();
            c.disconnect();
        } catch (Throwable ignored) {}
    }

    public void startAsync() {
        if (running.get()) return;
        Thread t = new Thread(this::startBlocking, "TMS-DeX-Server");
        t.setDaemon(true);
        t.start();
    }

    public void startBlocking() {
        if (!running.compareAndSet(false, true)) return;
        try {
            serverSocket = new ServerSocket();
            serverSocket.setReuseAddress(true);
            boolean bound = false;
            for (int attempt = 0; attempt < 10 && !bound; attempt++) {
                try {
                    serverSocket.bind(new InetSocketAddress("0.0.0.0", port));
                    bound = true;
                } catch (java.net.BindException be) {
                    // The in-app standby server holds the port: ask it to step aside, then retry.
                    if (!isPrivilegedProcess()) throw be;
                    requestStandbyYield(port);
                    try { Thread.sleep(300); } catch (InterruptedException ignored) {}
                    serverSocket.close();
                    serverSocket = new ServerSocket();
                    serverSocket.setReuseAddress(true);
                }
            }
            if (!bound) throw new IOException("port " + port + " still busy");
            System.out.println("[TMS-DeX] Listening on 0.0.0.0:" + port);

            while (running.get()) {
                Socket client = serverSocket.accept();
                client.setTcpNoDelay(true);
                Thread worker = new Thread(() -> handleSocket(client), "TMS-DeX-Client");
                worker.setDaemon(true);
                worker.start();
            }
        } catch (IOException e) {
            if (running.get()) {
                System.err.println("[TMS-DeX] Server socket error: " + e.getMessage());
            }
        } finally {
            running.set(false);
        }
    }

    public void stop() {
        running.set(false);
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {}
    }

    public boolean isRunning() {
        return running.get() && serverSocket != null && !serverSocket.isClosed();
    }

    private void handleSocket(Socket socket) {
        try {
            BufferedInputStream in = new BufferedInputStream(socket.getInputStream());
            BufferedOutputStream out = new BufferedOutputStream(socket.getOutputStream());

            String requestLine = readHttpLine(in);
            if (requestLine == null || requestLine.isEmpty()) {
                socket.close();
                return;
            }

            String[] parts = requestLine.split(" ");
            String method = parts.length > 0 ? parts[0] : "GET";
            String path = parts.length > 1 ? parts[1] : "/";

            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readHttpLine(in)) != null && !line.isEmpty()) {
                int idx = line.indexOf(':');
                if (idx > 0) {
                    String k = line.substring(0, idx).trim().toLowerCase();
                    String v = line.substring(idx + 1).trim();
                    headers.put(k, v);
                }
            }

            if ("OPTIONS".equalsIgnoreCase(method)) {
                writeHttpJson(out, 200, "{\"ok\":true}");
                socket.close();
                return;
            }

            String cleanPath = path.split("\\?")[0];
            if ("/dex/yield".equals(cleanPath)) {
                // Only a non-privileged standby server yields, and only to a loopback caller.
                boolean local = socket.getInetAddress() != null && socket.getInetAddress().isLoopbackAddress();
                boolean yield = local && !isPrivilegedProcess();
                writeHttpJson(out, 200, "{\"ok\":true,\"yielded\":" + yield + "}");
                socket.close();
                if (yield) stop();
                return;
            }

            if ("/dex/status".equals(cleanPath) || "/status".equals(cleanPath)) {
                JSONObject status = buildStatusJson();
                writeHttpJson(out, 200, status.toString());
                socket.close();
                return;
            }

            String upgrade = headers.get("upgrade");
            String wsKey = headers.get("sec-websocket-key");
            if (wsKey != null && "websocket".equalsIgnoreCase(upgrade)) {
                performWebSocketHandshake(out, wsKey);
                handleRemoteWebSocket(socket, in, out);
                return;
            }

            writeHttpJson(out, 404, "{\"ok\":false,\"error\":\"not_found\"}");
            socket.close();
        } catch (Throwable t) {
            try { socket.close(); } catch (IOException ignored) {}
        }
    }

    private JSONObject buildStatusJson() {
        JSONObject json = new JSONObject();
        try {
            json.put("ok", true);
            json.put("service", "tms-dex-host");
            json.put("device", Build.MANUFACTURER + " " + Build.MODEL);
            json.put("sdkInt", Build.VERSION.SDK_INT);
            json.put("privileged", privilegedMode || android.os.Process.myUid() == 2000 || android.os.Process.myUid() == 0);
            json.put("port", port);
            json.put("displayId", activeDisplayId);
            json.put("width", currentWidth);
            json.put("height", currentHeight);
            json.put("dpi", currentDpi);
            json.put("connectedClients", connectedClients);
            Map<String, String> usbIps = detectUsbInterfaces();
            JSONObject ifaceObj = new JSONObject();
            String primaryUsbIp = null;
            for (Map.Entry<String, String> entry : usbIps.entrySet()) {
                ifaceObj.put(entry.getKey(), entry.getValue());
                if (primaryUsbIp == null) primaryUsbIp = entry.getValue();
            }
            json.put("usbInterfaces", ifaceObj);
            json.put("usbIp", primaryUsbIp != null ? primaryUsbIp : JSONObject.NULL);
        } catch (Exception ignored) {}
        return json;
    }

    public static Map<String, String> detectUsbInterfaces() {
        Map<String, String> result = new HashMap<>();
        try {
            Enumeration<NetworkInterface> nets = NetworkInterface.getNetworkInterfaces();
            if (nets == null) return result;
            for (NetworkInterface nif : Collections.list(nets)) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                String name = nif.getName().toLowerCase();
                boolean isUsb = name.startsWith("ncm")
                        || name.startsWith("rndis")
                        || name.startsWith("usb")
                        || name.startsWith("eth")
                        || name.contains("tether");
                for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        String ip = addr.getHostAddress();
                        if (isUsb || (ip != null && (ip.startsWith("192.168.42.") || ip.startsWith("192.168.43.")))) {
                            result.put(name, ip);
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
        return result;
    }

    private void performWebSocketHandshake(OutputStream out, String wsKey) throws Exception {
        String magic = wsKey.trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
        String accept = Base64.getEncoder().encodeToString(sha1.digest(magic.getBytes(StandardCharsets.UTF_8)));
        String resp = "HTTP/1.1 101 Switching Protocols\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
        out.write(resp.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private void handleRemoteWebSocket(Socket socket, InputStream in, OutputStream out) {
        connectedClients++;
        final Object writeLock = new Object();
        final AtomicBoolean sessionAlive = new AtomicBoolean(true);
        final DeXSessionController[] sessionRef = new DeXSessionController[1];

        try {
            while (sessionAlive.get() && !socket.isClosed()) {
                WsFrame frame = readWsFrame(in);
                if (frame == null) break;

                if (frame.opcode == 0x8) { // CLOSE
                    break;
                } else if (frame.opcode == 0x9) { // PING -> PONG
                    sendWsFrame(out, writeLock, 0xA, frame.payload);
                } else if (frame.opcode == 0x1) { // TEXT
                    String text = new String(frame.payload, StandardCharsets.UTF_8);
                    handleClientMessage(text, out, writeLock, sessionRef, sessionAlive);
                }
            }
        } catch (Throwable ignored) {
        } finally {
            sessionAlive.set(false);
            if (sessionRef[0] != null) {
                sessionRef[0].stop();
                sessionRef[0] = null;
            }
            connectedClients = Math.max(0, connectedClients - 1);
            try { socket.close(); } catch (IOException ignored) {}
        }
    }

    private void handleClientMessage(
            String text,
            OutputStream out,
            Object writeLock,
            DeXSessionController[] sessionRef,
            AtomicBoolean sessionAlive
    ) {
        try {
            JSONObject msg = new JSONObject(text);
            // Input events in TMSRemote have short 't' keys ('m', 'd', 'b', 's', 'k', 'x', 'g')
            if (msg.has("t") && !msg.has("type")) {
                if (sessionRef[0] != null) {
                    sessionRef[0].handleInput(msg);
                }
                return;
            }

            String type = msg.optString("type", "");
            JSONObject payload = msg.optJSONObject("payload");

            switch (type) {
                case "remote:start": {
                    if (sessionRef[0] != null) {
                        sessionRef[0].stop();
                        sessionRef[0] = null;
                    }
                    int reqMaxW = payload != null ? payload.optInt("maxWidth", 2048) : 2048;
                    int reqMaxH = payload != null ? payload.optInt("maxHeight", 1536) : 1536;
                    int fps = payload != null ? payload.optInt("fps", 60) : 60;
                    int bitrateKbps = payload != null ? payload.optInt("bitrateKbps", 6000) : 6000;
                    int dpi = payload != null ? payload.optInt("dpi", 220) : 220;
                    boolean localCursor = payload == null || payload.optBoolean("localCursor", true);

                    int[] dims = computeAlignedDeXResolution(reqMaxW, reqMaxH);
                    currentWidth = dims[0];
                    currentHeight = dims[1];
                    currentDpi = Math.max(120, Math.min(360, dpi));

                    if (!privilegedMode && android.os.Process.myUid() != 2000 && android.os.Process.myUid() != 0) {
                        JSONObject err = new JSONObject();
                        err.put("type", "remote:error");
                        JSONObject errPayload = new JSONObject();
                        errPayload.put("code", "permission_screen");
                        errPayload.put("message", "DeX-Engine auf dem Fold 7 wartet auf ADB/Shell-Start (tms-terminal dex oder DeX-Button in der App).");
                        err.put("payload", errPayload);
                        sendWsText(out, writeLock, err.toString());
                        return;
                    }

                    DeXSessionController ctrl = new DeXSessionController(
                            currentWidth, currentHeight, currentDpi, fps, bitrateKbps, localCursor, out, writeLock, sessionAlive
                    );
                    sessionRef[0] = ctrl;
                    ctrl.start();
                    // Sound to the iPad speakers (viewer asks with audio:true; DeX mode always does).
                    if (payload != null && payload.optBoolean("audio", false)) {
                        boolean pcm = "pcm".equals(payload.optString("audioCodec", ""));
                        ctrl.audio = new DeXAudioCapture(shellContext(appContext), out, writeLock, pcm);
                        ctrl.audio.start();
                    }
                    break;
                }
                case "remote:diag": {
                    System.out.println("[TMS-DeX] iPad diag: " + (payload != null ? payload.toString() : "{}"));
                    break;
                }
                case "remote:stop": {
                    if (sessionRef[0] != null) {
                        sessionRef[0].stop();
                        sessionRef[0] = null;
                    }
                    break;
                }
                case "remote:keyframe": {
                    if (sessionRef[0] != null) {
                        sessionRef[0].requestKeyframe();
                    }
                    break;
                }
                case "remote:ack": {
                    if (sessionRef[0] != null && payload != null) {
                        long ts = payload.optLong("ts", 0);
                        sessionRef[0].onAck(ts);
                    }
                    break;
                }
            }
        } catch (Exception ignored) {}
    }

    /**
     * Computes a 16-pixel macroblock-aligned resolution that preserves the iPad's exact aspect ratio
     * (e.g. 4:3 -> 2048x1536 or 1920x1440) so Samsung DeX fills 100% of the iPad screen without black bars.
     */
    public static int[] computeAlignedDeXResolution(int maxWidth, int maxHeight) {
        int w = Math.max(1024, Math.min(2560, maxWidth > 0 ? maxWidth : 2048));
        int h = Math.max(768, Math.min(1920, maxHeight > 0 ? maxHeight : Math.round(w * 0.75f)));
        w = (w / 16) * 16;
        h = (h / 16) * 16;
        return new int[]{w, h};
    }

    // ── Virtual Display + MediaCodec H.264 + InputManager Controller ─────────

    private final class DeXSessionController {
        private final int width;
        private final int height;
        private final int dpi;
        private final int fps;
        private final int bitrateKbps;
        private final boolean localCursor;
        private final OutputStream out;
        private final Object writeLock;
        private final AtomicBoolean connAlive;
        private final AtomicBoolean active = new AtomicBoolean(false);
        private final AtomicLong lastClientAckTs = new AtomicLong(0);

        private VirtualDisplay virtualDisplay;
        private Object reflectiveVirtualDisplay;
        private int displayId = -1;
        private MediaCodec encoder;
        private Surface inputSurface;
        private Thread encodeThread;

        // Cursor & mouse button state on the DeX VirtualDisplay
        private float cursorX;
        private float cursorY;
        private int pressedButtons = 0;
        private long downTime = 0;

        // Reflection cache for InputManager & displayId targeting
        private Object inputManager;
        private Method injectInputEventMethod;
        private Method setDisplayIdMotionMethod;
        private Method setDisplayIdKeyMethod;

        DeXSessionController(
                int width,
                int height,
                int dpi,
                int fps,
                int bitrateKbps,
                boolean localCursor,
                OutputStream out,
                Object writeLock,
                AtomicBoolean connAlive
        ) {
            this.width = width;
            this.height = height;
            this.dpi = dpi;
            this.fps = Math.max(24, Math.min(60, fps));
            this.bitrateKbps = Math.max(800, Math.min(12000, bitrateKbps));
            this.localCursor = localCursor;
            this.out = out;
            this.writeLock = writeLock;
            this.connAlive = connAlive;
            this.cursorX = width / 2f;
            this.cursorY = height / 2f;
            initInputReflection();
        }

        private void initInputReflection() {
            try {
                // Android 14+ moved the singleton to InputManagerGlobal; older builds keep InputManager.getInstance().
                Class<?> imClass;
                try {
                    imClass = Class.forName("android.hardware.input.InputManagerGlobal");
                } catch (ClassNotFoundException e) {
                    imClass = Class.forName("android.hardware.input.InputManager");
                }
                Method getInstance = imClass.getDeclaredMethod("getInstance");
                getInstance.setAccessible(true);
                inputManager = getInstance.invoke(null);
                injectInputEventMethod = imClass.getDeclaredMethod("injectInputEvent", InputEvent.class, int.class);
                injectInputEventMethod.setAccessible(true);

                setDisplayIdMotionMethod = InputEvent.class.getDeclaredMethod("setDisplayId", int.class);
                setDisplayIdMotionMethod.setAccessible(true);
                setDisplayIdKeyMethod = setDisplayIdMotionMethod;
            } catch (Throwable t) {
                System.err.println("[TMS-DeX] Input reflection init warning: " + t.getMessage());
            }
        }

        void start() {
            if (!active.compareAndSet(false, true)) return;
            encodeThread = new Thread(this::runCaptureLoop, "TMS-DeX-Encoder");
            encodeThread.setDaemon(true);
            encodeThread.start();
        }

        DeXAudioCapture audio;

        void stop() {
            if (audio != null) { audio.stop(); audio = null; }
            if (!active.compareAndSet(true, false)) return;
            releaseResources();
        }

        void requestKeyframe() {
            MediaCodec codec = this.encoder;
            if (codec != null) {
                try {
                    Bundle b = new Bundle();
                    b.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
                    codec.setParameters(b);
                } catch (Throwable ignored) {}
            }
        }

        void onAck(long ts) {
            lastClientAckTs.set(ts);
        }

        private void runCaptureLoop() {
            try {
                MediaFormat format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
                format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
                format.setInteger(MediaFormat.KEY_BIT_RATE, bitrateKbps * 1000);
                format.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
                format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
                format.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline);
                format.setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel41);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
                }
                format.setInteger(MediaFormat.KEY_PRIORITY, 0);
                // Repeat previous frame every 100ms if screen is static so WebCodecs immediately renders on connect
                format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000L);

                encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
                encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                inputSurface = encoder.createInputSurface();
                encoder.start();

                displayId = createDeXVirtualDisplay(inputSurface);
                activeDisplayId = displayId;

                // Notify iPad WebView that the DeX stream has started
                JSONObject started = new JSONObject();
                started.put("type", "remote:started");
                JSONObject sp = new JSONObject();
                sp.put("width", width);
                sp.put("height", height);
                sp.put("scale", 1);
                sp.put("fps", fps);
                sp.put("codec", "avc1");
                sp.put("localCursor", localCursor);
                sp.put("displayId", displayId);
                sp.put("mode", "dex");
                started.put("payload", sp);
                sendWsText(out, writeLock, started.toString());

                long startMs = SystemClock.uptimeMillis();
                long lastStatMs = startMs;
                int statFrames = 0;
                long statBytes = 0;
                int droppedFrames = 0;
                byte[] configNal = null;

                MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
                while (active.get() && connAlive.get()) {
                    int outIndex = encoder.dequeueOutputBuffer(info, 20_000);
                    if (outIndex >= 0) {
                        ByteBuffer buf = encoder.getOutputBuffer(outIndex);
                        if (buf != null && info.size > 0) {
                            buf.position(info.offset);
                            buf.limit(info.offset + info.size);
                            byte[] nal = new byte[info.size];
                            buf.get(nal);

                            if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                                configNal = nal;
                            } else {
                                boolean isKey = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                                long tsMs = Math.max(0, SystemClock.uptimeMillis() - startMs);
                                long ackTs = lastClientAckTs.get();
                                boolean congested = !isKey && ackTs > 0 && (tsMs - ackTs) > 350;

                                if (congested) {
                                    droppedFrames++;
                                    requestKeyframe();
                                } else {
                                    byte[] payloadBytes;
                                    if (isKey && configNal != null) {
                                        payloadBytes = new byte[configNal.length + nal.length];
                                        System.arraycopy(configNal, 0, payloadBytes, 0, configNal.length);
                                        System.arraycopy(nal, 0, payloadBytes, configNal.length, nal.length);
                                    } else {
                                        payloadBytes = nal;
                                    }

                                    byte[] packet = packAccessUnit(payloadBytes, isKey, tsMs);
                                    sendWsFrame(out, writeLock, 0x2, packet);
                                    statFrames++;
                                    statBytes += packet.length;
                                }
                            }
                        }
                        encoder.releaseOutputBuffer(outIndex, false);
                    }

                    long now = SystemClock.uptimeMillis();
                    if (now - lastStatMs >= 1000) {
                        int kbps = (int) ((statBytes * 8) / Math.max(1, now - lastStatMs));
                        long ack = lastClientAckTs.get();
                        int rtt = ack > 0 ? (int) Math.min(999, Math.max(1, (now - startMs) - ack)) : 1;
                        JSONObject st = new JSONObject();
                        st.put("type", "remote:status");
                        JSONObject stp = new JSONObject();
                        stp.put("fps", statFrames);
                        stp.put("kbps", kbps);
                        stp.put("rttMs", rtt);
                        stp.put("dropped", droppedFrames);
                        st.put("payload", stp);
                        sendWsText(out, writeLock, st.toString());

                        statFrames = 0;
                        statBytes = 0;
                        lastStatMs = now;
                    }
                }
            } catch (Throwable t) {
                try {
                    JSONObject err = new JSONObject();
                    err.put("type", "remote:error");
                    JSONObject ep = new JSONObject();
                    ep.put("code", "capture_unavailable");
                    ep.put("message", "DeX VirtualDisplay Fehler: " + t.getMessage());
                    err.put("payload", ep);
                    sendWsText(out, writeLock, err.toString());
                } catch (Exception ignored) {}
            } finally {
                releaseResources();
            }
        }

        private int createDeXVirtualDisplay(Surface surface) throws Exception {
            if (appContext != null) {
                DisplayManager dm = shellDisplayManager(appContext);
                if (dm == null) dm = (DisplayManager) appContext.getSystemService(Context.DISPLAY_SERVICE);
                if (dm != null) {
                    try {
                        virtualDisplay = dm.createVirtualDisplay(
                                "TMS-DeX-iPad",
                                width,
                                height,
                                dpi,
                                surface,
                                DEX_VIRTUAL_DISPLAY_FLAGS
                        );
                        if (virtualDisplay != null && virtualDisplay.getDisplay() != null) {
                            return virtualDisplay.getDisplay().getDisplayId();
                        }
                    } catch (SecurityException se) {
                        // Fall back to standard public presentation flags if trusted flag requires system sig on older builds
                        int fallbackFlags = VIRTUAL_DISPLAY_FLAG_PUBLIC
                                | VIRTUAL_DISPLAY_FLAG_PRESENTATION
                                | VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY
                                | VIRTUAL_DISPLAY_FLAG_SUPPORTS_TOUCH;
                        virtualDisplay = dm.createVirtualDisplay(
                                "TMS-DeX-iPad",
                                width,
                                height,
                                dpi,
                                surface,
                                fallbackFlags
                        );
                        if (virtualDisplay != null && virtualDisplay.getDisplay() != null) {
                            return virtualDisplay.getDisplay().getDisplayId();
                        }
                    }
                }
            }
            return 0;
        }

        private synchronized void releaseResources() {
            activeDisplayId = -1;
            if (virtualDisplay != null) {
                try { virtualDisplay.release(); } catch (Throwable ignored) {}
                virtualDisplay = null;
            }
            if (encoder != null) {
                try { encoder.stop(); } catch (Throwable ignored) {}
                try { encoder.release(); } catch (Throwable ignored) {}
                encoder = null;
            }
            if (inputSurface != null) {
                try { inputSurface.release(); } catch (Throwable ignored) {}
                inputSurface = null;
            }
        }

        // ── Input Injection onto DeX Display ─────────────────────────────────

        void handleInput(JSONObject ev) {
            String t = ev.optString("t", "");
            switch (t) {
                case "m": { // Absolute pointer position (0..1)
                    float nx = (float) ev.optDouble("x", 0.5);
                    float ny = (float) ev.optDouble("y", 0.5);
                    cursorX = Math.max(0, Math.min(width - 1, nx * width));
                    cursorY = Math.max(0, Math.min(height - 1, ny * height));
                    int action = pressedButtons != 0 ? MotionEvent.ACTION_MOVE : MotionEvent.ACTION_HOVER_MOVE;
                    injectMouseMotion(action, 0, cursorX, cursorY, 0f, 0f);
                    break;
                }
                case "d": { // Relative pointer delta in points
                    float dx = (float) ev.optDouble("dx", 0);
                    float dy = (float) ev.optDouble("dy", 0);
                    cursorX = Math.max(0, Math.min(width - 1, cursorX + dx));
                    cursorY = Math.max(0, Math.min(height - 1, cursorY + dy));
                    int action = pressedButtons != 0 ? MotionEvent.ACTION_MOVE : MotionEvent.ACTION_HOVER_MOVE;
                    injectMouseMotion(action, 0, cursorX, cursorY, 0f, 0f);
                    emitCursorSync();
                    break;
                }
                case "b": { // Mouse button press/release ('l', 'r', 'm')
                    String btn = ev.optString("b", "l");
                    boolean down = ev.optBoolean("d", false);
                    int mask = "r".equals(btn)
                            ? MotionEvent.BUTTON_SECONDARY
                            : ("m".equals(btn) ? MotionEvent.BUTTON_TERTIARY : MotionEvent.BUTTON_PRIMARY);
                    // Android only treats a mouse click as a click with the BUTTON_PRESS/RELEASE
                    // pair around DOWN/UP (same sequence a real mouse and scrcpy produce).
                    if (down) {
                        boolean first = pressedButtons == 0;
                        pressedButtons |= mask;
                        if (first) {
                            downTime = SystemClock.uptimeMillis();
                            injectMouseMotion(MotionEvent.ACTION_DOWN, 0, cursorX, cursorY, 0f, 0f);
                        }
                        injectMouseMotion(MotionEvent.ACTION_BUTTON_PRESS, mask, cursorX, cursorY, 0f, 0f);
                    } else {
                        if ((pressedButtons & mask) == 0) break;
                        pressedButtons &= ~mask;
                        injectMouseMotion(MotionEvent.ACTION_BUTTON_RELEASE, mask, cursorX, cursorY, 0f, 0f);
                        if (pressedButtons == 0) {
                            injectMouseMotion(MotionEvent.ACTION_UP, 0, cursorX, cursorY, 0f, 0f);
                            downTime = 0;
                        }
                    }
                    break;
                }
                case "s": { // Scroll wheel / two-finger trackpad scroll
                    float dx = (float) ev.optDouble("dx", 0);
                    float dy = (float) ev.optDouble("dy", 0);
                    injectMouseMotion(MotionEvent.ACTION_SCROLL, 0, cursorX, cursorY, dx / 40f, dy / 40f);
                    break;
                }
                case "k": { // Hardware keyboard key
                    String code = ev.optString("c", "");
                    boolean down = ev.optBoolean("d", false);
                    JSONObject mods = ev.optJSONObject("mods");
                    int meta = 0;
                    if (mods != null) {
                        if (mods.optBoolean("s")) meta |= KeyEvent.META_SHIFT_ON | KeyEvent.META_SHIFT_LEFT_ON;
                        if (mods.optBoolean("c")) meta |= KeyEvent.META_CTRL_ON | KeyEvent.META_CTRL_LEFT_ON;
                        if (mods.optBoolean("a")) meta |= KeyEvent.META_ALT_ON | KeyEvent.META_ALT_LEFT_ON;
                        if (mods.optBoolean("m")) meta |= KeyEvent.META_META_ON | KeyEvent.META_META_LEFT_ON;
                    }
                    int keyCode = mapDomCodeToAndroidKeyCode(code);
                    if (keyCode != KeyEvent.KEYCODE_UNKNOWN) {
                        injectKeyEvent(down ? KeyEvent.ACTION_DOWN : KeyEvent.ACTION_UP, keyCode, meta);
                    }
                    break;
                }
                case "x": { // Direct text / dictation string
                    String s = ev.optString("s", "");
                    injectTextString(s);
                    break;
                }
                case "g": { // Multi-finger DeX gestures
                    String g = ev.optString("g", "");
                    if ("swipe-up".equals(g)) {
                        injectKeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_APP_SWITCH, 0);
                        injectKeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_APP_SWITCH, 0);
                    } else if ("swipe-down".equals(g)) {
                        injectKeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_HOME, 0);
                        injectKeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_HOME, 0);
                    }
                    break;
                }
            }
        }

        private void emitCursorSync() {
            if (!localCursor) return;
            try {
                JSONObject msg = new JSONObject();
                msg.put("type", "remote:cursor");
                JSONObject p = new JSONObject();
                p.put("x", cursorX / Math.max(1f, width));
                p.put("y", cursorY / Math.max(1f, height));
                msg.put("payload", p);
                sendWsText(out, writeLock, msg.toString());
            } catch (Exception ignored) {}
        }

        private void injectMouseMotion(int action, int actionButton, float x, float y, float hScroll, float vScroll) {
            if (inputManager == null || injectInputEventMethod == null) return;
            try {
                long now = SystemClock.uptimeMillis();
                long dt = downTime > 0 ? downTime : now;

                MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[1];
                props[0] = new MotionEvent.PointerProperties();
                props[0].id = 0;
                props[0].toolType = MotionEvent.TOOL_TYPE_MOUSE;

                MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[1];
                coords[0] = new MotionEvent.PointerCoords();
                coords[0].x = x;
                coords[0].y = y;
                boolean pressing = pressedButtons != 0 || action == MotionEvent.ACTION_BUTTON_RELEASE;
                coords[0].pressure = pressing ? 1.0f : 0.0f;
                coords[0].size = 1.0f;
                if (action == MotionEvent.ACTION_SCROLL) {
                    coords[0].setAxisValue(MotionEvent.AXIS_HSCROLL, hScroll);
                    coords[0].setAxisValue(MotionEvent.AXIS_VSCROLL, vScroll);
                }

                MotionEvent event = MotionEvent.obtain(
                        dt,
                        now,
                        action,
                        1,
                        props,
                        coords,
                        0,
                        pressedButtons,
                        1.0f,
                        1.0f,
                        0,
                        0,
                        InputDevice.SOURCE_MOUSE,
                        0
                );
                if (actionButton != 0) {
                    if (setActionButtonMethod == null) {
                        setActionButtonMethod = MotionEvent.class.getMethod("setActionButton", int.class);
                    }
                    setActionButtonMethod.invoke(event, actionButton);
                }
                if (displayId > 0 && setDisplayIdMotionMethod != null) {
                    setDisplayIdMotionMethod.invoke(event, displayId);
                }
                Object ok = injectInputEventMethod.invoke(inputManager, event, 0);
                if (Boolean.FALSE.equals(ok)) logInjectProblem("motion action=" + action + " rejected");
                event.recycle();
            } catch (Throwable t) {
                logInjectProblem("motion action=" + action + ": " + t);
            }
        }

        private Method setActionButtonMethod;
        private int injectProblems = 0;

        /** Injection failures were swallowed silently before; log the first few to the dex log. */
        private void logInjectProblem(String what) {
            if (injectProblems++ < 20) System.err.println("[TMS-DeX] inject problem: " + what);
        }

        private void injectKeyEvent(int action, int keyCode, int metaState) {
            if (inputManager == null || injectInputEventMethod == null) return;
            try {
                long now = SystemClock.uptimeMillis();
                KeyEvent ev = new KeyEvent(
                        now,
                        now,
                        action,
                        keyCode,
                        0,
                        metaState,
                        KeyCharacterMap.VIRTUAL_KEYBOARD,
                        0,
                        0,
                        InputDevice.SOURCE_KEYBOARD
                );
                if (displayId > 0 && setDisplayIdKeyMethod != null) {
                    setDisplayIdKeyMethod.invoke(ev, displayId);
                }
                Object ok = injectInputEventMethod.invoke(inputManager, ev, 0);
                if (Boolean.FALSE.equals(ok)) logInjectProblem("key " + keyCode + " rejected");
            } catch (Throwable t) { logInjectProblem("key " + keyCode + ": " + t); }
        }

        private void injectTextString(String text) {
            if (text == null || text.isEmpty() || inputManager == null || injectInputEventMethod == null) return;
            try {
                KeyCharacterMap kcm = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD);
                KeyEvent[] events = kcm.getEvents(text.toCharArray());
                if (events != null) {
                    for (KeyEvent ev : events) {
                        if (displayId > 0 && setDisplayIdKeyMethod != null) {
                            setDisplayIdKeyMethod.invoke(ev, displayId);
                        }
                        injectInputEventMethod.invoke(inputManager, ev, 0);
                    }
                }
            } catch (Throwable ignored) {}
        }
    }

    /**
     * Packs one H.264 Annex-B AccessUnit into the exact 5-byte TMSRemote binary header:
     *   byte 0   = 0x01 | (keyframe ? 0x80 : 0)
     *   byte 1-4 = uint32 BE timestamp in ms
     *   byte 5.. = Annex-B NAL payload
     */
    public static byte[] packAccessUnit(byte[] nalData, boolean keyframe, long tsMs) {
        byte[] out = new byte[5 + nalData.length];
        out[0] = (byte) (0x01 | (keyframe ? 0x80 : 0));
        long ts = Math.max(0, tsMs) & 0xFFFFFFFFL;
        out[1] = (byte) ((ts >>> 24) & 0xFF);
        out[2] = (byte) ((ts >>> 16) & 0xFF);
        out[3] = (byte) ((ts >>> 8) & 0xFF);
        out[4] = (byte) (ts & 0xFF);
        System.arraycopy(nalData, 0, out, 5, nalData.length);
        return out;
    }

    private static int mapDomCodeToAndroidKeyCode(String code) {
        if (code == null) return KeyEvent.KEYCODE_UNKNOWN;
        if (code.startsWith("Key") && code.length() == 4) {
            char c = code.charAt(3);
            if (c >= 'A' && c <= 'Z') return KeyEvent.KEYCODE_A + (c - 'A');
        }
        if (code.startsWith("Digit") && code.length() == 6) {
            char d = code.charAt(5);
            if (d >= '0' && d <= '9') return KeyEvent.KEYCODE_0 + (d - '0');
        }
        switch (code) {
            case "Enter":
            case "NumpadEnter": return KeyEvent.KEYCODE_ENTER;
            case "Backspace": return KeyEvent.KEYCODE_DEL;
            case "Delete": return KeyEvent.KEYCODE_FORWARD_DEL;
            case "Tab": return KeyEvent.KEYCODE_TAB;
            case "Space": return KeyEvent.KEYCODE_SPACE;
            case "Escape": return KeyEvent.KEYCODE_ESCAPE;
            case "ArrowUp": return KeyEvent.KEYCODE_DPAD_UP;
            case "ArrowDown": return KeyEvent.KEYCODE_DPAD_DOWN;
            case "ArrowLeft": return KeyEvent.KEYCODE_DPAD_LEFT;
            case "ArrowRight": return KeyEvent.KEYCODE_DPAD_RIGHT;
            case "Home": return KeyEvent.KEYCODE_MOVE_HOME;
            case "End": return KeyEvent.KEYCODE_MOVE_END;
            case "PageUp": return KeyEvent.KEYCODE_PAGE_UP;
            case "PageDown": return KeyEvent.KEYCODE_PAGE_DOWN;
            case "Minus": return KeyEvent.KEYCODE_MINUS;
            case "Equal": return KeyEvent.KEYCODE_EQUALS;
            case "BracketLeft": return KeyEvent.KEYCODE_LEFT_BRACKET;
            case "BracketRight": return KeyEvent.KEYCODE_RIGHT_BRACKET;
            case "Backslash": return KeyEvent.KEYCODE_BACKSLASH;
            case "Semicolon": return KeyEvent.KEYCODE_SEMICOLON;
            case "Quote": return KeyEvent.KEYCODE_APOSTROPHE;
            case "Backquote": return KeyEvent.KEYCODE_GRAVE;
            case "Comma": return KeyEvent.KEYCODE_COMMA;
            case "Period": return KeyEvent.KEYCODE_PERIOD;
            case "Slash": return KeyEvent.KEYCODE_SLASH;
            default: return KeyEvent.KEYCODE_UNKNOWN;
        }
    }

    // ── Minimal RFC 6455 WebSocket & HTTP Helpers ────────────────────────────

    private static final class WsFrame {
        final int opcode;
        final byte[] payload;
        WsFrame(int opcode, byte[] payload) {
            this.opcode = opcode;
            this.payload = payload;
        }
    }

    private static WsFrame readWsFrame(InputStream in) throws IOException {
        int b0 = in.read();
        if (b0 == -1) return null;
        int b1 = in.read();
        if (b1 == -1) return null;

        int opcode = b0 & 0x0F;
        boolean masked = (b1 & 0x80) != 0;
        long len = b1 & 0x7F;

        if (len == 126) {
            len = ((in.read() & 0xFF) << 8) | (in.read() & 0xFF);
        } else if (len == 127) {
            len = 0;
            for (int i = 0; i < 8; i++) {
                len = (len << 8) | (in.read() & 0xFF);
            }
        }

        byte[] mask = null;
        if (masked) {
            mask = new byte[4];
            readFully(in, mask);
        }

        if (len > 4 * 1024 * 1024) throw new IOException("Frame too large");
        byte[] payload = new byte[(int) len];
        readFully(in, payload);

        if (masked && mask != null) {
            for (int i = 0; i < payload.length; i++) {
                payload[i] ^= mask[i & 3];
            }
        }
        return new WsFrame(opcode, payload);
    }

    private static void sendWsText(OutputStream out, Object writeLock, String text) {
        sendWsFrame(out, writeLock, 0x1, text.getBytes(StandardCharsets.UTF_8));
    }

    static void sendWsFrame(OutputStream out, Object writeLock, int opcode, byte[] payload) {
        synchronized (writeLock) {
            try {
                out.write(0x80 | (opcode & 0x0F));
                int len = payload.length;
                if (len <= 125) {
                    out.write(len);
                } else if (len <= 65535) {
                    out.write(126);
                    out.write((len >>> 8) & 0xFF);
                    out.write(len & 0xFF);
                } else {
                    out.write(127);
                    // 64-bit length: shift a long — on an int, ">>> 56" is ">>> 24" (shift mod 32)
                    // and every frame over 64 KB (keyframes) got a garbage length.
                    long len64 = len;
                    for (int i = 56; i >= 0; i -= 8) {
                        out.write((int) ((len64 >>> i) & 0xFF));
                    }
                }
                out.write(payload);
                out.flush();
            } catch (IOException ignored) {}
        }
    }

    private static void readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int r = in.read(buf, off, buf.length - off);
            if (r == -1) throw new EOFException();
            off += r;
        }
    }

    private static String readHttpLine(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(128);
        int prev = -1;
        while (true) {
            int cur = in.read();
            if (cur == -1) {
                return bos.size() == 0 ? null : bos.toString("UTF-8");
            }
            if (prev == '\r' && cur == '\n') {
                byte[] bytes = bos.toByteArray();
                return new String(bytes, 0, Math.max(0, bytes.length - 1), StandardCharsets.UTF_8);
            }
            bos.write(cur);
            prev = cur;
            if (bos.size() > 8192) throw new IOException("HTTP line too long");
        }
    }

    private static void writeHttpJson(OutputStream out, int code, String body) throws IOException {
        byte[] bodyBytes = body.getBytes(StandardCharsets.UTF_8);
        String statusText = code == 200 ? "OK" : "Not Found";
        String header = "HTTP/1.1 " + code + " " + statusText + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: *\r\n"
                + "Content-Length: " + bodyBytes.length + "\r\n"
                + "Connection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.UTF_8));
        out.write(bodyBytes);
        out.flush();
    }
}
