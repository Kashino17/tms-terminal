# Shell-Naming: Echte Terminal-Namen für Manager Agent

**Datum:** 2026-04-10
**Status:** Approved

## Problem

Die AI und der User kommunizieren über "Shell 1/2/3" — generische Labels die nicht erkennen lassen welches Terminal gemeint ist. Die Terminals haben aber echte Namen (CWD-Ordnernamen wie "ayysir", "TMS Terminal") die in der Tab-Leiste angezeigt werden.

## Lösung

Kombination aus echtem Namen + Shell-Nummer: "Shell 1 · ayysir". Drei Änderungen:

---

## 1. Server: Labels mit echten Namen

### `ws.handler.ts`

Bei `terminal:create` und `terminal:reattach`: CWD-Ordnername auslesen und ins Label packen.

```
setSessionLabel(session.id, "Shell 1 · ayysir")
```

- CWD kommt aus `session.cwd` (bei reattach verfügbar) oder aus dem PTY-Prozess
- Ordnername = letztes Segment des Pfads (z.B. `/Users/ayysir` → "ayysir")
- Fallback: `"Shell N"` ohne Suffix wenn kein CWD bekannt

### Label-Updates bei CWD-Änderungen

Bei `terminal:reattach` wird das Label mit dem aktuellen CWD aktualisiert. Das reicht — CWD ändert sich selten genug.

---

## 2. AI-Kontext + Tool-Matching

### `resolveLabel()` in `manager.service.ts`

Muss jetzt auch den Ordnernamen matchen:
- "Shell 1" → matcht "Shell 1 · ayysir" (beginnt mit "Shell 1")
- "ayysir" → matcht "Shell 1 · ayysir" (enthält "ayysir")
- "Shell 1 · ayysir" → exakter Match

### Tool-Description Update

`write_to_terminal.session_label` Description ändern zu:
```
"Terminal-Name oder Shell-Nummer, z.B. 'Shell 1', 'ayysir', 'TMS Terminal'"
```

### `formatContextBlock()` — keine Änderung nötig

Zeigt bereits `ctx.label` an. Durch die Label-Änderung zeigt es automatisch die echten Namen.

---

## 3. Mobile: Manager-Chips mit echten Namen

### `ManagerChatScreen.tsx`

Die Chips unten im Chat zeigen aktuell `Shell ${idx+1}` oder `tab.customTitle`. Ändern zu:

```
S{idx+1} · {tabDisplayName(tab)}
```

Nutzt das bestehende `tabDisplayName()` Utility aus `mobile/src/utils/tabDisplayName.ts`.

---

## Was unverändert bleibt

- `tabDisplayName()` Utility — existiert schon
- Terminal-Screen Tab-Leiste — zeigt schon echte Namen
- Die Shell-Nummer bleibt als stabile Referenz (Reihenfolge ändert sich nicht)
