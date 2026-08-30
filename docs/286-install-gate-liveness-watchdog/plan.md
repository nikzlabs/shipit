---
issue: planning#485
title: Install gate — liveness watchdog
description: Reopen a gate that holds preview services while nothing that could open it is in flight, and log every branch that declines to open one.
---

# Install gate — liveness watchdog

Implements [requirements.md](./requirements.md). Read
[docs/137-depends-on-install](../137-depends-on-install/plan.md) for the gate
itself, [docs/239-teardown-sigkill-not-oom](../239-teardown-sigkill-not-oom/plan.md)
for why the release waits, and
[docs/283-install-gate-lost-completion](../283-install-gate-lost-completion/plan.md)
for the two routes to this symptom that are already closed.

## The incident

Diagnosed read-only from an ops session against the deployed build
`3780af7e73e0d3e556dd043ff2016e2f4a86da24`.

Session `064ea640-8474-492f-a68e-8f0cb42e1df2` (repo `reward-tag`). Its
`preview: auto` services `game` and `debug` went down and stayed down. The
orchestrator log, 2026-08-30 UTC:

```
10:35:53  [container-runner:064ea640-…] dependency input changed — reinstalling
10:35:53  [compose:064ea640-…] install re-running — holding 2 gated service(s): game, debug
10:36:04  [container] … compose game exited (exit=137)
10:36:04  [container] … compose debug exited (exit=137)
          <no `install finished — starting …` line, ever>
```

Both containers: `OOMKilled: false`, `ExitCode: 137`, `RestartPolicy: no`. The
137 is our own `docker compose stop` — SIGTERM, grace, SIGKILL — which is the
docs/239 pattern and correct. What was wrong is that the bracket never closed.

While a service sits in `gatedServices`, nothing can start it: the poller's
`isGated` skip (`service-poller.ts`), `handleNonZeroExit`'s gated early return
and Compose's `restart: no` all deliberately ignore it.

**Not one session.** Scanning the retained orchestrator log for the last gate
event per session: 19 released correctly, **5 had a HOLD as their last gate
event with no release** — `064ea640`, `9f408e61`, `563cc64c`, `4cc667c8`,
`fe91fdc1`. Two were still visibly broken at diagnosis time. `064ea640` itself
released correctly on its FIRST install and then failed on all five subsequent
mid-session re-installs.

One session recovered by accident, which is worth recording because it shows
nothing in the gate path did it: at 10:21:45 the same wedge occurred, a plugin
reconcile at 10:22:51 ran a full `compose up`, and `game` came back at 10:23:04.
At 10:35:53 no reconcile followed, so it stayed down.

## This is docs/283's symptom on a build that already has docs/283's fix

`awaitInstallCompletion()` and `INSTALL_STATUS_PROBE_INTERVAL_MS` are both
present at this ref. So this is a **surviving route** to the same user-visible
outcome, not a regression of a fixed one. Both of docs/283's known routes are
ruled out for this incident:

1. **The install finished.** `docker top` on the session container showed no
   install process.
2. **The teardown finished.** `docker top` on the orchestrator showed no
   `docker compose stop` for project `shipit-064ea640-847` (other sessions'
   `compose logs -f` processes were present, so the command would have shown).

And `runInstall` demonstrably RETURNED on the earlier cycles:
`maybeReinstallForDepChange()` guards on `inFlight = this._installComplete !== null`,
and `dependency input changed — reinstalling` was logged five separate times for
this session. Each of those proves `_installComplete` was null at that moment,
so the previous cycle's `signalInstallComplete` had run.

That leaves only the branches that returned **with no log at all**:

- `releaseInstallGate()` → `open()`: `_disposed`; `_installRunning`; and the
  `_gateGeneration !== generation` check in the post-teardown continuation.
- `startGatedServices()`: `gatedServices.size === 0`; and `names.length === 0`
  after the `stoppedByUser` filter — which clears `gatedServices` and returns
  silently.

