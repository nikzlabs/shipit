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

## Bounding the teardown (req 1, req 6)

Review on the change above found a **second, independent** route to the same
user-visible symptom. It was deferred at the time — the production evidence
ruled it out as this incident's cause — and then closed in a follow-up.

### A `compose stop` that never returns (req 1)

`releaseInstallGate` awaits `_gatedTeardown` *on purpose*: the wait is what
makes the teardown's own SIGKILL land while the service is still gated, so our
teardown is not reported to the user as a crash (docs/239). But
`docker compose stop` has no timeout of its own, so a wedged daemon turned that
deliberate wait into a permanent one — services stopped by us, sitting in
`gatedServices` where the poller and `handleNonZeroExit` deliberately ignore
them, with nothing able to start them again.

The bound goes in `stopGatedForReinstall`, not in `releaseInstallGate` and not
in `defaultComposeRunner`. That method's docstring already promised the
invariant the code did not deliver — "never rejects … so it can't wedge the gate
closed" — and a hang is the same failure as a rejection with a different shape.
Bounding it there means the promise `releaseInstallGate` awaits is *guaranteed
to settle*, so the gate logic needs no timeout of its own. Bounding
`defaultComposeRunner` globally would be wrong: `up --build` legitimately runs
for minutes.

#### The bound is derived, not fixed

The first attempt was a flat 60s, and review caught that it silently encoded
Compose's **default** grace period as though it were the rule. `stop_grace_period`
is a per-service key with **no upper bound**, and one ShipIt explicitly passes
through (`plugin-compose.ts`). A repo declaring `stop_grace_period: 1m30s` would
have had a perfectly healthy teardown declared wedged, reopening the gate into a
container still shutting down — the docs/239 bug, caused by its own fix.

So the parse now carries `stop_grace_period` through to `ManagedService`, and
`gatedTeardownTimeoutMs(name)` is that service's own grace period plus
`GATED_TEARDOWN_GRACE_MARGIN_MS` (60s of daemon/CLI slack, the part that really
is ShipIt's to estimate). A service that declares nothing gets Compose's
default — now a fact read from the file rather than an assumption about it.

`parseStopGracePeriodMs` handles Go durations (`1m30s`, `500ms`) and Compose's
bare-number-means-seconds form. A present-but-unrecognized value yields
`UNKNOWN_STOP_GRACE_PERIOD_MS` (10 min), **not** the default: the two error
directions are not symmetric, and under-estimating is what causes the docs/239
race.

#### What an abandoned stop actually does

Abandoning the wait does **not** cancel the stop, and cancellation would not
help: the operation is daemon-side, so killing the CLI process would not stop
it.

An earlier draft of this document claimed such a late stop "surfaces as an
ordinary non-zero exit and goes through the normal retry path — visible and
self-correcting". **That was asserted, not verified, and it is not true in
general.** Traced through the code:

- A service that handles SIGTERM and exits **0** goes to `onExitedCleanly` and
  is marked `stopped` (`service-poller.ts`). It is **not** retried.
- A **non-zero** exit is retried only while the service is still in
  `postGateServices`, and that window clears after `POST_GATE_STABLE_MS` of
  continuous uptime (`service-retry-manager.ts`). A stop landing later latches
  the service to `error`.

So the honest claim is narrower: a late-landing stop leaves the service
**visibly** `stopped` or `error` rather than invisibly held by a gate no code
can reopen — recoverable by the user or the next reinstall, not always
self-recovering. That is still strictly better than the permanent invisible
wedge, and it is now bounded by the derived timeout above, which a healthy
teardown does not reach.

### An older teardown opening a newer cycle's gate (req 6)

`_gatedTeardown` is a single field, so a second hold overwrites the first
teardown's handle while an earlier `releaseInstallGate` is still awaiting it.
That callback re-checked only `_installRunning` — which the newer bracket's own
release has already cleared — so the older teardown could open the newer cycle's
gate, starting the very services the newer teardown was still stopping.

`_gateGeneration` fixes it: `holdGatedServicesForReinstall` stamps each teardown
with a fresh generation, and a release callback opens only if its generation is
still current.

**The generation must travel with the queued batch too.** Checking it in
`releaseInstallGate` only proves the open was valid when it was *scheduled*.
`startGatedServices` then queues the work on the stack-op queue
(`serializeStackOp`), which can hold it for as long as the `compose up` ahead of
it takes — long enough for a whole new reinstall cycle to re-gate those services
and start stopping them. `startGatedBatch` therefore re-checks the generation it
was given, and drops a stale batch. Without that, req 6 is violated one layer
down; review found this after the first version of the fix.

**`start()` bumps the generation before its first `await`.** It clears
`_disposed` on its opening line, which reopens the only other guard a pending
release callback has, and everything from there to the service-map rebuild is
awaited. Bumping alongside the later `_gatedTeardown = null` left that whole
window open. In practice the batch re-check above masks most of the damage, so
this is defence in depth rather than a second live bug — but `_disposed` is not
the protection the earlier draft claimed it was, and the bump costs nothing
where it now sits.

`stop()` needs no bump: it sets `_disposed`, which `open()` checks first, and
nothing clears it until `start()` — which bumps.

## Known separate route — the stack-op queue (NOT fixed here)

`serializeStackOp` waits for the preceding op with no deadline, and a preceding
`compose up --build` has deliberately no total deadline (only a silence
timeout). A queue held indefinitely means the gated start never runs, and
`startGatedServices` has by then already cleared `gatedServices` and marked the
services `starting` — so the services are not started and the gate machinery no
longer considers them held. The starting-watchdog eventually reports an error,
which is visible, but it does not advance the queue.

This is a third, independent route to "services never come back", in a third
subsystem, and bounding it has its own hazard: the thing most likely to be
holding the queue is a legitimate long image build. Recorded rather than fixed,
the same way this document recorded the teardown route before it was closed.
Raised by review on the teardown change.

## Key files

- `src/server/orchestrator/container-session-runner.ts` —
  `INSTALL_STATUS_PROBE_INTERVAL_MS`, `awaitInstallCompletion()`,
  `runInstall()`, `resyncInstallStateAfterReconnect()`.
- `src/server/orchestrator/service-manager.ts` — `setInstallRunning()`,
  `releaseInstallGate()`, `stopGatedForReinstall()`,
  `holdGatedServicesForReinstall()`, `GATED_TEARDOWN_STOP_TIMEOUT_MS`,
  `settleOrTimeout()`, `_gateGeneration`.
- `src/server/session/install-controller.ts` — `/install/status` and the
  retained `_lastInstallResult` the probe reads (unchanged).
- `src/server/orchestrator/integration_tests/install-gate.test.ts` —
  regression tests for the completion wait, plus the end-to-end one.
- `src/server/orchestrator/service-manager.test.ts` — regression tests for the
  teardown bound and the gate generation, in the
  `ServiceManager install gate (x-shipit-depends-on-install)` block.

## Tests

Every test below was verified to FAIL with its own fix reverted — see
"A test that could not fail" for why that step is not a formality here.

### The completion wait (`integration_tests/install-gate.test.ts`)

The first two hang without the fix — the production symptom exactly; the third
fails a specific assertion:

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
  restarting — `service-manager.test.ts` covers the release itself.
- **`does not let a probe outlive its install and resolve the NEXT one`** (req
  5) — the stub holds install A's first `/install/status` open, A settles by
  SSE, install B starts, and only then does A's probe answer "settled". B must
  still be waiting. Without the generation re-check B resolves early, which is
  the failure this test names.

### End to end (`integration_tests/install-gate.test.ts`)

- **`a lost install_done still gets the stopped services running again`** — the
  whole incident in one test, and the answer to "each half can pass while the
  user-visible outcome fails". It drives a **real `ServiceManager`** (fake
  compose runner, no Docker) alongside the stub worker: the `preview: auto`
  service is running, the reinstall stops it (`stopCalls` contains `web` — the
  exit 137 the user saw), the completion event never arrives, and the service is
  `up` a second time and running at the end.

