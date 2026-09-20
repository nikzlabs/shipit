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
- [x] `src/server/session/agent-shim/shipit.ts` — `create`, `list`, `view`, `help` subcommands; rejection set for `delete`/`archive`/`message`/`wait`/`adopt`/`merge`/`fork`/`rename`/`switch`; `--repo`/`--owner` rejected with a helpful pointer. (`message` and `wait` left the rejection set in Phase 3; `archive` returned to it.)
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

## Phase 2 — Agent prompts + parent-chat surface (DONE)

The agent now learns when to reach for `shipit session create` (per-agent
guidance in the system prompt), and the parent's chat renders a
`SpawnedSessionCard` inline at the moment of the spawn. The sidebar groups
spawned children indented under their parent.

- [x] `src/server/orchestrator/agent-instructions.ts` — appends the per-agent "Parallel sessions" guidance:
  - Claude branch: "Use `Task` for in-turn fan-out; `shipit session create` only when the user has asked for a separate session / PR."
  - Codex branch: "`shipit session create` is your only fan-out primitive — only spawn when the user signaled they want parallel work, not as an optimization."
- [x] `src/server/shared/types/ws-server-messages.ts` — adds `WsSessionSpawned` (`{ sessionId, childSessionId, title, branch?, spawnedAt }`).
- [x] `src/server/orchestrator/api-routes-session.ts` — after `spawnChildSession` returns, looks up the parent's runner in the registry and emits `session_spawned` via `runner.emitMessage(...)` so every attached viewer sees it and it lands in the turn-event buffer for reconnecting viewers.
- [x] `src/client/components/SpawnedSessionCard.tsx` — new in-chat card with title, branch, status pill (running/idle/archived/missing), "Open" button.
- [x] `src/client/components/MessageList.tsx` — renders `SpawnedSessionCard` when an assistant message carries `spawnedSession` metadata (skipped past the bubble-rendering path).
- [x] `src/client/hooks/message-handlers/session-spawned.ts` — new handler that converts the `session_spawned` WS event into a ChatMessage with `spawnedSession` populated; registered in `message-handlers/index.ts`.
- [x] `src/client/components/SessionSidebar.tsx` — renders spawned children indented under their parent inside the existing RepoGroup; falls back to top-level rendering when the parent isn't visible in the same repo group (archived, cross-repo, etc.).
- [x] `src/client/stores/session-store.ts` — adds a `getChildren(parentSessionId)` selector. `parentSessionId` was already plumbed onto `SessionInfo` in Phase 1.
- [x] Unit tests for the agent-instructions per-agent text (Claude branch contrasts Task vs. shipit; Codex branch says "only fan-out primitive"; baseline no-options rendering still omits the section).
- [x] Component tests for `SpawnedSessionCard` (idle/running/archived/missing-child statuses, Open button click handler, branch omission, disabled Open when missing).
- [x] Integration coverage: `POST /api/sessions/:parentId/spawn` emits a `session_spawned` event on the parent's WS — verified in `agent-spawned-session.test.ts`.

## Phase 3 — `message`, `wait` (DONE)

The coordination subcommands are live: spawn → message follow-ups → wait.
`archive` shipped here too and was **removed** afterwards; see *The parent
never archives a child* in `plan.md`.

- [x] Drop `message` and `wait` from `REJECTED_SESSION_SUBCOMMANDS` in `shipit.ts`; add their handlers.
- [x] `shipit session message <id> -m "TEXT" [--json]` — `POST /agent-ops/session/message/:childId` → `POST /api/sessions/:parentId/children/:childId/message`. Returns `{ queuePosition, enqueued }`.
- [x] `shipit session wait <id> [--timeout SECONDS] [--json]` — `GET /agent-ops/session/wait/:childId?timeout=N` → long-poll `GET /api/sessions/:parentId/children/:childId?wait=true&timeout=N`. Default 300s, cap 3600s. Non-zero exit when the timeout fires.
- [x] ~~`shipit session archive <id>`~~ — **removed.** The shim refuses it and names the UI; `POST /agent-ops/session/archive/:childId` and `POST /api/sessions/:parentId/children/:childId/archive` are deleted, as is the `assertArchivableChild` guard. Archiving is the user's action, and a child is archived with its parent.
- [x] `services/child-sessions.ts` — added `sendChildMessage` and `waitForChildIdle`; preserve the cross-tenancy 404 contract via `assertChildOfParent`.
- [x] Extended `ChildSessionView` with `latestAssistantMessage` and `prUrl` via the new `ChildViewProjections` plumbing. `ChatHistoryManager.loadLatestAssistantText()` is the read-only projection for the latest assistant text; `PrStatusPoller.getStatus()` provides the PR URL.
- [x] Env-var overrides for the quota constants — `MAX_SPAWNED_SESSIONS_PER_PARENT`, `MAX_SPAWNED_SESSIONS_PER_TURN`. Read once at module init; bad values (non-integer or ≤ 0) log a warning and fall back to the compile-time default.
- [x] Unit tests for the three new shim handlers (happy path, 404, 409/429 surfacing, timeout exit).
- [x] Integration tests: message enqueues on the child runner; wait blocks until `running=false && queueLength=0` (both the "already idle" fast path and the "register listener then finish" path).

