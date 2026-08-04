---
issue: https://linear.app/shipit-ai/issue/SHI-233
description: Multiple isolated Projects per deployment — each with its own repos, sessions, Linear, GitHub identity, agent credentials, MCP servers, and settings; soft separation as a step toward trusted multi-user.
---

# Projects — multiple isolated project spaces in one deployment

Later human-owned additions are recorded in
[requirements.md](./requirements.md). In particular, private planning tracker
bindings become per Project when this feature ships; see
[doc 247](../247-private-github-issue-tracker/requirements.md).

> Twice revised (2026-07) after two rounds of adversarial review, each by two
> independent agents (Codex + Opus) checking the doc against the actual code.
> Round 1 killed the original phase 1 (SSE tagging, store-reset switching, "GitHub
> identity is a manager move"). Round 2 verified the revision's claims and forced:
> Default-project undeletability until phase 3, the in-container git *identity* fix
> (the broker covers credentials, not authorship), a boot-fenced credential migration,
> a project-vs-host git execution model, scoped bootstrap moved into 1a (the phases
> weren't independent), a project-deletion quiescence protocol, and a pile of
> verified call-site corrections now baked into the tables below.

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
  pre-existing data (see [Migration](#migration)). **Default is undeletable until phase
  3**: the phase-1/2 intermediate has every Project aliasing Default's credential file
  for not-yet-scoped surfaces (agent auth, and pre-1c GitHub), so deleting it would
  strand the whole deployment. After phase 3 removes the alias, Default is an ordinary
  Project; the last remaining Project is always undeletable.
- The browser has one **active Project** at a time (localStorage). Everything renders
  only the active Project. **Switching = write `activeProjectId` + reload** (see
  [Client](#client)).
- Server-side, nothing pauses on switch: sessions in other Projects keep running, their
  PRs keep polling, their containers idle out on the normal clock. Blindness is a client
  presentation rule, not a lifecycle rule.
- The in-container agent is **project-unaware**. Brokered surfaces (`shipit issue`,
  secrets, MCP) resolve orchestrator-side through the session's Project. Note the git
  path is *not* free: the credential broker must resolve the session's Project manager
  (today it uses the singleton), and the per-session container gitconfig copies author
  identity from the process-global config — both are 1c work, not "no change" (see
  [Per-project git](#per-project-git-identity--credentials)).
- **Session creation-path matrix** — every path that creates a session row must carry a
  Project, enforced by making the constructors require one:
  - explicit Project: new-session, headless, template, sandbox, plugin-install
    (`api-routes-marketplace.ts` creates sessions from a currently-global route)
  - inherited from the **source session row**: child spawns (`shipit session create`),
    fork, rewind (`session-fork-merge.ts` calls `track()` directly)
  - composite `(projectId, canonicalRepoKey)`: warm creation and claim
  - preserved immutably: graduation (standalone → repo-backed keeps its Project)
- The **ShipIt source repo** used by ops `--shipit-fix` sessions stays
  deployment-global (host-maintenance concern); it attaches in the invoking ops
  session's Project.

### Project deletion is a lifecycle operation, not a row delete

Deletion must quiesce before it destroys, or fire-and-forget work races new state into
the deleted Project (warm allocation stores uncancellable promises and creates its
session row *after* async work starts; runner disposal refuses to kill running agents
unless forced; PR/release pollers need explicit untracking). Protocol:

1. Mark the Project `deleting` (durable) — all scoped routes reject new operations.
2. Cancel + await warm/claim/prefetch work; force-dispose the Project's runners
   (`{force: true}`), destroy containers/volumes/workspaces and session credential dirs.
3. Untrack the Project's repos from all pollers/watchers; evict its `ProjectContext`.
4. Delete rows across all session-owned tables (sessions, messages, usage, file/agent
   reviews + comments, rewinds, presentations, egress rows), repos, secrets; delete the
   Project credential dir and its `repo-memory/<projectId>/` tree; clear its TTS-cache
   entries and any per-project browser namespaces on next load.
5. Emit the targeted `project_deleted` event (see scoped delivery) so viewing browsers
   fall back to Default and reload.

Deleting the active Project switches the browser to another. Tests: deletion during a
running turn, during warm creation, during a poll cycle.

## What is project-scoped vs global

Ruling for every deployment-global surface found in the audits. Phase column refers to
[Phasing](#phasing).

| Surface | v1 scope | Phase | Notes |
|---|---|---|---|
| Repos (`repos` table) | **Project** | 1a | PK becomes `(project_id, url)`; display order, hidden flag follow. Same URL may be open in two Projects. |
| Repo **trust** | **Project** | 1a | **Code-execution gate with three call sites.** `isTrusted`/`setTrusted` scan *all* rows via `canonicalRepoKey`; readers `service-manager-setup.ts` (gates repo-declared `agent.install`/compose auto-exec) and `warm-pool-manager.ts` pass a bare URL; and `POST /api/repos/trust` (`api-routes-session-repos.ts`) **fans out immediately** — it sweeps every live runner whose canonical key matches and calls `rerunServiceSetup()`, then warms the repo. Unscoped, trusting `owner/repo` in Project A re-runs its compose inside Project B's *already-open* sessions. All three sites move to `(projectId, canonicalRepoKey)`. |
| Sessions | **Project** | 1a | `project_id` on `sessions`; ops/sandbox pseudo-groups per Project. `SessionManager.list()`/`findAllByRemoteUrl` gain project-filtered variants filtering **before** resolved-session caps (caps group by `remote_url` pre-filter today). One deliberate global lookup survives: `resolveProjectIdForSession(sessionId)` for deep links (see Client). |
| Warm pool | Per `(project, canonicalRepoKey)` | 1a | Maps/locks and the claim chain are URL-keyed today (Project B could claim A's warm session) → composite keys. **Footprint multiplies**: boot warms every ready repo row lacking a warm session, and there is **no existing pool-size cap to "stay global"** — the same 5 repos in 2 Projects = 10 standby containers at boot. 1a adds a host-wide warm-session cap and warms most-recently-active Projects first. A URL-global lock may still serialize shared-bare-cache fetches. |
| Usage tracking | **Project** | 1a | `project_id` stamped at insert; `UsageManager.getStats()` and the session-usage route return deployment-wide aggregates today — scoped in 1a or blindness leaks every Project's spend. |
| Per-Project reset / delete | **Project** | 1a | See the deletion protocol above. Deployment-wide `clearAll()` remains the nuclear option (its table list is also the reset checklist's source; note it omits the dead pre-migration-7 `doc_reviews`/`review_comments` tables and global `marketplaces` — deliberately). |
| Linear binding | **Project** | 1a | Token + team in the Project file. `TrackerRegistry` is already rebuilt per request — it binds Linear from the Project's store; ~10 `buildTrackerRegistry` call sites in `services/issues.ts` swap stores. `setLinearTeam` takes an explicit projectId. |
| Private planning GitHub tracker binding | **Project** | **1c** | Each Project selects its own user-created private issue repository. The binding is resolved from the session's Project and uses that Project's GitHub identity; it never falls back to another Project or the active code remote. This private destination coexists with the public ShipIt user bug tracker. Detailed routing invariants: [doc 247](../247-private-github-issue-tracker/plan.md). |
| GitHub identity | **Project** | **1c** | Token / App-account choice + git author per Project. See [Per-project git](#per-project-git-identity--credentials). GitHub *App registration* (app id, private key — env config) stays host-global; App installation tokens are minted per repo, and the existing `owner/repo`-keyed installation-token cache stays correct because a repo's installation is repo-derived, not Project-chosen. |
| PR / release polling, prefetch, auto-push, auto-merge, auto-fix-CI | Global machinery, per-project credentials | 1c | All hold the singleton `GitHubAuthManager` + one rate-limit gate. Job keys become `(projectId, repo)` and each call resolves the job's Project credentials; per-project rate-limit state. **Also re-key the bare-`repoKey` caches**: `release-status-poller.ts#releasedByKey` (A's release card would dedup B's), `pr-polling-supervisor.ts#lastPolledAt` (A's poll satisfies B's cadence), `ci-grace-tracker.ts` sticky observed-checks state (drives auto-fix-CI verdicts). |
| Upstream bug reports | Invoking Project | 1c | `services/bug-report.ts` files issues under the user's GitHub identity via the singleton token — after 1c it uses the invoking session's Project token. |
| Agent credentials | **Project binding** | 3 | Each Project binds `{provider → accountId}` against the **global** provider-account roster (docs/150: per-account credential dirs). No credential duplication or re-login; `sessions.provider_route_kind/_id` + `agent_pinned` unchanged; docs/155 per-session isolation copies from the resolved account. Phase 3 also: scope the `agent_auth_*` SSE event family + pending-device-code replay by account binding; **global sign-out of a bound account must repair or block on dangling Project bindings**. |
| Orchestrator-side agent invocations | **Project** | 3 | Session namer, `generateText`, token refresh run on `process.env` today, and `app-di.ts` copies `getAllAgentEnv()` into **`process.env`** at boot (with an existing-env-wins guard). Hydration is **removed**; `AgentCredentialResolver(projectId, agentId) → env` feeds every call site. |
| MCP servers | **Project** | 2 | Configs + OAuth state **including the `mcp__<server>__*` subtree of `agentEnv`** (`$secret:` values live there). `agentEnv` therefore needs **per-key** resolution between phases 2 and 3: `mcp__*` keys from the own Project, the rest (agent auth, `OPENAI_API_KEY`) from the Default alias until 3. OAuth flows persist `projectId` in flow state; the callback resolves from that state (its own resolution mode — see below). Config-refresh and the test route scope to the Project's runners. Built-in `playwright` + `shipit` bridge stay universal. |
| Settings + system prompt | **Project** | 2 | Storage *and* consumers: a `ProjectSettingsResolver` sweep covers the PR-automation gates (`app-lifecycle.ts` closes over the singleton store), runner live-steering, WS agent-execution reads, branch reset, sub-agent defaults, and the voice stack (routes are sessionless today; the **TTS cache dir is global and keyed without project** — scope or partition it). Host-resource knobs (`maxIdleContainers`, docker memory) stay global. |
| Secrets | **Project** | 1a | Key `(project_id, repo_url, key)`; ciphertext copied verbatim; cipher key stays global. |
| Egress allowlist | **Project tier** | 2 | `scope` gains `project:<id>` — **including the fourth existing tier** `__suppressed_defaults__` (user-removed built-in hosts): unscoped, removing a default host in Project A changes Project B's firewall. Egress broadcasts scoped in 1b. |
| Repo memory | **Project** | **1a** | `repo-memory/<projectId>/<repoHash>/`. Promoted from phase 4: memory is the closest thing to per-user knowledge ("how this user likes things done"), so two trusted users sharing a repo across Projects must not cross-pollinate it. Required companion: `sweepOrphanedRepoMemory` rm-rf's top-level entries not matching live hashes — needs nested per-Project traversal or it deletes every Project's memory. (`sweepOrphanedCaches` also lands in 1a for a different reason: repo/dep caches stay global, but its live-hash set comes from the repo list, which becomes project-keyed — the union must span all Projects or it deletes other Projects' caches.) Cost of the split: the same repo in two Projects builds memory twice. |
| Bare git cache / dep cache / overlay store | Global | — | Content, not policy. Caveats: (a) cached content fetched for Project A serves Project B for the same URL; (b) until 1c the *workspace-clone* fetches (warm pool, claim) and auto-push run under the singleton token, and their failure paths `markTokenInvalid` the host-wide token — after 1c, per-Project tokens and per-Project invalidation. (Bare-cache `fetchCache` itself holds no auth manager; its failures are swallowed by callers.) |
| Templates, marketplaces/skills | Global (v1) | — | Catalog content; revisit if Projects want private skill sets. |
| Resource budgets, janitors, idle enforcer, disk tiers | Global | — | One host, one budget; Projects contend, explicitly. Janitors/prefetch/reset use explicit `listAllProjects()` store variants. |
| Preview proxy | Unchanged | — | Session ids stay globally unique. |

## Data model & storage

**New table:**

```sql
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,      -- uuid; Default has a fixed well-known id
  name          TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  deleting      INTEGER NOT NULL DEFAULT 0
);
```

**Existing tables:**

- `sessions.project_id TEXT NOT NULL DEFAULT '<default-id>'` — a single atomic
  `ALTER TABLE ADD COLUMN` with the default baked in (SQLite can't retro-fit `NOT NULL`
  onto a nullable column without a full `sessions_v2` rebuild of ~40 accumulated
  columns; the DEFAULT approach avoids that rebuild entirely).
- `repos`: PK `url` → `(project_id, url)` — rebuild-and-copy (`repos_v2`, every
  accumulated column: status, warm_session_id, display_order, trusted, hidden).
- `secrets`: same rebuild, `(project_id, repo_url, key)`.
- `usage_turns.project_id` — backfilled via session; orphans → Default.
- `egress_allowlist`/`egress_settings`: `scope` admits `project:<id>` (and the
  suppressed-defaults tier gains a project-scoped variant in phase 2).

**Rebuild hazards** (no FK references to `repos`/`secrets` exist — the risks are
data-shape):

1. `sessions.remote_url` ↔ `repos.url` correspondence is unenforced, and un-rowed
   `remote_url` sessions **persist indefinitely** (the boot backfill in
   `startup-tasks.ts` runs only when the repo table is *empty* — a one-time legacy
   migration, not an ongoing repair).
2. Duplicate raw-URL rows for one canonical repo exist in real deployments (why
   `isTrusted` scans canonically).
3. **Live writers create late repo links with no project in hand**: `services/
   session.ts#listSessions` lazily backfills `remote_url` from the workspace's `origin`
   on *every* list; `setGitRemote` is the real standalone→repo-backed graduation;
   `setRemoteUrl` has 7 call sites; `graduate-session.ts` calls `repoStore.touch`,
   `startup-tasks.ts` calls `add`/`setReady`. All of these inherit the **session's**
   `project_id` and create/touch the repos row in that Project.

**Store APIs — reads *and* writes take `projectId`.** The non-test `repoStore.*`
surface is ~60 calls across 18 files, half of them writes (`touch`, `setReady`, `add`,
`setWarmSessionId`, `setTrusted`, `setOrder`, `setHidden`, `remove`); a read-only
scoping leaves every write ambiguous. Host supervisors (janitors, prefetch, startup
tasks, full reset) use explicitly-named `listAllProjects()` variants. There is no
default-scoped access.

Migration test fixture: duplicate raw-URL rows, un-rowed `remote_url` sessions,
dangling `warm_session_id`, orphaned usage rows, a populated `sessions` table proving
every accumulated column survives, and an interrupted-migration replay.

**Credential storage.** The mechanism for the intermediate phases is a **re-point, not
a fork**: at 1a the existing `CredentialStore` singleton is constructed against
`projects/<default>/credentials.json` (a verbatim copy of the old blob — see
Migration), and a small separate host store owns the host file. Every consumer that
hasn't reached its owning phase keeps using the singleton — which now *is* the Default
Project's store — so "aliasing Default" is the unmodified code path, not new code.
Each later phase peels its surface off the singleton into `ProjectContext`.

```
{credentialsDir}/
  shipit-credentials.json                 # host store: maxIdleContainers (+ future
                                          # host knobs); provider-account roster
  provider-accounts/<provider>/<acct>/    # unchanged (docs/150) — global roster
  projects/<projectId>/
    credentials.json                      # everything else (field list below)
    system-prompt.md                      # moved here in 1a — readers/writers
                                          # (services/settings.ts, bootstrap-managers)
                                          # follow the new path in the same phase
    .gitconfig                            # per-project git identity (1c)
  sessions/<sessionId>/                   # unchanged per-session isolation
  repo-memory/<projectId>/<repoHash>/     # 1a (janitor edits land with it)
```

**Field ownership** (exhaustive over the `CredentialData` type): host-owned —
`maxIdleContainers`, `providerAccounts`. Project-owned — everything else
(`githubToken`, `linear`, `privateGithubTracker`, `mcpServers`, `mcpOAuth`, `mcpOAuthClients`, `agentEnv`,
`voiceProviderKeys`, `voiceDeliveryMode`, `voiceWebhook`, `autoCreatePr`,
`liveSteering`, `autoResolveConflicts`, `autoFixCi`, `autoResetMergedBranch`,
`enableSubAgents`, `agentSubAgentDefaults`, `agentSystemInstructionsEnabled`). One
stray exists *outside* the type: `git-config.ts` raw-reads a legacy `gitIdentity` key
from the blob — it migrates into the per-project `.gitconfig` in 1c. A new field must
declare its owner in the PR that adds it.

**Per-phase field resolution** (the contract that makes intermediates correct): a
project-owned field resolves from the **own** Project's store once its owning phase
lands, and from the **Default alias** (the re-pointed singleton) before that. `agentEnv`
splits per-key between phases 2 and 3 (`mcp__*` own, rest Default). A second Project
therefore shares Default's GitHub/agent identity until 1c/3 respectively — correct for
the single-user-multiple-contexts case — and gets genuinely empty config per surface
only at that surface's phase.

## Orchestrator architecture

**`ProjectRegistry`** (new, `orchestrator/projects.ts`): owns the `projects` table and
a lazy `projectId → ProjectContext` map holding the per-project instances as phases
land: credential store accessor (1a), `GitHubAuthManager` (1c), MCP state (2),
settings resolver (2), provider binding (3).

Singleton managers stay singletons, but any consumer of `githubAuth`, settings, or
agent credentials resolves the owning Project **per operation** — from the session row
for session-driven work, from the `(projectId, repo)` job key for background work.

**Request → Project resolution.** Every route/WS handler declares exactly one scope
mode via a typed wrapper (omission = compile error):

1. **session-derived** — `sessionId` present: the session row's `project_id` is
   authoritative. An accompanying explicit `projectId` that disagrees → 400. (The
   container guard already forces every container-accessible route to be
   own-session-scoped, which is why the in-container surface needs no new concept.)
2. **explicit-project** — repo list/add/hide/reorder, session create, settings,
   secrets, MCP config, tracker connect, github auth: `projectId` required. Bare repo
   URLs are ambiguous by design once two Projects can hold one URL.
3. **flow-state-derived** — OAuth callbacks (MCP, and any future redirect flow): no
   session, no caller-supplied project; the `projectId` persisted in server-side flow
   state at flow start is authoritative.
4. **host-global** — janitors' listAll, docker memory, system info, update checks, and
   one named exemption: `resolveProjectIdForSession(sessionId)` for deep links.

Two hardening rules the modes don't cover on their own: **hybrid routes** (e.g.
`/api/sessions/:id/template` where `id === "new"` flips it from session-derived to
explicit; pin-reorder taking a repo URL plus arbitrary session ids; issue routes with
optional sessions) are split or use a typed `oneOf` resolver; and every **secondary
resource id** in a request (target sessions, review ids, repo URLs in bodies) passes an
`assertBelongsToProject` check — scope resolution alone is not authorization of every
entity the request touches.

Background jobs derive Project identity from durable rows (session row, `(projectId,
repo)` job key), never from any notion of an "active" project — the server has none.

### Per-project git identity & credentials

Today `GIT_CONFIG_GLOBAL` points every orchestrator-side git operation at one
process-global gitconfig — the single source of truth for author identity
(`setGitIdentity`), the credential helper (`setGlobalCredentialHelper`), *and*
non-identity policy (`safe.directory`, GitHub URL rewrites). `GitManager.autoCommit`
passes no author override, and `GitHubAuthManager.checkCredentials()` mutates the
global helper as a side effect. The non-test `githubAuth` surface is ~400 references
across ~54 files (~1000 including tests — tests are part of the sweep).

The 1c design is a **git execution factory** with two lanes, and a prohibition on
direct `simpleGit`/child-process git anywhere else:

- **`{projectId}` lane** — resolves `GIT_CONFIG_GLOBAL` to
  `projects/<id>/.gitconfig`, which *inherits* a base config (safe.directory, URL
  rewrites) and adds the Project's identity + credential helper. Used by auto-commit,
  auto-push, clone/fetch for claim + warm pool, rebase, fork/merge
  (`session-fork-merge.ts` runs git directly today), graduation.
- **`{hostGlobal}` lane** — marketplace/skill cache git ops, ShipIt-source/update
  operations, anything with no owning Project.

**The container path changes too** (round-2 correction): the credential broker
resolves the *session's Project* `GitHubAuthManager` instead of the singleton, and
`writeContainerGitConfig` — which today copies author identity from the process-global
file into each session's mounted gitconfig — takes the Project identity. Existing
session scaffolds re-provision when a Project's identity changes. The
`git_identity_required` WS gate and the settings-service identity read also become
per-project.

Pollers/auto-push/prefetch/auto-merge resolve credentials per `(projectId, repo)` job
with per-project rate-limit state, and the bare-`repoKey` caches listed in the scoping
table re-key.

### Scoped delivery — four boundaries

1. **`GET /api/bootstrap`** — the primary hydration path; gains a required
   `?project=`. **Scoped in 1a** (round-2 correction: 1a's project-keyed store reads
   and the wholesale-replacing client make unscoped bootstrap incoherent — the phases
   weren't independent with this in 1b). An unknown/deleted `project` param resolves
   to Default and tells the client, which rewrites localStorage — a second browser
   holding a stale id must never hard-fail hydration.
2. **SSE connect snapshot** — the connection registers `?project=`; the snapshot is
   built for that Project **through the same payload builders as live events** (today
   it hand-rolls `client.write`, which would silently bypass any wrapper-level type
   guard). Scoped in 1a alongside bootstrap.
3. **Live SSE events** (1b) — `sseBroadcast` today fans one payload to every client,
   and the collection events carry the full deployment-wide set which clients replace
   wholesale. The new API has **three typed forms**, and an unscoped emit is a compile
   error:
   - `broadcastProject(projectId, event, data)` — targeted single-entity events. This
     is most of the ~28 event types, including the URL-keyed ones that are a
     *correctness* bug unscoped, not just a leak (`repo_warm_ready` and `repo_status`
     carry only a URL — with one repo in two Projects, A's ready-state would apply to
     B's row), warm/claim `error` toasts, `session_*`, `gh_rate_limited`.
   - `broadcastPerScope(event, (projectId) => data | undefined)` — per-Project
     collection payloads (`session_list`, `repo_list`, `pr_status` batches split
     before emit); `undefined` skips a Project.
   - `broadcastGlobal(event, data)` — genuinely scalar infra (`docker_memory`,
     `system_info`, update-available) plus a names-only `project_list` event, and the
     targeted terminal `project_deleted` (EventSource auto-reconnects to its original
     URL, so a deleted Project's viewers need an explicit signal to fall back and
     reload rather than reconnect forever).
4. **WS reconnect replay** — already session-scoped; sessions are project-owned.

`agent_list`, `provider_accounts`, `subscription_limits`, and the `agent_auth_*` family
have nothing to scope by until phase 3 and stay global through 1b. Honest blindness
claim per phase: 1a = sessions/repos/usage scoped at the source; 1b = all
session/repo/PR delivery server-enforced; identity- and settings-shaped surfaces
remain Default-aliased until 1c/2/3.

## Client

- **`useProjectStore`**: `projects`, `activeProjectId` (localStorage), CRUD over
  `/api/projects`.
- **Switcher**: top of sidebar — names only, plus "New project…", "Rename", "Delete"
  (runs the deletion protocol; Default and the last Project are undeletable).
- **Switching = write `activeProjectId` + hard reload** — `location.reload()` when
  already at `/`, else `window.location.href = "/"` (the existing full-reset precedent
  navigates conditionally for exactly this reason). Review verified there is no other
  client persistence surface: no IndexedDB, no sessionStorage, no cookies; the service
  worker precaches nothing and wipes Cache Storage on activate. An installed PWA
  shares origin storage with the tab, so both are always in the same Project. The
  store-reset alternative stays rejected: `resetSessionState()` covers 8 of ~21
  stores, `repo-store.ts` holds a module-level Map outside any store, and every
  in-flight async response would need a generation guard.
- **localStorage namespacing is 1a** for content-bearing keys: the new-session
  message draft **and** `shipit-draft-uploads:` (both keyed by the same `"new"`
  sentinel — Project A's draft text and attached files would render in Project B),
  upload-deletion tombstones (one global key; a deletion in A can hide a same-named
  `/uploads` file in B), `vibe-active-repo`, collapse sets (URL-keyed, shared across
  Projects holding one repo), issue filters (their code comments assume exactly the
  workspace-scoping this feature breaks). Phase 3 adds the agent/model/reasoning
  new-session seeds. Content-free physical prefs (theme, panel sizes) stay global.
- **Deep links**: `/session/{id}` stays. The session list is project-scoped, so an
  out-of-project deep link can't resolve from hydrated state — a pre-bootstrap
  `resolveProjectIdForSession(sessionId)` call answers "whose is it"; the client sets
  `activeProjectId` and reloads. Unknown/deleted session → normal 404 handling in the
  active Project. `/repo/{owner}/{repo}/new` resolves its slug against the
  project-filtered list (today `parseRepoLabel` + `.find()` would silently pick across
  Projects); `activeRepoUrl` fallback recovery is project-aware.
- **Naming cleanup**: the existing per-repo settings modal is called "project
  settings" in code (`ui-store.ts#projectSettingsRepoUrl`) — renamed to *repo
  settings* in 1a.

## Migration

Two idempotent passes, both **boot-fenced**: they run to completion before the HTTP
server listens and before any credential store, manager, watcher, or background writer
is constructed — otherwise an already-constructed legacy store can reserialize stale
fields over the rewritten host file, and any write landing mid-pass is silently lost
(the store is whole-document last-writer-wins).

**DB pass** (standard `user_version` chain): create Default; add
`sessions.project_id NOT NULL DEFAULT`; rebuild `repos`/`secrets`; backfill
`usage_turns`. Fixture list under [Data model](#data-model--storage).

**Credential-file pass** (own state tracking — `user_version` can't cover filesystem
writes, and "a valid project file exists" is *not* a completion marker, since a crash
after step 1 leaves exactly that):

1. Copy `shipit-credentials.json` **verbatim** (staged temp + fsync + rename +
   decrypt-read-back) to `projects/<default>/credentials.json`. Record state `copied`.
2. Rewrite the host file to host-owned fields (same staged protocol). State
   `host_rewritten`.
3. Move `system-prompt.md` into Default's dir; its readers/writers follow the new path
   in the same phase. State `prompt_moved`.
4. Move each `repo-memory/<repoHash>/` → `repo-memory/<default>/<repoHash>/` (plain
   renames within one filesystem). State `memory_moved`.

Each state is re-checked and the remaining steps re-run on every boot until all four
hold. Crash between 1 and 2 leaves both files complete — reads resolve per field-owner
(project file wins for project-owned fields) and the rewrite retries. In the same PR:
`CredentialStore.writeToDisk` becomes atomic (temp + rename — today it's an in-place
`writeFileSync` whose errors are swallowed), because after 1a there are 1+N such files
and the current fail-closed load would let **one** corrupt project file brick boot for
every Project — a single unreadable project file instead degrades to "Project
unavailable, surfaced in the switcher", never a failed boot.

A deployment that never creates a second Project behaves exactly as today.

## Trust model

Soft separation, stated plainly: **Projects hide, they do not protect.** No auth
layer; any browser reaching the deployment can switch into any Project. Scoped
delivery prevents accidental cross-viewing, not adversarial access. This is the
"trusted users" tier — housemates, close collaborators, your own two hats.

Sharp edges said out loud:

- **An ops session in any Project is host-root-equivalent** (host journal mounts,
  privileged Docker proxy). Projects do nothing to contain it.
- The shared bare cache serves one Project's fetched repo content to another for the
  same URL.
- Until phase 3, all Projects share Default's agent identity; until 1c, Default's
  GitHub identity (the alias intermediate).

For future auth: the typed resolution wrapper is the choke point for the HTTP/WS
surface; background flows are attributable via their `(projectId, …)` job keys. Real
authz later gates the wrapper and attributes those flows to users. Untrusted
multi-tenancy remains `docs/062-managed-shipit`.

## Phasing

- **1a — Core scoping, blind switch, scoped hydration.** `projects` table + registry;
  DB migrations + fixture; boot-fenced credential pass + atomic store writes +
  re-pointed singleton; typed four-mode resolution wrapper + `assertBelongsToProject`;
  project-keyed store **reads and writes** (+ `listAllProjects()` variants); late
  `remote_url`/graduation paths inherit the session's Project; session creation-path
  matrix; all three trust call sites; warm-pool composite keys + host-wide warm cap;
  usage stamping + scoped stats; the deletion protocol (Default + last Project
  undeletable); **scoped `/api/bootstrap` + SSE connect snapshot**; reload-based
  switching + switcher; deep-link resolver; content-bearing localStorage namespacing;
  "repo settings" rename; Linear per Project; system prompt moved + readers updated;
  **repo-memory scoping** (`repo-memory/<projectId>/<repoHash>/` + the
  `sweepOrphanedRepoMemory` nested traversal and `sweepOrphanedCaches` all-Projects
  hash union — promoted from phase 4: memory is per-user knowledge and must not
  cross-pollinate between trusted users sharing a repo).
- **1b — Scoped live delivery.** The three typed broadcast forms; split cross-project
  poller batches; project ids on URL-keyed single-entity events; `project_deleted` +
  stale-project fallback; scoped egress broadcasts. Blindness now server-enforced for
  session/repo/PR delivery (identity/settings surfaces still Default-aliased).
- **1c — Per-project git & GitHub.** Git execution factory (`{projectId}` /
  `{hostGlobal}` lanes, base-config inheritance, no direct git elsewhere); per-project
  `.gitconfig` incl. the legacy `gitIdentity` key; container broker + container
  gitconfig + scaffold re-provisioning + identity gates; `GitHubAuthManager` per
  Project; pollers/auto-push/prefetch/auto-merge per `(projectId, repo)` with
  per-project rate limits; bare-`repoKey` cache re-keying; bug-report token lane.
- **2 — Config surfaces.** Settings + system prompt per Project **including the
  consumer sweep** (`ProjectSettingsResolver` through PR-automation gates, steering,
  agent-execution, voice incl. TTS cache); MCP per Project with per-key `agentEnv`
  split + flow-state-derived OAuth; egress `project:<id>` + suppressed-defaults tier.
- **3 — Agent credential binding.** Per-Project `{provider → accountId}` binding;
  `AgentCredentialResolver` in provisioning, namer, `generateText`, refresh, limits;
  remove the `process.env` hydration; scope `agent_list`/`provider_accounts`/
  `subscription_limits` + the `agent_auth_*` event family + device-code replay;
  sign-out repairs dangling bindings; per-project agent/model/reasoning seeds; **drop
  the Default alias — Default becomes deletable**.
- **4 — Residual polish.** (Repo-memory scoping and both janitor edits were promoted
  into 1a.)

Each phase ships independently; the per-phase field-resolution matrix defines the
correct intermediate at every point.

## Risks & caveats

- **1c is the big sub-project**: ~400 non-test `githubAuth` references (~54 files,
  roughly double with tests), a git execution model, container re-provisioning, and
  background-flow semantics changes (per-project rate limits). Budget accordingly.
- **Repos PK rebuild**: data-shape hazards (duplicate raw URLs, unenforced
  `remote_url` correspondence with *live* writers, orphans); fixture list is the
  contract.
- **Credential pass**: boot-fenced, three-state, verbatim-copy; never field surgery on
  the encrypted blob; degraded single-file failure mode.
- **Shared git caches** leak repo content across Projects for one URL — accepted
  under trusted users.
- **Warm-pool cost**: N Projects × M repos standby containers without the new cap.
- **Naming**: "Project" vs Linear projects (UI copy rule) and the old per-repo
  "project settings" modal (renamed in 1a).

## Key files

- `src/server/shared/database.ts` — migrations; `shared/git.ts`, `orchestrator/
  git-config.ts`, `repo-git.ts`, `services/session-fork-merge.ts` — git factory lanes
  (1c)
- `app-di.ts` — `ProjectContext`; boot fencing; `process.env` hydration removal (3)
- `credential-store.ts` — re-pointed singleton, host store, atomic writes, migration
- `repo-store.ts`, `secret-store.ts`, `sessions.ts` — project-keyed reads/writes +
  `listAllProjects()`
- `warm-pool-manager.ts`, `services/claim-session.ts`, `services/child-sessions.ts`,
  `services/session-fork-merge.ts`, `services/templates.ts`,
  `api-routes-marketplace.ts` — creation-path matrix, composite keys
- `api-routes-session-repos.ts` (`/api/repos/trust` fan-out), `service-manager-setup.ts`
  — trust gate sites
- `trackers/registry.ts`, `services/issues.ts` — Linear and private planning
  GitHub tracker bindings per Project
- `app-lifecycle.ts` (broadcast forms), `route-registry.ts` (snapshot, auto-push,
  identity gate), `api-routes-bootstrap.ts` + `services/misc.ts` (scoped bootstrap)
- `pr-status-poller.ts`, `release-status-poller.ts`, `pr-polling-supervisor.ts`,
  `ci-grace-tracker.ts`, `repo-prefetch.ts`, `services/bug-report.ts` — per-job
  credentials + cache re-keying (1c)
- `steady-state-reclaim.ts` — sweep keying (1a)
- `src/client/stores/` (`project-store.ts`, reload switch), `utils/local-storage.ts`,
  `hooks/useSessionActivation.ts` + `App.tsx` (deep links), `SessionSidebar/`

## Related docs

- `docs/092-multi-repo-workspace` — the sidebar repo-group tier Projects sit above
- `docs/062-managed-shipit` — real (infra-level) multi-tenancy; explicitly not this
- `docs/150` provider accounts (phase 3 binds to these), `docs/155` agent credential
  isolation (unchanged)
- `docs/184-remove-platform-secret-forwarding` — secret flow Projects inherit
