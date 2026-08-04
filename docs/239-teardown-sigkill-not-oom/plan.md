---
issue: https://linear.app/shipit-ai/issue/SHI-256
description: Exit 137 is SIGKILL, not proof of OOM — stop reporting our own re-install teardown as a service OOM kill.
---

# Teardown SIGKILL is not an OOM kill

## Problem

Confirmed live on the production host against deployed commit
`7a39eaeb`. One session's `preview: auto` `dev` service reported an OOM
kill every 30 seconds for ~2 hours, and told the user to raise a memory
limit that was never binding.

The orchestrator log, one full cycle:

```
10:29:07.254  dependency input changed — reinstalling
10:29:07.254  install re-running — holding 1 gated service(s): dev     <- compose stop -> SIGTERM
10:29:07.289  install finished — starting 1 gated service(s): dev      <- gate reopened, +35ms
10:29:17.467  compose dev exited (container=<id>, exit=137)            <- SIGKILL, +10.213s
10:29:21.896  dev OOMKilled — retry #1/3 in 1000ms
```

The hold→exit gap was 10.213s / 10.263s / 10.215s across every
occurrence — Docker's default 10s `stop_grace_period`. A
`command: sh -c "npm install && npm run dev"` service does not forward
SIGTERM, so the grace period always expires into a SIGKILL.

It was not an OOM:

- Docker emitted **zero** `oom` events host-wide. Every death logged the
  non-OOM form `compose <svc> exited (…)` — i.e. `info.oom === false`.
- Container steady-state RSS was ~110 MiB against a correctly-applied
  3 GiB limit (`HostConfig.Memory=3221225472`, matching the declared
  `mem_limit`).
- The host had ~86 GiB free throughout.
- No "JavaScript heap out of memory" in the service logs — V8 never
  self-terminated.

## Defect chain

1. **The teardown wasn't awaited.** `holdGatedServicesForReinstall` ran
   `void this.stopGatedForReinstall(...)`. With a cached no-op install
   (~35ms observed), `startGatedServices` cleared `gatedServices`
   synchronously roughly 10s *before* the SIGKILL landed.

   This matters specifically because the poller already had the right
   guard — `if (this.isGated(svc.name)) continue;`, commented "a `ps`
   reading here (e.g. a container exiting during re-install teardown)
   must not overwrite the held `starting`/`error`". So did
   `handleNonZeroExit`, with a matching early-return for gated services.
   Both were simply raced past. The fix is to make those existing guards
   still be in force when the exit they were written for arrives.

2. **`exitCode === 137` was treated as "OOM" on its own.**
   `handleNonZeroExit` routed any 137 on a `preview: auto` service to
   `scheduleOomRetry`. 137 is SIGKILL — the OOM killer is one sender, and
   inside ShipIt it is not the most frequent one. Our own teardown is.

3. **The budget-exhausted message asserted an OOM as fact** and advised
   "increase the service's memory limit or close other sessions to free
   host memory" — inert advice for a plain SIGKILL, and the reason the
   user spent the incident chasing memory.

4. **The budget could never reset under a teardown loop.**
   `DEP_REINSTALL_COOLDOWN_MS` (30s) is shorter than
   `OOM_STABLE_RESET_MS` (60s), so a re-install every 30s tore the
   service down before it could bank the continuous uptime that clears
   `oomRetryAttempts`. The budget drained monotonically to exhaustion and
   latched to `error` every cycle.

## Design

### 1. Confirm the OOM instead of inferring it

The poller already runs `docker inspect` on every container each poll to
resolve IPs. That same payload carries `State.OOMKilled` — the
authoritative answer. It is now harvested there (free — no extra Docker
call) and threaded to `onExitedWithError(name, exitCode, oomKilled)`.

Three-valued on purpose:

| `oomKilled` | Meaning | Behavior |
|---|---|---|
| `true` | Daemon confirms the cgroup OOM killer | OOM auto-retry (docs/126), then the OOM-specific latch message |
| `false` | Daemon confirms it was *not* an OOM | No OOM retry; `"Exited with code 137 (SIGKILL — not an OOM kill)"` |
| `undefined` | Inspect failed / field absent | No OOM retry; the pre-existing hedge `"…(likely OOMKilled)"` |

"Unknown" stays distinguishable from "confirmed not an OOM" so the
user-facing message never over-claims in either direction.

**Why inspect rather than the `service_exited` event's `oom` flag.** The
diagnosis offered both. The event flag loses on two counts. First,
`handleNonZeroExit` is reached only from the poller, which has no event
in hand — threading the flag in would mean wiring `startup-tasks.ts`'s
`service_exited` listener back into the per-session `ServiceManager`, a
new cross-layer dependency for a value the poller can read directly.
Second, that flag is `action === "oom"` on the raw Docker event, and
Docker emits `oom` and `die` as *separate* events for compose children —
so the `die` that carries exit 137 always reports `oom: false`, even for
a genuine OOM. (The agent-container path compensates with the
`recentOoms` correlation; the compose-child path has no equivalent.)
Gating on it would have broken real-OOM auto-retry. `State.OOMKilled`
from the inspect has neither problem.

