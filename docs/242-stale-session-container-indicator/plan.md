---
title: Stale session-container indication
description: Detect workers left on an older ShipIt build after an update and show an inline suggestion to restart them.
---

# Stale session-container indication

## Status

Planned.

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

Restarting the agent container kills its current CLI process. While a turn is
running, keep the warning visible but disable the action with the explanation
“Wait for the current turn to finish.” Once the turn finishes, the action
becomes available. ShipIt never restarts a stale worker automatically.

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
| Update occurs during an active turn | Turn survives; warning appears after reconnect; restart is disabled until the turn finishes. |
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
active turns. The stale state is safe under the additive wire contract, so
rotation remains user-initiated or natural through idle disposal.

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
| Tests | co-located server freshness/discovery tests and client banner/message-handler tests |
| Related designs | `docs/113-zero-downtime-updates`, `docs/112-container-recovery`, `docs/127-restart-agent`, `docs/240-turn-survives-orchestrator-restart` |

## Out of scope

- Automatically restarting stale containers.
- Blocking chat on a stale-but-compatible worker.
- Restarting the user's Compose service containers.
- A fleet-wide admin page or bulk restart action.
- A sidebar badge in the first version.
- Runtime worker protocol negotiation; docs/113 defers that until the first
  breaking worker-contract change.
