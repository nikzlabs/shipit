---
issue: https://linear.app/shipit-ai/issue/SHI-233
description: Multiple isolated Projects per deployment — each with its own repos, sessions, Linear, GitHub identity, agent credentials, MCP servers, and settings; soft separation as a step toward trusted multi-user.
---

# Projects — multiple isolated project spaces in one deployment

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

- A Project is a named scope with a stable id. Every user-visible entity — repo, session,
  secret, tracker binding, MCP server, setting — belongs to exactly one Project.
- The deployment boots with a **Default** Project that adopts all pre-existing data
  (see [Migration](#migration)). A deployment always has ≥ 1 Project.
- The browser has one **active Project** at a time (persisted client-side). The sidebar,
  session list, issues panel, settings, header pills — everything renders only the active
  Project. Switching tears down the client state and reconnects scoped to the new Project.
- Server-side, nothing pauses on switch: sessions in other Projects keep running, their
  PRs keep polling, their containers idle out on the normal clock. Blindness is a client
  presentation rule, not a lifecycle rule.
- The in-container agent is **project-unaware**. Every brokered surface it touches — git
  credentials, `shipit issue`, secrets into compose services, MCP resolution — is resolved
  orchestrator-side *through the session's Project*. `shipit session create` spawns
  siblings within the same Project. No new agent-facing concept, no shipit-docs change
  beyond a mention.

## What is project-scoped vs global

Ruling for every deployment-global surface found in the audit:

| Surface | v1 scope | Notes |
|---|---|---|
| Repos (`repos` table) | **Project** | PK becomes `(project_id, url)`; trust, display order, hidden flag follow. Same URL may be open in two Projects. |
| Sessions | **Project** | `project_id` on `sessions`; ops/sandbox pseudo-groups exist per Project. |
| Linear binding | **Project** | Token + team move from the global credential blob into the Project's. The `credential-store.ts` comment "a Linear workspace is deployment-wide" is exactly what this feature retires. |
| GitHub identity | **Project** | Token / App auth + git author name/email per Project. Work PRs come from the work account. |
| Agent credentials | **Project** | Claude/Codex OAuth, `agentEnv`, provider accounts, limits pills — each Project holds its own subscription(s). Per-session credential isolation (docs/155) is unchanged; it just copies from the session's Project instead of the global blob. |
| MCP servers | **Project** | Server configs + their OAuth state. Built-in `playwright` + `shipit` bridge stay universal. |
| Settings + system prompt | **Project** | The behavioral settings (`autoCreatePr`, `enableSubAgents`, voice, live steering, …) and `.shipit/system-prompt.md` move per Project. Host-resource knobs (`maxIdleContainers`, docker memory) stay global — they govern the shared box. |
| Secrets | **Project** | Already `(repo_url, key)`; becomes `(project_id, repo_url, key)` alongside the repos PK change. |
| Egress allowlist | **Project tier** | The `scope` string pattern (`'global'` \| session id) gains `project:<id>` as a middle tier. Cheapest migration in the codebase, by design. |
| Repo memory | **Project** | `repo-memory/<projectId>/<repoHash>/` — memory written while working in one Project must not surface in another (it's the closest thing to per-user knowledge). |
| Usage tracking | **Project attribution** | `project_id` column on `usage_turns` so per-Project cost reporting is a query, not a join reconstruction. |
| Full reset | **Both** | New per-Project reset (wipe one Project's rows + credential dir); the deployment-wide `clearAll()` remains as the nuclear option. |
| Bare git cache / dep cache / overlay store | Global | Keyed by URL hash; they're content, not policy. Caveat: a repo fetched with Project A's credentials is served from cache to Project B — acceptable under the trusted-users model, documented as such. |
| Warm pool | Per (project, repo) | Follows the repos PK naturally (`warm_session_id` is a repos column). Pool *sizing* limits stay global. |
| Templates, marketplaces/skills | Global (v1) | Hardcoded/catalog content; revisit if Projects want private skill sets. |
| Resource budgets, janitors, idle enforcer, disk tiers | Global | One host, one budget. Projects contend; that's explicit and fine for trusted users. |
| PR polling | Global machinery | One supervisor iterates all sessions; emitted events are tagged with the session's Project (see SSE below). |
| Preview proxy | Unchanged | Session ids stay globally unique; `{sessionId}--{port}` routing needs no Project awareness. |
| Secret cipher key (`SHIPIT_SECRET_KEY`) | Global | One key encrypts all Projects' secrets. |

## Data model & storage

**New table:**

```sql
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,      -- uuid
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,  -- for URLs / dir names
  display_order INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);
```

**Existing tables** (all via the standard additive-migration path in `database.ts`):

- `sessions.project_id` — backfilled to the Default Project.
- `repos`: PK `url` → `(project_id, url)`. SQLite can't alter a PK, so this is a
  rebuild-and-copy migration (create `repos_v2`, copy with `project_id = <default>`,
  drop, rename). All `RepoStore` call sites gain a `projectId` argument.
- `secrets`: same rebuild, key `(project_id, repo_url, key)`.
- `usage_turns.project_id` — backfilled via each row's session.
- `egress_allowlist` / `egress_settings`: no schema change; the `scope` TEXT column
  admits `project:<id>` values.

**Credential storage** splits the single JSON blob:

```
{credentialsDir}/
  shipit-credentials.json                 # host-level remnant: host-resource settings,
                                          # anything not claimed by a Project
  projects/<projectId>/
    credentials.json                      # agent auth, agentEnv, provider accounts,
                                          # GitHub token, Linear binding, MCP servers,
                                          # behavioral settings
    system-prompt.md                      # replaces {workspaceDir}/.shipit/system-prompt.md
  sessions/<sessionId>/                   # unchanged per-session isolation subtree
  repo-memory/<projectId>/<repoHash>/     # was repo-memory/<repoHash>/
```

## Orchestrator architecture

**`ProjectRegistry`** (new, `orchestrator/projects.ts`): owns the `projects` table and a
lazy map `projectId → ProjectContext`. A `ProjectContext` holds the per-project manager
instances that are singletons today:

- `CredentialStore` (per-project file) — the global one shrinks to host-level facts
- `GitHubAuthManager`, `AuthManager` (Claude), `CodexAuthManager`, `ProviderAccountManager`
- MCP config + OAuth state
- settings accessor + system prompt path

Managers that stay singletons (docker, service manager, runners registry, janitors,
pollers, preview proxy) keep taking these as before; the routes/services that today reach
for `deps.credentialStore` / `deps.githubAuth` instead resolve the Project first and take
the context's instance. This is the bulk of the mechanical work.

**Request → Project resolution**, one helper with strict precedence:

1. `sessionId` present (WS, per-session routes, worker relays) → the session row's
   `project_id`. Authoritative; a session can never act in another Project.
2. Explicit `projectId` query/body param (repo list, session create, settings, secrets,
   MCP, tracker connect, github auth routes).
3. Neither → 400. No implicit "active project" server-side — the server has no notion of
   which Project a browser is looking at except what the request says.

**SSE filtering** (the load-bearing change for blindness): `/api/events` gains a
`?project=<id>` param; each `SSEClient` registers with its Project. `sseBroadcast` gains a
scope argument — `{ project: id }` or `{ global: true }` — and delivers only to matching
clients. Session/repo/PR/tracker events are project-tagged; infra events (docker memory,
system info, update available) stay global. The bootstrap snapshot
(`route-registry.ts`) filters `session_list`, `repo_list`, `github_status`, `agent_list`,
`provider_accounts`, `subscription_limits`, `egress_settings` to the requesting Project.

**The tracker seam**: `TrackerRegistry` is already rebuilt per request precisely because
Linear and GitHub have different scopes. It now binds Linear from the *Project's*
credential store — the deployment-wide assumption disappears; the registry's shape does
not change.

## Client

- **`useProjectStore`**: `projects: ProjectInfo[]`, `activeProjectId` (localStorage).
  Project CRUD over new `/api/projects` routes.
- **Switcher**: at the top of the sidebar, above the repo groups — the current name plus
  a menu of Project names, "New project…", "Rename", "Delete" (delete = the per-Project
  reset, confirm-gated). Names only; no badges, counts, or activity dots (decision:
  completely blind).
- **Switching** reuses the centralized reset in `stores/actions/session-actions.ts`:
  reset all stores, reconnect SSE with the new `?project=`, re-bootstrap. Equivalent to a
  fresh page load into the other Project.
- **Routing**: session URLs stay `/session/{id}` (ids are globally unique). Deep-linking
  a session that belongs to another Project auto-switches the active Project. The
  repo-new route gains the project context implicitly from the active Project.
- **localStorage namespacing**: per-project UI state (collapse sets, active repo, panel
  sizes) keys gain the project id; deployment-level prefs (theme) do not.

## Migration

One boot-time migration, idempotent, in the standard `user_version` chain plus a
credential-file pass:

1. Create the Default Project (fixed well-known id) if `projects` is empty.
2. Backfill `project_id` on `sessions`, `repos` (rebuild), `secrets` (rebuild),
   `usage_turns`.
3. Move the claimed fields (agent auth, `agentEnv`, provider accounts, GitHub token,
   Linear, MCP, behavioral settings) from `shipit-credentials.json` into
   `projects/<default>/credentials.json`, leaving host-level fields behind. Write a
   `.bak` of the original blob first; the move is one atomic rewrite of both files.
4. Move `{workspaceDir}/.shipit/system-prompt.md` → the Default Project's dir;
   `repo-memory/<hash>` → `repo-memory/<default>/<hash>`.

A deployment that never creates a second Project behaves exactly as today.

## Trust model

Soft separation, stated plainly: **Projects hide, they do not protect.** There is no
auth layer; any browser that can reach the deployment can switch to any Project and see
its sessions, secrets (names), and settings. SSE filtering prevents accidental
cross-viewing, not adversarial access. This is the "trusted users" tier — housemates,
close collaborators, your own two hats.

The design keeps one clean seam for the future: *all* project-scoped access flows through
the single request→Project resolution helper. Real users/authz later means putting a check
in that one choke point (plus login UI) — a follow-up doc, not a rework. Untrusted
multi-tenancy remains `docs/062-managed-shipit` (per-tenant orchestrators).

## Phasing

1. **Core scoping** — `projects` table, Default migration, `project_id` on
   sessions/repos/secrets, request-resolution helper, SSE filtering + scoped bootstrap,
   client store + switcher + blind switching. Linear + GitHub identity per Project
   (the tracker seam and `GitHubAuthManager` instantiation move into `ProjectContext`).
2. **Config surfaces** — settings + system prompt per Project; MCP servers + OAuth per
   Project; egress `project:<id>` tier.
3. **Agent credentials** — Claude/Codex auth, provider accounts, token sync, limits
   pills per Project. The deepest cut (touches docs/150 multi-account routing and
   docs/155 per-agent credential isolation); sequenced last deliberately.
4. **Reporting & lifecycle** — per-Project usage reporting, per-Project reset,
   repo-memory scoping, localStorage namespacing polish.

Each phase ships independently; until phase 3, agent credentials remain global and every
Project shares them — a correct intermediate state for the single-user-multiple-contexts
case.

## Risks & caveats

- **Repos PK rebuild** is the riskiest migration (SQLite table rebuild with FK-like
  references from warm pool and trust checks). Needs a dedicated migration test over a
  populated fixture DB.
- **Credential blob split** must be atomic-ish and backed up; a half-moved blob strands
  auth. The `.bak` + single-rewrite approach above.
- **Shared git caches** leak repo *content* across Projects for the same URL. Accepted
  under trusted users; called out so nobody mistakes Projects for tenancy.
- **`sseBroadcast` call-site sweep**: every emit must declare a scope; an unscoped emit
  should be a type error, not a silent global broadcast.
- **Naming**: "Project" collides mildly with Linear projects. In UI copy, "Project"
  unqualified always means the ShipIt concept; Linear's is written "Linear project".

## Key files

Everything named in the audit; the primary touch points:

- `src/server/shared/database.ts` — migrations, new table
- `src/server/orchestrator/app-di.ts` — manager construction moves into `ProjectContext`
- `src/server/orchestrator/credential-store.ts` — split global/per-project
- `src/server/orchestrator/repo-store.ts`, `secret-store.ts` — project-keyed
- `src/server/orchestrator/trackers/registry.ts` — Linear from project credentials
- `src/server/orchestrator/app-lifecycle.ts` (`sseBroadcast`), `route-registry.ts`
  (bootstrap snapshot) — scoped delivery
- `src/client/stores/` — new `project-store.ts`, reset wiring in
  `stores/actions/session-actions.ts`, switcher in `SessionSidebar/`

## Related docs

- `docs/092-multi-repo-workspace` — the sidebar repo-group tier Projects sit above
- `docs/062-managed-shipit` — real (infra-level) multi-tenancy; explicitly not this
- `docs/150` provider accounts, `docs/155` agent credential isolation — phase 3 touches
- `docs/184-remove-platform-secret-forwarding` — secret flow Projects inherit
