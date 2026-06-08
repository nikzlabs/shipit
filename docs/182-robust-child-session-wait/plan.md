---
description: Make a parent agent's wait on spawned child sessions resilient to connection resets, orchestrator restarts, and stuck state so one parent can autonomously orchestrate a fleet of children without stalling.
---

# 182 — Robust child-session orchestration (resilient `shipit session wait`)

## Goal

A parent agent should be able to spawn N child sessions and orchestrate them to
completion **fully autonomously**, without its coordination loop ever stalling
or falsely failing because of transport flakiness. Today `shipit session wait`
works on the happy path, but it leans on a single long-lived HTTP connection and
a one-shot in-memory event. In practice that connection gets reset (proxy/NAT
idle timeouts, orchestrator redeploys, half-open TCP), and the wait surfaces a
non-zero exit that is indistinguishable from a real timeout — so the parent
either gives up or re-issues blindly. We want the wait to be **level-triggered,
resumable, and self-correcting**, and to report **distinguishable outcomes** so
the parent can react correctly.

This is squarely inside the product model: chat is the input surface, the agent
is the actor (CLAUDE.md §5). Nothing here adds a user-facing shell affordance —
it hardens an existing agent primitive.

## How it works today (and where it breaks)

The full chain for `shipit session wait <id> --timeout N`:

1. **Shim** `handleSessionWait` (`agent-shim/shipit.ts:598`) does a **single**
   `GET /agent-ops/session/wait/:childId?timeout=N` via `callBroker`
   (`shipit.ts:197`). `callBroker` is one `fetch()` with **no timeout and no
   retry**; a thrown fetch becomes `status: 0` → `fail(... exit 1)`.
2. **Worker** relays it (`agent-ops-routes.ts:376`) through
   `OrchestratorClient.request` (`orchestrator-client.ts:111`) to
   `GET /api/sessions/:parent/children/:child?wait=true&timeout=N`. `request`
   is also a single `fetch()` per base URL; it only advances to a fallback host
   on a *thrown* connection error, and then re-runs the **entire timeout**
   against the next host — no backoff, no overall cap.
3. **Orchestrator** route (`api-routes-session.ts:760`) calls
   `waitForChildIdle` (`child-sessions.ts:669`), which holds the HTTP request
   open for **up to one hour** and resolves on the child runner's in-memory
   `"idle"` / `"disposed"` events (fast-path checks current state first).

### Concrete flakiness vectors

1. **One long-lived connection held open up to 1h, across three hops.** It only
   survives if every TCP leg stays alive for the whole wait. Any reverse-proxy
   or NAT idle timeout, any orchestrator redeploy, or a TCP RST tears it down.
   `fetch` throws and the shim exits 1 — **indistinguishable from a genuine
   timeout**.
2. **No retries and no resumption anywhere in the chain.** A single reset is
   terminal. The agent has to know to re-run, and even then…
3. **Outcomes are conflated into exit 1.** Timed-out (`idle:false`), HTTP 404
   (child gone / wrong parent), and transport error (`status:0`) all collapse
   to exit 1. The parent can't tell "retry me" from "child is gone" from "child
   genuinely still working" from "child errored." Autonomous scripting on top
   of this is guesswork.
