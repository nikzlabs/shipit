# WebSocket → HTTP Migration Checklist

## Phase 0: Infrastructure

- [x] Create shared service layer that extracts business logic from `HandlerContext`-dependent WS handlers into plain functions that accept explicit parameters (session ID, managers) — `src/server/services.ts`
- [x] Add Fastify route prefix (`/api`) and JSON schema validation plugin — `src/server/api-routes.ts` with `registerApiRoutes()` + `resolveSessionDir()` middleware
- [x] Add session ID resolution middleware (look up session dir from ID, return 404 if missing) — `resolveSessionDir()` in `src/server/api-routes.ts`
- [x] ~~Auth strategy~~ — **Decision: no auth.** Same as WebSocket today. ShipIt is single-user/container-per-user; security relies on container/network isolation. No tokens, cookies, or middleware needed.
- [x] Add `fetch`-based API client hook on the client (`useApi` or similar) with error handling — `src/client/hooks/useApi.ts`
- [x] Add `GET /api/bootstrap` endpoint that returns all initial data in one response (sessions, agents, templates, GitHub status, global settings) — replaces the 5 sequential WS messages sent on connect

## Phase 1: Tier 1 — Pure data reads (GET endpoints)

### Combined endpoints (co-occurring requests)

- [x] `GET /api/bootstrap` — (Phase 0) returns `{ sessions, agents, templates, githubStatus, settings }` — replaces `list_sessions` + `list_agents` + `list_templates` + `github_get_status` + `get_global_settings`
- [x] `GET /api/sessions/:id/deploy/setup` — returns `{ targets, projectSettings }` — replaces `list_deploy_targets` + `get_project_settings` (called together from `handleDeployTabSelected` and `handleDeployOpen`)
- [x] `GET /api/sessions/:id/workspace-state` — returns `{ gitLog, fileTree }` — replaces `get_git_log` + `get_file_tree` (called together after `reject_changes_complete`)

### Session-scoped reads

- [x] `GET /api/sessions/:id/files` — extract from `get_file_tree`
- [x] `GET /api/sessions/:id/files/*path` — extract from `get_file_content` (optional query param `tree=true` to include file tree in response — for post-commit refresh when files tab is active)
- [x] `GET /api/sessions/:id/docs` — extract from `list_docs`
- [x] `GET /api/sessions/:id/docs/*path` — extract from `get_doc`
- [x] `GET /api/sessions/:id/git/log` — extract from `get_git_log`
- [x] `GET /api/sessions/:id/git/diff` — extract from `get_turn_diff` (query params: `from`, `to`)
- [x] `GET /api/sessions/:id/git/remotes` — extract from `github_get_remotes`
- [x] `GET /api/sessions/:id/git/branches` — extract from `github_list_branches`
- [x] `GET /api/sessions/:id/status` — extract from `get_session_status`
- [x] `GET /api/sessions/:id/history` — read-only portion of `get_chat_history` (messages + git log + file tree, without session activation side effect)
- [x] `GET /api/sessions/:id/deploy/history` — extract from `get_deploy_history`
- [x] `GET /api/sessions/:id/usage` — extract from `get_usage_stats`
- [x] `GET /api/sessions/:id/pr/status` — extract from `get_pr_status`
- [x] `GET /api/sessions/:id/threads` — extract from `list_threads`
- [x] `GET /api/sessions/:id/worktrees` — extract from `list_worktrees`

### Global reads (no session context needed)

- [x] `GET /api/features` — extract from `list_features`
- [x] `GET /api/github/repos` — extract from `github_search_repos` (query param: `q`)

### Client updates for Phase 1

- [x] Create `useApi` hook wrapping `fetch()` with JSON parsing, error handling, and base URL — `src/client/hooks/useApi.ts`
- [x] Update `useConnectionSync` to call `GET /api/bootstrap` on mount (before WS connects) instead of sending 5 separate WS messages
- [x] Update `useAppCallbacks` to call HTTP endpoints for all Tier 1 reads — `src/client/hooks/useAppCallbacks.ts`
- [x] Update `useMessageHandler` to stop handling response types that are now HTTP (e.g., `file_tree`, `file_content`, `doc_list`, etc.)
- [x] Remove corresponding `case` entries from `src/server/index.ts` switch dispatcher
- [x] Remove unused WS message types from `WsClientMessage` / `WsServerMessage` unions in `src/server/types.ts`

