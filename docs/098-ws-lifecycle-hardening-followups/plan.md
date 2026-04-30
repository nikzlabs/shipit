---
status: done
---
# 098 — WS-Lifecycle Hardening: Follow-ups

## Summary

Loose ends from the WebSocket-lifecycle hardening work in features 094 (cont'd) → 097 and the independent code review that followed. None of these are bugs; they're tightening, polish, and test-coverage gaps that the reviewer flagged as "would land before merging" or "worth doing if quick."

Persisting them here so they don't evaporate with the conversation that produced them.

## Items

### 1. Cap the idle grace period (no infinite extension under flapping)

**Status:** done

`SessionRunner.detachViewer()` and `ContainerSessionRunner.detachViewer()` previously reset `_lastViewerDetachAt = Date.now()` on **every** detach. That had two failure modes:

- A flapping client could (in theory) hold a container alive forever by reconnecting just before each grace window expired.
- More immediately: in a multi-viewer scenario, detaching one of two viewers armed the timer even though the runner was still actively viewed (the idle enforcer ignored it because `viewerCount > 0`, but the state was a misleading lie).

**Fix shipped:** the timestamp is only set when `viewerCount` drops to `0` AND the timer isn't already armed; `attachViewer()` clears the timestamp so a stable reattach starts a fresh clock. This pins the multi-viewer semantics and prevents a stray double-detach from extending the grace period.

**Files:**
- `src/server/orchestrator/session-runner.ts` — `SessionRunner.attachViewer()` / `detachViewer()`
- `src/server/orchestrator/container-session-runner.ts` — same methods on the container runner
- `src/server/orchestrator/session-runner.test.ts` — new "grace-period timer arms only on LAST detach" test

### 2. Test: WS reconnect AFTER idle cleanup completed

**Status:** done

Added a test that connects, runs a turn to completion, disconnects, force-disposes the runner via a new test-only endpoint (`POST /api/_test/dispose-runner/:sessionId`), reconnects to the same session ID, and asserts a fresh runner is spawned and a new turn completes end-to-end.

**Files:**
- `src/server/orchestrator/integration_tests/ws-disconnect-resilience.test.ts` — new test "WS reconnect after idle cleanup spawns a fresh runner..."
- `src/server/orchestrator/index.ts` — added `POST /api/_test/dispose-runner/:sessionId` and `GET /api/_test/runner/:sessionId` (test-only)

### 3. Test: multi-viewer attach/detach race

**Status:** done

Added an integration test that connects two `TestClient`s to the same session, asserts both receive `runner.emitMessage()` broadcasts (`session_started`), confirms `viewerCount` drops to 1 (not 0) when one closes without arming the grace timer, and verifies the timer arms only on the last detach.

**Files:**
- `src/server/orchestrator/integration_tests/ws-disconnect-resilience.test.ts` — new test "two viewers on one session both receive broadcasts; grace period waits for last detach"

### 4. Test: grace-period boundary

**Status:** done

Added a boundary test using fake timers: a runner whose `lastViewerDetachAt` is exactly `IDLE_GRACE_PERIOD_MS - 1` ms in the past is skipped on the first tick, and `IDLE_GRACE_PERIOD_MS + 1` ms later is disposed on the next tick. Pins the grace-period semantics against future drift.

**Files:**
- `src/server/orchestrator/app-lifecycle.test.ts` — new test "grace-period boundary: ..."

### 5. Test: force-disposal while running, end-to-end (integration)

**Status:** done

Added an integration test for the production path "user archives a session whose agent is currently running." The test starts an agent, hits `DELETE /api/sessions/:id` (which calls `services/session.ts:archiveSession()` → `runnerRegistry.dispose(sessionId, { force: true })`), and asserts the runner is gone from the registry and the agent process was killed.

**Files:**
- `src/server/orchestrator/integration_tests/ws-disconnect-resilience.test.ts` — new test "archiving a session with a running agent force-disposes the runner"

### 6. Helper for repeated `runner.running = false` blocks

**Status:** done

Pulled the four occurrences in `claude-execution.ts` into a small `stopRunner(runner)` helper at the top of the file. Centralizes the pattern so adding a new error/exit path doesn't drift from the existing ones.

**Files:**
- `src/server/orchestrator/ws-handlers/claude-execution.ts` — added `stopRunner()` helper, replaced the `if (runner) runner.running = false;` call sites

### 7. Dead else-branch in `agent-listeners.ts`

**Status:** done

`wireAgentListeners` previously had an `else` branch in the `agent_init` handler for the "no captured session ID" case. That branch called `setActiveAppSessionId(event.sessionId)` — but `event.sessionId` is the Claude CLI's internal session_id (e.g. `agent-init-1`), not an app session UUID, so setting it as the active app session was always wrong. Per-session WS handlers always pass `capturedSessionId`, making the branch unreachable.

**Fix shipped:** added an explicit `throw` at function entry if `opts.capturedSessionId` is missing (fail loudly rather than silently mis-routing the session), and deleted the dead `else` branch.

**Files:**
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — assert at entry, simplified `agent_init` handler

### 8. Adversarial-timing test improvement

**Status:** done (partial — see notes)

Added the more valuable of the two suggested tests: "post-disconnect post-turn commit message uses correct `turnSummary`." It connects, emits an assistant message (which captures into `runner.turnSummary`), creates a file change, closes the WS, drives the agent to completion, reconnects, and verifies the auto-commit landed with the expected message via both chat history (`commitHash` linkage) and `git log`. Pins the round-2 fix where `postTurnCommit`'s `turnSummary` arg now bypasses the silent-no-op `ctx.getTurnSummary()`.

The other suggestion ("close fires DURING `await activateSession(...)`") was skipped — the existing "close immediately after `send_message`" test already exercises the relevant timing window, and synthesizing a controlled close inside the activate path would require either a test-only hook in the handler or extensive mocking. Left as not-worth-the-engineering until the next regression points at that specific window.

**Files:**
- `src/server/orchestrator/integration_tests/ws-disconnect-resilience.test.ts` — new test "post-turn commit message uses captured runner.turnSummary after WS disconnect"

## Out of scope

- The "explicit session-agent permissions" follow-up has its own doc: see `docs/097-explicit-session-agent-permissions/plan.md`.
- Any of these items that turn out to be larger than expected should be promoted into their own numbered feature doc; this is a parking lot, not a contract.
