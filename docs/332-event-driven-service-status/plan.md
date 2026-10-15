---
issue: planning#697
title: "Event-driven service status: design"
description: One host-wide Docker event subscription drives per-project refreshes; no per-session timer.
---

# Design: event-driven Compose service status

Implements [requirements.md](requirements.md). The measured cause and the behaviour inventory this design must preserve are in [investigation.md](investigation.md).

## Shape

Today each `ServiceManager` owns a 5-second timer that spawns `docker compose ps` plus one `docker inspect` per container. The timer is the only thing that moves service state forward, so it must run even for a session nobody is watching (req 1 is violated by construction).

This design keeps `ServicePoller` as the thing that *reconciles one project*, and removes its timer. Three callers drive it instead:

1. **Docker events**, routed per project (the normal case).
2. **One host-wide backstop**, every 5 minutes, for all sessions in one Engine API call (req 5).
3. **A resync** whenever the event stream reconnects, because events are lost across a disconnect.

Everything is in-process Engine API through dockerode (`service-manager.ts` already receives a client via `containerManager.getDockerClient()`); no step spawns a process.

## The event source is the existing stream

`container-health.ts` already holds one process-lived `docker.getEvents()` subscription with a 5-second reconnect and a `health_monitor_resumed` signal, and it already decodes Compose service exits into `service_exited` (verified at `container-health.ts:startHealthMonitor`). This design extends that stream rather than opening a second one:

- add `network` to the subscribed types, for the network heal trigger;
- emit `compose_container_changed` for a service container's `start` / `destroy`;
- emit `session_network_changed` for `disconnect` / `destroy` on a `shipit-session-*` network;
- keep `service_exited` as the authoritative crash signal, and **fix it**: it fired on `oom` *and* on the following `die`, describing one kill twice — once as an exit-1 crash with the OOM flag, once as a non-OOM SIGKILL with the real code. Harmless while it only drove a log line; it would have sent the OOM retry decision the wrong way. It now correlates the two as the agent-container path already did, within a 60 s window.

That correlation trades one thing deliberately: an `oom` with no `die` after it — the kernel killed a *child* and the container survived — now reports nothing, where before it raised a `service_oom` card. The card said the service was OOM-killed, which for a container that is still running was wrong, so the signal lost was a false one.

## Routing: project label, not the parent label

A new process-lived `service-event-router.ts` holds the `serviceManagers` map and builds a `com.docker.compose.project` → `sessionId` index from it (`composeProjectName(sessionId)`). Events and backstop rows are routed by that label. The project label is what every container of the stack carries, whether it came from the project file or from a plugin, so routing never depends on `shipit-parent-session` being present.

The router owns the 5-minute backstop: one `GET /containers/json?all=1&filters=label=com.docker.compose.project` (plus the stack filter, so two ShipIt stacks on one host do not cross-talk), sliced per project and handed to each manager. One timer for the process, cost independent of the session count.

**Refreshes are coalesced per session.** Events arrive in bursts — a `compose up` of a ten-service stack emits ten `start` events — and each refresh is a full listing of that project. So one runs at a time per session with at most one more queued behind it; the queued one reflects every event that arrived while it waited, which is all a reconcile needs. A backstop slice waits its turn like any other: a refresh already running is newer than that listing, so dropping it loses nothing, and letting it bypass the marker let one path clear another's and run two refreshes of a session at once.

Two failure modes of that shared listing are handled explicitly, both found in review. A listing that **fails** must not simply be logged and dropped: each session has to reach its own Docker-unreachable grace, or a stack that died while nobody was watching keeps publishing `running` for ever. The failure is *reported* to each manager (`noteListingFailed`) rather than relisted per session — a listing each, awaited in turn and each able to hang to its own timeout, would take a hundred sessions the better part of an hour to reach the last of them. A listing that **never settles** would latch the in-flight flag and silently disable every later backstop *and* stream-resume resync, so it is bounded by a timeout — as is the `network connect` repair inside a refresh, which was the one remaining unbounded await and could stall the whole sequential sweep.

**The stream-resume resync also heals every session's network.** Removing the heal from the refresh path removed the only recovery for a *missed* network event, and a listing cannot substitute: the agent container is not in the Compose project, so no listing reveals that it was detached. On resume — the one moment we know events were lost — each session's attachment is checked once. Bounded and one at a time per session, because a resume asks for every session together.

