# Ausklappbare Push-Benachrichtigungen (WhatsApp-Style)

**Datum:** 2026-04-23
**Status:** Design — User-Approval ausstehend
**Scope:** `server/src`, `mobile/src`, `mobile/android/.../AgentNotificationModule.kt`, `shared/protocol.ts`

---

## Ziel

Push-Benachrichtigungen für Manager-Agent-Aktivität sollen ausklappbar sein und deutlich mehr Text enthalten — so wie WhatsApp-Nachrichten, die man herunterziehen kann, um den vollen Text zu sehen.

**Aktueller Zustand:**
- Lokale Manager-Notifications (via `notifyManagerResponse` → native `AgentNotificationModule`) verwenden bereits `NotificationCompat.MessagingStyle`, aber der Preview ist auf **80 Zeichen** gekappt.
- Task-Events (`notifyTaskEvent`) haben 2-Wort-Bodies („Aufgabe abgeschlossen", „Aufgabe fehlgeschlagen").
- **Wenn die App gekillt ist, kommt keine Push** — es gibt keinen FCM-Push für Manager-Chat-Antworten. Nur lokale Notifications, die einen aktiven WebSocket brauchen.

**Zielzustand:**
- Manager-Chat-Antworten triggern eine Push — **außer** wenn der User gerade auf `ManagerChatScreen` ist.
- Body enthält bis zu 800 Zeichen, MessagingStyle expandiert automatisch beim Swipe.
- Lange Antworten bekommen „… (tap to read more)" als Hinweis; Tap öffnet den Chat.
- Task-Events bekommen die volle Task-Description als Body.
- Funktioniert auch bei gekillter App (via FCM-Push + Background-Handler → natives Modul).
- Eine Push pro Antwort — keine Duplikate zwischen lokaler und FCM-Notification.

---

## Architektur & Datenfluss

```
┌──────────────┐    manager:stream_end    ┌───────────────────────────────┐
│ Manager AI   │ ─────────────────────────▶│ ws.handler.ts                │
│ (server)     │                           │  ├─ sendManager()            │
└──────────────┘                           │  ├─ clientScreenState (Map)  │◀── client:screen_state
                                            │  └─ notifyManagerReply()     │    (heartbeat 10s)
                                            └──────────┬────────────────────┘
                                                       │ if screen!='manager_chat'
                                                       │    OR stale>15s
                                                       ▼
                                            ┌───────────────────────────────┐
                                            │ fcm.service.sendBig()         │
                                            │  - data-only payload          │
                                            │  - trunc 800 chars            │
                                            │  - debounce 3s per session    │
                                            └──────────┬────────────────────┘
                                                       │ FCM (data-only)
                                                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Mobile                                                                  │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ BackgroundHandler (notifications.service.ts)                        │ │
│ │  data.type === 'manager_reply' → NativeModules.AgentNotification    │ │
│ │    .show(title, body, avatarUri, messageId)                         │ │
│ └──────────────────────────┬──────────────────────────────────────────┘ │
│                            │                                            │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ Foreground WS-Handler (TerminalScreen.tsx)                          │ │
│ │  manager:stream_end + app!=active → notifyManagerResponse()         │ │
│ │    → NativeModules.AgentNotification.show(...)                      │ │
│ └──────────────────────────┬──────────────────────────────────────────┘ │
│                            ▼                                            │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ AgentNotificationModule.kt (UNCHANGED Style, gains messageId param) │ │
│ │  NotificationCompat.MessagingStyle + Avatar + Person                │ │
│ │  PendingIntent → MainActivity mit Extras (messageId, type)          │ │
│ └──────────────────────────┬──────────────────────────────────────────┘ │
│                            │ user tap                                   │
│                            ▼                                            │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ App.tsx — liest Intent-Extras → navigiert zu ManagerChatScreen      │ │
│ │  + scrollt zu messageId (falls gesetzt)                             │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

**Server entscheidet:**
- Schickt Server eine Push? → `clientScreenState` + `lastScreenStateAt` (stale > 15s)
- Debounce: max 1 Push pro 3s pro Session

**Mobile entscheidet:**
- Lokale Notification (via TerminalScreen WS-Handler) wenn `AppState != 'active'` UND `!chatScreenActive`
- FCM-Push wird nur ausgeliefert wenn Server sich dafür entscheidet

---

## Komponenten

### 1. `shared/protocol.ts`

Neue Client→Server-Message:

```ts
interface ClientScreenStateMsg {
  type: 'client:screen_state';
  payload: { activeScreen: 'manager_chat' | 'other'; foregrounded: boolean };
}
```

FCM `data`-Payload für Manager-Reply:

```ts
{
  type: 'manager_reply',
  text: string,       // gekürzter Body (800 chars)
  agentName: string,  // für Titel
  messageId: string,  // für Tap-Scroll
}
```

FCM `data`-Payload für Task-Events (unchanged structure, erweiterte Bodies):

```ts
{ taskId: string, type: 'task_completed' | 'task_failed' | 'task_needs_input' }
```

---

### 2. `server/src/notifications/fcm.service.ts`

Neue Methode `sendBig(token, title, body, data)`:

- Body wird auf max 800 chars trunkiert (Unicode-safe via `Array.from(body).slice(0, 800).join('')`).
- Wenn gekürzt: Suffix `"\n\n… (tap to read more)"`.
- **Sendet data-only** (kein `notification`-Field) → erzwingt Client-seitiges Rendering.
- Android-Config bleibt: `priority: 'high'` (damit Background-Handler zuverlässig läuft).

`send()` bleibt bestehen für kurze System-Benachrichtigungen (Idle-Detector, Watcher-Test).

---

### 3. `server/src/websocket/ws.handler.ts`

**State pro Connection:**

```ts
let clientScreenState = { activeScreen: 'other', foregrounded: false };
let lastScreenStateAt = 0;
let lastReplyPushAt = new Map<string, number>();  // debounce per sessionId
```

**Neuer Message-Handler:**

```ts
case 'client:screen_state':
  clientScreenState = msg.payload;
  lastScreenStateAt = Date.now();
  break;
