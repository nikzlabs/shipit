---
status: done
priority: high
---

# Restart agent — recover the agent container without nuking the compose stack

## Problem

Today the heaviest recovery action a user can take on a stuck session
is **Rescue session**, which does a full session reset:

1. Stop the compose stack (`docker compose down`).
2. Kill the agent CLI on the worker.
3. Force-dispose the runner.
4. Destroy the agent container.
5. Reap any orphaned compose containers by label.
6. Re-create the agent container (via the runner factory).
7. Re-create the compose stack from scratch.

That's the right tool for "everything is wedged, scorched-earth recover."
But it's overkill for the much more common case: **the agent container
itself is in a bad state but the compose stack is healthy.** Today's
Rescue tears down a working compose stack as collateral damage and
takes ~20–30 s to come back, during which the user's preview iframe
goes blank, dev-server state is lost (in-memory caches, HMR module
graph, watch state), and any debugger / repl attached to a compose
container is killed.

Worse, when the compose stack happens to be the **inner orchestrator
in dogfood mode**, "restart compose" means "restart everything the
user is looking at" — even though the *outer* agent container is the
one we actually wanted to recover.

## What the user wants (per the original request)

> "I want the agent container to always work! If for some reason it
> crashes, there should be a way to restart it, without restarting the
> whole shipit. 'preview' recovery is lower priority for now."

Concretely:

- A recovery action that destroys and recreates **only the agent
  container**.
- The compose stack stays running across the agent restart.
- Faster than Rescue (no compose down + up).
- Sits alongside Rescue session — Rescue stays as the big hammer for
  cases where compose itself is wedged.

## Design

### The coupling problem

The reason today's Rescue tears down compose is structural: the
`ServiceManager` is owned by the runner. Each runner has a
`runner.serviceManager` reference, and the runner's `disposed` event
handler in [`app-lifecycle.ts`](../../src/server/orchestrator/app-lifecycle.ts)
explicitly calls `mgr.stop()`:

```ts
runner.on("disposed", () => {
  serviceManagers.delete(runner.sessionId);
  mgr.stop().catch((err) => { … });
});
```

So *any* path that disposes the runner — Rescue, idle eviction,
shutdown, full reset — drags the compose stack down with it. There's
no lifecycle for "swap out the agent container while keeping the
ServiceManager."

### The fix — `preserveComposeOnDispose`

A small lifecycle hook on `ContainerSessionRunner`:

```ts
/** Set by recovery flows that destroy+recreate the agent container
 *  but want the compose stack preserved. The disposed-handler in
 *  app-lifecycle.ts honors this flag by skipping `mgr.stop()` and by
 *  leaving the ServiceManager in the orchestrator-wide `serviceManagers`
 *  map. The next `setupServiceManager(newRunner)` reuses it. */
preserveComposeOnDispose = false;
```

The disposed-handler reads the flag:

```ts
runner.on("disposed", () => {
  if (isContainerRunner(runner) && runner.preserveComposeOnDispose) {
    // Keep the ServiceManager alive; the next setupServiceManager
    // call adopts it. We only detach the listeners attached to *this*
    // runner so its disposed state can't leak into future events.
    mgr.off("stack_error", stackErrorListener);
    return;
  }
  serviceManagers.delete(runner.sessionId);
  mgr.stop().catch(…);
});
```

And `setupServiceManager` learns to adopt an orphaned ServiceManager,
delegating to a sibling helper:

```ts
function setupServiceManager(runner, deps) {
  // …shared prelude: parse shipit.yaml, fire install, etc…
  const existing = serviceManagers.get(runner.sessionId);
  if (existing) {
    adoptExistingServiceManager(runner, existing, {
      serviceManagers,
      containerManager,
      broadcastLog,
      installPromise,
      secretsLoader,
    });
    return;
  }
  // Normal path: create a fresh ServiceManager and start the stack.
  // …existing code…
}
```

The `adoptExistingServiceManager` helper wires the new runner onto the
preserved manager. The full sequence is:

1. `runner.setServiceManager(mgr)` — attaches the new runner's
   event listeners to the surviving manager.
