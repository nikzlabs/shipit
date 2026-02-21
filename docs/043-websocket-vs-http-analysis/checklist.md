# WebSocket → HTTP Migration Checklist

## Phase 0: Infrastructure

- [ ] Create shared service layer that extracts business logic from `HandlerContext`-dependent WS handlers into plain functions that accept explicit parameters (session ID, managers)
- [ ] Add Fastify route prefix (`/api`) and JSON schema validation plugin
- [ ] Add session ID resolution middleware (look up session dir from ID, return 404 if missing)
- [ ] ~~Auth strategy~~ — **Decision: no auth.** Same as WebSocket today. ShipIt is single-user/container-per-user; security relies on container/network isolation. No tokens, cookies, or middleware needed.
- [ ] Add `fetch`-based API client hook on the client (`useApi` or similar) with error handling
- [ ] Add `GET /api/bootstrap` endpoint that returns all initial data in one response (sessions, agents, templates, GitHub status, global settings) — replaces the 5 sequential WS messages sent on connect

## Phase 1: Tier 1 — Pure data reads (GET endpoints)

### Combined endpoints (co-occurring requests)

- [ ] `GET /api/bootstrap` — (Phase 0) returns `{ sessions, agents, templates, githubStatus, settings }` — replaces `list_sessions` + `list_agents` + `list_templates` + `github_get_status` + `get_global_settings`
- [ ] `GET /api/sessions/:id/deploy/setup` — returns `{ targets, projectSettings }` — replaces `list_deploy_targets` + `get_project_settings` (called together from `handleDeployTabSelected` and `handleDeployOpen`)
- [ ] `GET /api/sessions/:id/workspace-state` — returns `{ gitLog, fileTree }` — replaces `get_git_log` + `get_file_tree` (called together after `reject_changes_complete`)

### Session-scoped reads

- [ ] `GET /api/sessions/:id/files` — extract from `get_file_tree`
- [ ] `GET /api/sessions/:id/files/*path` — extract from `get_file_content` (optional query param `tree=true` to include file tree in response — for post-commit refresh when files tab is active)
- [ ] `GET /api/sessions/:id/docs` — extract from `list_docs`
- [ ] `GET /api/sessions/:id/docs/*path` — extract from `get_doc`
- [ ] `GET /api/sessions/:id/git/log` — extract from `get_git_log`
- [ ] `GET /api/sessions/:id/git/diff` — extract from `get_turn_diff` (query params: `from`, `to`)
- [ ] `GET /api/sessions/:id/git/remotes` — extract from `github_get_remotes`
- [ ] `GET /api/sessions/:id/git/branches` — extract from `github_list_branches`
- [ ] `GET /api/sessions/:id/status` — extract from `get_session_status`
- [ ] `GET /api/sessions/:id/history` — read-only portion of `get_chat_history` (messages + git log + file tree, without session activation side effect)
- [ ] `GET /api/sessions/:id/deploy/history` — extract from `get_deploy_history`
- [ ] `GET /api/sessions/:id/usage` — extract from `get_usage_stats`
- [ ] `GET /api/sessions/:id/pr/status` — extract from `get_pr_status`
- [ ] `GET /api/sessions/:id/threads` — extract from `list_threads`
- [ ] `GET /api/sessions/:id/worktrees` — extract from `list_worktrees`

### Global reads (no session context needed)

- [ ] `GET /api/features` — extract from `list_features`
- [ ] `GET /api/github/repos` — extract from `github_search_repos` (query param: `q`)

### Client updates for Phase 1

- [ ] Create `useApi` hook wrapping `fetch()` with JSON parsing, error handling, and base URL
- [ ] Update `useConnectionSync` to call `GET /api/bootstrap` on mount (before WS connects) instead of sending 5 separate WS messages
- [ ] Update `useAppCallbacks` to call HTTP endpoints for all Tier 1 reads
- [ ] Update `useMessageHandler` to stop handling response types that are now HTTP (e.g., `file_tree`, `file_content`, `doc_list`, etc.)
- [ ] Remove corresponding `case` entries from `src/server/index.ts` switch dispatcher
- [ ] Remove unused WS message types from `WsClientMessage` / `WsServerMessage` unions in `src/server/types.ts`

### Tests for Phase 1