```

**Neue Funktion `notifyManagerReply(text, sessionId?)`:**

```ts
const notifyManagerReply = (text: string, sessionId: string = 'manager-global'): void => {
  if (persistedTokens.size === 0) return;

  // Skip if user is actively on chat screen (und WS-State ist frisch)
  const stateAge = Date.now() - lastScreenStateAt;
  const stateIsFresh = stateAge < 15_000;
  if (stateIsFresh && clientScreenState.activeScreen === 'manager_chat' && clientScreenState.foregrounded) {
    return;
  }

  // Debounce: max 1 push pro 3s pro session
  const lastPush = lastReplyPushAt.get(sessionId) ?? 0;
  if (Date.now() - lastPush < 3_000) return;
  lastReplyPushAt.set(sessionId, Date.now());

  const agentName = managerService.personality.agentName ?? 'Manager';
  const cleanText = stripMarkdownForPush(text);
  const messageId = `mr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  for (const token of persistedTokens) {
    fcmService.sendBig(token, `💬 ${agentName}`, cleanText, {
      type: 'manager_reply',
      agentName,
      messageId,
    }).catch(() => { persistedTokens.delete(token); });
  }
};
```

**Wiring in `setupManagerCallbacks`:**

`onStreamEnd` (und `onResponse` für Parallel-Branch, falls relevant — aber nur einer soll pushen; wir nehmen `onStreamEnd`, weil das der endgültige Text ist).

**Neuer Helper:**

```ts
function stripMarkdownForPush(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code]')      // code fences
    .replace(/`([^`]+)`/g, '$1')                // inline code
    .replace(/\*\*(.+?)\*\*/g, '$1')            // bold
    .replace(/\*(.+?)\*/g, '$1')                // italic
    .replace(/^#+\s+/gm, '')                    // headers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')    // links
    .trim();
}
```

---

### 4. `server/src/manager/manager.service.ts`

`notifyTaskEvent` anpassen:

```ts
const titles = {
  completed:  `✅ Aufgabe fertig`,
  failed:     `❌ Aufgabe fehlgeschlagen`,
  needs_input: `🔔 Eingabe nötig`,
};
const bodies = {
  completed:  task.description,
  failed:     `${task.description}\n\nDie Task ist fehlgeschlagen.`,
  needs_input: `${task.description}\n\nDeine Eingabe wird benötigt.`,
};
for (const token of this.fcmTokens) {
  fcmService.sendBig(token, titles[event], bodies[event], { taskId: task.id, type: `task_${event}` })
    .catch(() => {});
}
```

Der Title ist jetzt generisch (`✅ Aufgabe fertig`), der Body enthält die Description. Das ermöglicht der MessagingStyle/BigTextStyle zu expandieren.

---

### 5. `server/src/watchers/watcher.service.ts`

Zeile 153: `fcmService.send(...)` → `fcmService.sendBig(...)`. Rein konsistent; Watcher-Messages können lang sein.

---

### 6. `mobile/src/services/managerNotifications.service.ts`

- Preview-Länge: **80 → 800 Zeichen**, Suffix `"\n\n… (tap to read more)"` wenn gekürzt.
- Unicode-safe Truncation: `Array.from(text).slice(0, 800).join('')`.
- Screen-Check erweitern: neue Variable `_chatScreenActive: boolean` + Setter:

```ts
let _chatScreenActive = false;
export function setChatScreenActive(active: boolean): void {
  _chatScreenActive = active;
}

export async function notifyManagerResponse(
  text: string,
  agentName: string,
  avatarUri?: string,
  messageId?: string,
): Promise<void> {
  if (AppState.currentState === 'active' && _chatScreenActive) return;
  // ... rest unchanged, plus messageId wird ans native Modul durchgereicht
}
```

---

### 7. `mobile/android/.../AgentNotificationModule.kt`

`show()` bekommt neuen Parameter:

```kotlin
@ReactMethod
fun show(title: String, body: String, avatarUri: String?, messageId: String?) {
  // ...
  val launchIntent = reactContext.packageManager.getLaunchIntentForPackage(reactContext.packageName)?.apply {
    putExtra("notificationType", "manager_reply")
    if (messageId != null) putExtra("messageId", messageId)
  }
  val pendingIntent = PendingIntent.getActivity(
    reactContext,
    notificationCounter, // unique per notification, sonst wird Intent wiederverwendet
    launchIntent,
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )
  // MessagingStyle-Rendering bleibt identisch
}
```

MessagingStyle-Setup bleibt unverändert — der Body wird via `.addMessage(body, ts, agentPerson)` übergeben. Android expandiert automatisch beim Swipe, Avatar + Conversation-Context bleiben.

---

### 8. `mobile/src/screens/ManagerChatScreen.tsx`

```ts
useEffect(() => {
  setChatScreenActive(true);
  wsService.send({
    type: 'client:screen_state',
    payload: { activeScreen: 'manager_chat', foregrounded: AppState.currentState === 'active' },
  } as any);

  const appStateSub = AppState.addEventListener('change', (nextState) => {
    wsService.send({
      type: 'client:screen_state',
      payload: { activeScreen: 'manager_chat', foregrounded: nextState === 'active' },
    } as any);
  });

  // Heartbeat alle 10s (Server braucht frische State-Info für stale-Detection)
  const heartbeat = setInterval(() => {
    wsService.send({
      type: 'client:screen_state',
      payload: { activeScreen: 'manager_chat', foregrounded: AppState.currentState === 'active' },
    } as any);
  }, 10_000);

  return () => {
    setChatScreenActive(false);
    clearInterval(heartbeat);
    appStateSub.remove();
    wsService.send({
      type: 'client:screen_state',
      payload: { activeScreen: 'other', foregrounded: AppState.currentState === 'active' },
    } as any);
  };
}, []);
```

Auf anderen Screens (`TerminalScreen`, `HomeScreen`, etc.) wird kein Screen-State geschickt — Server bleibt beim letzten bekannten State (`activeScreen: 'other'`).

---

### 9. `mobile/src/App.tsx`

Zusätzlich zum bestehenden `addNotificationResponseReceivedListener`:

```ts
// Check launch intent for native-notification extras (from AgentNotificationModule)
useEffect(() => {
  const checkLaunchIntent = async () => {
    const initialUrl = await Linking.getInitialURL();
    // Native module puts extras on the launch intent; read via a tiny native bridge
    // method `AgentNotification.consumeLaunchExtras(): {type, messageId} | null`
    const extras = NativeModules.AgentNotification?.consumeLaunchExtras?.();
    if (extras?.notificationType === 'manager_reply') {
      navigationRef.current?.navigate('ManagerChat');
      // Scroll-to-messageId: siehe Out-of-Scope (Stretch Goal)
    }
  };
  checkLaunchIntent();
}, []);
```

Neue Kotlin-Methode in `AgentNotificationModule.kt`:

```kotlin
@ReactMethod
fun consumeLaunchExtras(promise: Promise) {
  val activity = currentActivity ?: return promise.resolve(null)
  val intent = activity.intent
  val type = intent?.getStringExtra("notificationType")
  if (type == null) return promise.resolve(null)
  val messageId = intent.getStringExtra("messageId")
  val result = Arguments.createMap().apply {
    putString("notificationType", type)
    if (messageId != null) putString("messageId", messageId)
  }
  // Clear extras so same tap doesn't re-trigger on next app-resume
  intent.removeExtra("notificationType")
  intent.removeExtra("messageId")
  promise.resolve(result)
}
```

---

### 10. `mobile/src/services/notifications.service.ts`

Background-Handler erweitern:

```ts
export function registerBackgroundHandler(): void {
  messaging().setBackgroundMessageHandler(async (message) => {
    const type = message.data?.type;

    if (type === 'manager_reply') {
      const text = String(message.data?.text ?? '');
      const agentName = String(message.data?.agentName ?? 'Manager');
      const messageId = String(message.data?.messageId ?? '');
      const avatarUri = await readAvatarUriFromStorage(); // helper, liest aus AsyncStorage

      if (Platform.OS === 'android' && NativeModules.AgentNotification) {
        NativeModules.AgentNotification.show(
          `💬 ${agentName}`, text, avatarUri ?? null, messageId,
        );
      }
      return;
    }

    // Task-events: use data-only, render via Expo fallback
    if (type?.startsWith('task_')) {
      const title = String(message.data?.title ?? '');
      const body = String(message.data?.body ?? '');
      await Notifications.scheduleNotificationAsync({
        content: {
          title, body, sound: 'default',
          data: message.data as Record<string, string>,
          ...(Platform.OS === 'android' ? { channelId: 'terminal-prompts' } : {}),
        },
        trigger: null,
      });
    }
  });
}
```

Avatar-Caching: Mobile speichert `personality.agentAvatarUri` in AsyncStorage beim Update → Background-Handler kann darauf zugreifen ohne den Store laden zu müssen.

---

## Edge Cases & Fixes

| # | Fall | Behandlung |
|---|------|-----------|
| 1 | 3 schnelle Replies in 1s | Server-Debounce: max 1 Push pro 3s pro Session |
| 2 | App gebackgrounded + WS offen + Manager antwortet | Server sieht WS-State „ManagerChat + foregrounded=false" → schickt FCM. Mobile lokaler Handler sieht `AppState != active` → rendert lokal. **Problem: Duplikat.** **Fix:** Server sieht `foregrounded: false` als „App backgrounded, braucht aber die Push" → schickt FCM. Aber: Mobile-lokaler Handler soll in diesem Fall NICHT auch rendern. **Lösung:** Mobile unterdrückt lokalen Render wenn `!_chatScreenActive && AppState !== 'active'` → Server übernimmt via FCM. Regel: **Local notification nur wenn App foregrounded + nicht auf Chat**. |
| 3 | WS stale > 15s, Manager antwortet | Server sendet FCM (stale → gilt als offline) |
| 4 | Markdown / Code-Blöcke im Text | `stripMarkdownForPush()` entfernt vor Senden |
| 5 | FCM-Token gelöscht | `persistedTokens.delete(token)` on error (bestehende Logik) |
| 6 | Native Modul nicht verfügbar (iOS) | Fallback auf `Notifications.scheduleNotificationAsync` (bestehend) |
| 7 | User tappt Push während Chat bereits offen | Navigation ist idempotent; ManagerChatScreen ist schon offen → kein Effekt |
| 8 | Task-Description leer | Fallback: `"(ohne Beschreibung)"` |

**Präzisierung zu Fall 2:**

Zwei Zustände → wer rendert?

| AppState | chatScreenActive | Lokaler Render | FCM vom Server | Resultat |
|---|---|---|---|---|
| `active` | `true` | Nein (skip) | Nein (Server skippt) | Kein Push (Chat ist offen) ✓ |
| `active` | `false` | Ja (lokal) | Nein (Server skippt, weil `foregrounded=true`) | 1 lokale Notif ✓ |
| `background` | — | Nein (Regel: nur wenn `active`) | Ja (Server sieht `foregrounded=false`) | 1 FCM-Notif ✓ |
| app killed | — | — | Ja (WS stale > 15s) | 1 FCM-Notif ✓ |

→ **Neue Regel in `notifyManagerResponse`**: Nur rendern wenn `AppState.currentState === 'active' && !_chatScreenActive`. Wenn `AppState !== 'active'` → Server übernimmt.

---

## Test-Plan

| # | Szenario | Erwartung |
|---|----------|-----------|
| 1 | App offen, ManagerChatScreen aktiv, Manager antwortet mit 500 chars | Keine Push, Text nur im Chat |
| 2 | App offen, TerminalScreen, Manager antwortet 500 chars | 1 lokale Push via native MessagingStyle, ausklappbar |
| 3 | App offen, TerminalScreen, Manager antwortet 1500 chars | Push zeigt 800 chars + „… (tap to read more)", Tap → Chat |
| 4 | App gebackgrounded, Manager antwortet | 1 FCM-Push → native Modul → MessagingStyle |
| 5 | App gekillt, Manager antwortet | 1 FCM-Push via Background-Handler, Tap öffnet App + navigiert zu Chat |
| 6 | App gekillt → reconnected nach 10s, Manager hat 2x geantwortet | Max 1 FCM-Push pro 3s (globaler Debounce, siehe #9). Bei ≥3s Abstand: 2 Pushes. Bei <3s: 1 Push. Gepufferte WS-Messages kommen beim Reconnect, keine Duplikate |
| 7 | Task completed mit kurzer Description | Titel `✅ Aufgabe fertig`, Body = Description, ausklappbar |
| 8 | Task failed mit langer Description | Body zeigt Description + Zusatzzeile |
| 9 | 3 Replies in 1s | Max 1 Push (Debounce) |
| 10 | Text mit `**bold**` + Code-Fences | Push-Text ist plain |
| 11 | Tap auf Manager-Push | App öffnet + navigiert zu `ManagerChatScreen` |
| 12 | Tap auf Task-Push | App öffnet + navigiert zum Terminal |
| 13 | User tippt Push während App schon offen auf Chat | No-op (idempotent) |
| 14 | WS offline > 15s (Doze-Mode) | Server sendet FCM (stale-Detection) |

---

## Out-of-Scope

- **iOS Push-Parität**: Aktuell reines Android-Projekt. iOS-Fallback über `expo-notifications` existiert, aber keine MessagingStyle-Entsprechung auf iOS (nur `UNNotificationAttachment` für Medien). Kein Blocker.
- **Reply-from-Notification**: Notifee o.ä. würde Quick-Reply-Actions ermöglichen. Explizit ausgeschlossen (Ansatz A).
- **Push-Settings UI**: User soll nicht pro Event-Typ an-/ausschalten können in diesem Change. Bestehender globaler Toggle in Settings bleibt.
- **Scroll-to-Message beim Tap (Stretch Goal)**: `messageId` wird bereits durchgereicht, aber der Chat-Screen-Scroll ist ein Nice-to-have. Kommt in einem Follow-up, nicht zwingend in diesem Change.

---

## Migration / Rollout

- Kein Server-Schema-Change, kein DB-Change.
- Mobile-Update ist abwärtskompatibel: wenn ein alter Client ohne `client:screen_state` läuft, Server hat Default-State `{ activeScreen: 'other', foregrounded: false }` → Push geht immer raus (nicht schlimm, eher mehr Pushes als weniger).
- Server-Update kann unabhängig deployt werden: `notifyManagerReply` ist additive.
- Reihenfolge: erst Server (neue `sendBig`, Screen-State-Handler, Debounce), dann Mobile (Screen-State-Emitter, Background-Handler für `manager_reply`, Native-Modul-Update).