2. `mgr.setSecretsLoader(secretsLoader)` — replaces the OLD closure
   (which referenced the disposed runner) with a fresh one. Today the
   two closures are functionally equivalent, but defensive against
   future wrappers.
3. **Defer the network join until `runner.whenWorkerReady()` resolves.**
   The runner is returned synchronously by `getOrCreate` with a
   placeholder workerUrl; the container is created asynchronously by
   the factory and `setWorkerUrl()` fires once the IP resolves. If we
   call `connectToNetwork` immediately, the container manager hasn't
   registered the new container yet — the call throws "No container
   found" and gets swallowed in `.catch()`, silently leaving the new
   agent off the compose network. The `whenWorkerReady()` gate is the
   load-bearing piece that makes "compose stays attached" actually work.
4. Re-bind a fresh `stack_error` listener so error logs route to the
   new runner. Captured in a local variable so the disposed handler
   can detach it cleanly.
5. Re-arm the install-running gate for the new agent container's
   install. The workspace volume is preserved, but a compose service
   reading from it during the new install still benefits from the
   retry-with-backoff treatment.
6. Register a disposed handler with the same shape as the create path:
   honors `preserveComposeOnDispose` for chained restartAgent calls;
   stops the manager and evicts from the map otherwise.

### The new recovery service

`restartAgent(deps, sessionId)` lives in
[`services/recovery.ts`](../../src/server/orchestrator/services/recovery.ts)
alongside `restartContainer`. The phase sequence is the same minus
the compose phases:

| Phase | What it does |
|---|---|
| `restarting_agent` (new) | UI overlay: "Restarting agent…" |
| (kill agent on worker) | Best-effort SIGKILL the CLI |
| (set `preserveComposeOnDispose = true`) | Mark the runner |
| (force dispose runner) | Detaches but compose survives |
| `destroying_container` | Destroy the agent container |
| `creating_container` | `getOrCreate` builds a fresh runner; setupServiceManager adopts the existing ServiceManager |
| `ready` / `failed` | Same poll-based finalize as restartContainer |

No `stopping_stack`, no `starting_stack`, no orphan reap. The compose
stack is never told the agent went away — from compose's perspective,
nothing happened.

### Reusing `RescuePhase` for the UI

Adds one new phase value:

```ts
export type RescuePhase =
  | "stopping_stack"
  | "destroying_container"
  | "creating_container"
  | "starting_stack"
  | "restarting_agent"   // <- new
  | "ready"
  | "failed";
```

The strip's PHASE_LABEL gets the new entry and renders the same
phased-progress overlay it already does for Rescue.

### HTTP API

`POST /api/sessions/:id/agent/container/restart`

Mirrors `/api/sessions/:id/container/restart`:

- Same `RestartContainerResult` shape.
- Same idempotency guarantees.
- Same WS message stream (`container_restarting` with phase events).

### UI

`SessionHealthStrip` grows a new button between "Kill agent" and
"Rescue session":

```
[ Diagnostics ] [ Kill agent ] [ Restart agent ] [ Rescue session ]
```

- **Kill agent** — SIGKILL the CLI process inside the worker (current
  behavior, unchanged).
- **Restart agent** *(new)* — destroys+recreates the agent container,
  compose stack untouched.
- **Rescue session** — the deep operation, current behavior unchanged.

Each escalates one notch from the previous.

## Edge cases

### Race: compose service config changes while agent is being restarted

The file watcher could fire a `reconcile()` on the orphaned
ServiceManager during the restart window. That's safe — `reconcile()`
re-runs `start()` on the same manager instance; the manager owns its
own state machine. The new runner adopts the manager at whatever
state it's in.

### Race: install on new container vs. running compose service

`agent.install` runs on the new agent container (fresh `node_modules`
needs to be re-extracted). The compose service might be reading from
the same workspace volume during the install window. This is the
*same* race the cold-start install gate already handles — we re-arm
`setInstallRunning(true)` for the duration of the new install, so any
compose service that fails during the install window gets retried
with backoff (per the existing `scheduleRetryWhileInstalling` path).

