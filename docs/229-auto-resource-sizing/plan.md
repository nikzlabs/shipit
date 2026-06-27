---
issue: https://linear.app/shipit-ai/issue/SHI-219
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
   so the quota is set to the host core count (effectively unlimited for a single session; the kernel
   scheduler time-shares under contention), never a per-repo knob.

## Design

### Auto-derivation (the default — no config anywhere)

```
reserve     = max(2 GiB, totalRam × 0.10)          // orchestrator + OS working set
usable      = totalRam − reserve
sized       = clamp( usable / TARGET_CONCURRENCY , FLOOR , CEILING )
perSession  = max( min( sized , usable ) , BOOT_MIN ) // never exceed usable; never below boot minimum

TARGET_CONCURRENCY = 8        // heavy sessions that should peak at once on a large host
FLOOR              = 4 GiB    // a real test suite needs room
CEILING            = 16 GiB   // no single session should need more; bounds blast radius
BOOT_MIN           = 1536 MiB // AGENT_DEFAULTS.memory — least a session needs to function
```

The `min(sized, usable)` step matters because `FLOOR` (4 GiB) can exceed `usable` on a small host — a
4 GB host has only ~2 GiB usable. There, `perSession` is pinned to `usable`: the session may use all
usable memory, one at a time, and the protected reserve is never crossed. `BOOT_MIN` is the last clamp
and the one exception to "never exceed usable": on a host so small that even `usable < BOOT_MIN`, the
session still gets `BOOT_MIN` (it cannot function below it) and the operator is warned that the host is
below the supported minimum and therefore oversubscribed.

- **CPU:** `cpuQuota` = host core count × the 100 ms CFS period — effectively unlimited for a single
  session, while still bounding any one container to the host's cores. This keeps `cpuQuota` a plain
  number through the existing container plumbing (`bootedLimits`, `resourceLimits`, the child-container
  sanitizer, `buildContainerConfig`, the `HostConfig` write) rather than threading an optional
  `cpuQuota?: undefined` through all of it just to omit the field. Cores are scheduler-shared; an
  over-busy session slows itself, not the host.
- **PIDs:** fixed 8192 fork-bomb guard. A safety rail, not a capacity-derived budget.

`reserve` is the orchestrator + OS working set — not reclaimable slack. It is never shaved to fit more
sessions: a session that OOMs kills one container, but an orchestrator that OOMs takes down the whole
host, so its headroom is protected first.

`TARGET_CONCURRENCY`, `FLOOR`, `CEILING`, and the reserve fraction are **internal constants**, not user
config. Operators who disagree use the override env below rather than tuning constants.

### How the constants behave across host sizes

`TARGET_CONCURRENCY` is a ceiling that only binds on large hosts. The division reaches the `FLOOR` once
`usable / 8 ≥ 4 GiB`, i.e. `usable ≥ 32 GiB` (host ≈ 34 GB+). Below that the `FLOOR` governs and
effective concurrency is `usable / FLOOR`, not 8 — which is correct: a small host should run fewer heavy
sessions at once. On a host smaller than the `FLOOR` itself, `perSession` is pinned to `usable` (the
`min(sized, usable)` step), so a single session fills the usable budget rather than overrunning it.

| Host RAM | reserve | usable | per-session memory | heavy sessions that fit |
|---|---|---|---|---|
| 4 GB | 2 GiB | 2 GiB | 2 GiB (capped to usable) | ~1 |
| 8 GB | 2 GiB | 6 GiB | 4 GiB (floored) | ~1 |
| 16 GB | 2 GiB | 14 GiB | 4 GiB (floored) | ~3 |
| 96 GB | 9.6 GiB | 86 GiB | ~10.8 GiB | ~8 |

### Operator override (the only override)

```
baseline   = DEFAULT_SESSION_MEMORY_MB (if set) else auto-derived perSession
cap        = MAX_SESSION_MEMORY_MB   (if set) else auto-derived host ceiling
effective  = min( baseline , cap )
```

`DEFAULT_SESSION_MEMORY_MB` (baseline) and `MAX_SESSION_MEMORY_MB` (hard ceiling) are honored when set —
for an unusual concurrency target or a pinned size. Unset means auto. There is no repo layer: the repo
cannot influence its own size, by design.

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

- `src/server/orchestrator/container-config-builder.ts` — auto-derivation, env overrides, host-capacity
  reader. Replaces `hostMemoryCapMb` (75%-of-host single-session cap) and the fixed-default flow.
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
