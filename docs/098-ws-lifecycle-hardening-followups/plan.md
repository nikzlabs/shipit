---
status: planned
---
# 098 — WS-Lifecycle Hardening: Follow-ups

## Summary

Loose ends from the WebSocket-lifecycle hardening work in features 094 (cont'd) → 097 and the independent code review that followed. None of these are bugs; they're tightening, polish, and test-coverage gaps that the reviewer flagged as "would land before merging" or "worth doing if quick."

Persisting them here so they don't evaporate with the conversation that produced them.

## Items

### 1. Cap the idle grace period (no infinite extension under flapping)

**Status:** open  
**Severity:** Low — needs a flapping client to manifest, not a real bug today.

`SessionRunner.detachViewer()` and `ContainerSessionRunner.detachViewer()` both reset `_lastViewerDetachAt = Date.now()` on **every** detach. If a client repeatedly auto-reconnects within the 60 s `IDLE_GRACE_PERIOD_MS` window, the grace timer resets each time and there is no absolute upper bound on how long an idle, agent-not-running runner can hold a container alive.

**Fix:** track the **first** detach in a series (only set `_lastViewerDetachAt` if it's currently 0; clear it on `attachViewer()` so the next detach begins a fresh series). Or: keep current behavior but cap the eligibility to `IDLE_GRACE_PERIOD_MS * 5` since the original `attachViewer()` so a session can't outrun cleanup forever.

**Files:**
- `src/server/orchestrator/session-runner.ts` — `SessionRunner.detachViewer()` / `attachViewer()`
- `src/server/orchestrator/container-session-runner.ts` — same methods on the container runner
- `src/server/orchestrator/app-lifecycle.test.ts` — new test for "flapping client" boundary

### 2. Test: WS reconnect AFTER idle cleanup completed

**Status:** open  
**Severity:** Low — the production path works (verified manually), just lacks a test.

`ws-disconnect-resilience.test.ts:241` reconnects *during* a running turn. There is no test for the path where the runner was disposed while disconnected and the next WS connect must trigger `runnerRegistry.getOrCreate()`. Add a test that:

1. Connects, starts an agent.
2. Lets the agent finish (so `running=false`).
3. Closes the WS.
4. Lets `IDLE_GRACE_PERIOD_MS` elapse.
5. Triggers `enforceIdleContainerLimit()` directly.
6. Reconnects to the same session ID.
7. Asserts the new connection successfully spawns a fresh runner and a new turn works end-to-end.

**Files:**
- `src/server/orchestrator/integration_tests/ws-disconnect-resilience.test.ts` — add the test

### 3. Test: multi-viewer attach/detach race

**Status:** open  
**Severity:** Low.

Today's coverage is the `viewerCount` counter unit test in `session-runner.test.ts:72-90`. Nothing exercises two `TestClient` connections against one session, in particular:
- Both viewers receive `runner.emitMessage()` broadcasts.
- Closing one viewer does not affect the other.
- The grace period applies only when the **last** viewer detaches, not on each detach.

**Files:**
- `src/server/orchestrator/integration_tests/ws-disconnect-resilience.test.ts` — add the test (or a new `multi-viewer.test.ts`)

### 4. Test: grace-period boundary

**Status:** open  
**Severity:** Low.

`app-lifecycle.test.ts:130-165` covers expiry. Add a boundary test: a runner whose `lastViewerDetachAt` is exactly `IDLE_GRACE_PERIOD_MS - 1` ms in the past is skipped on this tick, and `IDLE_GRACE_PERIOD_MS + 1` ms later is disposed on the next tick. Pins the grace-period semantics against future drift.

**Files:**
- `src/server/orchestrator/app-lifecycle.test.ts`

### 5. Test: force-disposal while running, end-to-end (integration)

**Status:** open  
**Severity:** Low.

`app-lifecycle.test.ts:273-297` covers the `SessionRunner` unit. Nothing covers the integration path "user archives a session whose agent is currently running." Production caller: `services/session.ts:358` (`archiveSession`).

**Files:**
- `src/server/orchestrator/integration_tests/` — new test (likely fits in `ws-disconnect-resilience.test.ts` or a new `force-dispose.test.ts`)

### 6. Helper for repeated `runner.running = false` blocks

**Status:** open  
**Severity:** Nit.

`claude-execution.ts:158`, `:172`, `:222` each have `if (runner) runner.running = false;` (or with adjacent state-clearing) on different error/exit paths. Pull into a small helper (e.g., `safeStop(runner, summary?)` ) to reduce drift if a future caller adds another path.

**Files:**
- `src/server/orchestrator/ws-handlers/claude-execution.ts`

### 7. Dead else-branch in `agent-listeners.ts`

**Status:** open  
**Severity:** Nit.

`agent-listeners.ts:83-90` has an `else` for `!turnSessionId` (when `opts.capturedSessionId` is unset) that calls `ctx.setActiveAppSessionId(event.sessionId)` — this would set the connection's active session ID to the Claude CLI's session_id (e.g. `agent-init-1`), which is wrong. On the per-session WS route this branch is unreachable because `capturedSessionId` is always set by `runClaudeWithMessage`/`handleAnswerQuestion`. Either delete the branch or `assert(opts.capturedSessionId, "...")` at function entry.

**Files:**
- `src/server/orchestrator/ws-handlers/agent-listeners.ts`

### 8. Adversarial-timing test improvement

**Status:** open  
**Severity:** Nit.

The "close immediately after `send_message`" test in `ws-disconnect-resilience.test.ts:310` closes the WS *after* the send but with `await settle()` after, which serializes things. Consider:

- A test where close fires *during* `runClaudeWithMessage`'s `await activateSession(...)` — that's the precise window where the round-2 silent-mutation bug used to manifest.
- A test for "post-disconnect post-turn commit message uses correct `turnSummary`" — `postTurnCommit`'s `turnSummary` arg was a round-2 fix; nothing currently asserts the commit message is correct after disconnect.

**Files:**
- `src/server/orchestrator/integration_tests/ws-disconnect-resilience.test.ts`

## Out of scope

- The "explicit session-agent permissions" follow-up has its own doc: see `docs/097-explicit-session-agent-permissions/plan.md`.
- Any of these items that turn out to be larger than expected should be promoted into their own numbered feature doc; this is a parking lot, not a contract.
