---
description: Fix gaps in service-manager's Docker Compose error handling that cause the preview proxy and log surfaces to drift out of sync when services hiccup.
---

# Compose resilience — services that recover when Docker hiccups

## Problem

Three related gaps in the orchestrator's view of compose services let
the preview and logs surfaces drift out of sync with reality. Symptoms:
the preview iframe loads against a dead container, the logs panel shows
empty output even when the service is healthy, or a preview service
that crashed and recovered never reappears in the proxy.

These are tracked separately from feature 120 (container resilience)
because they live in `service-manager.ts` and concern the compose stack
rather than the agent container's SSE channel.

## The gaps

### D — `pollStatus` swallows Docker errors

`src/server/orchestrator/service-manager.ts:830-833`:

```ts
try {
  stdout = await this.composeQuery(args, this.workspaceDir);
} catch (err) {
  console.warn(`[compose:${this.sessionId}] pollStatus failed:`, …);
  return; // ← stale state stays in `services` map
}
```

When `docker compose ps` fails (Docker daemon restart, socket EAGAIN,
permission glitch on the proxy), the in-memory `services` map keeps
its previous statuses. A service that has actually crashed still shows
`status: "running"`, the preview proxy routes requests to a dead
container, and the user sees timeouts or connection-refused responses.

Polling runs every 5s, so the window is small in steady state — but a
multi-second daemon hiccup (e.g., zero-downtime updates) can leave
multiple sessions wedged.

**Fix**: track consecutive poll failures per session. After N failures
(maybe 3 = 15s), mark all services as `status: "unknown"` and emit a
`stack_unhealthy` event. Resume normal polling with backoff. On first
successful poll after failure, re-establish actual statuses.

### E — SSE reconnect retries forever, capped at 10s

`container-session-runner.ts:783-797` schedules SSE reconnect with
exponential backoff capped at 10s, but never gives up. If the worker is
permanently gone (e.g., container destroyed but runner not yet
disposed), the orchestrator burns CPU on retries forever and the UI
keeps the session looking "alive."

**Fix**: bound retries to N attempts (maybe 12 = ~2 minutes of
attempts), then emit a `worker_unreachable` server message. The
SessionHealthStrip already shows the Restart Container button — this
new event surfaces a banner pointing the user at it. Also: clear stuck
state (`_isRunning = false`, dispose the agent reference) so the user
isn't stuck waiting on a turn that will never complete.

### F — Compose log streamer doesn't restart when service comes back

`service-manager.ts:525-563` spawns a `docker compose logs -f` process
once when a service is first detected. When the service crashes and
restarts (manual restart, retry-while-installing path, OOM kill), the
streamer process exits and isn't replaced. `logBuffers` stops growing,
the logs endpoint returns the original stale buffer, and the UI looks
broken even though the service is actually healthy.

**Fix**: when `pollStatus` transitions a service from non-running back
to `running`, check whether the log streamer for that service is still
alive. If not, re-spawn it. Also clear the buffer on transition (or
keep the old buffer with a separator marker) so the user sees fresh
output rather than stale lines from the previous instance.

## Sequence

D and F together close the "compose service recovers but UI thinks
it's still broken" loop. E is independent but small.

Suggested order: F → D → E. F is the smallest and most common
user-visible bug; D is defensive; E touches the runner and is the
riskiest change.

## Out of scope

- Cross-session daemon-down banner. The existing per-session stack
  status already covers this; a global "Docker is down" surface is
  separate.
- Compose stack auto-recovery (e.g., `docker compose up` retry on
  daemon recovery). Reconcile-on-config-change already exists; a
  reconcile-on-daemon-recovery could piggy-back but isn't a clear
  user-visible win yet.

## Key files

- `src/server/orchestrator/service-manager.ts` — `pollStatus` failure
  handling, log-streamer lifecycle.
- `src/server/orchestrator/container-session-runner.ts` — SSE retry
  bound, `worker_unreachable` emission.
- `src/server/shared/types/ws-server-messages.ts` — new
  `worker_unreachable` and `stack_unhealthy` message types.
- `src/client/components/SessionHealthStrip.tsx` — surface
  `worker_unreachable` and `stack_unhealthy` banners.
