---
issue: planning#221
title: Auto-sized session containers
description: Derive per-session memory from host capacity so neither operators nor repos need to configure container limits in the common case.
---

# Auto-sized session containers

Session container memory is derived automatically from host capacity. In the common case nobody
configures anything — not the operator, not the repo. The only override is deployment-level env, for the
rare deployment that needs it.

## Problem

Per-session limits were configured in two places:

- **Repo** — `shipit.yaml` `agent.memory` / `agent.cpu` / `agent.pids`. The value a session boots with.
- **Deployment** — `MAX_SESSION_*` env, which only **clamp the repo value down** (default: 75% of host
  RAM / host core count / 8192 pids).

Two structural problems follow:

1. **The deployment can only clamp down, never set the baseline.** On a 96 GB host every session still
   boots at the 1536 MiB library default unless someone edits that repo's `shipit.yaml`. A large
   deployment cannot be leveraged without touching every repo.
2. **Absolute size in a committed repo file is the wrong layer.** `agent.memory: 2048` means something
   different on a laptop and a 96 GB VM. How much a session *gets* is an operator budget decision (host
   RAM × concurrency × cost), not a fact about the code. A repo's only honest signal is "I'm heavy" —
   which, on a generous auto baseline, is rare and ultimately a host-capacity question the operator
   answers. The repo resource fields earn their API surface in approximately no cases.

## Principles

1. **A Docker memory limit is a ceiling, not a reservation.** A session capped at 16 GiB but using
   500 MB consumes 500 MB. Every session can hold a generous host-derived ceiling and the host relies on
   statistical multiplexing — idle sessions cost nothing; the host is only at risk if many sessions peak
   *simultaneously*. One ceiling, derived once; no live rebalancing as sessions come and go.
2. **Memory and CPU are not symmetric.** Memory is incompressible — overshoot invokes the OOM killer, so
   it needs a firm derived limit. CPU is compressible — contention slows everyone down, nothing crashes —
   so it is derived from host capacity too, never a per-repo knob. But "nothing crashes" holds only for
   the *sessions*: the orchestrator is one process serving every viewer, and CPU it does not get is a UI
   that reads as offline. Its protection is therefore a higher cgroup **weight**, not reserved cores —
   nothing in cgroup CPU reserves capacity for anybody. The per-session quota is a second, weaker guard
   that stops one container holding the machine. See **CPU** and **CPU weight** below.

## Design

### Auto-derivation (the default — no config anywhere)

```
reserve     = max(2 GiB, totalRam × 0.10)          // orchestrator + OS working set
usable      = totalRam − reserve
sized       = clamp( usable × PER_SESSION_USABLE_FRACTION , FLOOR , CEILING )
perSession  = max( min( sized , usable ) , BOOT_MIN ) // never exceed usable; never below boot minimum

PER_SESSION_USABLE_FRACTION = 0.5      // one session may hold up to half the usable budget
FLOOR                       = 4 GiB    // a real test suite needs room
CEILING                     = 48 GiB   // no single session should need more; bounds blast radius
BOOT_MIN                    = 1536 MiB // AGENT_DEFAULTS.memory — least a session needs to function
```

**Why a fraction of usable, not `usable / expectedConcurrency`.** The first cut of this design divided
`usable` by a `TARGET_CONCURRENCY = 8` — which quietly reintroduced the reservation model Principle 1
rejects. It priced *every* session as though all eight peaked simultaneously, so on a 96 GB host each
session got ~10.8 GiB while the host sat mostly idle. The real workload is the opposite shape: many
sessions parked at a few hundred MB and **one** doing something heavy (a full test suite, a native
build, an inner orchestrator). The session that actually needs the machine is exactly the one the
division starved. Sizing to a fraction of `usable` restores the ceiling semantics: one heavy session
can use half the host, and two simultaneous heavy peaks still fit inside `usable`. Beyond two, the OOM
circuit breaker and the rescue flow are the backstop — the same tradeoff the doc already accepted, now
priced honestly.

The `min(sized, usable)` step matters because `FLOOR` (4 GiB) can exceed `usable` on a small host — a
4 GB host has only ~2 GiB usable. There, `perSession` is pinned to `usable`: the session may use all
usable memory, one at a time, and the protected reserve is never crossed. `BOOT_MIN` is the last clamp
and the one exception to "never exceed usable": on a host so small that even `usable < BOOT_MIN`, the
session still gets `BOOT_MIN` (it cannot function below it) and the operator is warned that the host is
below the supported minimum and therefore oversubscribed.

