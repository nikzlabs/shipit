---
issue: planning#481
title: Idle preview survives the agent container — design
description: Replace the idle container count with a user-set memory budget, and reclaim in two tiers so an idle session loses its agent container before its preview.
---

# 284 — Idle preview survives the agent container (design)

Implements [requirements.md](./requirements.md). Requirements are cited as
`(req N)`.

## The problem in one sentence

`idle-enforcer.ts` reclaims a session by disposing its runner **and** destroying
its container, and the runner's `disposed` handler `compose down`s the stack —
so the preview dies with the agent, and both must be rebuilt on return.

## Two changes, one feature

### A. The limit becomes memory, not a count (reqs 3, 4, 10)

`maxIdleContainers` is removed. In its place, one setting: a memory budget for
all of ShipIt. Everything that rationed runtime by counting containers now
rations by measured bytes.

- **`credential-store.ts`** — `maxIdleContainers` → `memoryBudgetMb?: number`.
  Unset is meaningful: it means "the host is the budget" (req 9), so an install
  that never touches the setting behaves exactly as it does today.
- **`memory-pressure.ts`** — `resolveMemoryTargets` returns the three numbers
  everything else reads: `budgetBytes`, `warnAtBytes`, `evictAtBytes`. **Two
  regimes, deliberately different.** With an explicit budget the user's number
  is taken literally — reclaim starts *at* it (reqs 3 and 5 say previews survive
  until the budget is *reached*; evicting at 85% of a 16 GB budget would stop
  them with 2.4 GB of the allowance unspent) and the banner warns at 90% of it.
  With no budget the ceiling is the machine, which is not ShipIt's to fill, so
  the long-standing 80%/85% *host* fractions stand — which is what makes an
  unset budget byte-for-byte today's behaviour (req 9). The host clamps the
  budget in both regimes, or usage could never reach the number and nothing
  would ever be reclaimed.
- **`docker-memory.ts`** — `readDockerMemoryStats` today sums per-container
  usage and throws the breakdown away. It must keep it, keyed by session, so
  the enforcer can subtract what each reclaim actually frees instead of
  guessing. Agent containers carry the `shipit-session-id` label; a session's
  Compose containers carry `shipit-parent-session` with the FULL session id
  (written into the generated override by `compose-generator.ts:1804`), so
  attribution needs no `shipit-{sid12}` project-name parsing.
- **`warm-pool-manager.ts`** — the standby guard (`realCount < maxIdle`) becomes
  a headroom check against the budget (`isUnderEvictionPressure`). A count was
  always a proxy for "is there room"; now the real question is askable. The
  integration test that drove the old count cap is deleted with the rule rather
  than inverted — the predicate that replaced it is unit-tested in
  `memory-pressure.test.ts`.
- **`background-task-tracker.ts`** — `BACKGROUND_TASK_TTL_MS` was *defined as*
  the grace period. It keeps the same 10-minute value as its own constant: it
  was always about how long to trust a stale reading, which is unrelated to
  reclaim timing.
- **Settings surface** — `GlobalSettings.maxIdleContainers` →
  `memoryBudgetMb: number | null`, through `services/settings.ts`,
  `services/misc.ts`, `services/types.ts`, `api-routes-bootstrap.ts`, the client
  `settings-store`, `App.tsx`, and the Advanced tab, whose "Max Idle Containers"
  block becomes a memory budget input.
- **`docker_memory` SSE payload** gains the effective budget, so the banner can
  say what it is measuring against (req 12) rather than implying host RAM.

### B. Reclaim happens in two tiers (reqs 1, 2, 5, 7, 8)

`idle-enforcer.ts` stops slicing an over-limit list and instead reclaims only
while over budget (req 11 — the budget decides what is *stopped*, never what is
*refused*), cheapest loss first:

- **Tier 0 — give back the speculative capacity first.** A warm-pool standby is
  a container made on the chance someone starts a session on that repo; nobody
  has claimed it. Reclaiming a real session while one sits there spends a user's
  work to protect a guess. The enforcer used to skip standbys unconditionally,
  which was defensible when they were exempt from the count too; under a memory
  budget they occupy the same bytes as anything else.
- **Tier 1 — drop the agent container, keep the stack.** Longest-idle first, for
  every idle session, before any tier 2 happens. The session's runner is
  disposed with `preserveComposeOnDispose = true`, and the teardown is
  **`containerManager.destroyAgentContainer()`, never `destroy()`** — `destroy()`
  runs `cleanupSessionDockerResources`, which sweeps every
  `shipit-parent-session` container and the session's networks, i.e. exactly the
  stack this tier exists to keep. Its `ServiceManager` stays in
  `serviceManagers` and its Compose stack keeps running, whole, including
  `manual` services (req 7).
- **Tier 2 — stop the stack too.** Only once every idle session has been through
  tier 1 and ShipIt is still over budget, and only for stacks **this enforcer
  orphaned** (`tier1At`). "Has a manager and no runner" is not enough:
  `restartAgent` (`services/recovery.ts`) disposes the old runner with
  `preserveComposeOnDispose` and creates the replacement container
  asynchronously, so a session actively restarting has exactly that shape for
  the length of the window.

Reserved sessions (docs/241-keep-preview-running, `holdsActiveReservation`) are
exempt from both tiers, unchanged. The `agentBusy` and viewer-count guards are
unchanged, as is the planning#298 dispose-then-destroy ordering: a runner that
declines disposal leaves its container alone.

