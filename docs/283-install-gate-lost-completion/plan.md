---
issue: planning#479
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

### A probe outlives the install it asked about (req 5)

Polling for the whole wait created a second-order hazard that probing twice did
not. Every guard in `resyncInstallStateAfterReconnect` — `_installInFlight`,
`_disposed`, `_installPostIssued` — runs *before* the HTTP await, and a probe
can still be in flight when the install it asked about settles by SSE and a
*next* install arms a fresh resolver. The late answer is truthful and about the
wrong install, and resolving "the current" completion with it opens install B's
gate while npm is still running: the docs/183 early-resolve bug displaced by one
generation, with the overlay publish hook snapshotting a not-yet-installed dep
dir.

So the probe now captures `_installComplete` before the await and re-tests it
after. The promise identity IS the generation — `signalInstallComplete` nulls it
and `runInstall` arms a fresh one — so an unchanged reference is proof the
answer is still ours. Dropping a late answer is always safe: if an install
really is in flight, the next probe asks again.

`_installPostIssued` alone was not enough here. It is sufficient for the
original same-cycle pre-POST race it was written for, but it is read before the
await too, so it says nothing about which generation the answer belongs to.

### Known separate hole — a hung teardown (NOT fixed here)

`releaseInstallGate` awaits `_gatedTeardown` with no bound, and the
`docker compose stop` underneath it (`defaultComposeRunner`, `compose-cli.ts`)
has no timeout. A compose stop that hangs therefore leaves services gated
forever by a different route, which this change does not address. Two reasons it
is out of scope: the production evidence rules it out as this incident's cause
(`docker top` on the orchestrator showed no `docker compose stop` process for
the session's project, so `_gatedTeardown` had already resolved), and bounding a
compose child process is a different mechanism in a different subsystem.

Related and also unfixed: `_gatedTeardown` is a single field, so a later hold
overwrites an earlier one, and the earlier release callback re-checks only
`_installRunning` — an older teardown can reopen a newer gate. Both were raised
by review on this change; neither is reachable from a lost completion event.

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

Three tests. The first two hang without the fix — the production symptom
exactly; the third fails a specific assertion:

- **`recovers an install_done lost MID-install, with no SSE reconnect`** — POST
  returns `{ started: true }`, the first two post-POST `/install/status` probes
  report `running: true`, `install_done` is never sent, and the SSE stream never
  reconnects (asserted: `sseConnects() === 1`). The gate must still resolve.
  Probe counting rather than wall-clock timing is what makes this
  timing-independent while still proving the recovery came from a probe the
  runner issued itself.
- **`releases the reinstall bracket's gate after an install_done lost
  mid-reinstall`** — drives `reinstallForDepChange` and asserts the gate is both
  held AND released as a success, since the release is what starts the services
  again. Scoped deliberately: it uses a recorder rather than a real
  `ServiceManager` (which needs Docker), so it observes the *bracket* reaching
  its `finally`, not `gatedServices`, `_gatedTeardown`, or a service actually
  restarting — `service-manager.test.ts` covers the release itself. There is
  still no single end-to-end regression spanning both halves.
- **`does not let a probe outlive its install and resolve the NEXT one`** (req
  5) — the stub holds install A's first `/install/status` open, A settles by
  SSE, install B starts, and only then does A's probe answer "settled". B must
  still be waiting. Without the generation re-check B resolves early, which is
  the failure this test names.
