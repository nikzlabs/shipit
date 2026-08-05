# Projects — implementation checklist

Phasing from plan.md, twice re-cut after two rounds of adversarial review (Codex + Opus).

## Phase 1a — core scoping, blind switch, scoped hydration

- [ ] `projects` table (incl. `deleting` flag) + `ProjectRegistry` + Default-project boot migration; Default + last Project undeletable
- [ ] `sessions.project_id NOT NULL DEFAULT '<default-id>'` (atomic add, no rebuild); `repos` PK rebuild `(project_id, url)` copying all columns; `secrets` rebuild `(project_id, repo_url, key)` (ciphertext verbatim); `usage_turns.project_id` backfill (orphans → Default)
- [ ] Migration fixture: duplicate raw-URL rows, un-rowed `remote_url` sessions, dangling `warm_session_id`, orphaned usage, all-session-columns-survive proof, interrupted-migration replay
- [ ] Boot-fenced credential pass (verbatim staged copy → host rewrite → prompt move; three persisted states re-checked each boot; runs before server listen / store construction); `CredentialStore` singleton re-pointed at Default's file; host store split out; `writeToDisk` atomic; single unreadable project file degrades (never bricks boot)
- [ ] Typed four-mode resolution wrapper (session-derived / explicit-project / flow-state-derived / host-global); mismatch → 400; hybrid routes split or `oneOf`; `assertBelongsToProject` on secondary resource ids
- [ ] Project-keyed store **reads and writes** on `RepoStore`/`SecretStore`/`SessionManager` (filter before caps) + explicit `listAllProjects()` for janitors/prefetch/reset
- [ ] Late repo-link writers inherit the session's project: `listSessions` lazy `remote_url` backfill, `setGitRemote` graduation, all 7 `setRemoteUrl` sites, `graduate-session.ts` touch, `startup-tasks.ts` add/setReady
- [ ] Session creation-path matrix enforced by constructors: explicit (new/headless/template/sandbox/plugin-install), source-session inheritance (child/fork/rewind), composite key (warm/claim), preserved (graduation)
- [ ] Trust gate: `isTrusted`/`setTrusted` → `(projectId, canonicalRepoKey)`; all three call sites (`service-manager-setup.ts`, `warm-pool-manager.ts`, and the `POST /api/repos/trust` live-runner `rerunServiceSetup` fan-out + warm kick)
- [ ] Warm pool + claim chain keyed `(projectId, canonicalRepoKey)`; host-wide warm-session cap (none exists today); warm most-recently-active projects first
- [ ] Usage: stamp `project_id` at insert; scope `getStats()` + session-usage route
- [ ] Project deletion protocol: `deleting` state rejects new ops → cancel/await warm/claim/prefetch → force-dispose runners, containers, volumes, session credential dirs → untrack pollers/watchers → evict `ProjectContext` → delete rows (all session-owned tables, repos, secrets) + credential dir; tests for deletion during turn/warm/poll
- [ ] Scoped `GET /api/bootstrap` + SSE connect snapshot (`?project=` required; unknown/deleted id → Default + client localStorage rewrite; snapshot goes through the shared payload builders, no hand-rolled writes)
- [ ] Client: `useProjectStore`, switcher, switch = set `activeProjectId` + hard reload (`location.reload()` when already at `/`)
- [ ] Deep links: pre-bootstrap `resolveProjectIdForSession(sessionId)` → set active + reload; `/repo/.../new` slug + `activeRepoUrl` recovery use the project-filtered list
- [ ] localStorage namespacing (content-bearing): message draft + `shipit-draft-uploads:` (`"new"` sentinel), upload tombstones, `vibe-active-repo`, collapse sets, issue filters
- [ ] Rename per-repo "project settings" modal → "repo settings"
- [ ] Linear per project (`TrackerRegistry` from project store; `setLinearTeam` explicit projectId)
- [ ] System prompt moved to Default's dir; readers/writers (`services/settings.ts`, `bootstrap-managers.ts`) follow in the same phase
- [ ] Repo-memory scoping `repo-memory/<projectId>/<repoHash>/` (migration state `memory_moved`); `sweepOrphanedRepoMemory` nested per-project traversal (data-loss hazard) + `sweepOrphanedCaches` all-projects live-hash union; project deletion removes the tree

