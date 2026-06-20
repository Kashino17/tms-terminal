# AI-Thinking-Glow auf Manager-Chat-Panes — Design

**Date:** 2026-04-28
**Status:** Approved
**Scope:** Single feature, single screen (V2 Manager Chat → MultiSpotlight panes)

---

## Goal

Während eine CLI im Pane "denkt" (Claude/Codex/Gemini wartet auf Modell-Response,
zeigt Spinner + Elapsed-Time + "esc to interrupt"), pulsiert der Pane-Rahmen
in einem ruhigen Glow. Sobald das CLI idle ist (Prompt zurück, kein Spinner),
fällt der Rahmen sanft auf seinen normalen statischen Zustand zurück.

## Non-Goals

- Glow im V1-TerminalScreen (nur Manager-Chat V2)
- Settings-Toggle zum Aus-/Anschalten (YAGNI; Folge-Schritt falls nervig)
- Per-AI-Tool-spezifische Glow-Farben (Pane behält seine Identitätsfarbe)
- Server-seitige Detection — der Mobile-Client hat alle relevanten Daten,
  Server-Round-Trip wäre Overhead für ein rein visuelles Feature
- Detektion außerhalb von Claude/Codex/Gemini-CLIs (`tab.aiTool` filtert)

## Background

Das Repo hat bereits relevante Bausteine:

- `mobile/src/components/TerminalView.tsx:54` — `detectAiTool(rawData)` läuft
  schon auf jedem ankommenden Output-Chunk und setzt `tab.aiTool`.
- `mobile/src/components/manager/MultiSpotlight.tsx:185-202` — Pane-Wrapper
  hat bereits `tcolor`, statische Shadow-Properties (`shadowColor`,
  `shadowRadius: 8`, `shadowOpacity: 1`, `elevation: 4`) am `paneActive`-Style.
  Glow-Infrastruktur existiert, ist nur statisch.
- `mobile/src/screens/ManagerChatScreenV2.tsx:1552` — `statusFor(sid)` hat
  einen TODO-Kommentar genau für diesen Fall: "derive from terminal activity
  (idle > 60s, last AI tool detected, exit code, etc.)".

D.h. wir bauen auf vorhandener Architektur auf.

## User Story

User schickt im Manager-Chat einen Prompt an Claude im Pane 1. Während Claude
"Contemplating… (1m 31s)" zeigt:

1. Pane 1 fängt an zu glühen — der orange Rahmen pulsiert weich zwischen
   Voll-Sättigung und einem ~12 % helleren Tint, der Shadow atmet von
   `radius=6`/`opacity=0.5` zu `radius=14`/`opacity=1` über ~1.6 s Loop.
2. Pane 2 (Shell ohne CLI) bleibt unverändert ruhig.
3. Sobald Claude den Prompt zurückbringt (`>` mit Cursor) bzw. 2 s ohne
   Thinking-Signal vergehen, fadet der Glow über ~300 ms zurück auf den
   normalen statischen Zustand.

## Detection

### Modul (`mobile/src/utils/aiThinkingDetector.ts`, neu)

Stateful per Session, weil wir Idle-Timeouts brauchen.

```ts
export interface ThinkingDetector {
  feed(data: string): void;
  isThinking(): boolean;
  /** Subscribe to state changes — only fires when value actually flips. */
  onChange(cb: (thinking: boolean) => void): () => void;
  dispose(): void;
}

export function createThinkingDetector(opts?: {
  idleTimeoutMs?: number;  // default 2000
}): ThinkingDetector;
```

### Patterns

```ts
// Strong signal — alle drei CLIs (Claude, Codex, Gemini) drucken das
// während aktiver Wartephase als Hinweis "drück ESC zum Abbrechen".
const ESC_INTERRUPT = /esc to interrupt/i;

// Verb + elapsed-time pattern. Claude rotiert seine Verben — die Liste deckt
// die in Claude-Code beobachteten ab. Wenn Anthropic neue dazu nimmt, fallen
// die durchs Raster, aber ESC_INTERRUPT fängt sie trotzdem.
const VERB_TIME = /\b(?:Contemplating|Churning|Cooking|Sautéing|Cooked|Sautéed|Churned|Cogitating|Thinking|Pondering|Crafting|Brewing|Forging|Working|Processing)\b[^\n]*?\(?\d+m?\s*\d+s\)?/i;
```

`feed(data)` strippt ANSI (über `mobile/src/utils/stripAnsi.ts`, schon
existent), prüft beide Patterns. Match → setzt `thinking = true` und resettet
den Idle-Timer auf `idleTimeoutMs`. Wenn der Timer feuert ohne neuen Match
→ `thinking = false`.