### Tests for Phase 1

- [x] Add HTTP route tests using Fastify `app.inject()` for bootstrap endpoint (7 tests) — `src/server/integration_tests/http-bootstrap.test.ts`
- [x] Add HTTP route tests for each new GET endpoint as they're migrated (23 tests) — `src/server/integration_tests/http-reads.test.ts`
- [x] Update or remove integration tests that tested the old WS message flow for migrated endpoints
- [x] Add client hook tests for `useApi` (7 tests) — `src/client/hooks/useApi.test.ts`

## Phase 2: Tier 2 — Mutations (POST/PATCH/DELETE endpoints)

### Session management

- [x] `PATCH /api/sessions/:id` — extract from `rename_session` (body: `{ title }`)
- [x] `DELETE /api/sessions/:id` — extract from `archive_session`

### Settings

- [x] `POST /api/settings/git-identity` — extract from `set_git_identity`
- [x] `PUT /api/settings` — extract from `save_global_settings`
- [x] `POST /api/settings/agent` — extract from `set_agent`
- [x] `POST /api/agents/:id/env` — extract from `set_agent_env`

### Auth

- [x] `POST /api/auth/api-key` — extract from `set_api_key`
- [x] `DELETE /api/auth/api-key` — extract from `clear_api_key`
- [x] `POST /api/github/token` — extract from `github_set_token`
- [x] `POST /api/github/logout` — extract from `github_logout`

### Git operations

- [x] `POST /api/sessions/:id/git/remotes` — extract from `github_set_remote`
- [x] `POST /api/sessions/:id/git/push` — extract from `github_push`
- [x] `POST /api/sessions/:id/git/pull` — extract from `github_pull`
- [x] `POST /api/sessions/:id/git/rollback` — extract from `rollback`
- [x] `POST /api/sessions/:id/git/reject` — extract from `reject_changes`

### PR operations

- [x] `POST /api/sessions/:id/pr` — extract from `github_create_pr`
- [x] `POST /api/sessions/:id/pr/merge` — extract from `merge_pr`

### Deploy operations

- [x] `POST /api/sessions/:id/deploy/config` — extract from `deploy_configure`
- [x] `DELETE /api/sessions/:id/deploy/config/:targetId` — extract from `delete_deploy_config`

### Other mutations

- [x] `POST /api/sessions/:id/threads/checkpoint` — extract from `create_checkpoint`
- [x] `POST /api/sessions/:id/template` — extract from `apply_template`
- [x] `POST /api/reset` — extract from `full_reset`
- [x] `POST /api/sessions/:id/preview-errors` — extract from `preview_error`

### Service layer split

- [x] Split monolithic `services.ts` into domain-specific files under `src/server/services/` — types, reads, session, git, github, deploy, settings, threads, templates, misc
- [x] Split `reads.ts` (~330 lines, 27+ functions) into the existing domain-specific service files — merge read functions into `git.ts`, `github.ts`, `deploy.ts`, `session.ts`, `settings.ts`, `threads.ts`, `templates.ts`, `misc.ts` and add a new `files.ts` for file/doc reads

### Client updates for Phase 2

- [x] Update `useAppCallbacks` to call HTTP endpoints for all Tier 2 mutations
- [x] Replace WS send-then-listen patterns with `fetch()` calls that return responses directly
- [x] Update `useMessageHandler` to remove WS response handlers for migrated types
- [x] Migrate `App.tsx` inline `send()` calls (`set_api_key`, `clear_api_key`, `set_agent_env`, `save_global_settings`) to HTTP
- [x] Migrate `useAutoFix.ts` `preview_error` from WS to HTTP
- [x] Remove corresponding `case` entries from switch dispatcher — removed 23 Phase 2 cases from `src/server/index.ts`
- [x] Remove unused WS message types from type unions — removed 24 client types and 8 server types
- [x] Remove dead WS handler functions — deleted `git-handlers.ts`, `diff-handlers.ts`, `github-handlers.ts`, `file-handlers.ts`; cleaned dead functions from 7 other handler files
- [x] Migrate `useConnectionSync.ts` `set_agent` WS send to HTTP `fetch()`