- **CPU:**

  ```
  reserveCores    = max( 2 , floor( hostCores × 0.10 ) )   // headroom the ceiling is sized around
  usableCores     = max( 1 , hostCores − reserveCores )
  perSessionCores = max( 1 , floor( usableCores × 0.5 ) )
  cpuQuota        = perSessionCores × 100 ms CFS period
  ```

  | hostCores | 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 |
  |---|---|---|---|---|---|---|---|---|
  | reserve | 2 | 2 | 2 | 2 | 2 | 3 | 6 | 12 |
  | **per session** | 1 | 1 | 1 | 3 | **7** | 14 | 29 | 58 |

  **`reserveCores` shapes the ceiling; it does not reserve anything.** Principle 1 still holds — a
  quota is a ceiling, so three sessions at 7 cores each can still collectively saturate a 16-core
  host. What the subtraction buys is that *no single* container can, which is the failure mode that
  left the orchestrator unschedulable. The orchestrator's actual protection is the weight below.
  The one-core floor overrides the reserve on 1–2-core hosts by necessity; on a 4-core host a single
  session drops from 4 usable cores to 1, which is the intended trade.

  `cpuQuota` stays a plain number through the existing container plumbing (`bootedLimits`, `resourceLimits`, the child-container
  sanitizer, `buildContainerConfig`, the `HostConfig` write) rather than threading an optional
  `cpuQuota?: undefined` through all of it just to omit the field.

  **Why not the whole host (the original design).** `cpuQuota` = host core count let a single session
  hold every core. That is fine for *one* session and wrong for several: a CPU quota does not narrow
  what a process sees, so every worker still reported all 16 cores (Node's
  `os.availableParallelism()`, `nproc` on the coreutils we ship, `sched_getaffinity` generally) and
  every tool that sizes a pool from it — Vitest first among them — spawned a 16-wide pool. Four
  sessions running test suites produced ~39 vitest workers plus tsc and headless Chromium, load
  average 75 on 16 cores, and `/proc/pressure/cpu` "some" at ~85%. Halving the post-reserve budget
  bounds the CPU time each of those pools can consume. It does **not** stop them being spawned, and
  on that four-worker peak contention alone already held each worker near its new ceiling — so the
  quota is the guard against one container monopolising an otherwise-quiet host, and the weight
  below is what actually fixed the incident.

- **CPU weight.** The quota bounds one container; the *weight* decides who runs when several are
  runnable at once. Every container defaulted to `cpu.weight = 100` — the orchestrator included — and
  the orchestrator's single Node main thread was sampled at 10–27% of one core while permanently in
  state `R`. (CFS group scheduling does not pit that thread against each of the ~39 worker threads
  individually — a group's weight is distributed across its per-CPU runqueues by group load — but at
  equal weights the orchestrator's cgroup had no more claim on a CPU than any test runner's.)
  Measured against a starved orchestrator, a static `GET /` took 12–14 s to first byte and WS
  upgrades 5–10 s (two hit the 15 s timeout), so the client's 1.5 s `DISCONNECT_DELAY_MS`
  (`ConnectionBanner.tsx`) showed "Reconnecting to server" on every session switch. Two halves fix it:
  the orchestrator service sets `cpu_shares: 4096` in the deployment compose files, and session
  containers are created with `CpuShares: 512` (`SESSION_CPU_SHARES`) — a ratio that holds even if a
  session's quota is later raised.

  **Three kinds of container are siblings of the orchestrator, not children of a worker, so each
  needs the weight written explicitly**: the session worker itself; a docker-access session's child
  containers, clamped by the child-container sanitizer (`docker-proxy-sanitize.ts`); and **every
  Compose service** — `ServiceManager`/`ComposeCli` run `docker compose` from the *orchestrator*
  against the host daemon, so a repo's dev server is a host-level sibling and not inside the worker's
  cgroup. `generateComposeOverride` writes `cpu_shares` into the ShipIt-owned override block for that
  reason. Missing any one of them leaves a CPU-heavy container outranking the session it belongs to.

  **Read the weights from the kernel, not from the shares.** cgroup v2 has no "shares" — the
  container runtime rescales the Docker-v1 number into `cpu.weight`, and *the formula has changed
  across runc releases*, so 4096 and 512 do not map to fixed values. What is stable is the ordering
  and the rough ratio (single-digit multiple), and that an **unset** `CpuShares` means the cgroup
  default `cpu.weight = 100` — which is what every ShipIt container had, orchestrator included, and
  is how the starvation happened. Confirm a deployment by reading `cpu.weight` in the cgroups, e.g.
  `docker exec <c> cat /sys/fs/cgroup/cpu.weight`; do not infer it from the compose file.

  Left at the default on purpose: ShipIt's own per-session sidecars (egress proxy, resolver), which
  are near-idle by construction.

  The weight is deliberately *not* a CPU quota on the orchestrator (compose `cpus:`): the
  orchestrator is idle most of the time, and a ceiling it cannot exceed would cap the burst it needs
  precisely when many viewers reconnect at once. A weight costs nothing while the host is quiet and
  only decides the order under contention.

  **Rollout.** A session container survives an orchestrator deploy, so it would otherwise keep the
  policy it was created under — which on the incident host is the whole-host quota and the default
  weight. cgroup CPU limits are writable live, so adoption reconciles them
  (`reconcileAdoptedCpuPolicy` in `container-discovery.ts`) instead of waiting for the container to
  cycle; it also populates `bootedLimits`, which adoption previously left unset.
