# Terminal → App Browser-Bridge (CLI-Logins vom Handy)

**Datum:** 2026-07-17
**Status:** Design genehmigt — bereit für Implementierungsplan
**Branch (Code):** `feat/manager-chat-redesign` (Server + RN-App), Mockup im master-Worktree

## Ziel & Motivation

Wenn im TMS-Terminal (auf dem PC) ein CLI einen Browser öffnen will — typischerweise
für einen Login wie `render login`, `vercel login` — öffnet sich der Browser bisher
**am PC**. Wer per Handy remote arbeitet, muss dann an den PC. Dieses Feature leitet
solche Browser-Öffnen-Versuche in den **In-App-Browser des Handys** um, sodass der
Login vom Handy aus erledigt werden kann. Dank der bestehenden **Tailscale**-Verbindung
zwischen Handy und PC kann der `localhost`-Callback des CLI trotzdem den PC erreichen,
sodass der Login vollständig abschließt und das CLI sein Token bekommt.

## Nicht-Ziele (bewusst raus, YAGNI)

- **Kein** Fernsteuern/Spiegeln des echten PC-Chrome (kein CDP/Screen-Sharing). Der
  In-App-Browser ist eine eigene Browser-Session; das reicht, weil das Token am Ende
  beim CLI auf dem PC landet.
- **Kein** Abfangen von URLs, die ein CLI nur **in den Output druckt** (statt `open`
  aufzurufen). Für v1 raus; später über den vorhandenen Output-Detektor nachrüstbar.
- **Kein** Tailscale-IP-Rewrite/Port-Proxy (Weg B wurde verworfen, siehe unten).

## Gewählte Entscheidungen (aus dem Brainstorming)

1. **Grundansatz:** Login öffnet im App-Browser + Tailscale-Callback zurück zum PC.
2. **Steuerung:** **globaler Schalter** in der App. AN → jeder Browser-Öffnen-Versuch
   aus jedem Terminal geht ans Handy; AUS → Browser öffnet normal am PC.
3. **Callback:** **Weg A — Server-Relay** (nicht Tailscale-IP-Rewrite).
4. **Alarmierung:** **beides** — Push „🔐 Login öffnen · <Anbieter>" UND (wenn App im
   Vordergrund) automatisch den In-App-Browser auf die URL öffnen.

## User-facing Verhalten

- In den App-Einstellungen gibt es **einen globalen** Schalter
  **„Terminal-Browser aufs Handy leiten"**. Es ist eine einzige App-Einstellung
  (nicht pro Terminal, nicht pro Server); die App meldet ihren Stand an den gerade
  verbundenen Server (`browserbridge:toggle`) und meldet ihn beim Server-Wechsel erneut.
- Ist er AN und ein CLI ruft `open <https-URL>` / `xdg-open <URL>` / nutzt `$BROWSER`:
  - Push-Benachrichtigung „🔐 Login öffnen · <Host>". Tap → App öffnet In-App-Browser
    auf die URL.
  - Ist die App bereits offen, öffnet sich der In-App-Browser sofort (ohne Push-Tap).
- Nutzer loggt sich im In-App-Browser ein (einmalig; die WebView merkt sich Cookies).
- Nach dem Login schließt der Login **automatisch** ab (Callback-Relay, s.u.); die
  WebView zeigt die „Fenster kann geschlossen werden"-Seite bzw. eine Erfolgsmeldung.
- Ist der Schalter AUS, verhält sich alles wie bisher (Browser öffnet am PC).

## Architektur & Datenfluss

### Happy Path (Öffnen)

```
Terminal (PC):  $ vercel login
                └─ CLI ruft `open https://vercel.com/oauth/...`
                          │
   [1] tms-open-Shim (nur bei http(s)-URL; sonst echtes `open`)
                          │
   [2] Shim → POST http://127.0.0.1:<serverport>/internal/open-url
            { url, sessionId, secret }
                          │
   [3] Server prüft globalen Schalter:
          AUS → Antwort {action:"local"} → Shim ruft echtes `open` am PC
          AN  → Antwort {action:"handled"}, und:
                • WS → App:  browserbridge:open { url, host, sessionId }
                • FCM-Push „🔐 Login öffnen · <host>"
                          │
   [4] App: In-App-Browser auf <url> (Auto-Öffnen wenn Vordergrund; sonst per Push-Tap)
```

### Callback (Weg A — Server-Relay)

```
   Provider-Login (im App-Browser) → Redirect auf
            http://localhost:PORT/callback?code=…   (localhost = Handy!)
                          │
   [5] NativeBrowserLayer.onShouldStartLoadWithRequest fängt Host localhost/127.0.0.1 ab
        → bricht native Navigation ab, schickt volle URL an Server:
            WS → browserbridge:callback { url, sessionId }
                          │
   [6] Server (auf dem PC) GET http://127.0.0.1:PORT/callback?code=…  (loopback)
        → CLI-Listener erhält den Callback → Login schließt ab → CLI bekommt Token
                          │
   [7] Server → App: browserbridge:callback_result { status, html? }
        → WebView zeigt Erfolgsseite / „Login abgeschlossen ✓"
