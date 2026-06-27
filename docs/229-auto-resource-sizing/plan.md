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
   owns (host RAM × target concurrency × cost), not a fact about the code. The only thing the repo
   legitimately knows is its *workload requirement* — "my integration suite needs at least N GB" — which
   is a **floor**, not an allocation.

The goal: **in the common case, nobody configures anything.** Session size is derived automatically from
host capacity. Env vars and `shipit.yaml` remain as optional overrides for the rare cases that need them.

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

### Layering — every layer above auto is optional

1. **Auto (default, ~everyone):** the derived `perSession` above. No config.
2. **Operator override (rare):** `MAX_SESSION_MEMORY_MB` (hard ceiling) and a new
   `DEFAULT_SESSION_MEMORY_MB` (baseline) still honored when set — for unusual concurrency targets or a
   pinned size. Optional; unset means auto.
3. **Repo floor (rare):** `shipit.yaml agent.memory` re-semanticized from *allocation* to *minimum* —
   "this repo needs **at least** N." Used only when a repo's workload needs more than the auto baseline.

Resolution:

```
baseline   = DEFAULT_SESSION_MEMORY_MB (if set) else auto-derived perSession
cap        = MAX_SESSION_MEMORY_MB (if set) else auto-derived host ceiling
effective  = clamp( baseline , repoFloor , cap )      // min(max(baseline, repoFloor), cap)
```

A repo that asks for *more* than `cap` is clamped and warned (existing behavior). A repo can only raise
its floor, never shrink below the deployment baseline — shrinking to pack more sessions is an operator
concern, not the repo's call, so the repo field deliberately can't do it.

### Repo field semantics change (`agent.memory` → floor)

This is a behavior change for repos that set `agent.memory`. Previously `agent.memory: 2048` meant
"boot at exactly 2 GB"; now it means "at least 2 GB." On a generous deployment that repo gets the larger
of the two; on a stingy one it still gets its 2 GB floor. Most repos never set the field and are
unaffected. CPU/PIDs repo fields follow the same floor semantics for consistency (CPU floor only applies
if we set a quota at all).

### Implementation note — preserve "unset"

`parsePositiveNumber` in `shipit-config.ts` currently substitutes `AGENT_DEFAULTS.memory` (1536) at parse
time, so downstream cannot distinguish "user wrote nothing" from "user wrote 1536". Auto-derivation must
only fire when the field is genuinely **unset**, so the parser must preserve that — e.g. represent an
unset `agent.memory` as `null` and resolve the number later, in `container-config-builder.ts`, where host
capacity is known. The library default (1536) stops being the value a silent repo boots with; it survives
only as the absolute floor for a tiny host where `usable / TARGET_CONCURRENCY` would round below it.

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
- `src/server/shared/shipit-config.ts` — `AGENT_DEFAULTS`, `parsePositiveNumber`; preserve unset memory
  (and cpu/pids) so auto-derivation can fire only when the repo is silent.
- `src/server/orchestrator/resolve-agent-docker-limits.test.ts` — update for derived defaults; add
  host-capacity derivation + clamp + floor cases.
- `src/server/shipit-docs/shipit-yaml.md` — document `agent.memory` as a *minimum*, the auto behavior,
  and the optional `DEFAULT_SESSION_MEMORY_MB` / `MAX_SESSION_MEMORY_MB` env.

## Rejected alternatives

- **Keep `agent.memory` as an allocation, just add `DEFAULT_SESSION_MEMORY_MB` (Model A).** Less churn,
  but leaves the repo field doing the operator's job — the exact thing this change objects to. Rejected
  in favor of the floor semantics.
- **Drop the repo field entirely (purely deployment-level).** Over-corrects: loses the one legitimate
  repo signal (a workload requirement floor) for repos whose suites genuinely exceed the auto baseline.
- **Live concurrency-aware rebalancing** (recompute and `docker update` limits as sessions join/leave).
  Unnecessary given limits-are-ceilings: idle sessions don't consume their ceiling, so a static derived
  ceiling already handles the common case. Revisit only if simultaneous-peak OOM proves real in practice.
- **T-shirt sizing in the repo (`agent.size: small|large`) mapped by the deployment.** A cleaner future
  for repos that want to express relative size portably, but more schema surface than needed now. The
  auto baseline + optional floor covers the cases we have. `DEFAULT_SESSION_MEMORY_MB` could become the
  "medium" row of such a table later.