State-Flips fahren `onChange`-Subscriber. Keine Notifies bei No-Op-Flips
(wenn `feed` true sieht und der Detektor schon true war → kein Callback).

### Wiring (`mobile/src/components/TerminalView.tsx`)

Neuer optionaler Prop:

```ts
onThinkingChange?: (thinking: boolean) => void;
```

In der bestehenden Daten-Empfangs-Branch (gleicher Codepfad wie
`detectAiTool`) wird ein Per-Component-`ThinkingDetector` gefüttert. Bei
Unmount: `detector.dispose()` (Timer cleanup).

`onThinkingChange` ist nur ein Pass-Through der Detector-Subscription —
kein eigener State im TerminalView, keine Re-Render durch das Feature.

## State + Wiring (`mobile/src/screens/ManagerChatScreenV2.tsx`)

Neuer State:

```ts
const [thinkingMap, setThinkingMap] = useState<Record<string, boolean>>({});
```

Pro `MultiSpotlight`-Pane wird `onThinkingChange` an die `TerminalView`
durchgereicht (über MultiSpotlight) und der Callback updated `thinkingMap`:

```ts
const setThinking = useCallback((sid: string, thinking: boolean) => {
  setThinkingMap((prev) => {
    if (prev[sid] === thinking) return prev;       // stable refs
    if (!thinking) {
      const { [sid]: _, ...rest } = prev;          // prune false-entries
      return rest;
    }
    return { ...prev, [sid]: true };
  });
}, []);
```

Cleanup-Effect: wenn `tabs` sich ändert und ein `sid` aus `thinkingMap`
verschwunden ist, raus aus der Map.

Zwei neue Props an MultiSpotlight:

```ts
thinkingFor?: (sid: string) => boolean;
onPaneThinkingChange?: (sid: string, thinking: boolean) => void;
// passed:
thinkingFor={(sid) => thinkingMap[sid] === true}
onPaneThinkingChange={setThinking}
```

`onPaneThinkingChange` ist die Bubble-Up-Channel: MultiSpotlight verkabelt
intern `<TerminalView onThinkingChange={(t) => onPaneThinkingChange?.(sid, t)} />`
für jeden Pane mit Session.

## Animation (`mobile/src/components/manager/MultiSpotlight.tsx`)

### Prop

```ts
thinkingFor?: (sid: string) => boolean;
```

### Pro-Pane Animation

Im `forwardRef`-Body, einmalig erstellte `Animated.Value`-Refs pro Pane-Index:

```ts
const pulseRefs = useRef<Animated.Value[]>([]);
const loopRefs = useRef<Array<Animated.CompositeAnimation | null>>([]);

// Lazy init
function getPulse(i: number): Animated.Value {
  if (!pulseRefs.current[i]) pulseRefs.current[i] = new Animated.Value(0);
  return pulseRefs.current[i];
}
```

In `renderPane`, nach `tcolor`/`status`-Berechnung:

```ts
const thinking = thinkingFor?.(sid) ?? false;
const pulse = getPulse(i);
```

Effect (im Component-Body, in einer eigenen `useEffect`-Schleife):

```ts
useEffect(() => {
  panes.forEach((sid, i) => {
    const thinking = sid ? (thinkingFor?.(sid) ?? false) : false;
    const pulse = getPulse(i);
    const existing = loopRefs.current[i];
    if (thinking && !existing) {
      const loop = Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 800, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      ]));
      loopRefs.current[i] = loop;
      loop.start();
    } else if (!thinking && existing) {
      existing.stop();
      loopRefs.current[i] = null;
      Animated.timing(pulse, { toValue: 0, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
    }
  });
}, [panes, thinkingFor]);
```

Cleanup on unmount: stop all loops.

### Pane-Wrapper

`<View>` → `<Animated.View>` mit interpolierten Style:

```ts
const interp = (from: number, to: number) => pulse.interpolate({ inputRange: [0, 1], outputRange: [from, to] });

<Animated.View
  style={[
    s.pane,
    { borderLeftColor: tcolor },
    isActive && { ...s.paneActive, shadowColor: tcolor, borderColor: tcolor },
    thinking && {
      shadowColor: tcolor,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: interp(0.5, 1),
      shadowRadius: interp(6, 14),
      elevation: interp(2, 6) as any,   // Animated.AnimatedNode at runtime
      borderColor: pulse.interpolate({
        inputRange: [0, 1],
        outputRange: [tcolor, lighten(tcolor, 0.12)],  // util in terminalColors
      }),
    },
    focusedPaneIndex != null && i !== focusedPaneIndex && s.paneHiddenInFocus,
  ]}
>
```

`lighten(hex, amount)` ist eine kleine reine Funktion in
`mobile/src/utils/terminalColors.ts` (oder neu, falls da noch nichts drin
ist), die HSL umrechnet und Luminanz erhöht.