Because the count is gone, an idle session is no longer reclaimed for *being*
idle — only for being idle while ShipIt is over budget. That is the direct
consequence of req 10 leaving one knob, and it is what req 5 asks for.

Four rules make the ladder safe against the snapshot it reads:

- **`IDLE_GRACE_PERIOD_MS` is deleted, not re-tuned.** The 10-minute window
  exempted a just-detached runner so a page reload would not cost a container
  start. Ordering by longest-idle gives the same protection: the just-detached
  session is reached last, and only if everything older failed to cover the
  shortfall. The window had already become moot in practice — under real
  pressure the old code bypassed it, and over-budget is now the only state in
  which reclaim runs at all. Sorting by `idleSince` also makes the flag
  arithmetically redundant, since an older session always sorts first anyway.
- **An unmeasured reclaim ends the pass.** When `bySession` carries no entry for
  the session just stopped, the enforcer cannot subtract what it freed;
  subtracting zero and continuing would walk the whole idle list and empty the
  machine over an overage the first container may already have covered.
- **Tier 2 does not run behind an unmeasured tier-1 reclaim.** Same stale
  shortfall, worse consequence: tier 1 has just preserved a preview precisely so
  it survives, and spending the unadjusted `need` on tier 2 would stop that
  stack in the same pass — silently turning the feature back into today's full
  teardown. Caught by the tier-1 test before it shipped.
- **A snapshot is acted on once, and never mid-teardown.** Two triggers can fire
  between two 10s polls (the 30s timer and the pressure-crossing edge); identity
  on the snapshot object is the exact test, since the poller replaces it on every
  read. Identity alone is not enough, though: a `docker stop` takes seconds, so a
  genuinely *new* snapshot taken while a teardown is in flight still counts
  memory already on its way back. The enforcer counts its own in-flight
  teardowns and skips the pass while any remain.
- **A failed per-container stat read is unmeasured, not zero** (`docker-memory.ts`).
  Recording 0 would create a `bySession` entry, and a present entry is what the
  rule above reads as "measured" — so the enforcer would keep reclaiming on the
  strength of a number nobody read. The session is dropped from the breakdown
  instead, while its readable containers still count toward the global shortfall.
- **One memory read at a time** (`startup-monitors.ts`). `container.stats()` is a
  per-container round trip, so on a busy host a read can outlast the 10s
  interval and two overlapping reads would publish out-of-order snapshots. The
  first read is also seeded immediately at boot rather than 10s later: every
  memory-aware path treats "no snapshot" as "no answer", so the warm pool would
  otherwise create standbys through the whole startup burst.

## Why the preview survives without its agent container

This is not a new capability, only a new caller. `preserveComposeOnDispose`
already exists for the agent-restart chain (docs/127-restart-agent): the
`disposed` handler returns early without `compose down`, the manager stays in
`serviceManagers`, and `adoptExistingServiceManager` re-wires the *next* agent
container onto the surviving stack — reconnecting it to the stack's network and
re-arming the install gate.

Preview routing survives for the same reason. `preview-proxy.ts:resolveTarget`
resolves a service port through `serviceManagers.get(sessionId)` and only falls
back to the agent container's IP; the manager surviving in the map is exactly
what keeps the preview URL routable while the agent container is gone.

Verified at `service-manager-setup.ts:397` (the `disposed` early return),
`service-manager-setup.ts:212` (`adoptExistingServiceManager`) and
`preview-proxy.ts:624` (`resolveTarget`).

**It does not survive the orchestrator, and that is deliberate for now.**
`serviceManagers` is process-local, so the *next* orchestrator can neither route
to a preserved stack nor reclaim it — it would run on, invisible, until the user
reopened the session. So the shutdown hook stops every runner-less manager,
which is the same call the `disposed` handler makes for every other stack and
the same reasoning that hook already records ("a dev server running for a
session nobody reopens"). Re-adopting preserved stacks across a restart — so an
idle preview survives a ShipIt update too — is a worthwhile follow-up, not part
of this.

## What the user is told (req 8)

Tier 1 and tier 2 are different events and must not share one message. Tier 1
says the agent container stopped and the preview is still running; tier 2 is
today's "container shut down (workspace preserved)" copy. Both go through the
existing `session_status` SSE + per-session Logs surfaces
(docs/124-session-rescue-and-diagnostics §1.6) — no new indicator.

## Touchpoints

- Budget: `credential-store.ts`, `memory-pressure.ts`, `docker-memory.ts`,
  `startup-monitors.ts`, `warm-pool-manager.ts`
- Settings: `services/settings.ts`, `services/misc.ts`, `services/types.ts`,
  `api-routes-bootstrap.ts`, `shared/types/domain-types/misc.ts`
- Client: `stores/settings-store.ts`, `App.tsx`, `Settings/Settings.tsx`,
  `Settings/tabs/AdvancedTab.tsx`, `utils/session-data.ts`, memory banner
- Ladder: `idle-enforcer.ts`
- Agent-facing docs: `src/server/shipit-docs/environment.md`, `preview.md`

## Non-goals

- Changing what `docs/241-keep-preview-running` reserves, or its cap.
- Refusing to start sessions or services at the budget (req 11).
- Per-session memory budgets. The budget is one number for all of ShipIt.