- **PIDs:** fixed 8192 fork-bomb guard. A safety rail, not a capacity-derived budget.

`reserve` is the orchestrator + OS working set — not reclaimable slack. It is never shaved to fit more
sessions: a session that OOMs kills one container, but an orchestrator that OOMs takes down the whole
host, so its headroom is protected first.

`PER_SESSION_USABLE_FRACTION`, `FLOOR`, `CEILING`, and the reserve fraction are **internal constants**,
not user config. Operators who disagree use the override env below rather than tuning constants.

### How the constants behave across host sizes

The fraction governs the middle of the range. The `FLOOR` binds only below ~8 GiB usable (host ≈ 10 GB),
where half the budget is less than a test suite needs; there `perSession` is pinned to `min(FLOOR,
usable)` so a single session fills what's available rather than overrunning it. The `CEILING` binds only
above ~96 GiB usable (host ≈ 107 GB), where half the host is more than any one session has a use for.

| Host RAM | reserve | usable | per-session ceiling | simultaneous heavy peaks that fit |
|---|---|---|---|---|
| 4 GB | 2 GiB | 2 GiB | 2 GiB (capped to usable) | 1 |
| 8 GB | 2 GiB | 6 GiB | 4 GiB (floored) | 1 |
| 16 GB | 2 GiB | 14 GiB | 7 GiB | 2 |
| 32 GB | 3.2 GiB | 28.8 GiB | ~14.4 GiB | 2 |
| 96 GB | 9.6 GiB | 86.4 GiB | ~43.2 GiB | 2 |
| 1 TB | 102 GiB | 921 GiB | 48 GiB (ceiling) | 19 |

"Simultaneous heavy peaks" is the worst case, not the expected one — every session below its ceiling
costs only what it touches, so the practical concurrency is far higher.

### Operator override (the only override)

```
baseline   = DEFAULT_SESSION_MEMORY_MB (if set) else auto-derived perSession
cap        = MAX_SESSION_MEMORY_MB   (if set) else auto-derived host ceiling
effective  = min( baseline , cap )
```

`DEFAULT_SESSION_MEMORY_MB` (baseline) and `MAX_SESSION_MEMORY_MB` (hard ceiling) are honored when set —
for an unusual concurrency target or a pinned size. Unset means auto. There is no repo layer: the repo
cannot influence its own size, by design.

Both are read from the **orchestrator's own process env**, so the VPS deployment must pass them into the
`shipit` container explicitly (`deployment/vps/docker-compose.yml`) — otherwise exporting them in
`/etc/shipit/shipit.env` silently no-ops, the same failure mode `OVERLAY_DEP_STORE` and `SHIPIT_GIT_LFS`
carry warnings about in that file. The passthroughs default to empty (= auto).

### Repo resource fields are removed

`agent.memory` / `agent.cpu` / `agent.pids` are dropped from the schema. The deprecation path already
exists — `resolveShipitConfig` **warns-and-ignores** unrecognized resource keys (as it does today for the
old `resources:` / `capabilities:` blocks: a warning surfaced in the diagnostics panel, no value
extracted). A shipit.yaml that still sets these gets a "no longer used — session sizing is automatic"
warning, not an error, and boots auto-sized. The rest of the `agent` block (`install`, `depDirs`,
`installInputs`, …) and `compose.docker-socket` are unaffected — those are genuine repo concerns.

Removing the fields also removes the only real parser wrinkle: there is no "preserve unset" problem,
because there is no field to parse. `AGENT_DEFAULTS.memory` (1536 MiB) survives only as `BOOT_MIN` — the
last-resort minimum a session needs to function.

**Downstream surfaces that reference the removed fields must move too.** The diagnostics surface today
renders declared-vs-effective `agent.*` (`services/diagnostics.ts` → `SessionDiagnosticsPanel.tsx`), and
the OOM circuit breaker (`oom-circuit-breaker.ts`) tells the user the escape is to "bump memory in
shipit.yaml." Both go stale when the fields are gone: diagnostics must show the auto-derived sizing
(host RAM, reserve, derived `perSession`, any env override) instead of declared resources, and the OOM
guidance must point at the deployment env override (`DEFAULT_SESSION_MEMORY_MB` / `MAX_SESSION_MEMORY_MB`)
or the rescue flow — never `shipit.yaml`.

