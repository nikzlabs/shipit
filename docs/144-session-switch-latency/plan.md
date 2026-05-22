---
status: in-progress
priority: high
description: Investigation into the multi-second delay before a user can send a message on a freshly switched/created session, and a plan to unify the new-session and warm-claim code paths.
---

# Session-switch latency investigation

## Problem

When the user clicks **New Session** (for a repo) or otherwise switches into a
fresh session, there is a perceptible delay — "a couple of seconds" — before a
message can actually be sent and acted on. The goal is for this to feel
instant.

This doc records the end-to-end trace of what happens between the click and a
working chat input, identifies the bottlenecks, answers the "are new-session
and warm-claim the same code path?" question, and proposes fixes.

## TL;DR findings

1. **The container is *not* the bottleneck on the common (warm-pool) path.** A
   standby container is pre-booted during warming, so on a warm hit the runner
   factory reconnects to an already-running worker instantly. The delay is in
   the **client→claim→WS→history serial chain**, dominated by **synchronous git
   fetches to GitHub inside the `claim-session` request**.

2. **The biggest avoidable cost: the claim request blocks on re-warming the
   *next* session.** On the warm path, `claim-session` does
   `await warmSessionForRepo(url, { withStandby: true })`
   ([api-routes-session.ts:689](../../src/server/orchestrator/api-routes-session.ts#L689))
   before returning the current user's `sessionId`. That re-warm runs the full
   warm sequence — including a **second real-remote `git fetch`**
   ([warm-pool-manager.ts:132](../../src/server/orchestrator/warm-pool-manager.ts#L132))
   — which is pure prep work for a *future* user, yet sits on the critical path
   of *this* user's claim. Net: **two sequential GitHub fetches** before the
   client even has a session ID.

3. **There is a correctness bug, not just latency:** the chat input is enabled
   as soon as `sessionId` is set (before the WebSocket is `open`), but
   `useWebSocket.send()` silently drops any message sent while the socket isn't
   `OPEN` ([useWebSocket.ts:106](../../src/client/hooks/useWebSocket.ts#L106)).
   A user who types fast and hits send during the connect window sees an
   optimistic bubble + "Thinking…" spinner, but **the message is never sent**.
   The `pendingWsMessage` replay mechanism that would cover this is **dead
   code** — `setPendingWsMessage(...)` is only ever called with `undefined`
   (see `grep`), so nothing is ever queued for replay on WS open.

4. **The code paths *are* largely unified at the runner/container layer** —
   everything converges on the runner factory's `getOrCreate`
   ([app-lifecycle.ts:338](../../src/server/orchestrator/app-lifecycle.ts#L338)),
   which transparently handles "standby running" / "standby starting" / "no
   container" — but they **diverge at the session-creation layer**: warm-claim
   goes through `claim-session` (with its git fetches + re-warm), while
   template/spawn sessions call `runnerRegistry.getOrCreate` directly. There is
   no `POST /api/sessions` standalone route anymore.

## The end-to-end trace (warm-pool hit — the common case)

```
CLIENT                                            SERVER
  │
  T0  click "New Session" (SessionSidebar)
  │   App.handleNewSessionForRepo:
  │     setSessionId(undefined); resetSessionState()
  │     navigate("/{owner}/{repo}/new")        ← URL change, sessionId cleared
  │
  │   auto-claim effect (App.tsx:340) fires:
  ├── POST /api/repos/:url/claim-session ─────────►  serializeClaim(url):
  │                                                    (await any in-flight warming)
  │                                                    warm path:
  │                                                      refreshCloneToLatestMain
  │                                                        └─ git fetch #1 ───► GitHub   (fetchDurationMs)
  │                                                      await warmSessionForRepo(withStandby):
  │                                                        clone-from-cache + configureCreds
  │                                                        └─ git fetch #2 ───► GitHub   ← prep for NEXT user
  │                                                        createStandby (fire-and-forget)
  │◄────────── { sessionId, sessionDir, fetchDurationMs } ──┘
  │   setSessionId(result.sessionId)
  │
  │   useSessionWebSocket recomputes WS URL (now sessionId exists)
  ├── WS /ws/sessions/{id} ───────────────────────►  activateSession(id) (NOT awaited)
  │   status: connecting → open                        getOrCreate → factory:
  │                                                      standby running? claimStandby + reconnect (instant)
  │                                                    attachToRunner → attachViewer
  │                                                      connectEventStream().then(startWorkerResources)
  │
  │   useConnectionSync (on WS open):
  ├── GET /api/sessions/{id}/history ─────────────►  chat history + commits + fileTree
  │◄──────────────────────────────────────────────┘
  ├── GET /api/sessions/{id}/preview-status ──────►  (3s retry if not ready)
  │
  │   input enabled once (status==="open" || sessionId)
  │   → user can finally send
```

### Where the seconds go (warm hit)

| Stage | Cost | On critical path? | Notes |
|-------|------|-------------------|-------|
| Navigate + reset stores | ~0 | yes | client-only |
| `claim-session`: git fetch #1 (refresh current clone) | **0.3–2s** | yes | network RTT to GitHub; `fetchDurationMs` |
| `claim-session`: `await warmSessionForRepo` (clone-from-cache + git fetch #2) | **0.3–2s** | **yes — avoidable** | this is prep for the *next* user |
| WS connect + handshake | 50–200ms | yes | needs `sessionId` first |
| `activateSession` / standby reconnect | ~0 | no | standby already running; fire-and-forget |
| `loadSessionHistory` HTTP | 50–500ms | partially | input isn't strictly gated on this, but UI churns |

So on a warm hit the **two serial GitHub fetches** are the dominant, and the
second one is entirely avoidable on the current user's path.

### Slow path (no warm session available)

`claim-session` falls to the synchronous clone-from-cache + real-remote fetch +
branch checkout ([api-routes-session.ts:728+](../../src/server/orchestrator/api-routes-session.ts#L728)),
*and then still* `await warmSessionForRepo`. No standby exists, so the runner
factory takes case 3 (fresh container create, ~1–3s) on top. This is the worst
case but should be rare if warming keeps up.

## Code-path map (the "do we maintain two paths?" question)

**Container/runner layer — unified.** All activation converges on the runner
factory ([app-lifecycle.ts:338](../../src/server/orchestrator/app-lifecycle.ts#L338)):

| Factory case | Condition | Action |
|---|---|---|
| 1 | container `status === "running"` | `claimStandby()` + reconnect with real `workerUrl` (instant) |
| 2 | container `status === "starting"` | placeholder runner; poll up to 30s (500ms) for standby, then fall back to fresh create |
| 3 | no container / stale | placeholder runner; `createContainerForRunner` (fresh build) |

Warm sessions and on-demand sessions both flow through this. The only
difference is *whether a standby container already exists* — which is a data
condition, not a separate code path. **This layer is already DRY; no
duplication to remove here.**

**Session-creation layer — divergent:**

- **Warm-claim:** `POST /api/repos/:url/claim-session` → reuse / warm / waiting
  / slow-clone sub-paths, each doing a `refreshCloneToLatestMain` and a re-warm.
- **Template / child-spawn:** `createSessionDir` → `runnerRegistry.getOrCreate`
  directly (no claim, no git fetch).
- There is **no standalone `POST /api/sessions`** route.

The four claim sub-paths (`reuse`, `warm`, `waiting`, `slow-clone`) each
independently repeat the `refreshCloneToLatestMain` + `reprovisionStandbyIfLimitsChanged`
+ `warmSessionForRepo` dance — that *is* duplication worth collapsing into one
helper (see proposed work).

## Stale doc note

The `session-lifecycle` and `session-containers` skills claim warm-up is
"lightweight — worktree + metadata only, no container." **This is outdated.**
Warming now pre-boots a **standby container** (`createStandby`,
[warm-pool-manager.ts:192](../../src/server/orchestrator/warm-pool-manager.ts#L192))
and the runner factory `claimStandby`s it on activation. The skills should be
updated.

## Measured results (dev, dogfooded 2026-05-22)

Live `[timing]` data from the dev orchestrator, claiming `New Session` on a repo
(`tanks`) several times:

| # | path  | total  | fetch  | fetch % | container.create |
|---|-------|--------|--------|---------|------------------|
| 1 | warm  | 651ms  | 623ms  | 96%     | 1893ms (first claim after restart — no standby yet) |
| 2 | reuse | 697ms  | 678ms  | 97%     | none (reused container) |
| 3 | reuse | 1352ms | 704ms  | —       | none (serialized behind #2 — see note) |
| 4 | reuse | 683ms  | 667ms  | 98%     | none |

What this confirms:

- **Fix #1 works.** The re-warm (git fetch #2) now runs *after* the response —
  the `[warm] … ready` / `[warm] Standby container ready` log lines land after
  the claim returned at 651ms, not before it.
- **The container build is off the warm/reuse critical path.** Only the very
  first post-restart claim (no standby existed yet) paid the 1893ms
  `container.create`; every subsequent claim reused a standby / existing
  container with **no** create on the path.
- **git fetch #1 (`refreshCloneToLatestMain`) is now THE bottleneck** — a steady
  **~620–700ms, ~95–98% of total claim latency**, on every path. Critically it
  cost ~667ms even when the bare-cache fetch logged
  `3ebe5f5f7 → 3ebe5f5f7 (unchanged)`: **a no-op `git fetch` still pays the full
  network round-trip to GitHub.**
- **Dev-only double-claim.** Sample #3 (1352ms) is a second claim serialized
  behind #2 — React StrictMode double-invokes the auto-claim effect in dev. It's
  harmless (idempotent reuse) and won't happen in production (no StrictMode), so
  it's not a fix item, just a note.

This clears the gate for [docs/145](../145-proactive-git-prefetch/plan.md): the
residual git fetch is real, repeatable, and dominant — and (per the no-op-fetch
finding) eliminating it requires *skipping* the synchronous fetch, not just
keeping the cache warm.

## Instrumentation added by this investigation

Lightweight timing logs (greppable `[timing]`) so the delay can be measured on
a live deployment:

- **`[timing] claim-session for <url> path=<reuse|warm|waiting|slow-clone> total=<ms> fetch=<ms>`**
  — [api-routes-session.ts](../../src/server/orchestrator/api-routes-session.ts) claim handler.
  Tells you which sub-path ran and how much of the total was the git fetch.
- **`[timing] container.create for <id> took <ms>`**
  — [app-lifecycle.ts](../../src/server/orchestrator/app-lifecycle.ts) `createContainerForRunner`.
  Isolates fresh-container cost (only hit on slow path / standby miss).
- **`[timing] claimSession round-trip <ms> (server fetch=<ms>)`**
  — [repo-store.ts](../../src/client/stores/repo-store.ts) `claimSession`.
  Client-observed claim latency vs. the server-reported fetch portion; the gap
  is the re-warm + everything else on the request.

## Proposed fixes (ranked)

1. **Don't block the claim response on re-warming the next session.** Make
   `warmSessionForRepo(url, { withStandby: true })` fire-and-forget on the warm
   / waiting / slow sub-paths instead of `await`ing it. It has its own
   `warmingInProgress` / `warmingPromises` guards, and the claim already
   returns the *claimed* session (not the new warm one), so the await is not
   needed for correctness. **Biggest single win — removes git fetch #2 from the
   critical path.**

   Note: the standby container is **already** fire-and-forget inside
   `warmSessionForRepo` (`createStandby(...).then().catch()`,
   [warm-pool-manager.ts:192](../../src/server/orchestrator/warm-pool-manager.ts#L192)),
   so awaiting the call today does *not* wait for the container to boot — it
   only waits for the worktree + git fetch #2 + `setWarmSessionId`. Voiding the
   call therefore changes nothing about pool/standby tracking (all of which
   happens inside the promise body regardless of the caller); it only stops
   blocking the response on that worktree+fetch work.

   **Invariant — fast, repeated session creation must always be correct.**
   Creating sessions back-to-back — whether a human clicks "New Session"
   several times or an agent spawns a batch of child sessions — must *always*
   succeed and produce a usable session. It may be *slower* when many are
   created at once (e.g. the next warm session isn't registered yet, so a rapid
   follow-up takes the waiting path and blocks on the in-flight warm instead of
   getting an instant hit; or, under enough load, a claim falls through to the
   synchronous slow-clone path). That graceful degradation is acceptable;
   silent failure, a dropped first message, or a session that never becomes
   usable is not. Concretely, the deferral must preserve: (a) per-repo
   serialization of bare-cache git ops via `warmingInProgress` /
   `warmingPromises` + the claim waiting path, so concurrent creates never
   corrupt the cache; (b) the slow-clone fallback always firing when no warm
   session is available, so a claim never returns empty just because warming
   hasn't caught up; and (c) fix #2 below, so a message typed during any of
   these windows is queued and sent rather than dropped. Any change here should
   be covered by a test that creates N sessions for the same repo in immediate
   succession and asserts every one ends up usable.

2. **Fix the silent message drop.** Either (a) gate the input on
   `status === "open"` (not `sessionId`), or better (b) revive
   `pendingWsMessage`: when `handleSend` runs and the WS isn't open, stash the
   message and have `useConnectionSync` flush it on open (the consumer already
   exists at [useConnectionSync.ts:56](../../src/client/hooks/useConnectionSync.ts#L56)).
   This makes "type fast and hit send" reliable regardless of connect timing.

3. **Collapse the four claim sub-paths into one helper.** `reuse` / `warm` /
   `waiting` all do the same `refreshCloneToLatestMain` +
   `reprovisionStandbyIfLimitsChanged` + (now deferred) re-warm. Extract a
   single `finishClaim(sessionId, workspaceDir)` to remove the copy-paste and
   the risk of the paths drifting.

4. **Update the `session-lifecycle` / `session-containers` skills** to reflect
   standby containers.

## Follow-up feature (split out)

**Proactive background git pre-fetch** — keep the bare cache continuously close
to `origin/main` (periodic + on-change) so that `refreshCloneToLatestMain` (git
fetch #1) becomes a near-instant no-op and *no* git fetch sits on the claim's
critical path. This is a standalone feature with its own design surface
(change-detection wiring, bounded-staleness semantics) and is **gated on the
timing data** this investigation's logs produce: only worth building if, after
fix #1, git fetch #1 is still a meaningful chunk of perceived latency. Tracked
separately in [docs/145-proactive-git-prefetch/plan.md](../145-proactive-git-prefetch/plan.md).

## Key files

| File | Role in the latency |
|------|---------------------|
| [api-routes-session.ts](../../src/server/orchestrator/api-routes-session.ts) | `claim-session` handler; `refreshCloneToLatestMain`; the awaited re-warm |
| [warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts) | `warmSessionForRepo` (git fetch #2 + `createStandby`) |
| [app-lifecycle.ts](../../src/server/orchestrator/app-lifecycle.ts) | runner factory (`getOrCreate` 3 cases); `createContainerForRunner` |
| [index.ts](../../src/server/orchestrator/index.ts) | `activateSession`, `attachToRunner` (fire-and-forget on WS connect) |
| [container-session-runner.ts](../../src/server/orchestrator/container-session-runner.ts) | `attachViewer`, `_workerReady`, SSE connect |
| [App.tsx](../../src/client/App.tsx) | auto-claim effect, `handleSend`, input `disabled` gate |
| [useWebSocket.ts](../../src/client/hooks/useWebSocket.ts) | `send()` drops when not `OPEN` |
| [useConnectionSync.ts](../../src/client/hooks/useConnectionSync.ts) | history load + `pendingWsMessage` flush (consumer exists, producer dead) |
| [repo-store.ts](../../src/client/stores/repo-store.ts) | client `claimSession` fetch |

Remaining work is tracked in [checklist.md](checklist.md). The proactive
pre-fetch follow-up has its own doc and checklist under
[docs/145-proactive-git-prefetch/](../145-proactive-git-prefetch/plan.md).
