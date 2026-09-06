---
issue: planning#515
title: A Compose stack must not outlive the session that owns it — design
description: Boot reconciliation of surviving Compose stacks, and a stack teardown before the destructive disk rung.
---

# 290 — A Compose stack must not outlive the session that owns it (design)

Implements [requirements.md](./requirements.md).

## The incident

Host `shipit`, 2026-09-06. Load average **72 on 16 cores**. Four `vite` dev
servers — one per Compose stack — each at 100% CPU for three to four days. All
four belonged to sessions at `diskTier: evicted`, with no agent container and no
runner.

`docker ps` showed **23 Compose stacks whose session had no agent container**,
created between 09-01 and 09-05. The orchestrator container was recreated by the
self-updater seven times in that window, so every one of those stacks had
survived at least one "clean" update. 15 were `evicted`, 6 `light`, 2 `hot`.

In each spinning container `docker exec` failed with *"current working directory
is outside of container mount namespace root"*: the service's `/app` is a subpath
of the shared `shipit_workspace` volume, and the `light → evicted` rung deleted
`.../sessions/<id>/workspace` on 09-05 18:15 while the stack was still mounted on
it. The Vite log ends at exactly that minute with `src/image/png.ts changed,
restarting server...` and no `server restarted` line — the watcher saw the wipe,
began a restart against a root that no longer exists, and has been spinning
since. Quiet evicted stacks whose Vite never saw a change sat at 0.2% CPU, so the
spin is triggered by the wipe, not by idling.

## Root cause, in three parts

### 1. Clean shutdown never finishes a `compose down`