## Phase 1b — scoped live delivery

- [ ] Three typed broadcast forms (`broadcastProject` / `broadcastPerScope` with `undefined`-skip / `broadcastGlobal`); unscoped emit = compile error
- [ ] Project ids on URL-keyed single-entity events (`repo_warm_ready`, `repo_status`, warm/claim errors, `session_*`, `gh_rate_limited`)
- [ ] Split cross-project poller batches before emit
- [ ] `project_list` (names-only, global) + targeted `project_deleted` terminal event (EventSource reconnect fallback)
- [ ] Scoped egress broadcasts
- [ ] A-populated → B-empty switch tests with stale in-flight requests

## Phase 1c — per-project git & GitHub

- [ ] Git execution factory: `{projectId}` / `{hostGlobal}` lanes; base config (safe.directory, URL rewrites) inherited; no direct `simpleGit`/git spawn outside the factory (incl. `session-fork-merge.ts`, warm pool, marketplace=hostGlobal)
- [ ] Per-project `.gitconfig` (identity via `setGitIdentity`-equivalent, credential helper; migrate the legacy raw `gitIdentity` blob key); `checkCredentials` stops mutating global state
- [ ] Container path: broker resolves the session's project manager; `writeContainerGitConfig` takes project identity; re-provision scaffolds on identity change; `git_identity_required` gate + settings identity read per project
- [ ] `GitHubAuthManager` per project via `ProjectContext`; App registration stays host-global (installation tokens repo-derived — existing cache key stays valid)
- [x] ~~Private planning GitHub tracker binding per Project~~ — not needed: trackers are declared per repository in `shipit.yaml` (doc 247 req 5), so they are already Project-scoped. Only the separate public ShipIt bug-report destination still needs preserving, covered by the `services/bug-report.ts` row below.
- [ ] Pollers / auto-push / prefetch / auto-merge / auto-fix-CI per `(projectId, repo)` job; per-project rate-limit state + `markTokenInvalid`
- [ ] Re-key bare-`repoKey` caches: `releasedByKey`, `lastPolledAt`, `ci-grace-tracker` observed-checks
- [ ] `services/bug-report.ts` files under the invoking session's project token

## Phase 2 — config surfaces

- [ ] Settings + system prompt per project **and the consumer sweep**: `ProjectSettingsResolver` through PR-automation gates (`app-lifecycle.ts`), runner steering, WS agent-execution, branch reset, sub-agent defaults
- [ ] Voice stack per project incl. the global TTS cache dir (scope or partition; clear on project delete)
- [ ] MCP per project incl. `mcp__*` `agentEnv` subtree (per-key resolution: `mcp__*` own project, rest Default-alias until phase 3); OAuth `projectId` in flow state (flow-state-derived mode); scoped refresh/test
- [ ] Egress `project:<id>` tier **and** project-scoped `__suppressed_defaults__`

## Phase 3 — agent credential binding

- [ ] Per-project `{provider → accountId}` binding over the global roster
- [ ] `AgentCredentialResolver(projectId, agentId)` in provisioning, namer, `generateText`, token refresh, limits
- [ ] Remove boot-time `agentEnv → process.env` hydration (`app-di.ts`)
- [ ] Scope `agent_list` / `provider_accounts` / `subscription_limits` + the `agent_auth_*` event family + pending-device-code replay by account binding
- [ ] Global account sign-out repairs/blocks on dangling project bindings
- [ ] Per-project agent/model/reasoning new-session localStorage seeds
- [ ] Drop the Default alias; Default becomes deletable

## Phase 4 — residual polish

- [ ] Residual polish (repo-memory scoping and janitor edits promoted into 1a)
