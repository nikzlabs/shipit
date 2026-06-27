---
issue: https://linear.app/shipit-ai/issue/SHI-219
title: Auto-sized session containers
description: Derive per-session memory from host capacity so neither operators nor repos need to configure container limits in the common case.
---

# Auto-sized session containers

## Problem

Per-session container limits (memory / CPU / PIDs) are configured in two places today:

- **Repo level** — `shipit.yaml` `agent.memory` / `agent.cpu` / `agent.pids` (library defaults
  1536 MiB / 0.5 CPU / 4096 pids). This is the value a session actually boots with.
- **Deployment level** — `MAX_SESSION_MEMORY_MB` / `MAX_SESSION_CPU` / `MAX_SESSION_PIDS` env,
  which only **clamp** the repo value down (default cap: 75% of host RAM / host core count / 8192 pids).

Two structural problems:

1. **The deployment can only clamp down, never set the baseline.** On a 96 GB host, every session
   still boots at the **1536 MiB** library default unless someone edits that repo's `shipit.yaml`.
   A large deployment cannot be leveraged without touching every repo. The cap direction works; there
   is no "default up" direction. This is the headline complaint.

2. **Absolute size in a committed repo file is the wrong layer.** `agent.memory: 2048` means something
   different on a laptop host and a 96 GB VM. How much a session *gets* is a budget decision the operator
   owns (host RAM × target concurrency × cost), not a fact about the code. A repo's only honest signal is
   "I'm heavy" — but on a generous auto baseline that's rare, and when it's real it's a host-capacity
   question the operator answers, not something the repo can conjure. So the repo resource fields earn
   their API surface in approximately no cases.

The goal: **in the common case, nobody configures anything.** Session size is derived automatically from
host capacity. The repo resource fields (`agent.memory` / `agent.cpu` / `agent.pids`) are **removed**;
the only override is deployment-level env, for the rare deployment that needs it.

## Two realizations that make auto-config simple

1. **A Docker memory limit is a ceiling, not a reservation.** A session capped at 16 GB but using
   500 MB consumes 500 MB. So we can hand every session a generous host-derived ceiling and rely on
   statistical multiplexing — idle sessions cost nothing; the host is only at risk if many sessions peak
   *simultaneously*. No live rebalancing as sessions come and go is required: one ceiling, derived once.

2. **Memory and CPU are not symmetric.** Memory is *incompressible* — overshoot invokes the OOM killer,
   so it needs a firm limit. CPU is *compressible* — contention just slows everyone down, nothing
   crashes. So auto-config limits memory firmly and treats CPU loosely (no quota by default). That
   removes the second knob entirely for the common case.

## Design

### Auto-derivation (the default — no config anywhere)

At resolution time, derive the per-session memory ceiling from host RAM:

```
reserve     = max(2 GiB, totalRam × 0.10)          // orchestrator + OS headroom
usable      = totalRam − reserve
perSession  = clamp( usable / TARGET_CONCURRENCY , FLOOR , CEILING )

TARGET_CONCURRENCY = 8      // how many heavy sessions should be able to peak at once
FLOOR              = 4 GiB  // any real test suite needs room
CEILING            = 16 GiB // no single session should need more; bounds blast radius
```

Worked example, 96 GB VM: reserve ≈ 9.6 GiB → usable ≈ 86 GiB → `86 / 8 ≈ 10.8 GiB` per session
(under the 16 GiB ceiling) → **~10.8 GiB per session, ~8 heavy suites can coexist.** Zero configuration.

- **CPU:** no `CpuQuota` by default (optionally a soft `CpuShares` weight for fairness). Cores are
  shared by the scheduler; an over-busy session slows itself, not the host.
- **PIDs:** keep the fixed 8192 fork-bomb guard. Not capacity-derived — a safety rail, not a budget.

`TARGET_CONCURRENCY`, `FLOOR`, `CEILING`, and the reserve fraction are **internal constants**, not user
config. They encode a sensible point on the size-vs-concurrency curve; operators who disagree use the
override env below rather than tuning constants.

### Layering — auto by default, one optional operator override

1. **Auto (default, ~everyone):** the derived `perSession` above. No config anywhere.
2. **Operator override (rare):** `MAX_SESSION_MEMORY_MB` (hard ceiling) and a new
   `DEFAULT_SESSION_MEMORY_MB` (baseline) honored when set — for unusual concurrency targets or a pinned
   size. Optional; unset means auto.

