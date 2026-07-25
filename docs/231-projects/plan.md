---
issue: https://linear.app/shipit-ai/issue/SHI-233
description: Multiple isolated Projects per deployment — each with its own repos, sessions, Linear, GitHub identity, agent credentials, MCP servers, and settings; soft separation as a step toward trusted multi-user.
---

# Projects — multiple isolated project spaces in one deployment

> Revised 2026-07 after adversarial review by two independent agents (Codex + Opus)
> against the actual codebase. The review verdict on the first draft was "phase 1 not
> implementable as written"; this version incorporates every confirmed finding. The
> major changes: blind switching is a page reload (not a store reset), per-project
> GitHub identity is its own sub-phase (it's a git-config refactor), SSE scoping uses
> per-scope payload builders (not delivery filtering), the credential migration copies
> the blob verbatim (no field surgery), and agent credentials become a per-project
> *binding* to existing provider accounts (not a blob split).

## Motivation

A single ShipIt deployment today is one undifferentiated pool: one repo list, one Linear
binding, one GitHub identity, one set of agent credentials, one settings blob. That works
for one person with one context, and breaks the moment you have two: work repos next to
personal repos, a company Linear next to a personal one, a work GitHub account next to a
personal account.

A **Project** groups all of that. Switching to another Project gives you an (almost)
completely fresh ShipIt — its own repos, sessions, tracker, identities, connectors, and
settings — inside the same deployment, same host, same resource budget.

This is also the deliberate first step toward multi-user: each **trusted** user creates
their own Project. It is *not* security isolation (see [Trust model](#trust-model)) —
that remains the territory of `docs/062-managed-shipit` (infra-level tenancy). Projects
are separation of *context*, not separation of *privilege*.

## Decisions (settled in design discussion, 2026-07)

| Question | Decision |
|---|---|
| Name | **Project** ("workspace" is triply overloaded: Linear's tenant term, docs/092's sidebar grouping, the `/workspace` mount) |
| Scoping | Everything user-facing is per-project: repos, sessions, Linear, **GitHub identity**, **agent (Claude/Codex) credentials**, **MCP servers**, **settings + system prompt** |
| Trust model | **Soft separation only** — no auth, no gate; any browser can switch to any Project |
| Switch UX | **Completely blind** — the active Project sees nothing of the others; the switcher lists names only, no cross-project badges or activity signals |

## The model

- A Project is a named scope with a stable id (uuid). Every user-visible entity — repo,
  session, secret, tracker binding, MCP server, setting — belongs to exactly one Project.
- The deployment boots with a **Default** Project (fixed well-known id) that adopts all
  pre-existing data (see [Migration](#migration)). A deployment always has ≥ 1 Project;
  the last remaining Project cannot be deleted.
- The browser has one **active Project** at a time (localStorage). The sidebar, session
  list, issues panel, settings, header pills — everything renders only the active
  Project. **Switching = write `activeProjectId` + full page reload** (see
  [Client](#client) for why a reload, not a store reset).
- Server-side, nothing pauses on switch: sessions in other Projects keep running, their
  PRs keep polling, their containers idle out on the normal clock. Blindness is a client
  presentation rule, not a lifecycle rule.
- The in-container agent is **project-unaware**. Every brokered surface it touches — git
  credentials, `shipit issue`, secrets into compose services, MCP resolution — is
  resolved orchestrator-side *through the session's Project*. The in-container git
  credential broker already has the session row in hand (`api-routes-github.ts`,
  `gitCredentialAllowed(session)`), so containers resolve per-project from day one.
- **Child sessions inherit `project_id` from the parent's session row**, never from a
  repo URL — ops and sandbox parents have no `remoteUrl` (`services/child-sessions.ts`
  claims `opts.repoUrlOverride ?? parent.remoteUrl`), so URL-based inheritance would
  400 or mis-scope. `shipit session create` therefore always spawns within the parent's
  Project.
- The **ShipIt source repo** used by ops `--shipit-fix` sessions
  (`services/shipit-source.ts`) is a host-maintenance concern: it stays
  deployment-global and attaches in whichever Project the ops session was created in.

## What is project-scoped vs global

Ruling for every deployment-global surface found in the audit. Phase column refers to
[Phasing](#phasing).

| Surface | v1 scope | Phase | Notes |
|---|---|---|---|
| Repos (`repos` table) | **Project** | 1a | PK becomes `(project_id, url)`; display order, hidden flag follow. Same URL may be open in two Projects. |
| Repo **trust** | **Project** | 1a | **Code-execution gate, not cosmetics**: `RepoStore.isTrusted`/`setTrusted` scan *all* rows and match via `canonicalRepoKey`, and the consumers (`service-manager-setup.ts` — gates repo-declared `agent.install` + compose auto-execution — and `warm-pool-manager.ts`) pass a bare URL. Unfixed, trusting `owner/repo` in Project A auto-runs its `docker-compose.yml` in Project B. Both call sites move to `(projectId, canonicalRepoKey)`. |
| Sessions | **Project** | 1a | `project_id` on `sessions`; ops/sandbox pseudo-groups exist per Project. `SessionManager.list()` and `findAllByRemoteUrl` gain project-filtered variants that filter **before** resolved-session caps/ranking (the caps currently group by `remote_url` pre-filter). |
| Warm pool | Per `(project, canonicalRepoKey)` | 1a | **Not** "follows the repos PK naturally": `WarmPoolManager` maps/locks and the claim chain (`services/claim-session.ts`) are keyed by URL alone, so Project B could claim Project A's warm session. All keys become `(projectId, canonicalRepoKey)`; a separate URL-global lock may still serialize shared-bare-cache fetches. Pool *sizing* limits stay global. |
| Usage tracking | **Project** | 1a | `project_id` stamped at insert on `usage_turns`; `UsageManager.getStats()` and the session-usage route (`api-routes-session-spawn.ts`) currently return **deployment-wide** aggregates — scoped queries in phase 1a, or blindness leaks every project's spend. |
| Per-Project reset / delete | **Project** | 1a | Delete is exposed in the phase-1a switcher, so the implementation ships with it: dispose only that Project's runners/containers/volumes/workspaces/session credential dirs; delete its rows across *all* session-owned tables (sessions, messages, usage, reviews, comments, rewinds, presentations, egress, secrets, repos) + its credential dir. Deleting the active Project switches to another; the last Project can't be deleted. Deployment-wide `clearAll()` remains the nuclear option. |
| Linear binding | **Project** | 1a | Token + team move to the Project credential file. `TrackerRegistry` is already rebuilt per request because of scope differences — it binds Linear from the Project's store; only the ~10 `buildTrackerRegistry` call sites in `services/issues.ts` swap stores. `setLinearTeam` and friends take an explicit projectId (no session in hand). |
| GitHub identity | **Project** | **1c** | Token / App-installation choice + git author per Project. **A git-config refactor, not a manager move** — see [Per-project git identity](#per-project-git-identity--credentials). GitHub *App registration* (app id, private key — `github-app-token.ts` env config) stays host-global; a Project selects its token/account/installation. |
| PR / release polling, prefetch, auto-push, auto-merge, auto-fix-CI | Global machinery, per-project credentials | 1c | `PrStatusPoller`, `ReleaseStatusPoller`, `repo-prefetch.ts`, the auto-push closure in `route-registry.ts`, and `AutoMergeManager` all hold the singleton `GitHubAuthManager` and one rate-limit gate. Job keys become `(projectId, repo)` and every API call resolves credentials from the job's Project; rate-limit state is per Project's token. Without this, Project B's private-repo PRs 404 under A's token and one Project's rate limit pauses all. |
| Agent credentials | **Project binding** | 3 | Each Project binds `{provider → accountId}` against the existing **global** provider-account roster (docs/150 already stores each account's credentials in its own dir `provider-accounts/<provider>/<accountId>/`). No credential duplication, no re-login per Project; `sessions.provider_route_kind/_id` and `agent_pinned` unchanged. Per-session credential isolation (docs/155) copies from the resolved account as today. |
| Orchestrator-side agent invocations | **Project** | 3 | Session namer, `generateText`, token refresh currently run on `process.env` (+ `HOME=/root`), and `app-di.ts` copies `getAllAgentEnv()` into **`process.env`** at boot. That hydration is **removed**, not re-scoped (a process env can't be per-project); a resolver `(projectId, agentId) → env` feeds every call site. |
| MCP servers | **Project** | 2 | Server configs + OAuth state, **including the `mcp__<server>__*` subtree of `agentEnv`** (MCP `$secret:` values live there — moving MCP without that subtree breaks phase ordering). OAuth flows persist `projectId` in server-side flow state; the callback resolves from that state, never from the current browser Project. Config-change refresh and the test route scope to the Project's runners. Built-in `playwright` + `shipit` bridge stay universal. |
| Settings + system prompt | **Project** | 2 | Behavioral settings (`autoCreatePr`, `liveSteering`, `autoResolveConflicts`, `autoFixCi`, `autoResetMergedBranch`, `enableSubAgents`, `agentSubAgentDefaults`, `agentSystemInstructionsEnabled`, voice delivery/webhook/provider keys) and `system-prompt.md` move per Project. Host-resource knobs (`maxIdleContainers`, docker memory) stay global. |
| Secrets | **Project** | 1a | Key becomes `(project_id, repo_url, key)` alongside the repos PK change. Cipher key (`SHIPIT_SECRET_KEY`) stays global; migration copies ciphertext without re-encryption. |
| Egress allowlist | **Project tier** | 2 | The `scope` string (`'global'` \| session id) gains `project:<id>`. Note: `egress_settings` changes currently broadcast to every browser (`api-routes-egress.ts`) — scoped in 1b. |
| Repo memory | **Project** | 4 | `repo-memory/<projectId>/<repoHash>/`. **Required companion edit**: `steady-state-reclaim.ts#sweepOrphanedRepoMemory` rm-rf's any top-level entry not matching a live repo hash — under the nested layout it would delete every Project's memory on the first hourly pass. Until phase 4, memory stays repo-hash-keyed and is shared across Projects holding the same repo (documented interim leak). |
| Bare git cache / dep cache / overlay store | Global | — | Keyed by URL hash; content, not policy. Two caveats, stated precisely: (a) cached *content* fetched for Project A is served to Project B for the same URL; (b) until 1c, the *fetch* into the shared cache runs under whichever Project's token triggered it, and a fetch failure `markTokenInvalid`s that token — after 1c, fetches carry the requesting Project's credentials and only that Project's token can be invalidated. |
| Templates, marketplaces/skills | Global (v1) | — | Hardcoded/catalog content; revisit if Projects want private skill sets. |
| Resource budgets, janitors, idle enforcer, disk tiers | Global | — | One host, one budget. Projects contend; explicit and fine for trusted users. Janitors/prefetch/reset keep a deliberate `listAll()` view of stores (see below). |
| Preview proxy | Unchanged | — | Session ids stay globally unique; `{sessionId}--{port}` routing needs no Project awareness. |
| ShipIt source repo (ops fix flow) | Global | — | Host-maintenance concern; attaches in the invoking ops session's Project. |

## Data model & storage

**New table:**

```sql
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,      -- uuid; Default project has a fixed well-known id
  name          TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);
```

(No slug column — nothing consumes one: session URLs stay `/session/{id}` and storage
dirs use the id.)

**Existing tables:**

- `sessions.project_id` — nullable-add → backfill to Default → validate → enforce.
- `repos`: PK `url` → `(project_id, url)`. SQLite can't alter a PK → rebuild-and-copy
  (`repos_v2`, copy **every** accumulated column — status, warm_session_id,
  display_order, trusted, hidden — drop, rename).
- `secrets`: same rebuild, key `(project_id, repo_url, key)`, ciphertext copied verbatim.
- `usage_turns.project_id` — backfilled via each row's session; rows whose session no
  longer exists (no FK today) go to Default.
- `egress_allowlist` / `egress_settings`: no schema change; `scope` admits
  `project:<id>`.

**The real rebuild hazards** (there are *no* FK references to `repos` or `secrets` —
`warm_session_id` and `sessions.remote_url` are plain columns):

1. `sessions.remote_url` is the only session→repo link and **nothing enforces** that
   `(project_id, remote_url)` corresponds to a `(project_id, url)` row. The PR poller
   docstring (`pr-status-poller.ts`) already documents that session `remoteUrl`, the
   poller key, the RepoStore row, and the bare-cache hash must agree on one URL or the
   client orphans sessions.
2. `repos` rows are keyed by the **raw** URL first used; duplicate raw-URL rows for one
   canonical repo exist in real deployments (which is exactly why `isTrusted` scans
   canonically today).
3. Sessions whose `remote_url` has no `repos` row are an existing, legal state
   (`startup-tasks.ts` backfills them at boot).

The migration test fixture must therefore include: duplicate raw-URL rows for one
canonical repo, sessions with un-rowed `remote_url`s, warm rows with dangling
`warm_session_id`, orphaned `usage_turns`, and an interrupted-migration replay.

**Store APIs**: `RepoStore`/`SecretStore`/`SessionManager` read methods take `projectId`
and filter in SQL (before caps/ranking). Host supervisors that legitimately need the
deployment-wide view — `startup-janitor.ts`, `steady-state-reclaim.ts`,
`repo-prefetch.ts`, `startup-tasks.ts`, full reset — call explicitly-named
`listAllProjects()` variants. There is no default-scoped read.

**Credential storage** (see [Migration](#migration) for the protocol):

```
{credentialsDir}/
  shipit-credentials.json                 # host file: maxIdleContainers (+ future
                                          # host-resource knobs); provider-account
                                          # roster stays in its existing store
  provider-accounts/<provider>/<acct>/    # unchanged (docs/150) — global roster;
                                          # Projects hold bindings, not copies
  projects/<projectId>/
    credentials.json                      # everything else: GitHub token, Linear,
                                          # MCP (+ mcp__* env subtree), behavioral
                                          # settings, voice, agentEnv, provider binding
    system-prompt.md                      # replaces {workspaceDir}/.shipit/system-prompt.md
    .gitconfig                            # per-project git identity (phase 1c)
  sessions/<sessionId>/                   # unchanged per-session isolation subtree
  repo-memory/<projectId>/<repoHash>/     # phase 4 (janitor edit required, see table)
```

**Field ownership is exhaustive** — every `CredentialData` field is assigned:
host-owned: `maxIdleContainers`, `providerAccounts` (roster). Project-owned: everything
else (`githubToken`, `linear`, `mcpServers`, `mcpOAuth`, `mcpOAuthClients`, `agentEnv`,
`voiceProviderKeys`, `voiceDeliveryMode`, `voiceWebhook`, `autoCreatePr`,
`liveSteering`, `autoResolveConflicts`, `autoFixCi`, `autoResetMergedBranch`,
`enableSubAgents`, `agentSubAgentDefaults`, `agentSystemInstructionsEnabled`). A new
field must declare its owner in the same PR that adds it.

**Intermediate-state contract**: field *storage* moves to the Project file at migration
time (verbatim copy), but *reads* become per-project progressively by phase. Until phase
3, agent-auth reads for **every** Project alias the Default Project's file — agent
credentials are global-by-alias, which is the correct intermediate for the
single-user-multiple-contexts case. A second Project created before phase 3 shares agent
auth and has empty GitHub/Linear/MCP config until connected.

## Orchestrator architecture

**`ProjectRegistry`** (new, `orchestrator/projects.ts`): owns the `projects` table and a
lazy map `projectId → ProjectContext` holding the per-project instances:
per-project `CredentialStore` file accessor, `GitHubAuthManager` (1c), MCP config/OAuth
state (2), settings + system prompt path (2), provider-account binding (3).

Singleton managers (docker, service manager, runner registry, pollers, janitors, preview
proxy) stay singletons, but **any of them that consumes `githubAuth` or agent
credentials resolves the owning Project per operation** — from the session row for
session-driven work, from the `(projectId, repo)` job key for background work. "Managers
keep taking the singletons as before" is exactly the assumption the review killed;
353 `githubAuth` references across 48 files are the sweep.

**Request → Project resolution.** Every route/WS handler declares one of three scope
modes; a typed wrapper makes omission a compile error (the same discipline as
`sseBroadcast` below):

1. **session-derived** — `sessionId` present (WS, per-session routes, worker relays):
   the session row's `project_id` is authoritative. If the request *also* carries an
   explicit `projectId` that disagrees → **400**, never silent precedence.
2. **explicit-project** — repo list/add/hide/reorder, session create, settings, secrets,
   MCP, tracker connect, `setLinearTeam`, github auth: `projectId` is a required param.
   The many routes keyed today by bare repo URL fall here — with the same URL in two
   Projects, the URL alone is ambiguous by design.
3. **host-global** — janitors' listAll, docker memory, system info, update checks.

Background jobs are outside request resolution entirely: they derive Project identity
from durable rows (the session row, the `(projectId, repo)` job key), never from any
notion of "the active project" — the server has none.

### Per-project git identity & credentials

The single hardest dependency, and why phase 1c exists. Today
`GIT_CONFIG_GLOBAL` points every orchestrator-side git operation — auto-commit,
auto-push, bare-cache fetch, rebase, branch graduation — at **one** process-global
gitconfig (`git-config.ts`), which is the single source of truth for both author
identity and the inline PAT credential helper. `GitManager.autoCommit` passes no author
override.

The refactor: each Project gets `projects/<id>/.gitconfig`; every git `execFile` in
`shared/git*.ts`, `repo-git.ts`, and the fetch paths threads
`GIT_CONFIG_GLOBAL=<project gitconfig>` (or explicit `-c`/`GIT_AUTHOR_*` env) resolved
from the operation's Project. `configureGitCredentials`/`setGitIdentity` write the
Project file. The process-global file ceases to be a source of truth. The in-container
path needs no change (the broker resolves per session already).

### Scoped delivery — four boundaries, payload builders

Blindness has four server→client boundaries, each scoped independently:

1. **`GET /api/bootstrap`** (`api-routes-bootstrap.ts` → `services/misc.ts`
   `getBootstrapData`) — the *primary* hydration path; gains a required `?project=`.
   `sessions`, `repos`, `githubStatus`, `settings` filter to the Project.
2. **SSE connect snapshot** (`route-registry.ts#registerSseEndpoint`) — sends
   `active_runners`, `session_attention`, `pr_status`, `session_list`, `repo_list`, etc.;
   the connection registers with `?project=` and the snapshot is built for that Project.
3. **Live SSE events** — `sseBroadcast` today serializes **one** payload and fans it to
   every client; but the collection events (`session_list` ×21 call sites,
   `provider_accounts` ×12, `repo_list` ×5, `pr_status` batches) carry the *full*
   deployment-wide set, and the client **replaces wholesale** on receipt. Tagging
   delivery is therefore insufficient — a delivered payload still contains other
   Projects' rows, and a poller batch spanning Projects either leaks or drops. The new
   signature takes a **per-scope payload builder**: `sseBroadcast(event, {project:
   (projectId) => data})` builds per-Project payloads for registered Projects only;
   `{global: data}` is reserved for genuinely scalar infra events (`docker_memory`,
   `system_info`, update-available). Cross-project batches (PR poller) split before
   emitting. An unscoped emit is a type error.
4. **WS reconnect replay** (turn-event log) — already session-scoped; sessions are
   project-owned, nothing to do.

Until 1b, blindness is best-effort (client-filtered); 1b makes the server stop shipping
foreign rows. `agent_list`, `provider_accounts`, `subscription_limits` have nothing to
scope by until phase 3 — they stay global through 1b and scope in 3.

## Client

- **`useProjectStore`**: `projects: ProjectInfo[]`, `activeProjectId` (localStorage),
  CRUD over `/api/projects`.
- **Switcher**: top of the sidebar, above repo groups — current name + menu of Project
  names, "New project…", "Rename", "Delete" (= per-Project reset, confirm-gated,
  phase 1a). Names only; no badges or activity signals.
- **Switching = write `activeProjectId` + `window.location.href = "/"`.** Reviewed
  alternative (an exhaustive `resetProjectState()`) rejected: `resetSessionState()`
  covers 8 of ~20 stores and the resets are deliberately partial; `repo-store.ts` has a
  module-level `Map` outside any store; bootstrap applies truthy-only updates, so
  Project A values survive where Project B is empty; and every async response in flight
  would need a generation guard. A reload makes "fresh page load into the other
  Project" literally true, is the mechanism the existing full-reset path already uses,
  and costs one reload on an infrequent action.
- **localStorage namespacing is phase 1a, not polish** — content-bearing keys leak
  actual user content across Projects: the new-session **message draft** uses one
  `"new"` key (Project A's draft text renders in Project B), `vibe-active-repo` is a
  single URL, `shipit-collapsed-repos`/`-resolved` are URL sets shared across Projects
  holding the same repo, and the issue-filter keys' code comments assume exactly the
  workspace-scoping this feature breaks. All of these gain the project id in the key.
  Only content-free physical prefs (theme, panel sizes) stay global. `issues-store`
  keying by `trackerId` alone is fine post-reload (memory state), but its localStorage
  filters are not.
- **Routing**: session URLs stay `/session/{id}` (globally unique); deep-linking a
  session in another Project sets `activeProjectId` and reloads. The
  `/repo/{owner}/{repo}/new` route resolves its slug against the **project-filtered**
  repo list (today `parseRepoLabel` collapses URL forms and `.find()` would silently
  pick across Projects — the doc's own headline capability, same repo in two Projects,
  breaks it otherwise). `activeRepoUrl` fallback recovery is likewise project-aware.
- **Naming cleanup**: the existing per-repo settings modal is already called "project
  settings" in code (`ui-store.ts#projectSettingsRepoUrl`) — renamed to *repo settings*
  in phase 1a so "Project" means one thing in the codebase.

## Migration

Two independent, idempotent passes:

**DB pass** — in the standard `user_version` chain: create Default Project, backfill
`project_id` (nullable-add → backfill → validate row counts → enforce), rebuild
`repos`/`secrets` copying every column, backfill `usage_turns` (orphans → Default).
Fixture requirements listed under [Data model](#data-model--storage).

**Credential-file pass** — *outside* the `user_version` chain (SQLite transactions
can't cover filesystem writes), with its own completion marker (the validated existence
of the project file):

1. **Copy `shipit-credentials.json` verbatim** to `projects/<default>/credentials.json`
   via staged temp file + fsync + rename + decrypt-read-back validation. No field
   surgery on a live encrypted blob — the store is one AES-256-GCM ciphertext and its
   writes are in-place `writeFileSync`, so partial-edit crash states are unrecoverable;
   a verbatim copy is not.
2. Only after the copy validates, rewrite the host file to the host-owned fields (same
   staged protocol). Crash between the steps leaves both files complete — reads resolve
   per field-owner (project file wins for project-owned fields), duplication is
   harmless, and the rewrite retries at next boot.
3. Move `{workspaceDir}/.shipit/system-prompt.md` → the Default Project's dir.

A deployment that never creates a second Project behaves exactly as today.

## Trust model

Soft separation, stated plainly: **Projects hide, they do not protect.** There is no
auth layer; any browser that can reach the deployment can switch to any Project and see
its sessions, secret names, and settings. Scoped delivery prevents accidental
cross-viewing, not adversarial access. This is the "trusted users" tier — housemates,
close collaborators, your own two hats.

Two sharp edges said out loud:

- **An ops session in any Project is host-root-equivalent** — it mounts host journals
  and gets the privileged Docker proxy (`container-lifecycle.ts`). Projects do nothing
  to contain it; a trusted user who can create an ops session owns the box.
- The shared bare cache serves one Project's fetched repo content to another for the
  same URL (see the scoping table caveat).

For the future auth story, the honest claim is narrower than "one choke point": the
typed request-resolution wrapper is the choke point for the *HTTP/WS surface*, and
background flows (pollers, warm allocation, OAuth callbacks, auto-push) derive Project
identity from durable rows — real authz later means gating the wrapper **and**
attributing those flows to a user, which the `(projectId, …)` job keys make tractable.
Untrusted multi-tenancy remains `docs/062-managed-shipit`.

## Phasing

Re-cut after review (the original phase 1 bundled the DB core with two mechanisms whose
stated designs didn't survive contact with the code):

- **1a — Core scoping & blind switch.** `projects` table + registry; DB migrations +
  fixture; typed scope-mode resolution wrapper; project-keyed
  `RepoStore`/`SecretStore`/`SessionManager` reads (+ explicit `listAllProjects()` for
  janitors); **trust check project-scoping** (code-exec gate); **warm-pool/claim
  composite keys**; child-session inheritance from parent row; usage stamping + scoped
  usage queries; per-Project reset/delete; reload-based switching + switcher UI;
  content-bearing localStorage namespacing; "project settings"→"repo settings" rename;
  Linear per Project; credential-file copy migration. Blindness is client-best-effort.
- **1b — Scoped delivery.** Per-scope payload builders in `sseBroadcast` (unscoped emit
  = type error); split cross-project poller batches; scoped `/api/bootstrap` +
  SSE connect snapshot; scoped egress broadcasts. (`agent_list`, `provider_accounts`,
  `subscription_limits` stay global until 3.) Blindness is now server-enforced.
- **1c — Per-project git & GitHub.** Per-project `.gitconfig`; thread
  `GIT_CONFIG_GLOBAL` through every orchestrator git exec; `GitHubAuthManager` into
  `ProjectContext`; pollers/auto-push/prefetch/auto-merge resolve credentials per
  `(projectId, repo)` job; per-project rate-limit state; bare-cache fetches carry the
  requesting Project's credentials.
- **2 — Config surfaces.** Settings + system prompt per Project; MCP per Project
  **including the `mcp__*` agentEnv subtree** and projectId-carrying OAuth flow state;
  egress `project:<id>` tier.
- **3 — Agent credential binding.** Per-Project `{provider → accountId}` binding over
  the global roster; `AgentCredentialResolver(projectId, agentId)` feeding session
  provisioning, namer, `generateText`, token refresh, limits; **remove** the boot-time
  `agentEnv → process.env` hydration; scope `agent_list`/`provider_accounts`/
  `subscription_limits` delivery; drop the Default-alias intermediate.
- **4 — Remaining lifecycle.** Repo-memory scoping (+ the
  `sweepOrphanedRepoMemory`/`sweepOrphanedCaches` keying edits — without them the
  janitor deletes every Project's memory), residual polish.

Each phase ships independently and leaves a documented-correct intermediate state.

## Risks & caveats

- **The `githubAuth` sweep (1c) is the big one**: ~353 references across 48 files, and
  it changes background-flow semantics (per-project rate limits, per-job credential
  resolution). Budget it as its own sub-phase; it is not incidental to phase 1.
- **Repos PK rebuild**: hazards are data-shape, not FKs (none exist) — duplicate
  raw-URL rows, unenforced `remote_url` correspondence, orphaned sessions/usage. The
  fixture list above is the contract.
- **Credential-file pass**: verbatim-copy protocol above; never field surgery on the
  encrypted blob; own idempotency marker, not `user_version`.
- **Shared git caches** leak repo content across Projects for the same URL. Accepted
  under trusted users; called out so nobody mistakes Projects for tenancy.
- **Naming**: "Project" collides mildly with Linear projects (UI copy: unqualified
  "Project" = the ShipIt concept; Linear's is "Linear project") and collided with the
  old per-repo "project settings" modal (renamed in 1a).

## Key files

Primary touch points (the review-verified list):

- `src/server/shared/database.ts` — migrations; `src/server/shared/git.ts`,
  `orchestrator/git-config.ts`, `repo-git.ts` — per-project git threading (1c)
- `src/server/orchestrator/app-di.ts` — `ProjectContext`; removal of `agentEnv`
  `process.env` hydration (3)
- `credential-store.ts` — per-project files + verbatim-copy migration
- `repo-store.ts` (incl. `isTrusted`/`setTrusted`), `secret-store.ts`, `sessions.ts` —
  project-keyed reads + `listAllProjects()`
- `warm-pool-manager.ts`, `services/claim-session.ts`, `services/child-sessions.ts` —
  composite keys, parent-row inheritance
- `trackers/registry.ts`, `services/issues.ts` — Linear from project store
- `app-lifecycle.ts` (`sseBroadcast` payload builders), `route-registry.ts` (SSE
  snapshot, auto-push), `api-routes-bootstrap.ts` + `services/misc.ts` (scoped
  bootstrap)
- `pr-status-poller.ts`, `release-status-poller.ts`, `repo-prefetch.ts` — per-job
  credential resolution
- `steady-state-reclaim.ts` — repo-memory sweep keying (4)
- `src/client/stores/` — `project-store.ts`, reload-based switch, localStorage
  namespacing (`utils/local-storage.ts`), switcher in `SessionSidebar/`

## Related docs

- `docs/092-multi-repo-workspace` — the sidebar repo-group tier Projects sit above
- `docs/062-managed-shipit` — real (infra-level) multi-tenancy; explicitly not this
- `docs/150` provider accounts (phase 3 binds to these), `docs/155` agent credential
  isolation (unchanged, copies from the resolved account)
- `docs/184-remove-platform-secret-forwarding` — secret flow Projects inherit
