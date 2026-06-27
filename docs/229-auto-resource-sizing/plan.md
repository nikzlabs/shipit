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
   it needs a firm limit. CPU is compressible — contention slows everyone down, nothing crashes. So
   memory is limited firmly; CPU gets no quota by default.

## Design

### Auto-derivation (the default — no config anywhere)

```
reserve     = max(2 GiB, totalRam × 0.10)          // orchestrator + OS working set
usable      = totalRam − reserve
perSession  = clamp( usable / TARGET_CONCURRENCY , FLOOR , CEILING )

TARGET_CONCURRENCY = 8      // heavy sessions that should peak at once on a large host
FLOOR              = 4 GiB  // a real test suite needs room
CEILING            = 16 GiB // no single session should need more; bounds blast radius
```

- **CPU:** no `CpuQuota` (optionally a soft `CpuShares` weight for fairness). Cores are scheduler-shared;
  an over-busy session slows itself, not the host.
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
sessions at once.

| Host RAM | reserve | usable | per-session memory | heavy sessions that fit |
|---|---|---|---|---|
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
because there is no field to parse. `AGENT_DEFAULTS.memory` (1536) survives only as the `FLOOR`'s library
fallback for a tiny host.

### Host-capacity source

`os.totalmem()` reports the host/VM total RAM. For ShipIt's own deployment (orchestrator uncapped inside
a 96 GB VM) that is exactly the real budget. As defensive code for portability, prefer a cgroup memory
limit (`/sys/fs/cgroup/memory.max`) when one is set *below* host total, else fall back to
`os.totalmem()` — this only matters for a deployment that runs the orchestrator inside a constrained
container.

## Key files

- `src/server/orchestrator/container-config-builder.ts` — auto-derivation, env overrides, host-capacity
  reader. Replaces `hostMemoryCapMb` (75%-of-host single-session cap) and the fixed-default flow.
- `src/server/shared/shipit-config.ts` — remove `agent.memory` / `agent.cpu` / `agent.pids` from
  `AgentConfig` and the schema; route them through the warn-and-ignore deprecation path. Keep
  `AGENT_DEFAULTS.memory` only as the `FLOOR` fallback.
- `src/server/orchestrator/resolve-agent-docker-limits.test.ts` — derived default, env override, clamp,
  tiny-host floor, and deprecated-field-ignored-with-warning cases.
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