### Race: user clicks "Restart agent" twice quickly

Idempotent. The second click destroys whatever container the first
restart just created, and the third creation runs the same way. The
phased overlay debounces in the UI.

### Failure: new container creation fails

Surfaces via `lastCreateError` on the health endpoint, just like
restartContainer. The strip flips the rescue overlay to `failed` and
the user can retry or escalate to full Rescue session.

### State: agent was mid-turn when restart fires

The `running` flag is captured at turn start (post-095) so the
old runner's turn never "leaks" into the new runner. The new runner
starts idle. The user's chat history is preserved (it lives in
`ChatHistoryManager`, not on the runner).

## Why this stays narrow

This feature deliberately does NOT:

- Try to swap containers under a live runner without disposing
  (would require re-attaching SSE, re-pushing secrets, re-wiring all
  in-flight handlers — too much surgery for the value).
- Fix `killStaleContainers()` aggressiveness (separate concern; the
  `restartAgent` path side-steps that codepath because it never
  re-runs `ServiceManager.start()`).
- Add an auto-restart watchdog that triggers `restartAgent` on agent
  container `die` events. Feature 120 already auto-restarts on
  container exit; this feature gives the user a manual override.

## Key files

### Server

- `src/server/orchestrator/container-session-runner.ts` — adds
  `preserveComposeOnDispose` field.
- `src/server/orchestrator/app-lifecycle.ts` — `setupServiceManager`
  adopts an orphaned ServiceManager; disposed handler honors the
  preserve flag.
- `src/server/orchestrator/services/recovery.ts` — new
  `restartAgent` function.
- `src/server/orchestrator/api-routes-container.ts` — new endpoint.
- `src/server/shared/types/ws-server-messages.ts` — new
  `restarting_agent` value in `RescuePhase`.

### Client

- `src/client/components/SessionHealthStrip.tsx` — new "Restart
  agent" button; new phase label.

### Tests

- `src/server/orchestrator/services/recovery.test.ts` — restartAgent
  flow with a stub container manager + ServiceManager. Covers:
  - Compose-untouched invariant (no `mgr.stop`, no `reapOrphans`).
  - Emitted phases (`restarting_agent`, `destroying_container`,
    `creating_container`, `ready`); no compose phases.
  - Phase=failed on create error; lastInterruptError surfacing on
    best-effort kill failures.
  - **Chained restart-agent**: two consecutive `restartAgent` calls
    each preserve compose. Catches regressions where the adoption
    handoff drops state across iterations.
- `src/server/orchestrator/integration_tests/service-manager-adoption.test.ts`
  — focused coverage of `adoptExistingServiceManager`:
  - `setServiceManager` is invoked on the new runner.
  - Exactly one `stack_error` listener is attached.
  - `connectToNetwork` is deferred until `whenWorkerReady()` resolves
    (the load-bearing fix for the network-join race).
  - Disposed handler preserves the manager when the flag is set;
    tears it down when not.
  - Install-running gate is re-armed and released around the new
    container's install.

## Patterns this fits into

- **WebSocket lifecycle independence** (CLAUDE.md): the API endpoint
  is HTTP, the phased progress goes through `runner.emitMessage`, so
  reconnecting viewers see ready/failed via the turn-event buffer.
- **Service layer** (server-architecture skill): new function in
  `services/recovery.ts` alongside the existing `killAgent` /
  `restartContainer` family.
- **Idempotent recovery** (CLAUDE.md): the action is safe to retry;
  partial state is recoverable.
- **Inline beats link-out** (CLAUDE.md §2): user fixes the agent from
  inside the health strip; no shell, no logs to grep.

## Out of scope

- Auto-restart on agent container OOM (feature 120 territory; this
  feature is the *manual* affordance).
- Fixing `killStaleContainers()` over-aggressive label filter (the
  separate "Rescue kills running compose" bug — tracked separately).
- Decoupling the runner factory from compose setup entirely (would
  let RestartAgent skip the runner recreate entirely; bigger
  refactor, can revisit if needed).
