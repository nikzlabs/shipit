---
description: Fix gaps in service-manager's Docker Compose error handling that cause the preview proxy and log surfaces to drift out of sync when services hiccup.
issue: planning#43
---

# Compose resilience — services that recover when Docker hiccups

## Problem

Three related gaps in the orchestrator's view of compose services let
the preview and logs surfaces drift out of sync with reality. Symptoms:
the preview iframe loads against a dead container, the logs panel shows
empty output even when the service is healthy, or a preview service
that crashed and recovered never reappears in the proxy.

These are tracked separately from feature 120 (container resilience)
because they live in `service-manager.ts` and concern the compose stack
rather than the agent container's SSE channel.

## The gaps

### D — `pollStatus` swallows Docker errors (fixed)

When `docker compose ps` failed (Docker daemon restart, socket EAGAIN,
permission glitch on the proxy), `pollOnce` bailed out and the in-memory
`services` map kept its previous statuses. Bailing out is right as far as it
goes — "no rows" from a broken docker CLI is not evidence that every container
vanished, and reconciling on it would walk a healthy stack to `stopped`. But it
froze the last reading *indefinitely*: a service that crashed during the outage
still showed `running`, and because `getServices` publishes an address for a
`running` service, the preview proxy kept routing at a dead container.

**Fixed** in `ServicePoller.expireUnconfirmedStatuses`. A *continuous* run of
`ps` failures past `DOCKER_UNREACHABLE_GRACE_MS` (30s, ~6 polls) withdraws the
claims that are no longer supportable: every `running` service is moved to
`error` with `DOCKER_UNREACHABLE_MESSAGE`. One successful `ps` clears the clock,
and the forward pass restores the real statuses on that same poll.

Only `running` services are touched, and that is the whole mechanism:
`running` is the one status that asserts a live container and the only one
`getServices` publishes an address for, so moving it to `error` also drops the
container IP (`updateServiceStatus` deletes it) and the proxy stops routing.
`stopped`/`error` assert nothing. `starting` is already bounded by the manager's
own watchdog, which runs off its own timer and therefore keeps working while the
poll loop is blind — a second mechanism for it here would be redundant. Gated
services (docs/137) and services with a `compose up` in flight are excluded, as
in every other pass.

**Rejected**: the `unknown` status + `stack_unhealthy` WS message + client banner
this section used to propose. A new member of `ServiceStatus` has to be taught to
the client, the preview gating and the agent-facing service registry before it
buys anything, and `error` plus the existing `error` string already delivers the
requirement — stop claiming `running`, stop routing, name the cause. The message
says plainly that the container may still be running, because we are reporting a
failure to *observe*, not an observed failure.

### E — A dead worker can look alive forever (fixed)

Satisfies requirement 6: *when the session worker is permanently
unreachable, ShipIt says so; it does not keep presenting the session as
alive.*

The gap was originally written as "SSE reconnect retries forever". The
unbounded reconnect turned out to be a symptom, not the defect — most of
the paths that were meant to make it harmless do work, and one does not.

**What already covers a dead worker.** Both verified in the code, not
inherited from a doc:

- Docker emits `die` → `container-health.ts` deletes the map entry and
  emits `container_exited` → `handleContainerExited`
  (`startup-tasks.ts`) writes a log-ring breadcrumb, finalizes the
  interrupted turn's chat rows, emits a visible notice and
  `session_status {running:false}`, and force-disposes the runner. Dispose
  calls `sse.disconnect()`, so the retry loop stops as a consequence. The
  worker is PID 1 in the container, so worker death *is* container death
  and this is the common case.
- A map entry deleted while the runner survives (a `die` attributed to a
  replacement incarnation) is caught by the missing-container reconciler
  in `app-lifecycle.ts`, which re-adopts a live container or force-disposes
  the runner.

**What did not.** `SessionContainerManager`'s `containers` map is mutated
only by that `die` handler and by explicit `destroy()`. The Docker event
stream reconnects on a 5s debounce and goes down entirely on a daemon
restart, and missed events are never replayed — so a `die` delivered
during a gap leaves an entry claiming `status: "running"` for a container
that no longer exists. Nothing re-verified the map after startup, and the
reconciler's `if (containerManager.get(sid)) continue` skipped exactly
those sessions. Everything else declines by design: `runReconcileCheck`
and `verifyRunningState` (`container-session-runner.ts`) deliberately keep
`running=true` when the worker is unreachable rather than penalize a
transient failure, and `health_monitor_resumed` only writes a breadcrumb.
Net effect: the session rendered as alive indefinitely, the parked turn
never resolved, and the SSE loop retried for the life of the process.

