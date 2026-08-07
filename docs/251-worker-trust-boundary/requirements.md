# Requirements — session-worker trust boundary (planning#313)

Source: planning#313, filed after a cross-agent review of PR #1975 (docs/250) surfaced it.
The finding is pre-existing and unrelated to that change; it affects the whole
`/agent-ops/*` surface.

Companion design: [plan.md](./plan.md).

## The problem, in the reporter's terms

Every agent container joins the shared orchestrator bridge network, each session
worker binds `0.0.0.0:9100`, the egress sidecar explicitly permits the local
bridge subnet, and `/agent-ops/*` has no authentication. So session A — which can
learn session B's id, e.g. because B is a child returned by `shipit session list`
— can POST directly to `http://agent-<first-12-of-B>:9100/agent-ops/...`. B's
worker accepts it and relays it to the orchestrator through B's own
`OrchestratorClient`, which injects **B's** session id. The orchestrator's
container-origin guard then sees B's worker IP and a request targeting B, so the
own-session check passes.

The guard in `api-container-guard.ts` is sound for agent→orchestrator traffic.
The hole is agent→**other agent's worker**, where the worker is the deputy.

## Requirements

1. A session container MUST NOT be able to invoke `/agent-ops/*` on another
   session's worker. This closes the confused-deputy path for every route in that
   group, including the destructive ones the report names:
   `POST /agent-ops/branch/reset-to-base` (moves another session's branch),
   `POST /agent-ops/session/notify-on-merge-self`,
   `POST /agent-ops/voice/note` and `POST /agent-ops/bug/report` (inject content
   into another session's transcript), and `POST /agent-ops/session/rename`
   (retitle another session).

2. The fix MUST be at the **worker boundary**, not per route. Per the report:
   "Per-route checks can't help — the worker is already speaking for its own
   session by the time the orchestrator sees the request." Either a per-session
   shared secret the orchestrator injects at container creation and the worker
   requires, or binding/restricting the agent-ops listener to something only that
   container's agent can reach.

3. A session's own agent MUST keep its existing access to its own worker. The
   `gh` / `shipit` shims, the `shipit` MCP bridge, and the permission/ask bridges
   all go through `/agent-ops/*` and must be unaffected.

4. The orchestrator MUST keep full access to every worker it manages, including
   workers it adopts after an orchestrator restart and workers created by a
   previous deploy.

5. Rolling out the fix MUST NOT be able to brick a live session. A version skew
   between the orchestrator and a session-worker image is a normal state
   (containers outlive deploys — docs/113), so a skew must degrade to today's
   behavior rather than to a session that can no longer be driven.

## Decisions taken while implementing

Recorded here rather than left implicit, since each goes past the literal ask.

- **D1 — the guard covers the whole worker surface, not only `/agent-ops/*`.**
  Requirement 2 asks for a boundary rather than per-route checks, and once the
  boundary exists it would be arbitrary to let the *other* cross-container routes
  through. They are the same class and strictly more severe: on another session's
  worker, `POST /terminal/start` + `/terminal/input` is command execution in that
  container, `POST /agent/message` injects a turn into its running agent, and
  `PUT /secrets` rewrites the env its next agent spawn inherits. See plan.md
  §"Why the whole surface".

- **D2 — requirement 1 is satisfied without depending on the token.**
  `/agent-ops/*` (and `/present-files/*`) are pinned to loopback and are not
  reachable with a valid token at all, so the reported hole closes even in the
  skew case requirement 5 covers.

- **D3 — a worker with no token configured leaves its orchestrator-facing routes
  open**, logging a warning. This is requirement 5: container env is written by
  the orchestrator, so an older orchestrator running a newer worker image would
  set no token, and failing closed there would 403 every orchestrator call.
  Failing open is exactly the pre-fix behavior, so it is a strict
  non-regression — and D2 means requirement 1 still holds there.

- **D4 — local/dogfood mode is documented, not gated.** The report also notes
  that the orchestrator's container guard is deliberately inert without a
  container manager, so an in-process local agent could POST to any session id.
  That is true, and it is left as-is: in `RUNTIME_MODE=local` the agent runs in
  the orchestrator's own process and filesystem (it can read and write the
  SQLite database directly), so an HTTP-layer gate would not be a boundary. Local
  mode also has no worker and no `/agent-ops` host at all
  (`local-agent-mcp.ts:LOCAL_SHIPIT_BRIDGE`), so requirement 1 does not arise
  there. See plan.md §"Local mode".

## Open questions

None. D4 is a decision, not a deferral — if the reporter wants local-mode
containment treated as its own work item, it needs a threat model for an agent
that shares the orchestrator's process, which is a different piece of work from
this one.