**The sweep itself is bounded.** Per-call timeouts do not bound a *sequential* sweep: a hundred sessions each hanging to their own timeout would occupy it for the better part of an hour, suppressing every backstop and resync in between. Sessions are independent, so they are reconciled concurrently, each bounded. And a resync requested while a sweep is already running is queued rather than dropped — that sweep's listing predates the gap, so it cannot answer the request.

Routing by project label covers start/destroy and the backstop: the router matches `composeProjectName(sessionId)` against the label for each live manager, rather than reversing the project name (it is a truncation of the session id). Exits are routed by session, because `service_exited` is derived from the `shipit-parent-session` label upstream in `container-health.ts`; the generated override sets both labels on every service, plugin services included.

## Two entry points on the manager, because there are two different jobs

- **`applyServiceExit(serviceName, { exitCode, oomKilled })`** — the crash path. Both values come from the event, which is the only source for them: a listing carries neither, and a container with a restart policy is replaced before any listing could observe its exit. It feeds the same `onLeftRunning` / `onExitedCleanly` / `onExitedWithError` callbacks the reconcile path uses, so install-time retry, OOM retry and post-gate retry are unchanged.
- **`refreshServices(listed?)`** — the reconcile path. A project listing → status transitions, container addresses, the missing-container rule, the Docker-unreachable rule, the install-gate check.

Both already exist inside today's `pollOnce`; the exit branch is factored out so an event can reach it directly. **An exit is always followed by a refresh**, which is what re-reads the service's real state: the restart policy may already have replaced the container, in which case the refresh reports `restarting` or the new address, and its verdict supersedes what the exit scheduled — correctly, because the service is up again.

### The ordering hazard this creates, and the generation counter

A listing describes the moment it was taken, and resolving it is asynchronous. So a refresh that *started before* an exit can finish after it — and applying it then republishes a dead container as `running` and, through `onRunning` → `clearRetryState`, **cancels the crash recovery the exit just scheduled**. Reviewed and reproduced against the real `ServiceRetryManager`: zero retries, status `running`, no timers left.

`ServicePoller` therefore carries a generation counter, bumped by `applyServiceExit` and by `stop()`. `pollOnce` captures it on entry, resolves addresses and exits **without publishing anything**, and discards the whole listing if the generation moved. An earlier guard that instead compared the exiting container's id against the last one seen running was removed: it dropped a *real* exit whenever a replacement container died before its own listing landed, which is the worse failure.

The generation at entry is not enough for a **shared** listing, though, and the second review round caught that: the backstop takes one listing and reconciles sessions in turn, so a slice can be applied long after the listing was taken — by which time an exit may already have been handled. A slice therefore carries **when it was taken**, and is discarded if anything has been applied since. Reproduced before the fix, against the real `ServiceRetryManager`: `starting → running`, zero retries, container still exited.

Three details of that guard are load-bearing, each from the third round. The clock is **monotonic** (`performance.now()`), because a wall-clock step backwards would make a newer exit look older than the slice it has to override. The mark is seeded **at construction**, so a replacement manager for the same session never accepts its predecessor's slice. And it advances on **every** publication, not only on exits and stops, so a slice taken before a completed start or network refresh cannot undo it.

Ordering between two *overlapping* listings needs its own answer, because follow-up timers and the manager's own post-`up` refreshes call `pollOnce` directly — ordering cannot live in whichever caller happens to coalesce. Each listing takes a sequence number on entry and refuses to publish if a later-started one already has.

## One listing, no per-container inspect

`pollOnce` consumes a normalized `PollerContainer[]` from an injected `listContainers`. Two implementations, one consumer:

- **Engine API** (production): `/containers/json?all=1&filters=label=…` carries `State`, `Labels` and `NetworkSettings.Networks[*].IPAddress`, so a running container needs **no** `inspect` at all — this is where most of the measured CPU goes.
- **`docker compose ps --format json -a`** (tests): the existing parse, kept so tests that inject `composeQuery` keep working.

`inspect` survives for the two things a listing cannot answer, and only then: the exit code / `OOMKilled` of an exited container whose exit no event reported (a resync after a missed event), and the re-read after a repair `network connect` for a running container that shows no session network.

**An exited container's exit is re-read every reconcile, and deliberately not remembered.** Three attempts to remember it each produced a defect, in three successive review rounds:

1. Cache it per container id — unsound, because a restart reuses the id, so a container that exited 0, restarted and was then OOM-killed reconciles as a clean stop and can cancel a scheduled OOM retry. (The same id reuse is why an unclaimed `oom` attribution is dropped on that container's next `start`.)
2. Skip when the service already reads `stopped`/`error` — unsound, because the docker-unreachable sweep leaves a terminal status *no exit produced*, and the `die` event that would have classified the crash was lost in the same outage.
3. Skip when this exact container's exit was already applied, dropping the entry when it is next seen running — still unsound: a restart *and* a second exit can both fall inside one event-stream gap, so the run in between is never observed; a transiently failed inspect settles a fabricated exit code 1 for good; and with two exited replicas the single entry per service thrashes, inventing exit-1 errors.

So it was deleted rather than hardened a fourth time. What it bought was **one socket request per exited container per five minutes, with no process spawn** — against a baseline of 18 process spawns per second. That is the right side of the trade, and it is the honest reading of req 5: the periodic work must not spawn processes or grow with idle sessions, and a bounded inspect of a container that has actually exited does neither.

Two notes on scale, since this is the one place the shared check is not literally one call. Exited containers are not the common case — Compose removes a service's container when it is brought down — so for most stacks this is zero. And it is one request on a unix socket, not three Go processes.

## Pending conditions get a one-shot timer, not a cadence

Three of the poller's rules need a *second* observation after a delay: the missing-container grace (30 s), the Docker-unreachable grace (30 s), and the install-gate watchdog. With a cadence they came for free; with events they would never fire, because no further event arrives for a container that is simply absent.

So a refresh that leaves a pending condition arms **one** follow-up at that condition's deadline, and a refresh that leaves none arms nothing. An idle, healthy session therefore holds no timer, which is req 1; a session mid-install or mid-outage holds one, which is not idle.

Three details are load-bearing, each a defect found in review:

- **A deadline already in the past must not be re-armed.** Once the Docker-unreachable sweep has run there is nothing more that clock can decide, but every further failed listing still scheduled its past deadline — clamped to the 250 ms floor, that measured **four listings per second per session** for as long as the outage lasted. The clock stops driving follow-ups once swept; recovery arrives with the next event or the backstop.
- **A requested follow-up outlives the arming that folded it in.** The install-gate watchdog requests one; an unrelated service exiting then re-armed with no pending clocks and cleared the gate's timer. The request is now cleared when it fires, not by a later arm.
- **A condition that cannot be resolved is not pending.** The gate watchdog asks for a look only while it could still reopen the gate — a *failed* install holds its services for ever by design, so asking there refreshed an idle session every 60 seconds for ever.
- **A clock that cannot act must not re-arm either.** While listings are failing, nothing reconciles, so a missing-container deadline already in the past stayed eligible and re-armed at the 250 ms floor on every attempt — the same spin by a second route, reached whenever an outage followed a vanished container.
- **The gate watchdog's clock starts when the gate starts being held**, not at the next refresh. A held gate runs no containers, so it produces no Docker events of its own to ride.
- **A clock's "already swept" flag resets with the clock itself.** Leaving it set meant the *first* outage disarmed every later one: a second outage would start its 30-second clock and then never arm the follow-up that fires the sweep.

The network heal was a fourth case and is now simply gone from the refresh: it ran `ensureConnectedToSessionNetwork` for every manager on every tick, so a "shared" backstop still cost one network inspect per session. Docker `network` events drive it instead — including `connect`, so a *recreated* network is rejoined rather than attempted once and abandoned. The heal is membership-gated, so our own reattachment settles rather than looping.

The log follower is the last such case: every `running` poll called `ensureLogFollower`, to catch a follower that exited while its container kept running. It re-arms itself from its own `close` handler instead (which also follows a spawn `error` — verified, so a failed spawn is covered), guarded on the service still being `running`. That re-arm is **bounded**: a follower that cannot attach at all would otherwise be a permanent 2-second timer on an idle session, which is the very thing req 1 forbids. Only **stdout** restores the budget — a `docker compose logs` that writes a diagnostic to stderr and exits proves the follower did *not* attach, and crediting that made the bound meaningless. The budget covers **every** attempt, including the one `onRunning` makes on each reconcile: bounding only the self-armed retries left the periodic check spawning a process per backstop for a follower that could never attach, which is exactly the cost this feature exists to remove. A deliberate restart grants a fresh budget.

## Out of scope

Container health (req 6): the poller never read it and this design does not subscribe to `health_status`.

## Key files

- `src/server/orchestrator/service-poller.ts` — reconcile one project; normalized container shape; no timer.
- `src/server/orchestrator/service-event-router.ts` — new: project index, event routing, host-wide backstop, resync.
- `src/server/orchestrator/container-health.ts` — the one subscription; network events and the new emissions.
- `src/server/orchestrator/service-manager.ts` — `refreshServices()` / `applyServiceExit()`; Engine API listing; on-demand network heal.
