---
issue: planning#273
title: Container-start recovery — a session that fails to start recovers itself
description: Retry container creation before tearing down the turn, stop the missing-container reconciler from killing in-flight creations, and never dial the placeholder worker URL.
---

# Container-start recovery

## Problem

A session would sometimes fail to start — or stop mid-session — with a single
chat error:

```
Error: connect ECONNREFUSED 0.0.0.0
```

The user's only recovery was to type "continue". That worked (it built a fresh
runner and a fresh container), but the original prompt was **gone**: the failed
turn was never re-delivered, so the new turn began with no task at all and the
agent answered "I don't have the prior task context — what should I continue
working on?".

## Why `0.0.0.0`

`ContainerSessionRunner` is constructed with `workerUrl: "http://0.0.0.0:0"` and
holds that placeholder until `setWorkerUrl()` fires when its container is ready.
Worker calls await a `_workerReady` gate first, so under normal operation the
placeholder is never dialed.

But `dispose()` **also** resolves that gate — deliberately, so awaiters don't
leak when a runner dies before its container exists. A turn parked on the gate
is therefore released by disposal and POSTs `/agent/start` to the placeholder.
Node reports that as `connect ECONNREFUSED 0.0.0.0` (it omits the `:0`), which
names neither the session container nor the actual failure, and reads like a bug
in the user's own project.

Two paths disposed a placeholder-URL runner:

1. **Container creation failed.** `createContainerForRunner` disposed the runner
   on the *first* error. Most creation failures are transient — a slow image
   pull, a busy Docker daemon, an IP/veth allocation race, a worker health check
   that misses its window under host load.

2. **The missing-container reconciler force-disposed a healthy session.** It
   force-disposes any registered runner the container manager doesn't know
   about. A runner is registered *synchronously* by `getOrCreate`, while
   `createContainerForRunner` runs fire-and-forget — and the manager's map entry
   is only written partway into `createContainer`. Everything before that
   (destroying a stale container, resolving overlay specs, building the config)
   is a window in which a perfectly healthy activating session looks orphaned.
   The reconciler runs every 30s, which is why this hit "sometimes".

## Design

### 1. Retry container creation before giving up

`createContainerForRunner` now loops up to `MAX_CONTAINER_CREATE_ATTEMPTS` (3)
with a 1s/3s backoff. Each attempt is `attemptContainerCreate`, which returns
its error rather than throwing so the loop owns all policy in one place.

The retry *is* the user's "continue", done automatically and **before** the turn
is torn down — so the prompt is never lost. A turn parked on the worker-ready
gate simply starts a few seconds late; nothing re-dispatches and no queue is
touched. Retries are silent in chat (they land in the session log ring); the
user experiences a slightly slower start, not a failure.

A retry destroys leftovers first, so the next attempt starts clean. Deterministic
causes are not retried — retrying only delays an error the user must act on:

- `Session workspace is missing` (planning#181): the clone could not be restored.
- `SESSION_EGRESS_SIDECAR_IMAGE is not set`: deployment misconfiguration.

The loop also bails if the runner was disposed mid-attempt (archive, full reset,
shutdown) — nothing is waiting on that container any more.

### 2. The reconciler skips in-flight creation

`ContainerSessionRunner.awaitingContainer` is true while the runner still holds
the placeholder and creation hasn't failed. `createMissingContainerReconciler`
skips those runners, alongside its existing standby skip. It flips false on both
`setWorkerUrl()` and `markWorkerUnavailable()`, so a runner whose creation truly
failed is not shielded forever.

The property is optional on `SessionRunnerInterface` — in-process runners have
no container and omit it.

### 3. The placeholder is never dialed

Two layers, because the first cannot be forgotten and the second explains the
failure:

- **Transport (`worker-http.ts`).** `workerPost` / `workerPut` / `workerGet`
  reject with a `WorkerUnavailableError` when handed
  `PLACEHOLDER_WORKER_URL`. It *rejects* rather than throwing synchronously, so
  the many fire-and-forget `workerPost(...).catch(() => {})` call sites keep
  swallowing it exactly as they swallow a transport error today.

- **Runner.** `markWorkerUnavailable(reason)` records the real creation failure,
  and is called immediately *before* the terminal `dispose()`. The turn-start
  and install paths call `assertWorkerReachable()` after their `_workerReady`
  await, so the chat error carries the actual cause ("no space left on device")
  instead of an address.

## Key files

| File | Change |
|---|---|
| `orchestrator/worker-http.ts` | `PLACEHOLDER_WORKER_URL`, `WorkerUnavailableError`, placeholder guard on all three verbs |
| `orchestrator/container-session-runner.ts` | `awaitingContainer`, `markWorkerUnavailable`, `assertWorkerReachable`; guards on `_doStartAgentViaProxy` + `runInstall` |
| `orchestrator/app-lifecycle.ts` | create-retry loop + `attemptContainerCreate`; reconciler skips `awaitingContainer` |
| `orchestrator/session-runner.ts` | optional `awaitingContainer` on `SessionRunnerInterface` |
| `orchestrator/container-create-recovery.test.ts` | retry, terminal-failure, reconciler-skip, and error-legibility coverage |
| `orchestrator/worker-http.test.ts` | placeholder-guard coverage |

## Behaviour that is deliberately unchanged

- The OOM circuit breaker still refuses creation outright (it now records its
  reason on the runner first, so a parked turn reports it).
- `dispose()` still resolves `_workerReady` — leaking awaiters would be worse
  than a legible error.
- The reconciler still force-disposes genuinely orphaned runners.