**Fix**: teach the reconciler that a map entry is not proof of life.

- `SseConnectionManager.streamDownSince` — a timestamp latched when the
  stream goes down and cleared when one opens — is surfaced on the runner
  as `workerStreamDownSince`. Deliberately a timestamp and *not* the
  reconnect counter: `onDisconnect` can abort the reconnect schedule
  entirely (the runner does exactly that once the terminal-only reconnect
  cap is exhausted), which freezes any attempt count forever — an
  attempt-count gate would never fire in precisely the sessions that are
  most thoroughly stuck. It is latched before `onDisconnect` for the same
  reason.
- A runner whose stream has been down for `WORKER_UNREACHABLE_MS` (90s)
  has its container checked against Docker via `isTrackedContainerRunning`.
  The gate keeps the probe off healthy sessions entirely — an open stream
  keeps the timestamp at 0 — and off the slow-image-build case the
  requirements exclude, which happens before the runner has a worker URL at
  all (`awaitingContainer`, checked first).
- Docker saying "not running" (or 404) is treated as the missed `die`:
  `markContainerGone` does what that handler would have — reap the
  incarnation's egress sidecars, then drop the entry — and the session
  falls through to the reconciler's existing vanished path. It refuses to
  act on a container id other than the one that was probed, so a rescue
  that swaps the container during the inspect cannot have its replacement
  deleted. Docker *failing to answer* returns `undefined` and is never read
  as death, so a daemon outage cannot reap the fleet.
- Docker saying "running" is not the end of it. Requirement 6 is about an
  unreachable **worker**, so a live container gets one confirming
  `/health` probe; a worker that does not answer that either is reported
  the same way, with a notice pointing at Restart rather than "send a
  message" (a fresh message would reconnect to the same wedged worker).
  Its map entry is deliberately kept — the container is alive, and
  forgetting it would have the next activation build a second one beside
  it.

No new WS message type and no new banner: `session_status
{running:false}` already clears the client's running state, and what the
user actually reads is a transcript row. That row is the second half of
the fix — the vanished path previously wrote only a log-ring entry
(`session_status.error` is rendered nowhere), so it stopped the spinner
without saying why and let the next turn's `replaceInProgress` delete the
interrupted turn's rows. It now calls the same
`preservePartialTurnOnWorkerLoss` rescue `handleContainerExited` uses, and
that rescue was corrected in two ways that fix the `die` path too: it
persists the **canonical** turn snapshot (`persistTurnInProgress`, which
re-interleaves live-steered user messages and recorded cards) instead of a
groups-only rebuild that `replaceInProgress` would have silently dropped,
and it delivers the explanation with `emitNoticePostTurn` — emit **and**
persist — instead of an append the attached viewer never sees until a
reload.

**Known and pre-existing, not fixed here**: force-disposing a runner
mid-turn tears down the proxy without running the turn's post-turn commit,
so edits can sit uncommitted in the session dir. (`dispatchOnRunner` does
settle the external `TurnHandle` as dropped, so nothing hangs — but the
commit is skipped.) This is identical on the Docker-`die` path and wants
a fix at the dispose boundary that covers both; it is not specific to this
gap.

### F — Compose log streamer doesn't restart when service comes back (fixed)

A `docker compose logs -f` follower dies with the container it resolved at spawn
time, so every recreate leaves the service unfollowed. It was spawned only from
`start()` / `startService` / `restartService` — never from the AUTOMATIC recovery
paths (`runRetryNow`, the OOM retry, the gated batch) — and it had no exit
handler, so nothing even noticed. `logBuffers` stopped growing and the panel
looked broken on a service that had recovered perfectly well; the only way back
was for the user to restart it by hand.

**Fixed** with two small pieces:

- `streamLogs` registers a `close` handler that retires the dead follower from
  `logProcesses`. That is what makes `logProcesses.has(name)` an honest liveness
  answer — the deliberate kills already remove their own entry first, so it only
  ever reaps a follower that exited on its own.
- `ensureLogFollower(name)` re-attaches one if and only if there isn't a live
  one. Called from the manager's `onRunning` hook **on the transition into
  `running`** — the single point every recovery route converges on, automatic or
  manual — and after `refreshSecrets`' `up`, which is the one recreate that can
  complete without any poll observing a non-`running` state.