Each is individually reasonable. Together they made a lost release **completely
invisible**: the hold is logged unconditionally, the release is not, so the
operator sees a stop with no matching start and no reason anywhere.

**Which branch it was is deliberately not known, and is not guessed at here.**
Narrowing it further from a read-only session was not possible, and the fix does
not need it.

## The fix

Two halves, matching the two halves of the problem.

### 1. A gate-liveness watchdog (req 1, req 5)

`ServiceManager.checkInstallGateLiveness()`, called from the poller's
`afterPoll` hook — the cadence that already exists, and that already knows about
the gate through `isGated`.

The watchdog is written against the **state**, not against a route. The wedge is
decidable without knowing what failed: services sit in `gatedServices` while
nothing that could open the gate is in flight, and nothing polls a held service,
so no gate event will arrive. That is the property req 5 asks for — docs/283
closed two routes and a third appeared on a build carrying that fix, so a fix
aimed at a fourth named route would be the same mistake again.

Four conditions must all hold, and each one is a way the bracket is legitimately
open rather than wedged:

| Condition | Why it is not a wedge otherwise |
|---|---|
| `gatedServices.size > 0` | Nothing to recover. |
| `!_installRunning` | A running install owns the gate; its completion is the release (req 2). |
| `!_installFailed` | `latchGatedServicesToError` keeps the services in the set **on purpose**, latched to `error` with the real cause, so a later successful re-install starts them. That is a held gate the user can see and act on — and starting them walks them into the `vite: not found` the latch exists to prevent. |
| `_gateReleasesInFlight === 0` | `docker compose stop` may legitimately run for a service's whole `stop_grace_period`, and `releaseInstallGate` awaits it precisely so our own SIGKILL lands while the service is still gated (docs/239). Reopening inside that window re-creates the bug the await exists to prevent. |

**`_gatedTeardown` cannot answer the last one**, and that is the subtle part.
`releaseInstallGate` captures the teardown and nulls the field on its first
line, so for the whole of its await — which can run for
`stop_grace_period + GATED_TEARDOWN_GRACE_MARGIN_MS` — the field reads `null`
while the bracket is very much still closing. A watchdog reading the field would
reopen the gate mid-teardown on **every healthy re-install**: not a backstop, a
participant, and a docs/239 regression. `_gateReleasesInFlight` is a counter
rather than a boolean because two releases can overlap (an older cycle's release
still awaiting its teardown when a newer one starts), and a boolean cleared by
whichever finished first would un-hide the other.

**`_gatedTeardown === null` is deliberately NOT in the predicate**, and an
earlier draft had it. It is unreachable-true: the field is non-null only while
`_installRunning` is true, since `holdGatedServicesForReinstall` sets it and
`releaseInstallGate` nulls it on entry. So it can never prevent a docs/239
regression that `_gateReleasesInFlight` doesn't already prevent, and its only
possible effect is to *suppress* a real recovery if that invariant ever shifts —
a condition whose only reachable behaviour is to block the fix. Raised by review.

**A settling delay** (`GATE_WATCHDOG_SETTLE_MS`, 60s) on top. The condition must
hold continuously, measured from the first heartbeat that saw it. On a healthy
bracket the watchdog never even starts its clock, because a teardown or a running
install is always in flight.

**The action is the gate's own open path** — `startGatedServices()`, not a
bespoke start. That is what makes req 3 hold by construction rather than by a
second copy of the filter: a wedged gate holding only services the user stopped
is cleared, logged, and nothing is started.

#### Requirement 5 one layer down: `startGatedBatch` re-filters too

Review found that the `stoppedByUser` filter in `startGatedServices` runs
**before** the batch is queued on `serializeStackOp`, and the queue can hold it
for as long as the `compose up` ahead of it takes. A Stop landing in that window
records itself and finds no `up` in flight to chase — `stopService` captures
`upSettled` before stopping, and the batch has not started one — so the queued
start walked the service straight back up. This is requirement 5 violated one
layer down, exactly as `_gateGeneration` was in docs/283, and it is fixed the
same way: `startGatedBatch` re-applies the filter against the state it actually
runs in.