### Host-capacity source

`os.totalmem()` reports the host/VM total RAM. For ShipIt's own deployment (orchestrator uncapped inside
a 96 GB VM) that is exactly the real budget. As defensive code for portability, prefer a cgroup memory
limit when one is set *below* host total, else fall back to `os.totalmem()`. Read **cgroup v2 first**
(`/sys/fs/cgroup/memory.max`), then **cgroup v1** (`/sys/fs/cgroup/memory/memory.limit_in_bytes`),
ignoring the unlimited sentinels (`max` for v2, and v1's near-`Int64.MAX` value), and ignoring any value
≥ host total. This only matters for a deployment that runs the orchestrator inside a constrained
container; for the VM deployment it resolves straight to `os.totalmem()`.

## Key files

- `src/server/orchestrator/container-config-builder.ts` — auto-derivation (`deriveSessionMemorySizing`,
  `deriveSessionCpuSizing`), `SESSION_CPU_SHARES`, env overrides, host-capacity reader. Replaces
  `hostMemoryCapMb` (75%-of-host single-session cap) and the fixed-default flow.
- `src/server/orchestrator/container-lifecycle.ts` — writes `CpuQuota` / `CpuShares` into the worker
  `HostConfig`.
- `src/server/orchestrator/docker-proxy-sanitize.ts` — clamps a docker-access session's sibling
  containers to the same `CpuShares`.
- `src/server/orchestrator/compose-generator.ts` — writes `cpu_shares` into the generated Compose
  override, since services are orchestrator-created host siblings.
- `src/server/orchestrator/container-discovery.ts` — `reconcileAdoptedCpuPolicy`, the live update
  that applies the policy to containers surviving a deploy, plus `bootedLimits` on adoption.
- `deployment/vps/docker-compose.yml`, `docker/local/prod/compose.yml`, `docker/local/dev/compose.yml`
  — `cpu_shares: 4096` on the orchestrator service. Any new compose file that runs the orchestrator
  beside workers needs it too, and `resolve-agent-docker-limits.test.ts` asserts the list; the dogfood
  `docker-compose.yml` is exempt (`RUNTIME_MODE=local` spawns no worker containers).
- `src/server/shared/shipit-config.ts` — remove `agent.memory` / `agent.cpu` / `agent.pids` from
  `AgentConfig` and the schema; route them through the warn-and-ignore deprecation path. Keep
  `AGENT_DEFAULTS.memory` only as `BOOT_MIN`.
- `src/server/orchestrator/services/diagnostics.ts` / `src/client/components/SessionDiagnosticsPanel.tsx`
  — replace declared-vs-effective `agent.*` rows with auto-derived sizing metadata (host RAM, reserve,
  derived `perSession`, env override if any).
- `src/server/orchestrator/oom-circuit-breaker.ts` — update the user-facing OOM guidance to point at the
  deployment env override / rescue flow, not "bump memory in shipit.yaml."
- `src/server/orchestrator/resolve-agent-docker-limits.test.ts` — derived default, env override, clamp,
  tiny-host (`usable`-capped) floor, `BOOT_MIN`, no-default-`CpuQuota`, and deprecated-field-ignored-with-warning
  cases.
- `src/server/shipit-docs/shipit-yaml.md` — remove the resource-field rows; document automatic sizing and
  the optional `DEFAULT_SESSION_MEMORY_MB` / `MAX_SESSION_MEMORY_MB` env.
- `deployment/vps/docker-compose.yml` — passes both override env vars into the orchestrator container so
  they can be set from `/etc/shipit/shipit.env`.

## Rejected alternatives

- **Keep `agent.memory` as a repo allocation, add a deployment default env.** Leaves the repo field doing
  the operator's job — the thing Problem #2 objects to.
- **Re-semantic the repo field to a minimum floor** (`agent.memory: N` = "at least N", clamped by the
  cap). Preserves API surface (schema field, parser unset-preservation, floor-clamp precedence, docs,
  tests) to serve a case the operator env already covers; a repo needing more than the auto baseline is
  rare, soft (the host may not have it), and fundamentally a host-capacity decision.
- **Live concurrency-aware rebalancing** (`docker update` limits as sessions join/leave). Unnecessary
  given limits-are-ceilings. Real protection against simultaneous-peak OOM is session admission/queueing,
  which is separate scope.
- **T-shirt sizing in the repo** (`agent.size: small|large` mapped by the deployment). More schema
  surface than the auto baseline needs now; `DEFAULT_SESSION_MEMORY_MB` could become its "medium" row if
  it ever ships.
