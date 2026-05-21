# 117 — Agent-Spawned ShipIt Sessions — Checklist

Tracks the multi-phase rollout described in the plan's "Phasing" section.
Each phase is shippable on its own; reverting later phases must leave
earlier phases working.

## Phase 1 — Shim + worker broker + spawn route (DONE)

The CLI surface (`shipit session create|list|view`), the worker
`/agent-ops/session/*` routes, and the orchestrator
`POST /api/sessions/:parentId/spawn` + `GET .../children[/:childId]`
endpoints are live. The agent is not yet *told* to use them — that's
Phase 2.

- [x] `/usr/local/bin/shipit` shim installed in `Dockerfile.session-worker.{dev,prod,dogfood}` (mode 0755, root-owned).
- [x] `src/server/session/agent-shim/shipit.ts` — `create`, `list`, `view`, `help` subcommands; rejection set for `delete`/`archive`/`message`/`wait`/`adopt`/`merge`/`fork`/`rename`/`switch`; `--repo`/`--owner` rejected with a helpful pointer.
- [x] `src/server/session/agent-shim/shipit.test.ts` — argument parsing, allowlist, JSON output, exit codes (38 cases).
- [x] `src/server/session/agent-ops-routes.ts` — relay routes `/agent-ops/session/create|list|view/:childId`, injecting `:parentId` from `SESSION_ID`.
- [x] `src/server/session/agent-ops-routes.test.ts` — 6 cases covering relay paths + 404 / 429 status pass-through.
- [x] `src/server/orchestrator/api-routes-session.ts` — `POST /api/sessions/:parentId/spawn`, `GET /api/sessions/:parentId/children`, `GET /api/sessions/:parentId/children/:childId`, including 404 cross-tenancy denial.
- [x] `src/server/orchestrator/services/child-sessions.ts` — `spawnChildSession`, `listSpawnedChildren`, `getSpawnedChild`, default quota constants.
- [x] `src/server/orchestrator/sessions.ts` — `setParentSession`, `findChildren`, mapped `parent_session_id` / `spawned_by_turn` columns.
- [x] `src/server/shared/database.ts` — migration 11 adds `parent_session_id`, `spawned_by_turn`, `idx_sessions_parent`.
- [x] `src/server/shared/types/domain-types.ts` — `parentSessionId`, `spawnedByTurn` on `SessionInfo`.
- [x] `src/server/shipit-docs/sessions.md` + index — agent-facing reference.
- [x] `src/server/orchestrator/integration_tests/agent-spawned-session.test.ts` — spawn happy path, linkage persistence, per-turn quota, list ordering, cross-tenancy 404 (7 cases).

## Phase 2 — Agent prompts + parent-chat surface (NOT STARTED)

Until this ships, the only way to invoke the shim is for the user to
type the exact command into chat. Phase 2 lets the agent reach for it
on its own when the user asks for "another session" / "a parallel
branch," and renders a card in the parent chat so the user sees what
happened without leaving the conversation.

- [ ] `src/server/orchestrator/agent-instructions.ts` — append the per-agent guidance from the plan:
  - Claude branch: "Use `Task` for in-turn fan-out; `shipit session create` only when the user has asked for a separate session / PR."
  - Codex branch: "`shipit session create` is your only fan-out primitive — only spawn when the user signaled they want parallel work, not as an optimization."
- [ ] `src/server/shared/types/ws-server-messages.ts` — add `session_spawned` event payload (`{ childSessionId, title, branch, spawnedAt }`).
- [ ] `src/server/orchestrator/api-routes-session.ts` (or a hook in `spawnChildSession`) — emit `session_spawned` on the parent's runner via `runner.emitMessage(...)` so the event is buffered into the turn-event log (so reconnecting viewers see the card).
- [ ] `src/server/orchestrator/ws-handlers/agent-listeners.ts` — forward `session_spawned` through the existing message-group machinery so it renders inline with surrounding agent output.
- [ ] `src/client/components/SpawnedSessionCard.tsx` — new in-chat card: title, branch, status pill (running/idle/error), "open" button that switches the active session.
- [ ] `src/client/components/MessageList.tsx` — render `SpawnedSessionCard` when a `session_spawned` event appears in the message group.
- [ ] `src/client/components/SessionList.tsx` — render spawned children indented under their parent (reuse the worktree-sibling affordance).
- [ ] `src/client/stores/session-store.ts` — surface `parentSessionId`; add a `getChildren(parentId)` selector.
- [ ] Unit tests for the new agent-instructions paragraph (assert both branches emit the right text).
- [ ] Component tests for `SpawnedSessionCard` (status transitions, open button, missing-child fallback).
- [ ] Integration coverage: agent emits a tool call running `shipit session create`; parent's chat receives a `session_spawned` event; sidebar SSE includes the child grouped under the parent.