The bug predates this change (it is reachable from any gate open), but the
watchdog is a new route into it, so it is fixed here.

#### What the watchdog does NOT cover

- **A lost install COMPLETION.** An install that never finishes leaves
  `_installRunning` true, and firing there would start services against a
  half-written dependency tree — the docs/137 race the gate exists to remove.
  That layer is docs/283's `awaitInstallCompletion`, deliberately independent.
- **A wedge that the poller never observes.** Recovery is one settle window
  after the first successful `docker compose ps`, and the poller is armed at the
  END of `start()` — so a `start()` that throws before that point leaves no
  heartbeat to run this. That is the existing `stack_error` path, which is
  visible.

#### Why the poll heartbeat, and not its own timer

`STARTING_WATCHDOG_MS` is the closest existing thing — a per-service backstop for
"stuck in `starting`" — and it runs off its own timer precisely so it holds when
the poll loop does not. It cannot catch this: the install gate is one of its two
documented exemptions, and it **re-arms** rather than firing, so a gated service
sits in `starting` forever with the watchdog politely waiting for the gate to
clear. That is a large part of why the incident was invisible from inside
ShipIt.

`afterPoll` runs only when `docker compose ps` SUCCEEDS, so a Docker outage
stalls detection. That is the right side to fail on: the recovery action is a
`docker compose up`, which during an outage fails and latches the services to
`error` — strictly worse than leaving them held, since the held state recovers
by itself on the first poll after Docker answers again.

### 2. Make every silent branch loud (req 4)

Arguably the more valuable half. Had these logged, the diagnosis above would
have taken minutes instead of an hour, and the branch would be known.

Every early return on the gate-open path now names itself:

| Site | Log |
|---|---|
| `open()` — disposed | `install gate not opened — the manager was disposed while the teardown ran` |
| `open()` — install running | `install gate not opened — a newer install is already running; its completion owns the next open` |
| release continuation — generation moved | `install gate not opened — this teardown belongs to gate generation N, superseded by M` |
| `startGatedServices` — empty set, stack started | `install gate open skipped — no services are held` |
| `startGatedServices` — all `stoppedByUser` | `install finished — all N gated service(s) were stopped by the user; clearing the gate and starting nothing` |
| watchdog fires | `install gate watchdog: N service(s) (…) have been held for Ns with no install running, no failed install, and no teardown pending — the gate's release was lost, and no gate event will arrive to open it. Reopening it.` |

Two branches stay silent, both deliberately. `startGatedServices`'s `_disposed`
return is unreachable — both callers check `_disposed` synchronously immediately
before calling it — so a log there would be dead. And the empty-set branch logs
only once `_started` is true: before `start()` has populated the service map
there is nothing the gate COULD be holding, and a successful install routinely
finishes in that window, so logging unconditionally would put a "declined to open
the gate" line in every session's boot. Both raised by review — the first draft
logged both unconditionally.

## What is deliberately unchanged

- **docs/283's probe.** `awaitInstallCompletion` /
  `resyncInstallStateAfterReconnect` are untouched. That is a second,
  independent backstop at a different layer (the completion *event*), not a
  replacement for this one (the gate *state*).
- **`releaseInstallGate`'s await of `_gatedTeardown`** (docs/239). The watchdog
  waits for it too, via `_gateReleasesInFlight`.
- **`_gateGeneration`.** `startGatedBatch` still re-checks it, and the watchdog
  cannot reach a gate a newer hold owns because such a hold sets
  `_installRunning` and parks a teardown.
- **The stack-op queue route.** docs/283 records a third, independent route:
  `startGatedServices` clears `gatedServices` before queuing `startGatedBatch`,
  so a queue held indefinitely leaves the services unstarted and *not* held by
  the gate. This watchdog cannot see that, by construction. Still recorded, not
  fixed — bounding it has its own hazard (the thing most likely to be holding
  the queue is a legitimate long image build).

