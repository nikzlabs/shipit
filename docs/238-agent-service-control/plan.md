---
issue: https://linear.app/shipit-ai/issue/SHI-251
title: Agent-driven Compose service control (`shipit service`)
description: Give the agent a first-class CLI to start, stop, restart, inspect, and tail the Docker Compose services declared in the project — including manual debug services.
---

# Agent-driven Compose service control

## Problem

A project's `docker-compose.yml` routinely declares services the agent needs but
that do not start on their own — a Postgres it must migrate, a Redis it must
flush, an Android emulator it must `adb` into, a log tailer, a worker. These are
`x-shipit-preview: manual` by default (that is the default for any service
without `ports`), and every piece of user-facing documentation described the way
to start them as **"User clicks Start in UI"**.

That is a §5 inversion of ShipIt's own product principles. Chat is the input
surface and *the agent is the actor*: the user should be able to say "bring up
the database and run the migration" and have it happen, rather than being told to
go press a button before the agent can continue. Worse, the user often *cannot*
press it usefully — the agent is the one that knows which service it needs, and
when.

The capability was in fact half-built, and failed in three distinct ways:

1. **Undiscoverable.** The worker has exposed `POST /services/start` on
   `localhost:9100` since the original compose work, but the only mention of it
   was a "Service control API" section at the tail of
   `src/server/shipit-docs/compose.md` — a document the agent reads when it is
   *authoring* a compose file, not when it is *debugging* one. The always-loaded
   system prompt told the agent it could read service **status and logs** and
   said nothing about start/stop/restart, so in practice the agent never used
   it. Every other agent-facing capability in ShipIt is a `shipit <noun> <verb>`
   subcommand; services were a raw `curl` to a port number.

2. **Broken for exactly the services that need it (the real bug).**
   `ServiceManager.startService` runs `docker compose up -d --build <name>`, but
   the worker's `ServiceRequestQueue` rejected *every* request after a flat
   **60 s**. A manual service is manual precisely *because* it is heavy — it
   pulls a multi-gigabyte image or runs a `build:`. So the agent's start reliably
   timed out with `Service start request timed out` while the start kept running
   in the background, leaving the agent with a failure message and a service
   that was actually coming up. This repo's own `dev`, `emulator`, and `android`
   services all fall in that bucket.

3. **Untruthful results.** `handleServiceRequest` returned a hardcoded
   `{ ok: true, status: "running" }` for start and restart, discarding the fresh
   poll it had just performed. A container that started and immediately exited
   `127` still reported `running`, so the agent would proceed against a dead
   service.

## Solution

Make service control a first-class, agent-facing verb, and fix the transport so
it survives a real image pull.

### `shipit service` — the CLI

```
shipit service list                          [--json]
shipit service start   <name>  [--timeout S] [--json]
shipit service stop    <name>                [--json]
shipit service restart <name>  [--timeout S] [--json]
shipit service logs    <name>  [--lines N]   [--json]
```

Backed by the existing worker → SSE → `ServiceManager` bridge; no new trust
boundary. The shim is the sanctioned surface, matching `shipit issue`,
`shipit session`, `shipit release`, and `shipit agent`. Raw `curl` to
`localhost:9100` still works and is unchanged — it is simply no longer the
documented path.

`list` prints an aligned table (name, status, preview mode, port, agent-reachable
`url`, error) so the agent can see in one call what exists, what is running, and
where to point `curl`/`browser_navigate`. Errors are surfaced per-row rather than
being dropped.

### Action-aware timeouts

`ServiceRequestQueue.enqueue` now takes a per-request timeout, and the worker
picks one per action (`service-request-timeouts.ts`):

| Action | Timeout | Why |
|---|---|---|
| `list` | 60 s | In-memory read. |
| `logs` | 60 s | Log-store snapshot or one `docker compose logs --tail`. |
| `stop` | 120 s | `docker compose stop` — 10 s SIGTERM grace per container. |
| `start` / `restart` | 600 s | Cold `docker compose up -d --build`: image pull + build. |

The shim issues `start`/`restart` over the **unbounded** transport
(`callBroker(..., 0)`, Node `http` rather than `fetch`), for the same reason
`shipit agent run` does: undici imposes a 300 s `headersTimeout` that an
AbortController-free call cannot disable, so a 7-minute image pull would abort
with the opaque `fetch failed` even though the worker was still waiting happily.
With the worker's own 600 s bound as the real ceiling, `--timeout` lets the agent
lower it (it is clamped to the ceiling, never raised past it).