It deliberately does **not** replace a follower that is still alive: `streamLogs`
clears the in-memory ring buffer on every spawn, so a needless replacement would
throw away the backlog this gap is about. The buffer is likewise *not* cleared on
recovery — docs/192's durable log store already carries history across the
container's death, and dropping it would lose the crash output that explains the
restart.

### G — A starting service is silent for the whole `compose up` (fixed)

`startService` writes `starting`, awaits `docker compose up -d --build`,
and spawns the log follower only once that returns. With a warm Docker
layer cache the `up` takes ~2s and nobody notices. With a cold one — a
fresh host, or any deploy that pruned the BuildKit cache — it is a full
image build: this repo's own dogfood `dev` service (apt-get + the agent
CLIs + a Playwright Chromium) runs for minutes.

For that entire window the service sat at `starting` with an **empty log
panel** and no diagnostic anywhere. Three mechanisms each correctly
declined to speak:

- `defaultComposeRunner` collected stderr into a local string and dropped
  it on success; stdout was piped and never read at all.
- the log follower had no container to follow, and isn't spawned until
  after the `up` anyway.
- `withUpInFlight` exempts an in-flight `up` from both the
  missing-container reconciliation and the `starting` watchdog — right,
  because an image build has no bound, but it means nothing times out.

Users read that as "Start does nothing", stop the service, and start it
again — which appears to work, because the first build has meanwhile
warmed the cache.

**Fix**: `ComposeRunner` takes an optional output sink; `ComposeCli.up` /
`upService` pass one through; `ServiceManager.composeLogSink` relays each
line into the log stream of the service(s) being brought up, prefixed
`[compose] `. The sink deliberately does **not** write the durable log
store — `streamLogs` decides `--tail 1000` vs `--tail 0` by asking
whether the store already holds the channel (docs/192), and seeding it
with build output would lose the container's first lines. The same change
drains stdout (an unread pipe could have deadlocked a chatty command) and
caps the stderr kept for the rejection message.

**Known limitation of that choice**: on a service whose channel already
holds container history, `snapshotLogs` returns the durable history and
ignores the ring buffer, so a *later* build is visible only live — a
panel opened mid-build sees it arrive but cannot scroll back to its
start. Persisting compose output properly needs `hasChannel` (a
file-size check over a raw-text channel) replaced by an explicit
"container backlog seeded" marker, or a stack-level compose channel with
UI aggregation. Both are docs/192 changes, not part of this fix.

Compose's output is stack-global — a single `up` can build a service
pulled in by `depends_on` that isn't named in the call — so a multi-service
`up` copies each line to every named service. There is no per-line
attribution to recover; the `[compose] ` prefix carries the distinction
instead.

### H — An in-flight `compose up` had no bound (fixed)

