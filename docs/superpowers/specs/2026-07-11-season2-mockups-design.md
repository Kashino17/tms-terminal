# TMS Terminal Season 2 — Mockup Phase Design

**Date:** 2026-07-11
**Status:** Approved by user
**Phase:** 1 of 3 (Mockups → Refinement → Implementation)

## Goal

Kick off "Season 2" of the TMS Terminal app: a complete design overhaul. This spec covers **Phase 1 only** — three fully interactive HTML mockups, each a complete simulated demo of every feature the current live app has (branch `feat/manager-chat-redesign` in `~/Desktop/tms-terminal`). The user reviews them on his Samsung Galaxy Fold 7 via Tailscale, picks/merges a direction, then Phase 2 refines the winner and Phase 3 implements it for real (separate specs).

## Pain Points Season 2 Must Solve (user-stated)

These drive the mockup designs — each mockup must *visibly demonstrate* the fixed experience:

1. **Terminal rendering chaos (biggest problem):** Claude Code / terminal output shown double/triple, overlapping, garbled, often unreadable. Mockups show a rock-solid, clean terminal rendering.
2. **Multi-terminal work:** Multiple terminals stacked vertically — minimalist but professionally highlighted. Terminals get user-assigned **names, titles, descriptions** (and color tags) so you always know what each one is doing.
3. **Voice transcription** often aborts or takes too long (UX shown improved; technical fix is Phase 3).
4. **Cloud (Vercel/Render):** Env vars are visible but not copyable/editable today. Wanted: copy + edit env vars, view service logs, **favorite** servers/projects, and user-managed **folder structures**.
5. **Logs:** reliably viewable, large, copyable. **Touch text-selection** currently near-impossible without an external mouse — mockups show touch-first selection with handles.
6. **Link detection:** links broken across line wraps copy only half the link. Mockups show correct wrapped-link handling.
7. General: too cluttered, inconsistent look, cumbersome navigation, not premium enough.

## The Three Concepts

All three are **complete, different visions** — own navigation, own layout, own visual style — chosen by the user from a Pro-Tool-minimal + Liquid-Glass taste profile:

### Concept 1 — "Command Deck" (Pro-Tool pure)
- Linear/Warp DNA: near-black, one accent color, monospace as a design element, hairline borders, zero decoration.
- Navigation: persistent bottom command bar + Spotlight-style universal command palette (⌘K feel, touch-first). Everything ≤ 2 taps away.
- Centerpiece: the **Terminal Stack** — named terminals stacked vertically, each with color tag and status chip ("Claude working…", "Waiting for input", "Done ✓"), collapsible and reorderable.

### Concept 2 — "Liquid Deck" (iOS 26 Glass)
- Translucent layers, blur, soft depth stacking, fluid spring animations, light reflections. The premium variant.
- Navigation: floating glass dock + Dynamic Island as living status hub (running sessions, agent activity, prayer countdown).
- Centerpiece: terminals as **glass cards in a spatial stack** — swipe through sessions like Safari tabs; Manager chat as a translucent sheet above everything.

### Concept 3 — "Mission Control" (Hybrid)
- Pro-tool density with targeted glass moments (island, sheets, alerts).
- Navigation: **hub-first** — landing view shows everything at once (servers, running sessions, cloud deployments, manager status) as living zones; dive into workspaces from there.
- Centerpiece: the **Fold-7 mode** — unfolded, the hub becomes a real operations center (terminals left, context right); folded, a focused single track.

## Architecture

New folder in the repo, **plain HTML/CSS/JS, no build step** (iteration in seconds):

```
mockups/season2/
├── index.html                    # Chooser page linking the 3 concepts
├── shared/
│   ├── data.js                   # ONE fake data world used by all 3
│   └── sim.js                    # Terminal streaming simulator (typewriter output, status transitions)
├── command-deck/index.html       # Concept 1 (self-contained SPA)
├── liquid-deck/index.html        # Concept 2
└── mission-control/index.html    # Concept 3
```

- Each concept is a self-contained single-page app; only `shared/` is common.
- Served by a trivial static server on **port 4321**; user opens `http://<tailscale-ip>:4321` on the phone. No TLS (Tailscale encrypts), matching the project's existing no-TLS decision.

## Shared Fake Data World

Identical data across all three concepts so comparison is fair:

- 2 servers (the user's Mac + one secondary), one connected, one offline.
- 4 named terminal sessions, e.g. "Pinterest Scraper — Claude fixing tests", "TMS Server — logs", including **one live-streaming simulated Claude Code session** that periodically hits a permission prompt (demonstrates Auto-Approve/Autopilot).
- 6 cloud projects (Vercel + Render) with env vars, deploy status, logs, favorites, and user folders.
- 1 Manager conversation incl. voice message player, artifacts, memory entries.
- Prayer times for the current day, snippets, notes, process list, watchers.

## Feature Coverage (every concept demos all of it, clickable)

Server list & connect · terminal stack with names/descriptions/status chips · simulated Claude session with streaming + permission prompt + Auto-Approve/Autopilot · terminal toolbar (Esc/arrows/Ctrl/Tab/paste) · touch text-selection with drag handles · wrapped-link detection & full-link copy · tool panels: Files, SQL, Ports, Processes, Snippets, Notes, Screenshots, Browser, Watchers · Manager chat V2 (chat, voice player, transcription status, artifacts, memory) · Cloud: project list with favorites + folders, env vars view/copy/edit, large selectable searchable log viewer, deploy status · Spotlight search · PrayerTimes/Adhan alert · Lock/PIN · Settings · Update banner. (Dynamic Island: concepts 2 & 3.)

UI language: **German** (per project convention).

## Responsive Requirements (Galaxy Fold 7)

Two modes per concept, switched automatically by breakpoint (existing convention: compact <400dp, medium 400–699dp, expanded ≥700dp):

- **Folded (cover screen, narrow):** focused single track, one terminal in focus.
- **Unfolded (~700+dp):** multi-terminal + context side by side.
- Desktop browser testing via window resizing works implicitly.

## Explicitly Out of Scope (Phase 1)

- No real server/WebSocket connection — everything simulated.
- No React Native code, no changes to the existing app.
- No technical fixes for rendering/transcription roots — those are Phase 3 (implementation), where the real causes (resize-storm SIGWINCH reprints, alt-screen issues, Whisper pipeline) get solved properly.

## Success Criteria

1. All three mockups open on the Fold 7 via Tailscale URL and feel like real apps (tap-through, animations, streaming terminal).
2. Every feature area above is reachable and demonstrated in each concept.
3. Both fold modes work in each concept.
4. The pain-point fixes are visible as designed features (named terminal stack, touch selection, env edit/copy, favorites/folders, log viewer, wrapped links).
5. User can compare fairly (same data everywhere) and pick/merge a direction for Phase 2.

## Roadmap After This Spec

- **Phase 2:** user picks/merges a concept → systematic refinement of the winning layout (own iteration loop on the mockup).
- **Phase 3:** separate brainstorm + spec for the real implementation in the React Native app (including the technical root fixes).