### Performance

- `useNativeDriver: false` — notwendig (borderColor + shadowRadius +
  elevation sind keine native-driver-fähigen Properties).
- Max 4 parallele Loops (4 Panes), 1.25 fps effektive State-Updates pro
  Loop (8 frames per 800 ms Sub-Animation × 2 = 16 frames/loop / 1.6 s
  → ~10 fps Updates pro Pane). JS-Thread-Last vernachlässigbar.
- Loop wird gestoppt sobald `thinking === false` → keine idle CPU-Last.

## Edge Cases

| Fall | Verhalten |
|------|-----------|
| Mehrere Panes thinking gleichzeitig | Jede pulsiert unabhängig mit ihrem eigenen `Animated.Value` |
| Pane wird zugemacht / Session-ID gewechselt | `thinkingMap`-Cleanup-Effect prunes; Animator wird gestoppt im nächsten Effect-Run |
| Pane ist nicht aktiv aber thinkt | Glow erscheint trotzdem — wichtig, damit User Background-Aktivität sieht |
| Aktive Pane mit Thinking | Glow überschreibt den existierenden statischen Shadow während der Pulse-Phase |
| TerminalView mit falschem aiTool (z.B. shell-only) | `ESC_INTERRUPT` matched dort sehr unwahrscheinlich; falls doch (Edge-Case): Glow zeigt sich kurz, Idle-Timer läscht ihn nach 2 s. Akzeptabel. |
| App goes background während Thinking | RN pausiert Animations meist; beim Resume springt Glow zurück (akzeptabel) |
| Detector dispose während Loop läuft | Loop-Stop in MultiSpotlight-Cleanup, Detector-Cleanup in TerminalView-Unmount |
| Race: feed() und gleichzeitiger Idle-Timeout | Idle-Timer wird bei jedem feed() resetted → kein Race |

## Files

| Datei | Änderung |
|-------|----------|
| `mobile/src/utils/aiThinkingDetector.ts` | neu — `createThinkingDetector()` mit `feed`/`isThinking`/`onChange`/`dispose` |
| `mobile/src/utils/terminalColors.ts` | erweitern — exportiert zusätzlich `lighten(hex, amount)` (oder neue Datei `colorUtils.ts`, wenn besser passt) |
| `mobile/src/components/TerminalView.tsx` | neuer Prop `onThinkingChange`; Detector-Instanz im Component, Feed-Hook in der bestehenden Daten-Branch, Dispose in Unmount-Effect |
| `mobile/src/components/manager/MultiSpotlight.tsx` | neue Props `thinkingFor` + `onPaneThinkingChange`; pulse-Animator pro Pane; Pane-Wrapper wird `Animated.View`; Effect für loop start/stop; Cleanup; `<TerminalView onThinkingChange>` intern verkabelt mit `onPaneThinkingChange?.(sid, t)` |
| `mobile/src/screens/ManagerChatScreenV2.tsx` | `thinkingMap`-State; `setThinking(sid, thinking)`-Helper; Cleanup-Effect für stale sids; übergibt `thinkingFor` und `onPaneThinkingChange={setThinking}` an MultiSpotlight |

## Testing

Manuell (kein Unit-Test-Setup für RN-Komponenten):

1. Manager-Chat öffnen, Pane 1 mit `claude` fütterm (oder beliebiges
   Terminal mit Claude-Session). Anweisung schicken, die ~30 s rechnet.
2. Während "Contemplating… (5s)" → Pane 1 glüht weich.
3. Pane 2 mit nur `bash`, keine CLI → bleibt ruhig.
4. Antwort kommt zurück, Cursor blinkt am Prompt → Glow fadet aus innerhalb
   ~2.3 s (2 s Idle + 0.3 s fade).
5. Während Claude denkt, mit `Strg+C` abbrechen → Glow fadet sofort aus
   beim Prompt-Return.
6. Zwei Panes parallel thinking → beide glühen unabhängig.
7. App in Background + zurück → Glow läuft wieder oder ist sauber aus.
8. Performance: 4 Panes, alle thinking → keine spürbare Frame-Drops beim
   Scrollen / Tippen.

## TypeScript-Validation

`cd mobile && npx tsc --noEmit -p tsconfig.json` muss exit 0.

## Out of Scope (Future)

- Glow-Toggle in Settings (wenn User sich beschwert)
- V1-TerminalScreen Glow (User hat A gewählt)
- Per-AI-Tool eigene Glow-Farbe
- "Thinking-Phase"-Sub-States (planning vs. tool-call vs. streaming) — ist
  separat im Manager-Service vorhanden, aber für CLIs im Terminal nur via
  Output-Pattern verfügbar und nicht das Ziel hier