### 2. Await the teardown before reopening the gate

`holdGatedServicesForReinstall` now retains the teardown promise, and
`releaseInstallGate` waits for it before releasing gated services. The
service therefore stays in `gatedServices` while the SIGKILL lands, so
the poller's `isGated` skip and `handleNonZeroExit`'s gated early-return
swallow it exactly as they were designed to.

Sequencing also stops the reopening `compose up` from racing the
`compose stop` it just issued against the same container.

The gate opens synchronously when no teardown is in flight (the common
first-install path), so nothing else changes shape.

**Latency.** Waiting costs up to one 10s grace period of extra preview
downtime per re-install. `stopGatedForReinstall` therefore stops services
**concurrently** rather than in the old sequential loop, capping the cost
at one grace period for the whole stack instead of one *per service*. A
shorter `-t` stop timeout was considered and rejected: it would SIGKILL a
gated service that *does* handle SIGTERM sooner than Docker's own
default, and the honest cost of a correct teardown is what it is.

### 3. Branch ordering

`handleNonZeroExit` tests, in order: `gatedServices` → `_installRunning`
→ confirmed-OOM → `postGateServices` → terminal error.

The exit-137 branch was left where it is rather than moved below the
post-gate check. Confirming the OOM first makes the ordering moot for the
teardown case: an unconfirmed 137 no longer short-circuits, so it falls
through to the post-gate window — which `startGatedServices` opens on
every gate open, and which docs/137 built for precisely "crashed shortly
after the gate opened". A *confirmed* OOM inside that window still takes
the OOM path, which is right: its budget and its message are the ones
that fit. Moving the branch would have swapped which of two correct
recovery paths owns a confirmed OOM, for no gain.

### 4. Re-gating resets the OOM budget

A mid-session re-install is a teardown-and-relaunch against a fresh
dependency tree; it should not inherit an earlier OOM count, exactly as
`postGateServices` state doesn't. This kills defect 4 directly, rather
than by retuning `OOM_STABLE_RESET_MS` against a cooldown constant that
lives in another file and can drift again.

## Key files

### Server

- `src/server/orchestrator/service-poller.ts` — `resolveContainerIps`
  returns a `Map<serviceName, boolean>` of `State.OOMKilled`, harvested
  before the network bail-outs (an exited container usually has no
  networks left, which is the case the flag is needed for);
  `onExitedWithError` gains the `oomKilled` argument.
- `src/server/orchestrator/service-manager.ts` — `handleNonZeroExit`
  requires `oomKilled === true` for the OOM branch; new `describeExit`
  helper for the three-valued terminal message; new `_gatedTeardown`
  promise + `releaseInstallGate`; `stopGatedForReinstall` is concurrent;
  `holdGatedServicesForReinstall` resets the OOM budget.
- `src/server/orchestrator/service-retry-manager.ts` — documents the
  confirmed-OOM precondition on `scheduleOomRetry` (its log line and
  budget-exhausted error state OOMKilled as fact and recommend a memory
  bump; both are only sound under that precondition).

### Tests

- `service-poller.test.ts` — the flag's three states, an exited container
  with no networks left, inspect failure, and the gated skip.
- `service-manager.test.ts` — 137 with `OOMKilled: false` does not
  retry and carries no memory advice; the hedged message when unknown;
  an unconfirmed 137 inside the post-gate window takes the docs/137 path
  (asserted via the terminal message, which names the owning path); the
  gate stays closed until the teardown lands. Existing OOM tests now
  confirm the OOM explicitly.
- `integration_tests/container-exit-logging.test.ts` — the service path
  of the principle already covered for the agent container by "does not
  assume exit 137 is OOMKilled when no explicit error string is given".

## Patterns this fits into

- **Service layer** (server-architecture skill): the change stays inside
  `ServiceManager` + `ServicePoller`. No new routes, WS messages, or
  client changes — `service_status` already carries the error string.
- **Don't infer a cause you can measure.** The daemon knows whether it
  OOM-killed a container; we were guessing from an exit code that has
  several senders, one of which was us.

## Out of scope

- The compose-child `oom` flag on `service_exited` (`container-health.ts`)
  is structurally always `false` on the `die` event, because Docker emits
  `oom` and `die` separately and only the agent-container path correlates
  them via `recentOoms`. It makes the *log line* for a genuine service OOM
  read as a plain exit. Cosmetic, pre-existing, and untouched here — this
  fix reads `State.OOMKilled` from the inspect instead, so no behavior
  depends on it.
- Per-compose-service memory limits in `shipit.yaml` — still tracked in
  `docs/121-compose-resilience`.
</content>
</invoke>