- [ ] Add HTTP route tests using Fastify `app.inject()` for each new GET endpoint (happy path + 404/error)
- [ ] Update or remove integration tests that tested the old WS message flow for migrated endpoints
- [ ] Add client hook tests for `useApi`

## Phase 2: Tier 2 — Mutations (POST/PATCH/DELETE endpoints)

### Session management

- [ ] `PATCH /api/sessions/:id` — extract from `rename_session` (body: `{ title }`)
- [ ] `DELETE /api/sessions/:id` — extract from `archive_session`

### Settings

- [ ] `POST /api/settings/git-identity` — extract from `set_git_identity`
- [ ] `PUT /api/settings` — extract from `save_global_settings`
- [ ] `POST /api/settings/agent` — extract from `set_agent`
- [ ] `POST /api/agents/:id/env` — extract from `set_agent_env`

### Auth

- [ ] `POST /api/auth/api-key` — extract from `set_api_key`
- [ ] `DELETE /api/auth/api-key` — extract from `clear_api_key`
- [ ] `POST /api/github/token` — extract from `github_set_token`
- [ ] `POST /api/github/logout` — extract from `github_logout`

### Git operations

- [ ] `POST /api/sessions/:id/git/remotes` — extract from `github_set_remote`
- [ ] `POST /api/sessions/:id/git/push` — extract from `github_push`
- [ ] `POST /api/sessions/:id/git/pull` — extract from `github_pull`
- [ ] `POST /api/sessions/:id/git/rollback` — extract from `rollback`
- [ ] `POST /api/sessions/:id/git/reject` — extract from `reject_changes`

### PR operations

- [ ] `POST /api/sessions/:id/pr` — extract from `github_create_pr`
- [ ] `POST /api/sessions/:id/pr/merge` — extract from `merge_pr`

### Deploy operations

- [ ] `POST /api/deploy/:targetId/config` — extract from `deploy_configure`
- [ ] `DELETE /api/deploy/:targetId/config` — extract from `delete_deploy_config`

### Other mutations

- [ ] `POST /api/sessions/:id/threads/checkpoint` — extract from `create_checkpoint`
- [ ] `POST /api/sessions/:id/template` — extract from `apply_template`
- [ ] `POST /api/reset` — extract from `full_reset`
- [ ] `POST /api/sessions/:id/preview-errors` — extract from `preview_error`

### Client updates for Phase 2

- [ ] Update `useAppCallbacks` to call HTTP endpoints for all Tier 2 mutations
- [ ] Replace WS send-then-listen patterns with `fetch()` calls that return responses directly
- [ ] Remove corresponding `case` entries from switch dispatcher
- [ ] Remove unused WS message types from type unions

### Tests for Phase 2

- [ ] Add HTTP route tests for each new mutation endpoint (happy path + validation errors)
- [ ] Update or remove WS integration tests for migrated mutations

## Phase 3: Tier 3 — Borderline cases

- [ ] Split `get_chat_history` into read-only `GET /api/sessions/:id/history` (Phase 1) and WS `activate_session` message
- [ ] Evaluate `fork_session` — HTTP POST for creation, WS for subsequent push events
- [ ] Evaluate `fork_thread` / `switch_thread` — HTTP POST if push events can be deferred
- [ ] Evaluate `merge_session` — straightforward HTTP POST candidate
- [ ] Evaluate `generate_pr_description` — HTTP POST with longer timeout (LLM call)
- [ ] Evaluate `home_create_repo_with_template` — HTTP POST with polling or WS notification on completion
- [ ] Evaluate `start_auth` / `paste_auth_code` — HTTP POST for initiation, keep WS for `auth_complete` push

## Phase 4: Cleanup

- [ ] Remove all migrated message types from `WsClientMessage` / `WsServerMessage` unions
- [ ] Remove empty handler files from `src/server/ws-handlers/` if all their messages migrated
- [ ] Simplify switch dispatcher in `src/server/index.ts` to only handle streaming + push + connection-scoped messages
- [ ] Update `docs/001-websocket-protocol/plan.md` to document the new HTTP + WS split
- [ ] Update `CLAUDE.md` "How to add a new WebSocket message type" section to include HTTP endpoint guidance
- [ ] Verify no dead code remains (unused imports, unreachable handlers)