`shutdown-manager.ts`'s `onClose` calls `runnerRegistry.disposeAll({
preserveAgent: true })`, whose `disposed` handlers go through `trackComposeStop`
— *fire-and-forget* — and the docs/284 sweep for runner-less stacks right below
it is `void mgr.stop()`. Nothing awaits `composeStopPromises`. The hook closes
the DB and returns, `autoStart` calls `process.exit(0)`, and the recreate that
`deploy.sh`'s `docker compose up -d` performs removes the orchestrator container,
killing every in-flight `docker compose down` child with it.

**Three places asserted the opposite**, and all three are corrected in this
change: `shutdown-manager.ts` (the hook itself), `restart-turn-reattach.ts` ("a
clean update takes every stack down on the way OUT"), and
`deployment/vps/deploy.sh`. Per CLAUDE.md, a doc describing a guarantee is a
claim, not a contract — these were exactly that, and docs/242's design section
["The Compose stack is not this sweep's business"] leaned on the first of them.

### 2. Nothing after a restart could see a surviving stack

`serviceManagers` is process-local and is never rebuilt from Docker at boot. The
idle enforcer's tier 2 (`idle-enforcer.ts`), the `hot → light` fallback in
`reclaimToLight`, and the shutdown sweep itself all key off that map, so a stack
that survived one restart was invisible to every reclaim path for the rest of its
life. `preview-proxy.ts:947` resolves a service port through the same map, so it
was unroutable too — it served nobody while holding memory and a CPU core.

The boot sweep in `restart-turn-reattach.ts` declined to touch stacks on the
grounds that they were already down (see 1) and that `killStaleContainers()`
removes them on the next attach — which only happens if the user reopens the
session. "A dev server running for a session nobody reopens" is precisely what
was left.

### 3. `light → evicted` wiped the workspace without stopping the stack

`reclaimToEvicted` deleted `workspace/` and never consulted Compose.
`containerManager.destroy()` looks like it would have covered this and does not:
its first statement is `const sc = deps.containers.get(sessionId); if (!sc)
return;`, and at `light` there is no container record by construction.

## What this adds

### `compose-stack-reaper.ts` — the teardown primitive plus the boot pass

`composeProjectName(sessionId)` is the one definition of `shipit-<sid12>`, now
shared with `ComposeCli.args()`'s `-p`. Deriving the name from the session row is
what makes a teardown possible with no compose file and no live manager.

`downComposeStackByProject(docker, sessionId)` is `docker compose -p <project>
down --remove-orphans` expressed against the Docker API: stop and remove every
container labelled `com.docker.compose.project=<project>`, then remove the
project's networks. **Volumes are never removed here** — a `light` session keeps
its overlay for a warm resume (docs/183), and only the tier ladder decides a
volume's fate.

Two things about it are load-bearing:

- **The project label, not `shipit-parent-session`.** The docs/172 Tier B
  resolver and Tier C SNI proxy carry the parent label so destroy-time cleanup
  reaps them, and they share the *agent* container's network namespace. A session
  whose agent container survived the restart still needs them; reaping by parent
  label would leave a live agent with no DNS and no HTTPS — the same mistake
  `killStaleContainers` already keeps an incarnation-aware keep-list for. The
  project label is set by Compose and by nothing else here.
- **It throws when it cannot establish the containers are gone.** `light →
  evicted` calls it immediately before wiping the workspace, so a best-effort
  teardown that swallowed a failure would hand that rung a "done" with no
  evidence — recreating the exact defect. Network removal stays best-effort: a
  network holds no mount.

`reapSurvivingComposeStacks(deps)` is the boot pass (req 1). It enumerates
containers carrying **both** `shipit-parent-session` and
`com.docker.compose.project`, requires the two to agree (a repository's own
compose file can set the parent label — Compose merges label maps — so this is
what stops one session's stack naming another's as its parent), and takes down
every resulting stack except those held for a named reason:

| Kept when | Why |
|---|---|
| the session row is gone | it is an ORPHAN, and `cleanupOrphanComposeResources` owns it earlier in the same boot — including its volumes, which that path may reap and this one may not |
| `serviceManagers` has it | this process owns it, so it is routable. docs/288's warm pre-start is the case that makes this necessary rather than defensive: manager, no runner |
| a runner exists | the docs/240 adoption sweep took its turn, a reserved preview was restored, or a viewer is attached |
| `unprobedAfterRestart` names it | docs/288 — its worker never answered the boot probe, so "no runner" does not mean "idle" |
| `holdsActiveReservation(session)` | docs/241 promises the preview survives an orchestrator restart, and `restoreReservedPreviews` makes good on it by creating a runner that rebuilds the stack |

A **pinned** session (docs/110) is deliberately *not* on that list. A pin protects
a session's disk from automatic reclaim; it says nothing about previews, and an
unroutable stack burning a CPU core is not something a pin promised to keep.

The pass is paced (500 ms) like every other boot sweep, re-checks each hold
immediately before the teardown (a viewer can attach while it works through the
list), never rejects, and logs one line per stack taken or kept.

### Where it is called, and why there

`startup-monitors.ts`, inside the `if (containerManager)` block, immediately
after `restoreReservedPreviews`. **The position is the whole of its
correctness**: every keep signal it reads is a runner, and runners are created by
two boot steps that must both have finished — `reattachInFlightTurns` (docs/240,
awaited in `bootstrap-managers.ts`) and `restoreReservedPreviews`. Run it any
earlier and it reaps the stack of a session that was about to get one.

### The disk ladder stops the stack before it wipes (req 2)

`TierEscalationDeps` gains `stopComposeStack?: (sessionId) => Promise<unknown>`,
wired in `startup-monitors.ts` to `downComposeStackByProject`. It is used at both
rungs:

- **`light → evicted`** stops the stack — the manager if there is one, then by
  project name unconditionally — *before* `reclaimRegenerableSessionDirs`. A
  teardown that throws **aborts the eviction**: the session stays at `light`, the
  next pass retries. This is the one place where a best-effort step must not be
  best-effort, because proceeding means deleting a directory a live service has
  open.
- **`hot → light`**'s no-runner fallback does the same, so the same blindness one
  rung up is closed too. Volumes still go on that rung, via the existing
  `pruneVolumes` by label.

Both rungs now also **delete the stopped manager from `serviceManagers`**. A
stopped manager left in the map is worse than none: `setupServiceManager`
consults the map to choose between *adopting* a manager and building one, and
adoption never calls `start()` — so the session's next activation would come up
with no preview at all.

### Shutdown stays a head start

Per the resolved question, the un-awaited stop is kept and the claims are
rewritten. Awaiting 20+ parallel `compose down`s does not fit Docker's stop grace
period, and slowing every update to reclaim something nobody is waiting on is the
wrong trade. Boot reconciliation is the guarantee; shutdown is the optimisation.

## Key files

- `src/server/orchestrator/compose-stack-reaper.ts` — project name, teardown
  primitive, boot pass. (+ `compose-stack-reaper.test.ts`)
- `src/server/orchestrator/tier-escalation.ts` — `stopComposeStack` at both rungs;
  the abort-the-wipe branch.
- `src/server/orchestrator/startup-monitors.ts` — wiring, and the call position.
- `src/server/orchestrator/compose-cli.ts` — `-p` now uses the shared name.
- `src/server/orchestrator/shutdown-manager.ts`,
  `src/server/orchestrator/restart-turn-reattach.ts`,
  `deployment/vps/deploy.sh` — the three corrected claims.

## Out of scope

- **Re-adopting a surviving stack instead of reaping it**, so an idle preview
  survives a ShipIt update. docs/284 already names this as a worthwhile follow-up
  ("Re-adopting preserved stacks across a restart … is a worthwhile follow-up,
  not part of this"). It needs the manager rebuilt from Docker — the compose
  file, the generated override, the overlay dep-dir set, the secrets closure —
  and only then is the stack routable again. This change makes the *unadopted*
  case correct, which is the prerequisite either way.
- **Awaiting the shutdown teardown.** See the resolved question.
