# Projects — implementation checklist

Phasing re-cut 2026-07 after adversarial review (Codex + Opus); see plan.md.

## Phase 1a — core scoping & blind switch

- [ ] `projects` table + `ProjectRegistry` + Default-project boot migration
- [ ] `sessions.project_id` (nullable-add → backfill → validate → enforce); `repos` PK rebuild to `(project_id, url)` copying all columns; `secrets` rebuild to `(project_id, repo_url, key)` (ciphertext verbatim); `usage_turns.project_id` backfill (orphans → Default)
- [ ] Migration fixture: duplicate raw-URL repo rows, sessions with un-rowed `remote_url`, dangling `warm_session_id`, orphaned usage rows, interrupted-migration replay
- [ ] Typed request-resolution wrapper with three scope modes (session-derived / explicit-project / host-global); session-vs-explicit mismatch → 400
- [ ] Project-keyed reads on `RepoStore`/`SecretStore`/`SessionManager` (filter before caps/ranking) + explicit `listAllProjects()` for janitors/prefetch/reset
- [ ] `isTrusted`/`setTrusted` → `(projectId, canonicalRepoKey)`; update both consumers (`service-manager-setup.ts`, `warm-pool-manager.ts`) — code-execution gate
- [ ] Warm pool + claim chain keyed `(projectId, canonicalRepoKey)`; URL-global lock retained only for shared-cache fetch serialization
- [ ] Child sessions inherit `project_id` from the parent session row (not repo URL); ops/sandbox covered
- [ ] Usage: stamp `project_id` at insert; scope `UsageManager.getStats()` and the session-usage route
- [ ] Per-Project reset/delete (runners, containers, volumes, workspaces, session credential dirs, all session-owned tables, repos, secrets, project credential dir); last project undeletable; deleting active project switches
- [ ] Credential-file migration: verbatim staged copy → validate → rewrite host file to host-owned fields; own idempotency marker
- [ ] Client: `useProjectStore`, switcher UI, switch = set `activeProjectId` + page reload
- [ ] Content-bearing localStorage keys project-namespaced (message drafts incl. the `"new"` key, `vibe-active-repo`, collapse sets, issue filters)
- [ ] `/repo/{owner}/{repo}/new` slug resolution + `activeRepoUrl` recovery use the project-filtered repo list
- [ ] Rename existing per-repo "project settings" modal → "repo settings" (`ui-store.ts#projectSettingsRepoUrl`)
- [ ] Linear binding per project (`TrackerRegistry` binds from project store; `setLinearTeam` takes explicit projectId)
- [ ] System prompt file moved to the Default project dir

## Phase 1b — scoped delivery

- [ ] `sseBroadcast` per-scope payload builders (`{project: (id) => data}` / `{global}`); unscoped emit is a type error
- [ ] Split cross-project poller batches before emitting
- [ ] Scoped `GET /api/bootstrap` (`?project=` required) and SSE connect snapshot
- [ ] Scope egress broadcasts (`api-routes-egress.ts`)
- [ ] A-populated → B-empty switch tests with stale in-flight requests

## Phase 1c — per-project git & GitHub

- [ ] Per-project `.gitconfig`; thread `GIT_CONFIG_GLOBAL` (or explicit env/-c) through every orchestrator git exec (`shared/git*.ts`, `repo-git.ts`, fetch paths)
- [ ] `GitHubAuthManager` per project via `ProjectContext`; App registration stays host-global
- [ ] Pollers / auto-push / prefetch / auto-merge / auto-fix-CI resolve credentials per `(projectId, repo)` job; per-project rate-limit state
- [ ] Bare-cache fetches carry the requesting project's credentials; `markTokenInvalid` targets the right project

## Phase 2 — config surfaces

- [ ] Settings + system prompt per project (host-resource knobs stay global)
- [ ] MCP per project incl. the `mcp__*` agentEnv subtree; OAuth flow state carries `projectId`, callback resolves from state; scoped refresh/test
- [ ] Egress `project:<id>` scope tier

## Phase 3 — agent credential binding

- [ ] Per-project `{provider → accountId}` binding over the global provider-account roster
- [ ] `AgentCredentialResolver(projectId, agentId)` in session provisioning, namer, `generateText`, token refresh, limits
- [ ] Remove boot-time `agentEnv → process.env` hydration (`app-di.ts`)
- [ ] Scope `agent_list` / `provider_accounts` / `subscription_limits` delivery; drop the Default-alias intermediate

## Phase 4 — remaining lifecycle

- [ ] Repo-memory scoping `repo-memory/<projectId>/<repoHash>/` **with** the `sweepOrphanedRepoMemory` / `sweepOrphanedCaches` keying edits (data-loss hazard otherwise)
- [ ] Residual polish