A timeout is now reported for what it is — **the start is still running** — and
names the recovery command instead of reading as a hard failure:

```
Service start request timed out after 600s.

The start is still running in the background — a cold image pull or `build:` can
take longer than this. Re-check with `shipit service list`, and read progress
with `shipit service logs <name>`.
```

### Truthful results

`handleServiceRequest` now reads the service back out of `ServiceManager` after
`pollOnce()` and returns its real `status`, `error`, `port`, and `url`. A service
that crashed on boot reports `error` with the message, and `shipit service
start` exits non-zero for it. `start` on an already-running service is reported
as a no-op rather than a restart, so the agent does not have to guess.

### `logs` as a service action

Log reading previously existed only on the orchestrator route
(`GET /api/sessions/:id/services/:name/logs`), reachable from the container but
on a different host/port than every other service call. A `logs` action was added
to the worker bridge so the whole verb set lives behind one interface — and so
`start` can point at `logs` in its timeout message without switching transports.
It resolves through `ServiceManager.snapshotLogs` (durable log store first,
`docker compose logs --tail` as the fallback) with ANSI stripped, exactly like
the HTTP route. The route is unchanged and still works.

## Key files

| File | Role |
|---|---|
| `src/server/session/agent-shim/shipit-service.ts` | The `shipit service` handlers (list/start/stop/restart/logs), table rendering, `--json`. |
| `src/server/session/agent-shim/shipit.ts` | Top-level dispatch + help for the `service` noun; rejects `create`/`delete`/`build`/`exec`/`up`/`down` with a pointer at the compose file. |
| `src/server/session/service-request-timeouts.ts` | Per-action timeout table + the timed-out-but-still-running message. |
| `src/server/session/service-request-queue.ts` | Per-request timeout support. |
| `src/server/session/session-worker.ts` | `GET /services/logs`; per-action timeouts on the bridge. |
| `src/server/orchestrator/container-session-runner.ts` | `handleServiceRequest` — the `logs` action and real post-poll status. |
| `src/server/orchestrator/service-manager.ts` | Unchanged; `startService`/`snapshotLogs`/`getServices` are the primitives all of the above call. |
| `src/server/orchestrator/prompts/skeleton.md`, `prompts/live-preview.md` | Prompt surfacing — the discoverability half of the fix. |
| `src/server/shipit-docs/compose.md`, `preview.md` | Agent-facing reference; "user clicks Start" → "the agent starts it". |

## Design notes

**Why a CLI rather than better docs on the existing curl.** Two of the three
failure modes were mechanical (the 60 s cap, the fake status), so documentation
alone would have left the agent hitting a timeout with a better sense of why. The
CLI additionally gives one place to own the unbounded transport, the clamped
`--timeout`, the actionable timeout copy, and the exit code — none of which a
documented `curl` can carry.

**Why not auto-start manual services when the agent needs them.** `manual` is a
cost signal from the compose author (this is heavy, do not pay for it on every
boot). Making it implicit would spend minutes of the user's session on a guess.
An explicit verb keeps the decision in the transcript.

**Deploy order: worker image before orchestrator.** The two halves of the fix
ship on different clocks — the prompt section is rendered by the *orchestrator*
at module load, while the `shipit` binary and `/shipit-docs/` are baked into the
*session worker image*. The skew is not symmetric. Orchestrator-first means the
agent reads "use `shipit service start`" and the old baked shim answers
`Unknown shipit subcommand: service`, pointing at `sessions.md` — a dead end that
cannot be fixed from this change, because the message comes from the old binary.
Worker-image-first is harmless: the verb works and the agent merely may not think
to reach for it. (`serviceError`'s 404 branch covers only the narrower
new-shim/old-worker case, where `/services/logs` doesn't exist yet.)

**What is deliberately not exposed.** `create`, `delete`, `build`, `exec`, `up`,
and `down` are rejected with a pointer at `docker-compose.yml`. The stack's shape
is declared in the repo and reconciled by ShipIt; the agent edits the file and
lets reconciliation happen rather than issuing imperative stack commands. This
mirrors `shipit release`'s refusal to push a tag.
