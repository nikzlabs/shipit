---
issue: planning#498
title: Stale session-container indication
description: Detect workers left on an older ShipIt build after an update, reclaim the idle ones so the update frees their memory, and show an inline restart suggestion for the rest.
---

# Stale session-container indication

## Status

Implemented (2026-07-31), automatic idle rotation added 2026-08-02, replaced by
idle **reclaim** 2026-09-02 (reqs 7, 8).

Worker image build IDs are retained on fresh and adopted container records,
classified centrally, and delivered as a transient session-scoped WebSocket
message. On orchestrator startup, every stale container that is genuinely idle is
destroyed and *not* recreated; a live turn is still re-adopted and is never
interrupted. See [Idle reclaim on update](#idle-reclaim-on-update).

## Requirement provenance

The complete user-sourced requirements are in [requirements.md](./requirements.md).
They require an indication that a container is stale and a suggestion to restart
it. Everything below—including the definition of stale, placement, copy, and
restart path—is a design decision, not a user-stated requirement.

## Context

[Zero-downtime updates](../113-zero-downtime-updates/plan.md) changed ShipIt
updates to replace only the orchestrator. Session-worker and Compose service
containers survive, which lets active turns continue and be re-adopted by the
new orchestrator. The tradeoff is deliberate worker-version skew: a surviving
session worker keeps the code and agent-facing docs baked into the image from
the deploy that created it.

The shipped groundwork already stamps `Dockerfile.session-worker.prod` with a
`shipit-build-id` image label. On boot, `container-discovery.ts` compares that
label with the orchestrator's `SHIPIT_BUILD_ID` and logs skew. That makes stale
workers diagnosable by an operator, but gives the user no indication inside
ShipIt and no direct path to refresh the worker.

The worker wire contract is currently additive-only and guarded in CI by
`worker-wire-contract.test.ts`. A stale worker is therefore not an error and
must not block chat. It means only that the session has not picked up the latest
worker-side changes.

## UX design

### Active-session warning

When the active session's running worker has a known build ID different from
the running orchestrator, show a compact warning banner immediately above the
message composer:

> **Update available for this session**  
> Its agent container is from an earlier ShipIt build. Restart it to use the
> latest agent and container updates.  
> **Restart agent**

Use the shared `Banner` warning variant, `WarningIcon`, and a secondary `Button`.
“Restart agent” matches the existing recovery action and is more precise than
“Restart container”: it recreates only the session's agent container and leaves
the user's Compose preview/services running.

The banner sits with the primary chat workflow rather than in the Terminal tab
or diagnostics drawer. A user should encounter the update state while using the
stale worker; diagnostics may also display the two build IDs, but is not the
primary indication.

### Running-turn safety

Reclaiming the agent container kills its current CLI process. The boot sweep
therefore checks the worker's authoritative agent status: a live turn is
re-adopted unchanged and never touched. The manual action remains disabled during
a turn as a fallback for states that cannot be classified automatically.

**`running: false` was the wrong test, and it is gone (2026-09-02).** The rule
this section originally described rotated only a stale worker reporting
`running: false`. `WorkerAgentStatus.running` means "a backend process occupies
the single agent slot" and stays true for a resident CLI **idle between turns** —
which, under live steering, is the steady state of every healthy Claude worker.
So the guard refused the normal case: on the production update of 2026-09-02, 35
containers were rediscovered, all 35 logged build skew, every `/agent/status`
probe answered, and **4** were rotated — the four whose CLI had fully exited. The
other 31 held 25.3 GiB and kept their banner. The test is now `turnActive`, the
field that means a turn is genuinely mid-flight.

### Idle reclaim on update

Req 7 asks for the memory back, which makes the two halves of the old rotation
both wrong:

**1. Idle is `turnActive === false`, not `running === false`.** With the
correction above, an idle-resident CLI is a reclaim candidate. Every clause of
the predicate (`isStaleIdleReclaimCandidate`, `restart-turn-reattach.ts`) reads a
**positive** report from the worker rather than an absence, because an image that
predates a field says nothing about it: `turnActive === false` (a legacy
pre-docs/240 worker omits it, and "unknown" has to stay conservative or a turn on
such an image dies mid-flight), plus the two docs/235 liveness fields below.

**2. Destroy, and stop there.** The old branch destroyed the agent container and
immediately called `runnerRegistry.getOrCreate`, spending the RAM straight back
on a session nobody was looking at — which is why the four rotations freed
nothing either. No viewer is attached at boot, so there is nothing to keep warm:
the lazy attach path (`activateSession` → `materializeRunner` → `getOrCreate`)
cold-starts a fresh container on the current image when the user next opens the
session, and the `container_started` listener re-sends
`session_container_freshness` as `current` — which is req 8, the banner never
appears.

#### Worker-side liveness, and why the wire needed two new fields

docs/235 established that `running` is not the busy signal: a session can be live
without an orchestrator-started turn, either because a background task is
outstanding (the *level* signal) or because the CLI woke **itself** when one
finished (the *edge* signal — and a self-woken turn never sets `turnActive`).
The orchestrator holds both facts on the runner as `agentBusy`, and that state is
in-memory and **dies with the orchestrator process**. A boot sweep is on the
other side of exactly that death, so it could not see either: it would have
destroyed the container running a backgrounded review, or a self-woken turn
mid-flight — the failure docs/235 exists to prevent.

So `WorkerAgentStatus` gains two optional fields, published by
`AgentController`: `backgroundTaskCount` (process-scoped — a turn routinely *ends*
with tasks still running, so it deliberately survives `agent_result` and is
cleared where the process dies) and `selfWakeActive` (turn-scoped, cleared by the
same `agent_result` that clears `turnActive`). Both are additive, so
`worker-wire-contract.test.ts` stays green.

They are `?? 0` / `!== true` on absence, unlike `turnActive`, and that asymmetry
is deliberate: every container running at the moment this shipped predates the
fields, so treating their absence as "unknown" would mean nothing is ever
reclaimable and the fix would never fire. Absence degrades to the blindness the
sweep already had, for one deploy per container.

#### What is never reclaimed

A live turn (adopted, docs/240), a self-woken turn, a worker with outstanding
background tasks, a `current` or `unknown` build, a standby/warm-pool container,
an archived session or one with no `workspaceDir`, a session holding a docs/241
always-on preview reservation (`holdsActiveReservation`), a worker whose
`/agent/status` probe failed (silence is not a report of idleness), and a session
whose runner is busy, has a viewer, or **declines** disposal — planning#298's
ordering applies here too, so a refused dispose is never followed by a destroy.

An orchestrator-side **queue** and a **post-turn hold** need no check: both live
in process memory that the restart already destroyed, so at boot there is nothing
to see and nothing to lose. Uncommitted edits are safe for a different reason —
the workspace is a host bind mount and outlives any container.

An **in-flight `/agent/spawn` consult** is deliberately not a hold either, and
that is docs/249's finding rather than an omission: the worker keeps no durable
record of a sub-agent run and returns its output inline over an in-memory
promise, so a restart already stranded it — `consult-card-reconcile.ts` runs at
the same boot and marks every such card `cancelled`. The subprocess that survives
is writing into a socket whose other end is gone, so reclaiming its container
ends work that was already unrecoverable rather than losing recoverable work.
This is the one place where the sweep and the steady-state enforcer legitimately
differ: `agentBusy` protects a live consult mid-session, because there the
caller is still there to receive it.

#### The Compose stack survives

The staleness being acted on belongs to ShipIt's own worker image; a project's
Compose services run the user's images and an update does not make them old.
Keeping them is also the only safe option available: the full teardown
(`containerManager.destroy`) sweeps every `shipit-parent-session` child
**including volumes**, so a boot-time memory sweep built on it would delete a
session's database on every deploy. What is left is docs/284 tier 1's split —
drop the agent container, keep the preview — which is the trade this sweep wants
anyway, and it means a session opened right after an update still has its
preview.

Known limit, carried deliberately: a stack orphaned this way is not a docs/284
**tier 2** candidate, since tier 2 only considers stacks *tier 1* orphaned
(`tier1At`). Such a preview holds its memory until the user next opens the
session, which makes it tier-1 eligible again. Still a large net win — the
incident measured 25.3 GiB in agent containers against 5.0 GiB in previews — and
closing it means teaching the enforcer about a second source of orphans, which is
its own change (see [Out of scope](#out-of-scope)).

This sweep is **not** the steady-state reclaim path. `idle-enforcer.ts` owns
that, driven by the docs/284 memory budget; this one fires once per boot and is
driven by worker staleness alone. It never fired in the incident because the host
was at 32 % of budget while the evict line is 85 % — the two answer different
questions and stay separate.

### Restart lifecycle

The action reuses
`POST /api/sessions/:id/agent/container/restart`, the existing lightweight
restart from docs/127. It feeds the existing `container_restarting` state into
the current phased overlay and reconnects the per-session WebSocket when the
new worker is ready. The warning clears only after the reconnect reports that
the new container matches the orchestrator build; an optimistic click must not
hide a failed restart.

### Unknown build identity

Do not call a container stale when either build ID is unknown. Show the worker
build as “unknown” in diagnostics and log it, but avoid a warning that could
persist through every restart on a malformed/custom image. This means old
containers created before build labeling cannot be classified; the next natural
container recreation brings them onto a labeled image.

## Freshness model

Define freshness as a comparison of immutable build identities:

```ts
type ContainerFreshness =
  | { state: "current"; workerBuildId: string; orchestratorBuildId: string }
  | { state: "stale"; workerBuildId: string; orchestratorBuildId: string }
  | { state: "unknown"; workerBuildId?: string; orchestratorBuildId?: string };
```

- `current`: both IDs are known and equal.
- `stale`: both IDs are known and different.
- `unknown`: either ID is absent.

Git SHAs are identities, not ordered versions. “Stale” here means “from a
different ShipIt build than the active orchestrator,” not a claim that one SHA
can be chronologically ordered before another. The user copy says “earlier
ShipIt build” because the normal source of skew is a forward update; diagnostics
retain both exact IDs for rollback/debugging cases.

The comparison is derived runtime state. It is not persisted in SQLite: after
an orchestrator update, restart, rollback, or container recreation, the source
build IDs are re-read and the result is recomputed.

## Server design

### Preserve the worker build on the container record

Add `workerBuildId?: string` to `SessionContainer`.

- On rediscovery/adoption, populate it from the Docker container/image label
  already read as `CONTAINER_BUILD_ID_LABEL`.
- On fresh creation, read the same label from the created container inspection
  rather than assuming the image matches the orchestrator. This keeps custom
  image and failed-deploy behavior honest.

Centralize the comparison in a pure helper such as
`getContainerFreshness(workerBuildId, orchestratorBuildId)`. The existing
adoption log should consume that helper so logs and UI cannot disagree about
what counts as skew.

### Send freshness on session attachment

Add a transient, session-scoped WebSocket message:

```ts
interface WsSessionContainerFreshness {
  type: "session_container_freshness";
  sessionId: string;
  freshness: ContainerFreshness;
}
```

Send it during the existing per-session attach/bootstrap flow, after the runner
and container have been resolved. Also send a fresh value when a container is
created or adopted while the viewer is attached. The restart path already
forces a WebSocket handshake, providing a final authoritative refresh.

Register the message in `TRANSCRIPT_SCOPED_MESSAGES` so a late packet from the
previous socket cannot put a stale warning on the newly active session. This is
runtime status, not transcript content, so it must not use `emitChatCard` or be
written to chat history.

Prefer this event over another polling endpoint. Freshness changes only when
the orchestrator or container changes; both already cause attachment,
reconnection, or lifecycle events. The existing 10-second health poll remains
focused on liveness.

## Client design

Store `containerFreshness` in `session-store.ts` and clear it in the centralized
session reset path. Handle `session_container_freshness` alongside the other
session-scoped WebSocket messages.

Add `StaleContainerBanner` in the chat column immediately above
`MessageInput`. It renders only for `freshness.state === "stale"` and:

- uses semantic design tokens through the shared warning `Banner`;
- uses Phosphor icons and `ICON_SIZE` constants;
- invokes the existing agent-container restart endpoint;
- disables restart while `isLoading` reports an active turn;
- joins the existing rescue state/overlay rather than inventing a second
  spinner or restart state machine;
- leaves the warning visible on request failure and surfaces the failure using
  the existing recovery error/toast convention;
- provides the full build IDs in an accessible tooltip or diagnostics detail,
  while keeping the banner copy human-readable.

The sidebar is deliberately unchanged in v1. A session without a running
container has nothing stale to refresh, and enumerating build state for every
session would add global synchronization for an indication only actionable
inside the active session. If users routinely miss the active-session banner,
a sidebar warning badge can be evaluated separately.

## Data flow

```text
ShipIt update
  -> old session container survives
  -> new orchestrator rediscovers container
  -> boot sweep probes agent status
  -> idle + stale worker: destroy the agent container, do NOT recreate
       (memory freed; Compose stack keeps serving)
  -> next open: fresh container on the current image, no banner
  -> active turn / self-wake / pending background task: leave it alone
  -> active turn: re-adopt without interruption
  -> Docker label supplies workerBuildId
  -> compare with orchestrator buildId
  -> session attach emits session_container_freshness
  -> active chat renders warning
  -> user selects Restart agent after any turn finishes
  -> existing restart lifecycle recreates worker, reconnects WS
  -> matching build IDs arrive
  -> warning clears
```

## Failure and edge cases

| Case | Behavior |
|---|---|
| Worker and orchestrator IDs match | No warning. |
| Either ID is missing | No stale warning; diagnostics/logs show unknown. |
| Update occurs during an active turn | Turn survives and is re-adopted; the reclaim does not run for it. |
| Stale container is idle — agent stopped, or its CLI resident between turns | Boot sweep destroys the agent container and does not recreate it. The next open cold-starts on the current image. |
| Stale idle container with outstanding background tasks, or a self-woken turn in flight | Left alone (`backgroundTaskCount` / `selfWakeActive`). Reclaimed on a later boot, once the work has drained. |
| Stale idle container whose `/agent/status` probe fails | Left alone. A worker that cannot answer has not reported itself idle. |
| Stale idle session with **Keep preview running** | Left alone — the docs/241 reservation wins over reclaim, as it does in the idle enforcer. |
| Restart request fails | Existing container remains classified stale; warning stays visible and the existing error surface explains the failure. |
| New container starts from an unexpectedly old/custom image | Recomputed IDs still differ, so the warning remains. |
| Session has no running container | No warning. Its next activation creates from the current image. |
| Orchestrator rolls back while a newer worker survives | IDs differ and the warning appears; diagnostics show the exact mismatch without claiming chronological ordering. |
| User switches sessions during delivery | `sessionId` scoping drops the foreign event; the new session gets its own value on attach. |

## Alternatives considered

### Put the warning only in `SessionHealthStrip`

Rejected as the primary surface. The strip is inside the Terminal panel, so a
user can spend an entire chat turn on a stale worker without seeing it. The
health details should expose build IDs, but the actionable indication belongs
beside chat.

### Restart every surviving worker after an update

Rejected. It would undo the benefit of zero-downtime updates and could kill
active turns. The reclaim is limited to workers whose agent endpoint
authoritatively reports no live work; live turns remain untouched.

### Reclaim the Compose stack too, for the last 5 GiB

Rejected here. The tempting call — `containerManager.destroy()` — also deletes
the session's Compose **volumes**, i.e. a project's database, which a memory
sweep must never do. Doing it safely means the docs/284 `services.stop` hook,
i.e. giving a boot sweep a second reclaim tier and killing the preview of every
session on every deploy, for a fifth of the memory. See
[Idle reclaim on update](#idle-reclaim-on-update).

### Compare semantic release versions

Rejected. The session-worker image already carries the exact build SHA, edge
deploys may not have a release tag, and equality—not ordering—is the relevant
question.

### Poll container freshness from the banner

Rejected. Freshness cannot change on a timer without a container/orchestrator
lifecycle transition, and those transitions already provide event/reconnect
points. A second poll would duplicate the health-strip channel.

## Verification

### Server

- Unit-test classification for equal, different, and missing build IDs.
- Test fresh creation and rediscovery both retain the image build label.
- Integration-test session attachment emits the scoped freshness event.
- Test a recreated container emits `current` after a previously stale worker.

### Client

- Render the banner for `stale`, and not for `current`, `unknown`, or no
  container.
- Verify restart is disabled during a turn and enabled when idle.
- Verify the action uses the agent-only restart endpoint and participates in
  the existing restart overlay/reconnect flow.
- Verify a failed restart keeps the warning visible.
- Verify a freshness message for another session is discarded.

### Completion checks

Run the co-located affected tests, `npm run lint:dev`, and
`npm run typecheck`. Use the live preview to visually verify the banner in both
themes, at desktop width, and in the mobile chat layout.

## Key files

| Area | Files |
|---|---|
| Build identity and discovery | `src/server/orchestrator/session-container.ts`, `src/server/orchestrator/container-discovery.ts`, container creation/inspection lifecycle |
| Session attachment | `src/server/orchestrator/ws-handlers/` attachment/bootstrap path |
| Wire types | `src/server/shared/types/ws-server-messages/`, shared domain types |
| Client handling/state | `src/client/hooks/message-handlers/`, `src/client/stores/session-store.ts`, `src/client/stores/actions/session-actions.ts` |
| UI | new `src/client/components/StaleContainerBanner.tsx`, chat-column composition in `src/client/App.tsx` |
| Existing restart flow | `src/server/orchestrator/services/recovery.ts`, `src/server/orchestrator/api-routes-container.ts`, `src/client/components/SessionHealthStrip/RecoveryActions.tsx` |
| Tests | `container-freshness.test.ts`, `container-discovery.test.ts`, `integration_tests/connection.test.ts`, `StaleContainerBanner.test.tsx`, `dispatch-session-scope.test.ts` |
| Idle reclaim on update | `src/server/orchestrator/restart-turn-reattach.ts` (`isStaleIdleReclaimCandidate` + the reclaim branch), `restart-turn-reattach.test.ts` |
| Worker-side liveness on the wire | `src/server/session/agent-controller.ts` (`backgroundTaskCount`, `selfWakeActive`), `src/server/shared/types/agent-types.ts` (`WorkerAgentStatus`), `agent-controller.test.ts` |
| Related designs | `docs/113-zero-downtime-updates`, `docs/112-container-recovery`, `docs/127-restart-agent`, `docs/240-turn-survives-orchestrator-restart`, `docs/235-agent-self-wake-liveness`, `docs/284-idle-preview-survives-agent-stop` |

## Out of scope

- Blocking chat on a stale-but-compatible worker.
- Restarting or stopping the user's Compose service containers.
- Making a stack the boot sweep orphaned reclaimable by docs/284 tier 2. Tier 2
  keys on `tier1At`, the enforcer's own record of what *it* orphaned; a second
  source needs the enforcer to learn about it, and the enforcer's steady-state
  model is deliberately untouched here.
- A fleet-wide admin page or bulk restart action.
- A sidebar badge in the first version.
- Runtime worker protocol negotiation; docs/113 defers that until the first
  breaking worker-contract change.