## Key files

- `src/server/orchestrator/service-manager.ts` — `GATE_WATCHDOG_SETTLE_MS`,
  `checkInstallGateLiveness()`, `_gateReleasesInFlight`, `_gateWedgedSince`, the
  `afterPoll` wiring, the `stoppedByUser` re-check in `startGatedBatch()`, and
  the branch logging in `releaseInstallGate()` / `startGatedServices()`.
- `ServiceManagerOptions.gateWatchdogSettleMs` — test seam, same role as
  `pollIntervalMs`.
- `src/server/orchestrator/integration_tests/install-gate.test.ts` — the
  `liveness watchdog` describe block.

## Tests

Seven tests, in the file that already harnesses this bracket. They drive a real
`ServiceManager` over a fake compose CLI (no Docker) with a real poll interval,
so the watchdog fires from the same hook it fires from in production.

They deliberately do **not** model a route to the lost release.
`loseTheGateRelease` sets `_installRunning` false and `_gatedTeardown` null,
which is what the manager looks like AFTER any of the five candidate branches
returned — `releaseInstallGate` nulls the teardown on its first line and only
then reaches the branches that can drop the open. No public call reproduces "the
release was dropped" without also deciding which branch dropped it, and the
incident deliberately left that unknown.

**Every negative test ends by removing the one condition that was holding the
watchdog back, and watching it fire.** Without that, "nothing happened for 300ms"
is equally consistent with "the poll loop was never running", and a deleted guard
could pass for the wrong reason on a loaded CI box. Raised by review; the first
draft's negatives were bare sleeps.

- **`reopens a gate whose release was lost mid-reinstall, and the held services
  start`** (req 1, req 4) — the incident, through the real bracket: the service
  is up, a mid-session re-install re-gates it and OUR `compose stop` goes out
  (the exit 137 the user reported), then the release is lost. Asserts the
  recovery AND that it logged why.
- **`does nothing while the install is still running`** (req 2).
- **`does nothing while the teardown's compose stop is still in flight`** (req 2,
  docs/239) — the `compose stop` is parked, so `_gatedTeardown` has already been
  nulled by `releaseInstallGate` and only `_gateReleasesInFlight` knows the
  bracket is still closing. Then the stop lands and the REAL release starts the
  service exactly once.
- **`clears a wedged gate that holds only services the user stopped, and starts
  nothing`** (req 3, req 4).
- **`does not resurrect a service the user stops while the gated start waits on
  the stack queue`** (req 3) — the queue is parked, the watchdog opens the gate,
  the user stops the service, and the batch must drop it. This is the review
  finding above; it fails without the `startGatedBatch` re-check.
- **`does not open a gate a newer hold owns`** — the wedge clock is started, a
  newer cycle takes ownership before it expires, and nothing starts until that
  cycle's own release lands.
- **`leaves a gate held by a FAILED install alone`** — the `_installFailed`
  exemption.

Each element was verified load-bearing by deleting it and watching a named test
go red. The full result, including what is NOT covered:

| Deleted | Red test |
|---|---|
| the whole watchdog | 5 of the 7 — every test except the two the release counter guards |
| `_gateReleasesInFlight === 0` | `does nothing while the teardown's compose stop is still in flight`, `does not open a gate a newer hold owns` |
| `!_installRunning` | `does nothing while the install is still running` |
| `!_installFailed` | `leaves a gate held by a FAILED install alone` |
| the settle delay | `does not open a gate a newer hold owns` |
| the `startGatedBatch` `stoppedByUser` re-check | `does not resurrect a service the user stops while the gated start waits on the stack queue` |
| `gatedServices.size > 0`, `!_disposed` | **none** — both are definitional (an empty set makes the action a no-op; a disposed manager has a stopped poller, so no heartbeat runs). Said here rather than left to look covered. |

Not covered: the individual log lines other than the watchdog's own and the
all-stopped-by-user one. Requirement 4 can regress for the three
`releaseInstallGate` lines without a red test.