## Phase 3 — `message`, `wait`, `archive` (NOT STARTED)

Once telemetry shows the agent uses Phase 1 reliably (i.e. spawn rate
roughly tracks user-prompted parallel work, no spam), wire the
coordination subcommands. These three add the "agent can drive a child
to completion without the user babysitting it" pattern.

- [ ] Drop `message`, `wait`, `archive` from `REJECTED_SESSION_SUBCOMMANDS` in `shipit.ts`; add their handlers.
- [ ] `shipit session message <id> -m "TEXT" [--json]` — `POST /agent-ops/session/message/:childId` → `POST /api/sessions/:parentId/children/:childId/message`. Returns `{ queuePosition }`.
- [ ] `shipit session wait <id> [--timeout SECONDS] [--json]` — `GET /agent-ops/session/wait/:childId?timeout=N` → long-poll `GET /api/sessions/:parentId/children/:childId?wait=true&timeout=N`. Default 300s, cap 3600s. Non-zero exit when the timeout fires.
- [ ] `shipit session archive <id>` — `POST /agent-ops/session/archive/:childId` → `POST /api/sessions/:parentId/children/:childId/archive`. Only archives children the parent itself spawned; refuses when the child is running.
- [ ] `services/child-sessions.ts` — add `sendChildMessage`, `waitForChildIdle`, `archiveChild`; preserve the cross-tenancy 404 contract.
- [ ] Extend `ChildSessionView` with `latestAssistantMessage` and `prUrl` now that the wait/view surface has a reason to consume them; plumb through a `ChatHistoryManager` "latest assistant text" projection (or accept the simple full-history scan).
- [ ] Env-var overrides for the quota constants — `MAX_SPAWNED_SESSIONS_PER_PARENT`, `MAX_SPAWNED_SESSIONS_PER_TURN`. Read once at process start, fall back to the existing defaults.
- [ ] Unit tests for the three new shim handlers (happy path, 404, 429 surfacing, timeout exit).
- [ ] Integration tests: message enqueues on the child runner; wait blocks until `running=false && queueLength=0`; archive moves the child to archived and refuses when it's running.

## Phase 4 — Cross-repo spawns *(OPTIONAL)*

Per-account setting that allows `--repo <owner/name>` on
`shipit session create`. Significant trust-model work (the spawned
child needs the right GitHub auth + credential store), so deferred
until Phase 2/3 have shipped and there's user demand.

- [ ] Account-level toggle (`allow_cross_repo_spawn`) plus an admin UI affordance.
- [ ] Drop the `--repo` / `--owner` rejection in the shim when the toggle is on (still rejected by default).
- [ ] Worker → orchestrator route accepts `repoUrl` and validates that the caller's GitHub auth covers the target repo.
- [ ] Documentation in `shipit-docs/sessions.md` explaining the new flag and its constraints.

## Cross-cutting follow-ups

These don't block any phase but should be picked up alongside the
relevant work.

- [ ] Surface a `shipit session create` failure (e.g., quota 429) inline in the parent's chat instead of just on stderr — likely Phase 2 alongside `SpawnedSessionCard`.
- [ ] Telemetry: count `shipit session create` invocations per session and per turn, broken down by agent id, so the Phase 3 "is the agent using this responsibly?" question is answerable.
- [ ] Decide whether spawned-children quota should count archived children (today: no — only active). Document the decision either way.
- [ ] Consider grand-children quotas (depth limit) before we get telemetry of agents spawning more than two levels deep.
- [ ] Add a "child spawned this session" indicator to the parent's PR card when the child opens a PR, so the user can review both side-by-side without manually correlating branches.