### Tests for Phase 2

- [x] Add HTTP route tests for each new mutation endpoint (34 tests) — `src/server/integration_tests/http-mutations.test.ts`
- [x] Migrate existing WS integration tests to use HTTP endpoints — all tests now use `app.inject()` for migrated message types
- [x] Remove WS switch cases for all 23 migrated Phase 2 message types from `src/server/index.ts`
- [x] Remove unused `WsClientMessage` types: 24 interfaces removed (rollback, archive_session, rename_session, set_git_identity, get_global_settings, save_global_settings, set_api_key, clear_api_key, apply_template, set_agent, set_agent_env, full_reset, reject_changes, preview_error, github_set_token, github_push, github_pull, github_set_remote, github_logout, github_create_pr, merge_pr, deploy_configure, delete_deploy_config, create_checkpoint)
- [x] Remove unused `WsServerMessage` types: 8 interfaces removed (rollback_complete, reject_changes_complete, github_pull_result, github_pr_created, merge_pr_result, deploy_config_saved, checkpoint_created, agent_env_set) — kept types still used by active code (session_renamed, github_push_result, git_identity_set, agent_list, full_reset_complete, global_settings, template_applied)

## Phase 3: Tier 3 — Borderline cases

Analysis complete — see `plan.md` Tier 3 section for detailed rationale on each verdict.

### Migrate to HTTP (6 messages)

- [ ] Split `get_chat_history` into:
  - [ ] Read-only `GET /api/sessions/:id/history` — returns `{ messages, commits, fileTree }` (move to Phase 1 since it's a pure read)
  - [ ] New WS `activate_session` message — extracted from `activateSession()` in `index.ts:739-796`, handles runner attach, file watcher, preview start, port scan, git identity check
  - [ ] Update client to call HTTP for data, then send `activate_session` over WS
- [ ] `POST /api/sessions/:id/fork` — extract from `fork_session` (body: `{ branchName, startPoint? }`, returns `{ session, parentSessionId, sessions }`)
  - [ ] Add optional WS broadcast of `session_list` to other connections after success
- [ ] `POST /api/sessions/:id/git/merge` — extract from `merge_session` (body: `{ sourceSessionId }`, returns `{ success, message, conflicts? }`)
- [ ] `POST /api/repos` — extract from `home_create_repo_with_template` (body: `{ repoName, templateId, description?, isPrivate? }`, returns `{ success, repoUrl, sessionId }`)
  - [ ] Client sends `activate_session` over WS after receiving HTTP response
- [ ] `POST /api/sessions/:id/pr/description` — extract from `generate_pr_description` (returns `{ description }`, 30s timeout)
- [ ] `POST /api/auth/start` — extract from `start_auth` (returns 202 Accepted)
- [ ] `POST /api/auth/code` — extract from `paste_auth_code` (body: `{ code }`, returns 200 or 400)
  - [ ] Keep `auth_complete` as WS broadcast (no change needed)

### Keep on WS (2 messages)

- [x] `fork_thread` — keep on WS (git reset + preview restart produce push events entangled with the connection's push channel; splitting trigger from effects adds coordination complexity)
- [x] `switch_thread` — keep on WS (same reasoning as `fork_thread`)

## Phase 4: Cleanup

- [ ] Remove all migrated message types from `WsClientMessage` / `WsServerMessage` unions
- [ ] Remove empty handler files from `src/server/ws-handlers/` if all their messages migrated
- [ ] Simplify switch dispatcher in `src/server/index.ts` to only handle streaming + push + connection-scoped messages
- [ ] Update `docs/001-websocket-protocol/plan.md` to document the new HTTP + WS split
- [ ] Update `CLAUDE.md` "How to add a new WebSocket message type" section to include HTTP endpoint guidance
- [ ] Verify no dead code remains (unused imports, unreachable handlers)
