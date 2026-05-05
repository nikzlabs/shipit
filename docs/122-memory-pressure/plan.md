---
status: done
---

# Memory pressure — pressure-aware eviction + visibility

## Problem

When many sessions are concurrently active, Docker memory usage on the
host can climb high enough to cause container OOM kills or kernel
paging — both of which present as the "agent container detached,
nothing works" symptom that motivated feature 120 (container
resilience).

Concrete scenario on a 16 GiB host:

| Component | Cost |
|---|---|
| 4 active session containers | ~4 GiB (1 GiB cap each) |
| 4 compose dev stacks (Next + db etc.) | ~4–6 GiB (no ShipIt limits) |
| Orchestrator container | ~0.2 GiB |
| Host OS + Docker Desktop | ~2–3 GiB |
| **Total** | **~10–13 GiB → 11 GiB observed** |

The legacy idle enforcer doesn't help here:
- Active sessions (viewer attached or agent running) are off-limits by
  design — they're real work, not idle slack.
- Idle sessions within the 60s grace period are also off-limits — the
  grace period exists to survive transient WS reconnects.
- `maxIdleContainers` (default 5) is a *steady-state* knob, not a
  *pressure* knob.

The result: when a user has many tabs open, no automatic release valve
exists. The user has to recognize the symptom and manually archive
sessions — but they can't recognize it because nothing surfaces the
pressure visibly.

## Design — A + B (this feature)

### A. Pressure-aware idle eviction

When Docker `usedBytes / totalBytes` crosses
`MEMORY_PRESSURE_EVICT_THRESHOLD = 0.85`, the idle enforcer:

1. **Bypasses the 60 s grace period** — a session whose viewer just
   detached is eligible for eviction immediately.
2. **Drops effective `maxIdleContainers` to 0** — every eligible idle
   session goes, regardless of the user's configured cap.

Invariants preserved (defense in depth):

- A runner with `running === true` (agent is mid-turn) is **never**
  evicted, even at 99% pressure. The agent is real work.
- A runner with `viewerCount > 0` is **never** evicted. The user has a
  tab open on it.
- The TOCTOU re-check at dispose time still applies.

Stats source: the existing `readDockerMemoryStats()` poll that runs
every 10 s. The most recent reading is cached in `latestMemoryStats`
in `index.ts` and exposed to the enforcer via the new optional
`getMemoryStats` dep.

**Edge-triggered immediate eviction**: when a poll detects a
*newly* crossed pressure threshold, the orchestrator fires the idle
enforcer immediately rather than waiting up to 30 s for the next
periodic tick. Within the duration of the pressure event the periodic
30 s enforcer continues to run with pressure-aware semantics.

### B. Memory pressure banner

A thin banner above the main layout shows when usage crosses
`MEMORY_PRESSURE_BANNER_THRESHOLD = 0.80` (5 points below eviction).
Hysteresis is intentional: the user gets a visible warning and a
window to act before the orchestrator starts evicting things.

States:
- < 80%: banner hidden.
- 80–89%: warning tone (orange). Copy: "close inactive sessions to
  free memory before things get evicted."
- ≥ 90%: error tone (red). Copy: "host is near OOM. Close inactive
  sessions or archive a few to free memory."

The banner reads from the existing `dockerMemory` slice on
`uiStore` — no new server message types or polling. The data path
is already wired (`docker_memory` SSE event broadcast every 10 s).

## Threshold rationale

| Threshold | Value | Why |
|---|---|---|
| Banner | 80% | Early warning so the user has time to react before automation kicks in |
| Eviction | 85% | High enough that we don't churn the warm pool on every minor spike, low enough to leave headroom before the kernel starts OOM-killing |
| Critical (red banner) | 90% | The "this is about to fail" tier — host is genuinely close to OOM |

The 5-point gap between banner and eviction is hysteresis.

## Key files

### Server

- `src/server/orchestrator/memory-pressure.ts` *(new)* — thresholds and
  helpers (`memoryUsedFraction`, `isUnderEvictionPressure`).
- `src/server/orchestrator/memory-pressure.test.ts` *(new)* — threshold +
  helper unit tests.
- `src/server/orchestrator/app-lifecycle.ts` — `IdleEnforcementDeps`
  grows an optional `getMemoryStats`; the enforcer flips into
  pressure-aware mode when it crosses the eviction threshold.
- `src/server/orchestrator/app-lifecycle.test.ts` — adds 5 tests for
  pressure-aware behavior (grace bypass, maxIdle override, running
  agents protected, attached viewers protected, sub-threshold no-op).
- `src/server/orchestrator/index.ts` — caches latest stats; passes
  `getMemoryStats` to `createIdleEnforcer`; fires immediate eviction
  on edge-triggered pressure crossing.

### Client

- `src/client/components/MemoryPressureBanner.tsx` *(new)* — banner
  component; renders only when `stats.usedBytes / stats.totalBytes ≥
  MEMORY_PRESSURE_BANNER_THRESHOLD`.
- `src/client/components/MemoryPressureBanner.test.tsx` *(new)* — 8
  tests covering the threshold, color-tier transition at 90%, and a11y.
- `src/client/AppLayout.tsx` — renders `MemoryPressureBanner` above
  the existing header.

## Patterns this fits into

- **Service layer** (server-architecture skill): `memory-pressure.ts`
  is a pure-function helper module — no I/O, no state. Composable into
  both the periodic poll and the idle enforcer.
- **Idempotent recovery**: edge-triggered immediate eviction is a
  no-op when nothing is actually evictable (running agents, attached
  viewers). Multiple pressure events in a short window don't cause
  duplicate work because the periodic enforcer dedupes.
- **WS lifecycle independence**: the banner reads from the existing
  `uiStore` slice fed by the global SSE channel, not the per-session
  WS. Pressure visibility survives session switches and per-session WS
  blips.

## Out of scope (tracked elsewhere)

- **C — auto-stop background containers** (tab-focus tracked) →
  `docs/123-background-session-suspension/plan.md`.
- **D — `docker pause` for backgrounded containers** → same doc.
- **E — concurrent active session cap** → same doc.
- Per-compose-service memory limits → `docs/121-compose-resilience/plan.md`.

## Validation

- 5 server tests for pressure-aware enforcer (running guard, viewer
  guard, grace bypass, maxIdle override, sub-threshold no-op).
- 3 server tests for `memory-pressure.ts` helpers + threshold ordering.
- 8 client tests for banner threshold, color tiering, accessibility.
- Existing 14 idle-enforcer tests still pass (legacy behavior preserved
  when `getMemoryStats` is omitted).