4. **Wait resolves on a one-shot in-memory edge.** `waitForChildIdle` registers
   `runner.on("idle")`. If the orchestrator restarts mid-wait, the listener and
   the pending promise vanish; the child container keeps running, but the
   parent's wait dies with **no way to resume** except re-issuing from the shim
   (which it doesn't do).
5. **Headless child runners are never reconciled — the worst failure.**
   `runReconcileCheck` (`container-session-runner.ts:610`) bails when
   `_viewerCount === 0` (line 615). A spawned child has **no viewer** (the user
   isn't watching it), so the safety net that resets a stuck `running=true`
   (`verifyRunningState`, line 1640) **never runs for exactly the sessions this
   feature targets**. If the child's `agent_result` SSE event is dropped,
   `runner.running` stays `true` forever, `"idle"` never fires, and the parent
   waits the **entire** timeout for a child that is actually done.
6. **No multi-child wait.** Orchestrating N children means N serial or parallel
   single-waits, each independently fragile. There is no `wait --any` /
   `wait --all`, so "react to whichever child finishes first" is not
   expressible.
7. **No heartbeat on the long-poll.** A silently black-holed (half-open) socket
   isn't noticed until an OS-level timeout (minutes). The SSE client already
   solves this with keepalive + idle-timeout (`sse-client.ts:35`); the wait path
   doesn't reuse it.

## Design

North star: **only genuine terminal conditions end a wait** — child idle, child
errored, child archived/disposed, or the user's overall deadline. Every
transport hiccup is absorbed and retried beneath the agent.

### A. Level-triggered, durable readiness (not edge-triggered events)

Make "is this child ready?" a function of **re-derivable state** that any fresh
request can compute, rather than a transient event you must be listening for at
the right instant:

- persisted session status from `SessionManager` (running / idle / error /
  archived), plus
- a live worker `/agent/status` probe to catch a stuck `running` flag.

The in-memory `"idle"` event stays — but only as a **fast-wakeup optimization**,
not the source of truth. After an orchestrator restart, a brand-new long-poll
re-derives readiness from scratch, so a restart can no longer strand a wait.

### B. Bounded server segments + a shim-driven resumable loop

Split the contract so the *server* long-poll has a bounded **segment** duration
(default ~25–30s) independent of the user's `--timeout`. When a segment elapses
with the child still running, the route returns **HTTP 200 with
`{ pending: true }`** ("poll again"), not a held-open hour-long socket.

The **shim** owns the overall deadline. `handleSessionWait` loops: issue a
segment, and on `pending` re-issue until the child is idle/terminal or the
overall `--timeout` is exhausted. Why this is the core of the fix:

- Each network leg is short, so it's far less exposed to idle-timeout / NAT /
  proxy resets.
- Resume is transparent: a dropped or reset segment is just the next loop
  iteration. An orchestrator redeploy costs one retried segment, not the wait.
- Pairing the ~25–30s segment with keepalive comments gives a natural heartbeat
  for detecting half-open sockets quickly.

Back-compat: keep `?wait=true&timeout=N` working for any caller that doesn't pass
the new `&segment=N`; absent a segment, behave as the legacy single long-poll.

### C. Retry-with-backoff inside the shim (transport failures are not outcomes)

- `callBroker` and `OrchestratorClient.request` get an **AbortController-based
  per-request timeout** (~segment + margin) so a black-holed socket fails fast
  instead of hanging.
- The shim's wait loop classifies `status:0`, `502`, and abort/connection errors
  as **transient** → exponential backoff retry (capped), bounded by the overall
  `--timeout`. They are **never** surfaced as a terminal failure.

The result: a single `shipit session wait` call is the robust unit. The parent
agent never has to script its own retry loop.

### D. Distinguishable, machine-readable outcomes

The wait result (always in `--json`, mirrored by distinct exit codes) separates:

| Outcome | exit | meaning |
|---|---|---|
| `idle` | 0 | child finished its turn(s), queue empty |
| `error` | 3 | child's last turn errored — parent must NOT treat as success |
| `archived` / `disposed` | 0 | child torn down; nothing left to wait for |
| `timed-out` | 1 | overall deadline hit while child still running |

Transient network failure is deliberately **not** an outcome — it's swallowed by
(C). It only ever manifests as `timed-out` if retries consume the whole
deadline, and the JSON carries a `lastTransportError` note so the parent can
distinguish "child is slow" from "we never reached the orchestrator."

### E. Reconcile headless child runners (eliminate the infinite false wait)

Fix vector #5 directly. Two complementary moves:

1. On each long-poll **segment**, if the runner still reports `running`, the
   readiness check calls `verifyRunningState()` (probe worker `/agent/status`)
   before deciding "still running." A stuck flag is then corrected within one
   segment instead of never.
2. Allow `runReconcileCheck` to run for **viewerless runners that have a parent
   linkage** (i.e. spawned children under autonomous orchestration), since
   that's precisely the case the `_viewerCount === 0` short-circuit was excluding
   and the case this feature needs covered.

This is the single highest-impact change: it removes the worst-case failure
(parent waiting the full timeout on a child that's actually done).

### F. Multi-child wait primitive

Add `shipit session wait <id...> [--any | --all]`:

- `--any` — resolve as soon as the **first** listed child is idle/terminal;
  report which one (so the parent can act on it, then wait on the rest).
- `--all` — resolve when **every** listed child is idle/terminal.

v1 implements this **shim-side** as a fan-out over the resilient single-wait
(parallel segment loops sharing one overall `--timeout`), so it inherits all of
A–D for free with no new server endpoint. This lets a parent orchestrate a fleet
with one call and react to whoever finishes first.

### G. (Future) push-based completion, not just polling

Optionally, surface a child's idle/terminal transition into the **parent's**
runner as a `child_session_idle` event so the parent agent is "woken" on its next
turn rather than holding a wait at all. Lower priority — A–F already deliver the
autonomy ask — but it's the natural end-state and is noted so the polling design
doesn't paint us into a corner. Persisted as a transcript card per the
"persist, don't just emit" rule (CLAUDE.md → *Chat transcript content MUST be
persisted*).

## Key files

| Concern | File |
|---|---|
| Shim wait loop, backoff, exit codes, multi-id fan-out | `src/server/session/agent-shim/shipit.ts` (`handleSessionWait`, `callBroker`) |
| Worker relay — pass `segment` through | `src/server/session/agent-ops-routes.ts` (wait route) |
| Per-request timeout + transient classification | `src/server/session/orchestrator-client.ts` (`request`) |
| Bounded segment + `pending`/`error`/terminal response shape | `src/server/orchestrator/api-routes-session.ts` (children wait route) |
| Durable readiness, segment timeout, `verifyRunningState` probe, terminal/error states | `src/server/orchestrator/services/child-sessions.ts` (`waitForChildIdle`, `isRunnerIdle`) |
| Headless reconciler fix | `src/server/orchestrator/container-session-runner.ts` (`runReconcileCheck`, `verifyRunningState`) |
| Idle emission contract | `src/server/orchestrator/session-runner.ts` (`onAgentFinished`) |
| Agent-facing docs (new semantics, exit codes, multi-id) | `src/server/shipit-docs/sessions.md` |

## Testing

- **Segment loop / resume**: a wait spanning multiple `pending` segments resolves
  on eventual idle; a simulated mid-wait orchestrator "restart" (drop the
  in-memory listener, force a fresh segment) still resolves from durable state.
- **Transient retry**: injected `status:0` / 502 on the first K segments is
  swallowed and the wait still resolves; retries that consume the deadline
  surface `timed-out` with `lastTransportError`.
- **Outcome mapping**: idle → exit 0, child error → exit 3, archived → exit 0,
  deadline → exit 1; `--json` fields match.
- **Headless reconcile**: a child runner with `running=true` but a worker
  reporting idle and **zero viewers** is reconciled and the wait resolves (the
  regression test for vector #5).
- **Multi-child**: `--any` returns the first finisher; `--all` waits for the
  slowest; overall `--timeout` is shared, not per-child.
- Round-trip tests for any new `pending`/outcome fields, following the existing
  `shipit.test.ts` wait coverage.

## Out of scope

- Changing *how* children are spawned or quota'd (docs/117, docs/149).
- The push-based design (G) beyond noting the seam.
- Any new user-facing UI; the parent's chat already renders `SpawnedSessionCard`.
