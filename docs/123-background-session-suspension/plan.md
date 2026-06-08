---
description: Pause or throttle session containers whose browser tab has been inactive for several minutes to reclaim memory on multi-session setups.
issue: https://linear.app/shipit-ai/issue/SHI-47
---

# Background session suspension — release memory from inactive tabs

## Problem

Feature 122 (memory pressure) handles the case where a user closes a
tab and then memory pressure forces immediate eviction. It does **not**
help when every session has a tab open but only one is in the
foreground. All N containers stay fully active even though only one is
being used.

This is the natural failure mode for power users: 5 sessions open in
5 tabs, only one foregrounded at a time, but all 5 containers
holding 1+ GiB each indefinitely.

## Design space

Three approaches, ranked by implementation cost vs. user-visible cost:

### C. Auto-stop background containers (heaviest, biggest savings)

When a session's tab loses focus for ≥ N minutes (proposed: 5 min),
fully `docker stop` the container. Re-create on tab return via the
existing factory.

- **Pros**: genuinely frees the bytes. Survives daemon restarts. Same
  recovery path as feature 112's Restart Container action.
- **Cons**: re-attach pays a 5–10 s cold-start cost. Loses in-memory
  state inside the worker (terminal scrollback, file watcher cache).
  Compose stack needs full re-bring-up.
- **Where**: extend the idle enforcer with a "tab-focus" eligibility
  signal. Reuse the WebSocket lifecycle: track whether each session's
  WS reports the tab as focused (via a new `tab_focus_change` client
  message).

### D. Pause backgrounded containers (lighter, marginal savings)

When a session's tab loses focus for ≥ N minutes, `docker pause`
instead of stop. Unpause on tab return.

- **Pros**: instant resume (no cold start), no state loss.
- **Cons**: paused containers still hold their RSS. The kernel *may*
  swap them out under pressure, but on macOS Docker Desktop swap is
  often disabled or limited inside the LinuxKit VM, so the savings
  are marginal at best. CPU stops, which helps with thermal/battery.
- **Where**: same plumbing as C, but call `container.pause()` /
  `unpause()` instead of full destroy.

### E. Concurrent active session cap

Hard cap on how many containers are *running* at once. When the user
opens an N+1th tab, the oldest non-foreground container is stopped.

- **Pros**: deterministic, simple to reason about. No tab-focus
  tracking needed (LRU on viewer attach time works).
- **Cons**: an aggressive cap is unfriendly when a power user
  legitimately wants 6 sessions warm. Users will hit the cap
  unexpectedly.
- **Where**: extend `SessionRunnerRegistry.getOrCreate` to evict the
  LRU non-foreground runner on overflow. Memory-pressure-aware: cap
  defaults to ∞, drops to N=2 only under pressure.

## Recommendation

**C is the right answer**, but C+D as fallback layers compose well:

1. Tab loses focus → start a 5 min timer.
2. Timer expires while still backgrounded → if memory pressure: `docker
   stop` (C). If no pressure: `docker pause` (D). Tab regains focus →
   `start` or `unpause` accordingly.
3. E becomes redundant once C is in place — the moment a 6th session
   loses focus for 5 min, it's gone.

Under feature 122 alone, this whole subsystem isn't needed at the
80–89% range (banner gives the user a chance to act). It's needed at
the 90%+ range where automatic action is genuinely required and
human-in-the-loop is too slow.

## Pre-requisites

- **Tab-focus tracking** — client-side `document.visibilityState`
  observer + new `tab_focus_change` WS message. Server tracks
  per-session `lastFocusedAt` on the runner.
- **Per-session WS lifecycle independence** (CLAUDE.md): focus state
  is per-tab metadata, not server-side state that drives lifecycle.
  When the WS closes (real disconnect, page reload), the server treats
  the session as "background" until a new WS asserts focus.

## Key files (proposed)

- `src/client/hooks/useTabFocus.ts` *(new)* — visibility observer.
- `src/client/AppLayout.tsx` — wire `useTabFocus` to the per-session
  WS for the currently active session.
- `src/server/shared/types/ws-client-messages.ts` — new
  `tab_focus_change` message.
- `src/server/orchestrator/ws-handlers/misc-handlers.ts` — handler
  that updates `runner.lastFocusedAt`.
- `src/server/orchestrator/session-runner.ts` — add `lastFocusedAt`,
  `tabFocused` to the runner interface.
- `src/server/orchestrator/app-lifecycle.ts` — extend the idle
  enforcer with tab-focus eligibility (a session whose tab has been
  unfocused ≥ N min and isn't running an agent is evictable, with the
  pressure-aware semantics from 122 layered on top).

## Out of scope

- Per-tab pinning (user explicitly says "keep this session warm
  forever"). If we need it, it's a separate setting on the session
  list — not in scope here.
- Automatic resume of paused containers when the user merely *hovers*
  the session in the sidebar. Resume only on actual tab focus.
- Suspending the orchestrator's own SSE/WS streams. Those are cheap;
  the agent containers and compose stacks are where the bytes are.
