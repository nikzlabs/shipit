---
title: Install gate — recover from a lost completion event
description: Poll /install/status for the whole completion wait so a lost install_done cannot hold preview services stopped forever.
---

# Install gate — recover from a lost completion event

Implements [requirements.md](./requirements.md).

## The incident

Observed on the production host on 2026-08-26, session
`9dbd12ee-9af2-430b-bfb4-9d8b3fcfda2f`. Its `preview: auto` services `game` and
`debug` exited 137 at 14:09:12 and were still stopped over an hour later. The
user reads that as a crash ShipIt failed to recover from.

It was not a crash. It was ShipIt's own teardown, never undone. Twelve sessions
on that host had a gate *hold* as their last gate event with no matching
release: `3e50e22e`, `3ffdde25`, `58285b2e`, `62aaa1f1`, `66a55ef0`, `8bfa8379`,
`8c15fdde`, `9dbd12ee`, `a3454067`, `d028ddca`, `ec792422`, `fcc4ef9d`.

## Root cause

The mid-session reinstall brackets the install between two gate calls
(`reinstallForDepChange`, `container-session-runner.ts`):

1. `mgr.setInstallRunning(true)` → `holdGatedServicesForReinstall()` adds the
   services to `gatedServices` and issues `docker compose stop`. SIGTERM, 10s
   grace, then SIGKILL — exit 137. This is the docs/239 pattern and is correct.
2. `runInstall()` awaits the completion promise.
3. `finally` → `mgr.setInstallRunning(false)` → `releaseInstallGate()` starts
   them again.

Step 2 had no way out but an SSE `install_done` / `install_error`. When that
event was lost, `runInstall` never returned, so step 3 never ran and the
services stayed in `gatedServices` — where the poller's `isGated` skip and
`handleNonZeroExit`'s gated early-return deliberately ignore them (docs/239),
and where compose's `RestartPolicy: no` means nothing else could start them.
No recovery path could see them.

Evidence the block was the completion wait and not the teardown await in
`releaseInstallGate`:

- The orchestrator logged `install re-running — holding 2 gated service(s):
  game, debug` at 14:09:01.729 with no matching `install finished — starting`
  afterwards. The previous cycle at 14:08:24.211 did get its release at
  14:08:34.716.
- `docker top` on the session container showed no install process left, so the
  install itself had finished.
- `docker top` on the orchestrator showed no `docker compose stop` for project
  `shipit-9dbd12ee-9af`, so `_gatedTeardown` had already resolved.

### Why the existing backstop missed it

`resyncInstallStateAfterReconnect()` is the lost-event recovery, and it ran in
exactly two places: when a worker SSE stream OPENS (`onSseOpen`), and once
immediately after the install POST. The post-POST probe correctly saw
`running: true` and waited for the real event, as it must — resolving there is
the docs/183 early-resolve bug. The SSE stream then stayed open for the rest of
the session, so no further probe ever ran. WebSocket `attachViewer` does not
trigger `onSseOpen`.

So the recovery existed but was reachable only at moments that had both already
passed. Recovery depended on SSE reconnect timing, and the stream did not need
to reconnect.

## The fix

`awaitInstallCompletion()` wraps the completion wait and re-probes
`/install/status` on a cadence (`INSTALL_STATUS_PROBE_INTERVAL_MS`, 30s) for as
long as the wait is open. The probe is `resyncInstallStateAfterReconnect()`
unchanged — it is already idempotent against the real event, and already a
no-op while the worker reports `running: true`.

Deliberately a **poll, not a deadline** (req 3). A deadline would have to decide
what a slow install means; the poll asks the worker instead. A slow install keeps
running because every probe says `running: true`; a lost event resolves within
one interval because the probe reads the worker's retained `lastResult`.

The timer is re-armed after each probe RESOLVES rather than on a fixed interval,
so a worker whose `/install/status` hangs cannot accumulate overlapping probes,
and it is `unref`'d so it never holds the process open.

Nothing in the gate itself changed, so req 4 holds by construction:
`releaseInstallGate` still awaits `_gatedTeardown`, and gated services are still
exempt from crash reporting while held.

## Key files

- `src/server/orchestrator/container-session-runner.ts` —
  `INSTALL_STATUS_PROBE_INTERVAL_MS`, `awaitInstallCompletion()`,
  `runInstall()`, `resyncInstallStateAfterReconnect()`.
- `src/server/orchestrator/service-manager.ts` — `setInstallRunning()`,
  `releaseInstallGate()` (unchanged; the gate this fix reopens).
- `src/server/session/install-controller.ts` — `/install/status` and the
  retained `_lastInstallResult` the probe reads (unchanged).
- `src/server/orchestrator/integration_tests/install-gate.test.ts` —
  regression tests.

## Tests

Two tests, both of which hang without the fix — the production symptom exactly:

- **`recovers an install_done lost MID-install, with no SSE reconnect`** — POST
  returns `{ started: true }`, the first two post-POST `/install/status` probes
  report `running: true`, `install_done` is never sent, and the SSE stream never
  reconnects (asserted: `sseConnects() === 1`). The gate must still resolve.
  Probe counting rather than wall-clock timing is what makes this
  timing-independent while still proving the recovery came from a probe the
  runner issued itself.
- **`reopens the ServiceManager install gate after an install_done lost
  mid-reinstall`** — the user-visible half. Drives `reinstallForDepChange` with
  a stand-in for the ServiceManager and asserts the gate is both held AND
  released as a success, since the release is what starts the services again.