Resolution:

```
baseline   = DEFAULT_SESSION_MEMORY_MB (if set) else auto-derived perSession
cap        = MAX_SESSION_MEMORY_MB (if set) else auto-derived host ceiling
effective  = min( baseline , cap )
```

There is no repo layer. The repo cannot influence its own size — that is deliberate (allocation is the
operator's budget call, see Problem #2).

### Remove the repo resource fields (`agent.memory` / `agent.cpu` / `agent.pids`)

These fields are dropped from the schema. The deprecation path already exists: `resolveShipitConfig`
**warns-and-ignores** unrecognized resource keys (it does this today for the old `resources:` /
`capabilities:` blocks — emits a warning surfaced in the diagnostics panel, extracts no value). The three
`agent.*` resource fields join that set: a shipit.yaml that still sets them gets a "no longer used —
session sizing is automatic" warning, not an error, and boots auto-sized. The rest of the `agent` block
(`install`, `depDirs`, `installInputs`, …) and `compose.docker-socket` are unaffected — those are
genuine repo concerns.

Removing the fields also removes the only real code wrinkle: there is no "preserve unset" problem to
solve in the parser, because there is no field to parse. `AGENT_DEFAULTS.memory` (1536) survives only as
the absolute floor for a tiny host where `usable / TARGET_CONCURRENCY` would round below it.

### Host-capacity source — `os.totalmem()` with a cgroup fallback

The derivation keys off "how much RAM does ShipIt actually have." `os.totalmem()` reports the host/VM
total. For ShipIt's own deployment (orchestrator runs uncapped inside a 96 GB VM) that is exactly right —
it reports the VM's 96 GB, which is the real budget. As cheap defensive code for portability, prefer a
cgroup memory limit (`/sys/fs/cgroup/memory.max`) when one is set *below* host total, else fall back to
`os.totalmem()`. For the VM deployment this resolves straight to `os.totalmem()`; it only matters for a
hypothetical deployment that runs the orchestrator inside a constrained container.

## Key files

- `src/server/orchestrator/container-config-builder.ts` — auto-derivation, env overrides, clamp warnings.
  Replaces `hostMemoryCapMb` (75%-of-host single-session cap) and the fixed-default flow.
- `src/server/shared/shipit-config.ts` — remove `agent.memory` / `agent.cpu` / `agent.pids` from the
  schema and `AgentConfig`; route them through the warn-and-ignore deprecation path alongside the old
  `resources:` / `capabilities:` blocks. Keep `AGENT_DEFAULTS.memory` only as the tiny-host floor.
- `src/server/orchestrator/resolve-agent-docker-limits.test.ts` — update for derived defaults; add
  host-capacity derivation + env-override + clamp cases; add a "deprecated repo field is ignored with a
  warning" case.
- `src/server/shipit-docs/shipit-yaml.md` — remove the `agent.memory`/`cpu`/`pids` rows; document that
  sizing is automatic and the optional `DEFAULT_SESSION_MEMORY_MB` / `MAX_SESSION_MEMORY_MB` env.

## Rejected alternatives

- **Keep `agent.memory` as an allocation, just add `DEFAULT_SESSION_MEMORY_MB` (Model A).** Less churn,
  but leaves the repo field doing the operator's job — the exact thing this change objects to.
- **Re-semantic the repo field to a *floor* / minimum (Model B).** Keeps the field but reads
  `agent.memory: N` as "at least N", clamped by the deployment cap. Rejected: it preserves API surface
  (schema field, unset-preservation in the parser, floor-clamp precedence, migration, docs, tests) to
  serve a case the operator env already covers — a repo needing more than the generous auto baseline is
  rare, soft (the host may not have it), and fundamentally a host-capacity decision. Removing the field
  outright is simpler and loses nothing real.
- **Live concurrency-aware rebalancing** (recompute and `docker update` limits as sessions join/leave).
  Unnecessary given limits-are-ceilings: idle sessions don't consume their ceiling, so a static derived
  ceiling already handles the common case. Revisit only if simultaneous-peak OOM proves real in practice.
- **T-shirt sizing in the repo (`agent.size: small|large`) mapped by the deployment.** A cleaner future
  for repos that want to express relative size portably, but more schema surface than needed now. The
  auto baseline + optional floor covers the cases we have. `DEFAULT_SESSION_MEMORY_MB` could become the
  "medium" row of such a table later.