```

**Warum Weg A statt IP-Rewrite:** Die meisten CLIs binden ihren Callback-Listener an
`127.0.0.1` (loopback-only). Ein direkter Zugriff von der Tailscale-IP des Handys würde
abgewiesen. Der Server läuft aber auf dem PC und darf loopback → er stellt den Callback
selbst zu. Kein neuer offener Port auf der Tailscale-Schnittstelle nötig.

## Bauteile

### Server (`/Users/ayysir/Desktop/tms-terminal/server`)

- **`src/browserbridge/shim/`** — das `tms-open`-Shim-Skript (POSIX sh oder Node), plus
  ein Shim-Verzeichnis mit `open`, `xdg-open`, `sensible-browser`, `www-browser`, das
  bei PATH vorangestellt wird. Jedes Shim:
  - Prüft, ob das Argument eine `http(s)`-URL ist. **Nein** → `exec` des echten Binaries
    (via absoluten Pfad / `command -v` außerhalb des Shim-Dirs). **Ja** → POST an Server.
  - Liest `TMS_SESSION_ID` + `TMS_BROWSERBRIDGE_SECRET` + `TMS_SERVER_PORT` aus der Env.
  - Bei Server-Antwort `{action:"local"}` → echtes Binary ausführen (Schalter war AUS
    oder Server nicht erreichbar → Fallback = lokal öffnen, nie „verschluckt").
- **`src/utils/platform.ts` → `getTermEnv()`** injiziert:
  `PATH=<shim-dir>:$PATH`, `BROWSER=<shim-dir>/tms-open`, `TMS_SESSION_ID`,
  `TMS_BROWSERBRIDGE_SECRET`, `TMS_SERVER_PORT`.
  (Session-ID muss zum Spawn-Zeitpunkt bekannt sein — ggf. Env erst beim Session-Create
  final setzen, nicht in der generischen Factory; Detail für den Plan.)
- **`src/index.ts`** — neuer **loopback-only** Endpoint `POST /internal/open-url`
  (127.0.0.1 gebunden bzw. Host-Check), Secret-geprüft. Entscheidet anhand des
  Schalter-States und leitet an App weiter.
- **`src/browserbridge/manager.ts`** (neu) — hält den globalen Schalter-State, kennt die
  aktive App-Verbindung, macht das **Callback-Relay** (loopback-GET, nur `localhost`/
  `127.0.0.1`-Hosts), triggert Push.

### Shared-Protokoll (`/shared`)

Neue WS-Nachrichten:
- App → Server: `browserbridge:toggle { enabled }`, `browserbridge:callback { url, sessionId }`
- Server → App: `browserbridge:open { url, host, sessionId }`,
  `browserbridge:callback_result { status, html? }`

### App (`/mobile/src/season2`)

- **Schalter** in den Einstellungen (S2SettingsScreen bzw. klassische Settings) →
  `browserbridge:toggle`. State im Store, an den Server gemeldet.
- **`SeasonTwoWebRoot.tsx`** — Handler für `browserbridge:open` → In-App-Browser öffnen
  (`TMSBridge.openBrowser(url)`), Vordergrund-Auto-Open; Handler für
  `browserbridge:callback_result` → Erfolgsseite anzeigen.
- **`NativeBrowserLayer.tsx`** — `onShouldStartLoadWithRequest`: Host `localhost`/
  `127.0.0.1` → Navigation abbrechen, volle URL über die Bridge an den Server
  (`browserbridge:callback`).
- **`notifications.service`** — Push „🔐 Login öffnen · <host>", Tap-Route in den
  In-App-Browser.

## Sicherheit

- `POST /internal/open-url` ist **nur** über loopback erreichbar und verlangt das
  per-PTY injizierte `TMS_BROWSERBRIDGE_SECRET` → fremde lokale Prozesse können keine
  URLs einschleusen.
- Das Callback-Relay ruft **ausschließlich** Hosts `localhost`/`127.0.0.1` auf (kein
  SSRF auf andere interne Adressen). Nur während eines aktiven, nutzer-initiierten
  Login-Flows.
- Der Schalter ist standardmäßig **AUS** (kein versehentliches Kapern des PC-Browsers).

## Fehler & Kanten

- **Server-Antwort schlägt fehl / Schalter AUS:** Shim öffnet lokal (Fallback) — ein
  Browser-Öffnen wird nie „verschluckt".
- **`open datei.txt` / `open -a App` / `open .`:** kein Eingriff (nur http(s)-URLs).
- **Mehrere Logins gleichzeitig:** Zuordnung über `sessionId`.
- **CLI druckt URL nur (kein `open`):** v1 nicht abgedeckt (Nicht-Ziel).
- **Plattform:** Shim-Set plattformabhängig (macOS `open`, Linux `xdg-open`, Windows
  `start`/`cmd`); `platform.ts` kennt die Plattform bereits. Primärziel macOS.

## Test-Strategie

- **Unit (Server):** Shim-URL-Erkennung (URL vs. Datei/App-Arg), Schalter-Entscheidung
  (AN→handled / AUS→local), Callback-Relay (nur localhost, loopback-GET korrekt gebaut),
  Secret-Prüfung des Endpoints.
- **Unit (App):** `onShouldStartLoadWithRequest`-Logik (localhost abfangen, sonst
  durchlassen) gegen einen Mock.
- **Integration:** simuliertes `open https://…` in einer PTY → Server-Entscheidung →
  WS-Nachricht an einen Test-Client. On-Device-Vollpfad (echtes CLI-Login) manuell.

## Offene Punkte / Zukunft

- Output-URL-Erkennung (CLIs, die die URL nur drucken) als optionaler zweiter Fang.
- Windows/Linux-Shims verfeinern, falls der Server dort läuft.
- Optional: „Login abgeschlossen"-Toast auch im Terminal (dim line) spiegeln.