## Agent/model selection — validation + view exposure (DONE)

Hardens the already-shipped `--agent`/`--model` spawn flags: validate before
disk work, derive backend from model, and surface the resolved agent/model on
`view`.

- [x] `services/child-sessions.ts` — `spawnChildSession` validates `--agent` against `KNOWN_AGENT_IDS`, derives the agent from `--model` when `--agent` is omitted (`agentIdForModel`), and rejects a cross-backend `agent`+`model` mismatch — all before the claim/disk work. Unlisted/versioned model ids pass through (CLI forwards `--model` as-is).
- [x] `services/child-sessions.ts` — `ChildSessionView` gains `agent`/`model`; `buildChildView` populates them from the child's `SessionInfo`.
- [x] `shared/agent-registry.ts` — exports `KNOWN_AGENT_IDS` (derived from `AGENT_DEFS`) for runtime agent-id validation.
- [x] `agent-shim/shipit-session.ts` — `shipit session view` plain-text output renders `agent:`/`model:` lines (omitted when unset).
- [x] `shipit-docs/sessions.md` — documents model-as-source-of-truth derivation, fail-fast validation, and the new `view` fields.
- [x] Tests: shim view rendering (`shipit.test.ts`); spawn validation, model→agent derivation, and `view` agent/model exposure (`agent-spawned-session.test.ts`).

## Phase 4 — Cross-repo spawns *(OPTIONAL — DEFERRED)*

Per-account setting that allows `--repo <owner/name>` on
`shipit session create`. Significant trust-model work (the spawned
child needs the right GitHub auth + credential store), so deferred
until there's user demand. Not blocking 117 as a whole — the doc is
marked `done` with Phase 4 explicitly carved out as optional.

- [ ] Account-level toggle (`allow_cross_repo_spawn`) plus an admin UI affordance.
- [ ] Drop the `--repo` / `--owner` rejection in the shim when the toggle is on (still rejected by default).
- [ ] Worker → orchestrator route accepts `repoUrl` and validates that the caller's GitHub auth covers the target repo.
- [ ] Documentation in `shipit-docs/sessions.md` explaining the new flag and its constraints.

## Cross-cutting follow-ups

The two load-bearing items are done. The remaining three are explicitly
out of scope for 117 — see the rationale beside each.

- [x] Surface a `shipit session create` failure (e.g., quota 429) inline in the parent's chat instead of just on stderr. Implemented as the `session_spawn_failed` WS event + `SpawnFailedCard`. Emitted on the parent runner alongside the existing `session_spawned` event so reconnecting viewers see it via the turn-event buffer.
- [x] Telemetry: count `shipit session create` invocations per session and per turn, broken down by agent id. Implemented as `services/spawn-telemetry.ts` — a `[spawn-telemetry]` structured log line per invocation plus in-process counters dimensioned by outcome / agent / parent / turn (queryable via `getSpawnTelemetrySnapshot()`).
- [ ] ~~Decide whether spawned-children quota should count archived children~~ — current behavior (active-only) is intentional; archived children don't consume containers, so the capacity argument doesn't apply. Not a blocker.
- [ ] ~~Grand-children quotas (depth limit)~~ — the per-parent + global container caps bound runaway depth in practice. Revisit if telemetry shows >2-level chains in the wild.
- [ ] ~~"Child spawned this session" indicator on the parent's PR card~~ — nice-to-have visual polish, doesn't block the feature.

## The parent never archives a child (DONE)

Removing the agent-facing archive API after a parent archived a child that had
merely paused to ask the user a question. Rationale and source citations in
`plan.md` → *The parent never archives a child*.

- [x] `agent-shim/shipit.ts` — refuse `shipit session archive` before dispatch, with a message naming the UI; drop the handler, the `HELP` line, and the `--help` path.
- [x] `agent-shim/shipit-session.ts` — delete `handleSessionArchive`.
- [x] `session/agent-ops-routes.ts` — delete the `/agent-ops/session/archive/:childId` relay.
- [x] `orchestrator/api-routes-session-spawn.ts` — delete `POST /api/sessions/:parentId/children/:childId/archive` and its now-dead imports.
- [x] `orchestrator/services/child-sessions.ts` — delete `assertArchivableChild` and its `session.ts` re-export.
- [x] Tests: replace the shim's archive suite with one refusal test (proven red without the branch); delete the worker-relay, container-guard-allowlist, and integration-route tests for the removed endpoints.
- [x] `shipit-docs/sessions.md` — drop `archive` from the reference table and the coordination example; add *You do not archive a child*; rewrite the `wait`→`archive` and quota guidance; note that `idle` includes a child paused on a question.
- [x] All five agent `system-prompt.md` variants — one line: a parent never archives a child, and a child's chat is a surface the parent cannot read.
- [x] The user's own archive/unarchive in the client UI is untouched.