`withUpInFlight` exempts a service from the poller's missing-container
reconciliation *and* re-arms the `starting` watchdog, both deliberately: an image
build has no time limit. But the exemption was unconditional, so a `docker
compose up` that never returns — wedged daemon, dead socket proxy, a `docker`
process that outlived its connection — re-armed the watchdog forever and pinned
the service at `starting` for the rest of the session with no diagnostic
anywhere. (Found by the cross-agent review of PR #2121.)

**Fixed** by bounding the exemption on **silence**, not on elapsed time. Since
gap G the `up`'s own output streams into the service's log panel, so "is this
build making progress the user can see?" is a question we can now actually ask.
`onStartingWatchdogFired` re-arms while the `up` has produced output within
`UP_SILENCE_TIMEOUT_MS` (5 min, refreshed per output chunk by `composeLogSink`);
once it has said nothing at all for that long, the service is reported `error`
with `UP_STALLED_MESSAGE`.

A wall-clock cap on the `up` was rejected: it is precisely the "time limit on a
legitimately slow image build" the requirements rule out, and it would fire on
the dogfood `dev` service's own cold build. The silence bound never fires on a
build that is talking, however long it runs. The `up` is never cancelled, so the
error is a report rather than a verdict — a build that was merely slow still
finishes, and the poll after it writes `running`.

### I — Stop did not cancel an in-flight start (fixed)

`stopService` ran `docker compose stop` while an earlier `startService`'s `up`
was still running, and nothing sequenced the two — both WS handlers just call the
manager. The stop landed on a container the racing `up` then created or started
anyway, so the service came back after the user asked for it to be gone. (Also
from the PR #2121 review.)

**Fixed** by making the stop outlive the start rather than by locking them:

- `stopService` issues its stop **immediately** (a running container should go
  down now, not after a build that may have minutes left), then — if an `up` was
  in flight for that service — waits that `up` out and stops again.
- `stoppedByUser` covers the race from the other side. The start paths abandon
  their post-`up` work, `runRetryNow` refuses to fire, and `handleNonZeroExit`
  ignores the exit our own stop produced. That last one matters more than it
  looks: `compose stop` SIGTERMs and then SIGKILLs a service that doesn't forward
  the signal, so the container exits 143/137 — read at face value, the next poll
  walked a service the user had just stopped to `error`, and a `preview: auto`
  one into a retry that brought it back.
- Any deliberate start — `startService`, `restartService`, `start()`, the install
  gate's release — clears the flag, so it only ever suppresses the window between
  a stop and the next explicit instruction.

Waiting for the `up` *before* stopping was rejected: it would leave the user
unable to stop a service whose `up` is hung (gap H's failure), and would make
Stop appear to do nothing for the length of an image build.

## Known limitations of the D/F/H/I work

Both came out of the cross-backend review and are accepted rather than fixed —
each would cost more mechanism than the requirement it serves.

- **A hung `up` during the INITIAL `start()` reaches no WS listener.** While
  `start()` runs, `_startupComplete` is false, so `updateServiceStatus` batches
  rather than emits — and a `docker compose up` that hangs never lets `start()`
  reach the `finally` that starts the poll loop either. The gap H watchdog still
  records `error` on the service, so `GET /api/sessions/:id/services` and
  `shipit service list` are correct; only the live push waits. This is the
  pre-existing shape of the startup batching (#2044 covered a *throw*, not a
  hang), and unbatching it for one case would trade a documented invariant for a
  narrow window.
- **`flushPostInstallRetries` cannot tell a gap-D `error` from a crash.** If
  docker is still unreachable when `agent.install` finishes, a healthy
  opted-out service that the gap-D sweep moved to `error` is included in the
  post-install restart pass and gets one `compose up` it did not need. The cost
  is a recreate on a service whose docker has been unreachable for ≥30s anyway;
  distinguishing the causes needs a typed error field on `ManagedService`, which
  is more vocabulary than requirement 3 asks for.

## Sequence

D, F, H and I have shipped. E has shipped too; it was independent of the compose
stack, living in the runner's SSE channel and the container map rather than in
`service-manager.ts`.

## Out of scope

- Cross-session daemon-down banner. The existing per-session stack
  status already covers this; a global "Docker is down" surface is
  separate.
- Compose stack auto-recovery (e.g., `docker compose up` retry on
  daemon recovery). Reconcile-on-config-change already exists; a
  reconcile-on-daemon-recovery could piggy-back but isn't a clear
  user-visible win yet.

## Key files

- `src/server/orchestrator/service-poller.ts` — `expireUnconfirmedStatuses`
  (gap D), `DOCKER_UNREACHABLE_GRACE_MS` / `DOCKER_UNREACHABLE_MESSAGE`.
- `src/server/orchestrator/service-manager.ts` — `ensureLogFollower` + the
  follower's `close` handler (gap F); `UP_SILENCE_TIMEOUT_MS` /
  `UP_STALLED_MESSAGE` and the bounded exemption in `onStartingWatchdogFired`
  (gap H); `stoppedByUser` / `upSettled` and `stopService` (gap I).
- `src/server/orchestrator/compose-cli.ts` — `ComposeOutputSink`, the output
  stream gap H's silence bound reads (gap G).
- `src/server/orchestrator/app-lifecycle.ts` — missing-container
  reconciler; the gap E liveness gate and vanished path.
- `src/server/orchestrator/container-discovery.ts` —
  `isTrackedContainerRunning`, the Docker liveness probe.
- `src/server/orchestrator/session-container.ts` — `markContainerGone`.
- `src/server/orchestrator/sse-connection-manager.ts` —
  `streamDownSince`, the "worker stopped answering" signal.
- `src/server/orchestrator/startup-tasks.ts` —
  `handleContainerExited` and the shared
  `preservePartialTurnOnWorkerLoss` rescue.
- `src/server/orchestrator/chat-card-persistence.ts` —
  `persistTurnInProgress` / `emitNoticePostTurn`, reused by that rescue.

No client, WS-type or `ServiceStatus` changes anywhere in this feature: D, F, H
and I are all expressed in the existing `ServiceStatus` union and the existing
`ManagedService.error` string, which the services drawer, `shipit service list`
and `GET /api/sessions/:id/services` already render — and E reuses
`session_status` plus the existing `system_notice`.