### The teardown (`service-manager.test.ts`)

- **`reopens the gate when the teardown's compose stop never returns`** (req 1)
  — the stop hangs forever. The gate must still be closed at 30s (so the
  docs/239 wait is not shortened) and open after the bound.
- **`waits out a long declared stop_grace_period before abandoning the
  teardown`** (req 4) — the service declares `stop_grace_period: 1m30s` and its
  stop is slow but healthy. At 75s — past the old fixed 60s bound — the gate
  must still be waiting, and it must open because the stop *landed*, not
  because we gave up. Fails against a fixed bound.
- **`does not let an older teardown open a newer cycle's gate`** (req 6) — two
  holds, both stops parked, both releases waiting. Teardown 1 lands first and
  must not start anything; teardown 2 lands and the gate opens exactly once.
- **`drops a queued gated start that a newer gate cycle has superseded`** (req
  6) — the stack queue is parked, cycle 1's release queues its batch behind it,
  cycle 2 re-gates the service, and only then does the queue drain. The stale
  batch must start nothing.

No test covers the `start()`-bump window: with the batch re-check in place it
has no observable effect, so any test for it would be asserting on the
re-check instead. Said here rather than left to look like coverage.

### A test that could not fail

The end-to-end test **passed with the fix reverted** on its first draft, and had
to be rewritten. It configured `/install/status` to report `running: true` for
only the first probe — but two probes are not the periodic poll (the one
`runInstall` issues after the POST, and the one `onSseOpen` issues), and either
answers "settled" and resolves the gate on its own. The test proved nothing
about the mechanism it was named for. Reporting `running: true` for the first
*three* probes is what forces the recovery to come from the poll, and the test
now asserts `postPostStatusProbes() > 3` so the reason it passes is visible in
the test itself rather than assumed.
