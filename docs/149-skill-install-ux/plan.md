---
status: planned
priority: medium
description: Inline skill/plugin discovery and install surface in ShipIt, matching the /plugin and /plugins TUIs from Claude Code and Codex.
---

# 149 — Skill Install UX

## Summary

Both Claude Code and Codex CLI shipped first-class skill/plugin browse-and-install
UIs in 2026 (Claude `/plugin`, Codex `/plugins` + `/skills`). ShipIt users
currently have to hand-write `.claude/skills/<name>/SKILL.md` or shell out to the
underlying CLI — neither fits §2 (inline > link-out) or §5 (chat is the input
surface). This doc designs an inline ShipIt-native surface that matches the
floor of what the two CLIs offer (Discover / Installed / Marketplaces / Errors,
install/enable/disable/uninstall) and lifts the ceiling where a GUI gives us
leverage the TUI doesn't (Monaco preview of SKILL.md, context-cost meter, diff
on marketplace update). ShipIt only supports **repo-scope** installs (skills
live in the workspace and travel with the repo); the CLIs' user/local scopes
are explicitly out of scope.

This builds on:

- **doc 096** — `.claude/skills/` access (Layer A harness permission + file-tree
  visibility). Status: done.
- **doc 138** — Skill *invocation* via `/name` (Claude) and `$name` (Codex), and
  the `/`-autocomplete menu fed by `services/skills.ts`. Status: done.

Doc 138 already wired discovery for *project* skills the user has *already
authored*. This doc covers the next layer up: discovery and install of skills
the user **hasn't** authored — from public catalogs, the agent's official
marketplaces, and team-internal sources.

**Repo-scope only.** Skills install into the workspace's `.claude/skills/` or
`.codex/skills/` and travel with the repo via auto-commit. User-scope skills
and Codex built-in `$CODEX_HOME` skills are explicitly out of scope — both
require a per-user persistent volume mounted into the session container,
which is much larger than this doc wants to take on.

## Background: how the two CLIs handle this today

Both CLIs converged on the same surface (a `/`-invoked TUI with Discover /
Installed / Marketplaces tabs) and the same open standard
([agentskills.io](https://agentskills.io)) for the file format. Where they
differ is mostly cosmetic — the underlying data model is the same.

### Claude Code (`/plugin`)

Source: <https://code.claude.com/docs/en/discover-plugins>, <https://code.claude.com/docs/en/skills>.

| Surface | Behavior |
|---|---|
| `/plugin` | Opens 4-tab TUI: **Discover** / **Installed** / **Marketplaces** / **Errors**. Tab/Shift-Tab cycles. |
| Discover tab | Lists plugins across all added marketplaces. Each detail page shows context-cost estimate, last-updated date, and a "Will install" preview of commands/skills/agents/hooks/MCP/LSP. |
| Installed tab | Grouped by scope; errors first, favorites next, disabled folded. `f` to favorite, type to filter, Enter for details. |
| Marketplaces tab | Add / remove / update / toggle auto-update per catalog. |
| Non-interactive | `/plugin install <name>@<market>`, `/plugin enable\|disable\|uninstall …`, `/plugin marketplace add\|list\|update\|remove`, `/reload-plugins`. CLI flag form: `claude plugin install … --scope project\|user\|local`. |
| Catalog sources | `owner/repo` (GitHub), any Git URL with `.git` suffix, local dir with `.claude-plugin/marketplace.json`, remote URL to a `marketplace.json`. |
| Official catalog | `claude-plugins-official` (pre-added). Community catalog (`anthropics/claude-plugins-community`) is opt-in. |
| Install scopes | **user** (`~/.claude/skills/`), **project** (`.claude/skills/`, committed), **local** (`.claude/settings.local.json`, gitignored), **managed** (admin, read-only). |
| Namespacing | Plugin-provided skills surface as `/<plugin>:<skill>` — cannot collide with project skills. |
| Reload | `/reload-plugins` picks up changes without restarting the session. |
| Auto-update | Per-marketplace toggle. Official defaults on, third-party defaults off. |
| Plugin manifest | Two file types, two repos: in a *marketplace* repo, `.claude-plugin/marketplace.json` describes the catalog and pins each plugin to a commit SHA. In a *plugin* repo (or a plugin's subdirectory inside a catalog), `.claude-plugin/plugin.json` describes one plugin. ShipIt reads both; ShipIt does NOT write either into the user's workspace. |

### Codex CLI (`/plugins`, `/skills`)

Sources: <https://developers.openai.com/codex/plugins>, <https://developers.openai.com/codex/plugins/build>, <https://developers.openai.com/codex/skills>. Marketplace UX shipped in codex-cli v0.117.0 (2026-03-26).

| Surface | Behavior |
|---|---|
| `/plugins` | Opens marketplace browser; tabs switch sources, Enter inspects, Space toggles enabled on installed plugins. |
| `/skills` | Skill picker — same shape as Claude's `/skill-name` menu in the composer. |
| `$skill-installer` | Built-in **skill** that installs other skills. `$skill-installer linear` installs the `linear` skill. New skills are auto-detected; a restart may be needed if they don't appear. |
| Non-interactive | `codex plugin marketplace add <owner/repo \| git URL \| local path>` documented; CLI install/uninstall verbs exist but aren't enumerated in the public docs as crisply as Claude's. |
| Catalog sources | Same shape as Claude: GitHub shorthand, Git URL, local directory. |
| Install scopes | **Project** (`.agents/skills/` per agentskills.io standard, or `.codex/skills/`), **user** (`$HOME/.agents/skills` or `~/.codex/skills/`), **admin** (`/etc/codex/skills`), **system** (bundled). The path migration to `.agents/skills` aligns with the open standard. |
| Plugin cache | `~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/` (or `local` for local plugins). |
| Plugin manifest | `.codex-plugin/plugin.json`. Plugin contents live at the plugin root: `skills/`, `hooks/`, `.app.json`, `.mcp.json`, `assets/`. |
| Composition | Plugins bundle **skills** + **apps/connectors** (GitHub, Slack, Google Drive) + **MCP servers** + **hooks**. |
| Disable | `enabled = false` in `~/.codex/config.toml` (file-based, not a TUI verb). |
| Catalog injection | `codex exec` auto-injects a `<skills_instructions>` block listing every discovered skill — the model can pick a skill even without an explicit `$name`. Distinct from Claude's textual `/skill` expansion (see doc 138). |

**Note — directory layout uncertainty:** doc 138 verified empirically against
`codex-cli 0.132.0` that project skills live at `.codex/skills/<name>/SKILL.md`.
The current OpenAI docs (May 2026) describe `.agents/skills/` as the canonical
path, aligned with the agentskills.io open standard. Both likely work in
current Codex (backwards-compat); ShipIt should **scan both** until empirical
re-verification confirms which is canonical. Treat as an implementation detail,
not a blocker.

### Convergences (good news)

| Aspect | Both agents |
|---|---|
| Open standard | [agentskills.io](https://agentskills.io) — `SKILL.md` with `name`/`description` frontmatter. Skills are portable across Claude, Codex, Cursor, Copilot, Gemini, etc. |
| Manifest pattern | `.{agent}-plugin/plugin.json` + manifest references to `skills/`, `hooks/`, `.mcp.json` |
| Catalog sources | GitHub shorthand + Git URL + local dir |
| TUI verbs | Browse / install / uninstall / enable / disable / toggle enabled / inspect details |
| Bundle contents | Skills + MCP servers + hooks (Codex adds app connectors; Claude adds LSPs) |
| Install scope split | User-global vs project-committed |

### Divergences (things ShipIt must branch on)

| Aspect | Claude | Codex |
|---|---|---|
| Composer token | `/name` | `$name` |
| Project skill path | `.claude/skills/` | `.codex/skills/` or `.agents/skills/` (see note) |
| User skill path | `~/.claude/skills/` | `~/.codex/skills/` or `~/.agents/skills/` |
| Plugin manifest dir | `.claude-plugin/` | `.codex-plugin/` |
| Catalog manifest | `.claude-plugin/marketplace.json` | (per OpenAI docs; format not fully specced publicly yet) |
| Official catalog | `claude-plugins-official` | (OpenAI hosts its own; name TBD per public docs) |
| Reload | `/reload-plugins` | Sometimes requires session restart |
| Disable mechanism | Per-plugin TUI verb | `~/.codex/config.toml` flag |
| Extra bundle contents | LSP servers | App connectors |

## Design

### Surface: a Skills tab inside the existing Settings dialog

Add **Skills** as a new tab in the existing Settings dialog
(`src/client/components/Settings.tsx`). The dialog today has two sidebar
groups: an **Agent** group (`agent-claude`, `agent-codex` — split per
backend) and a **General** group (GitHub, Git, Instructions, MCP, Advanced).
Place Skills under the **General** group rather than the Agent group,
because the surface is agent-aware but not agent-scoped (one Skills tab
follows whichever session you're on, like MCP). Position it just before
MCP so the two extension-management surfaces sit adjacent.

Skill management is configuration, not turn-by-turn workflow, so it
belongs with the other agent-config affordances.

**Per-tab dialog width.** Today the dialog is `max-w-2xl` (672 px) with
`md:h-120` (480 px), which suits the existing form-shaped tabs (single-column
inputs in `McpServerSettings.tsx`, the GitHub token form, git identity,
instructions textarea). The Skills tab needs roughly two-pane proportions —
a ~320 px plugin list plus a ~640 px detail/preview pane — so the dialog
must grow when Skills is active. Implementation: make the `DialogContent`
`className` conditional on the active tab so Skills swaps to `max-w-5xl`
(1024 px) + `md:h-[80vh]` while the other tabs stay at their current size.
This avoids regressing the existing forms (which would float in awkward
whitespace at 1024+ px) and avoids a separate dialog hierarchy.

**v1 sub-tabs:** Discover + Installed only. v2 adds Marketplaces + Errors.
The full target shape (all four sub-tabs) is described below; v1 ships the
first two and the rest are deferred — see Build order for the split.

1. **Discover (v1)** — browse the active agent's catalogs. Search bar at top.
   Cards show name, description, source marketplace, **context-cost estimate**,
   last-updated date, and a "Contains: 3 skills, 1 MCP server" capsule.
2. **Installed (v1)** — what's already in the workspace. Each row:
   marketplace + plugin chip, uninstall overflow. v1 lists only plugins
   ShipIt itself installed (identified by the install marker — see
   "Install marker — managed vs hand-written skills"). Skills the user
   wrote by hand under `.claude/skills/` show up in the existing
   `/`-autocomplete (doc 138) but are not listed here, since this surface is
   "what's installed *from a marketplace*." **No enable/disable in v1** —
   only install/uninstall (see Data model: enable/disable deferred to v3).
3. **Marketplaces (v2)** — add (paste GitHub shorthand, Git URL, or local
   path), list, refresh, remove, toggle auto-update. The official
   Anthropic/OpenAI catalogs come pre-added per active agent.
4. **Errors (v2)** — load failures, missing dependencies, marketplace fetch
   errors. Each row has a "Ask agent to fix" CTA that drops a contextual
   prompt into chat (e.g. *"install the rust-analyzer binary so the
   `rust-analyzer-lsp` plugin works"*) — keeps us §5-compliant: the *agent*
   runs the fix, not a hidden shell button.

This is a chat-shaped surface (per §5): skills *are* chat tools, so a tab
that manages them is "configure my chat" — not a category mistake like a
"click to run npm test" button. **No `/`-autocomplete launcher.** An earlier
draft proposed a "Browse skills…" entry at the bottom of the
`/`-autocomplete menu added in doc 138; on reflection that mixes the
invocation-flow trigger (typing `/` at the start of the composer to call a
skill) with the management-flow trigger, and ambiguous behavior for the
in-flight `/` token. Open Settings → Skills via the existing Settings
shortcut.

### Install flow

Click "Install" on a Discover card → opens an **Install sheet**. The
destination path is per active agent (Claude → `.claude/skills/`; Codex →
`.codex/skills/` or `.agents/skills/` per the directory-layout note above):

```
┌──────────────────────────────────────────────────────┐
│  commit-commands                                     │
│  by anthropic-official  ·  updated 3d ago            │
├──────────────────────────────────────────────────────┤
│  Installs to <agent skills dir>/ in this repo        │
│                                                      │
│  Will install:                                       │
│    📄  commit-commands__commit/SKILL.md     +52 lines│
│    📄  commit-commands__push/SKILL.md       +38 lines│
│                                                      │
│  Context cost: ≈ 1.2 KB / turn                       │
│                                                      │
│  ┌──── Preview: commit-commands__commit/SKILL.md ───┐│
│  │ --- (Monaco, read-only)                          ││
│  │ name: commit-commands:commit                     ││
│  │ description: …                                   ││
│  │ ---                                              ││
│  │ Stage and commit the current changes…            ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│              [Cancel]                  [Install]     │
└──────────────────────────────────────────────────────┘
```

The Monaco preview is **inline by default**, not behind a "Preview" button.
This is the headline GUI lift over the TUI (which can only show a
description), and also a real defense-in-depth: a list of file paths with
"+N lines" tells the user nothing about what the skill will do; the body
does. Showing it by default means the user has actually had the chance to
read what they're installing.

When a plugin contains multiple skills, the preview area gets a left-side
file picker (default-selected to the first skill); switching files keeps the
Monaco panel mounted. v1 only shows `SKILL.md` files; v3 (full plugin
composition) extends the preview to MCP configs, hooks, etc.

### Cross-agent installs in mixed-agent repos

A repo can be opened in a Claude session today and a Codex session tomorrow.
The Install sheet writes to the **active agent's** skills directory — install
once for Claude, again for Codex. No checkbox; the active session decides.
Same skill installed for both backends lives in two directories, since the
agentskills.io standard works across both but the directory-naming
conventions don't share a path. (If/when ShipIt's Codex side adopts
`.agents/skills/` and Claude ever supports it too, this collapses to one
write; not a v1 concern.)

### Concurrency and the install / turn relationship

Three concurrency cases the install flow must handle, since installs land
files in the workspace and the workspace is also being mutated by the
running agent:

1. **Install during an active turn.** The Install button is disabled while a
   turn is running (the existing `runner.running` state, mutated directly per
   CLAUDE.md "Mutate runner state directly"). Hovering shows a tooltip:
   "Agent is working — install will become available when it's done."
   Rationale: an in-flight turn that triggers `agent_result` mid-install
   risks the existing auto-commit (`postTurnCommit()` in
   `agent-execution.ts`) sweeping plugin files into a commit alongside
   unrelated agent edits, or losing the install's own commit to a race.
2. **Path-scoped `git add` on install commit.** Even with #1, the install
   commit must `git add` only the plugin's own paths, never `git add -A` or
   `git add .`. This prevents accidentally including unrelated user edits
   that happen to be in the working tree. **This is a new rule for the
   install path, NOT an existing server convention.** `GitManager.autoCommit()`
   (`src/server/shared/git.ts:70`, with the `git add -A` call at line 78)
   uses `git add -A` and is fine for its job
   (committing whatever the agent edited during a turn); the install flow
   needs the opposite discipline because the user — not the agent — is the
   one driving the change, and there may be unrelated in-flight work in the
   tree. Implementation: call `simpleGit.add([…paths])` directly with the
   plugin's own files plus the install marker, NOT through `autoCommit`.
   **Scope of this guarantee is single-commit only.** The next user turn's
   `postTurnCommit()` will still run `autoCommit()`'s `git add -A` and
   fold any unrelated edits sitting in the tree into the first
   agent-attributed commit afterward — that's auto-commit's job and not
   something this doc changes. The install-flow rule keeps the *install
   commit itself* clean; subsequent commits behave as usual.
3. **Multi-viewer / double-click races on a single session.** Two browser
   tabs attached to the *same* session can both see the Install button
   enabled (the runner broadcasts state to every attached viewer per
   CLAUDE.md "Mutate runner state directly"), and a single tab can fire
   Install twice in rapid succession. Both cases race on the git index and
   on the `.claude/skills/` directory. Resolution: an in-process
   per-workspace install mutex inside `services/marketplace.ts`, shaped
   like the canonical `Map<key, Promise<...>>` pattern used by
   `_mcpInstallMutex` in `src/server/session/session-worker.ts:133` —
   concurrent callers coalesce on the in-flight promise; the entry is
   deleted in `.finally()`. This is runtime state, not persistent state
   (surviving a process restart with the lock held would be a bug), so it
   belongs in the service module, NOT in `RepoStore` (which is SQLite).
   Keyed by `workspaceDir`, which is per-session: `RepoGit` gives each
   session its own complete `.git/` via hardlinked local clones with no
   shared worktree (`repo-git.ts:51-52`), and `session-dir-factory.ts:28-29`
   roots `workspaceDir` under the session's own directory. So the mutex
   covers same-session-multi-viewer and same-tab-double-click; cross-session
   installs on the same repo are independent operations on independent
   workspaces and don't need serialization at all.

### Install scope — repo-only

Only **project scope** is supported. Skills install to `.claude/skills/` (or
`.codex/skills/`) in the workspace and travel with the repo via auto-commit.
This is intentional:

- **It matches how teams already think about skills.** Skills are code-equivalent
  (they steer the agent's behavior on this codebase); they should live in the
  repo and be reviewed in PRs alongside it.
- **It avoids the persistent-volume yak-shave.** User-scope skills need a
  per-user volume mounted at `/root/.claude/` and `/root/.codex/`, which
  touches container lifecycle in ways that go well beyond skills.
- **Codex built-in `$CODEX_HOME` skills are explicitly out of scope.** They live
  inside the container and aren't orchestrator-reachable over the HTTP link
  (per doc 138); surfacing them requires the same volume work.

If users later need cross-repo skill sharing, the path is either (a) publish
the skill to a team-internal marketplace they `marketplace add` per repo, or
(b) revisit the persistent-volume design as its own follow-up.

### Reimplement, don't wrap

Two paths considered:

- **Wrap** the CLI: drive `/plugin install foo@bar` through the agent process
  and render the TUI's output state. Fast, inherits CLI updates for free, but
  locks us to Claude semantics (Codex's verbs differ) and to whatever the TUI
  chooses to surface — we can't easily add the Monaco preview or context-cost
  meter.
- **Reimplement**: fetch `marketplace.json` ourselves, write files to
  `.claude/skills/` directly. More code, but agent-agnostic and gives us full
  rendering control. Doc 138 already chose this shape for the *invocation*
  side (the `/`-autocomplete is reimplemented, not a CLI wrap). v1 does NOT
  write to `.claude/settings.json` — it only writes `SKILL.md` files. v3
  (full plugin composition with MCP servers) is where settings-file merge
  semantics start to matter; see the dedicated note under "Settings-file
  ownership" below.

**Decision: reimplement.** The agent-agnostic principle (CLAUDE.md preamble)
pushes here. The marketplace data model is small (`marketplace.json` is well
specced for Claude; Codex's catalog format will need empirical reading of an
official catalog, but converges structurally). The catalog fetch + cache layer
is ~one file; the UI is the bigger surface and that exists either way.

### Data model

Three new types in `src/server/shared/types/domain-types.ts`:

```ts
type MarketplaceSource =
  | { kind: "github"; ownerRepo: string; ref?: string }
  | { kind: "git";    url: string;      ref?: string }
  | { kind: "local";  path: string }
  | { kind: "url";    url: string };

interface MarketplaceInfo {
  id: string;           // catalog short name, e.g. "claude-plugins-official"
  source: MarketplaceSource;
  agentId: AgentId;     // catalog is per-backend
  autoUpdate: boolean;
  lastFetchedAt?: string;
  status: "ok" | "fetch-failed" | "loading";
}

interface PluginInfo {
  marketplaceId: string;
  name: string;
  version: string;
  description?: string;
  pinnedSha?: string;
  lastUpdated?: string;
  contains: {
    skills: SkillRef[];   // {name, description}; v1 only populates this
    // v3 adds: mcpServers, hooks, apps?, lspServers?
    // (Ref types defined alongside in v3 — left out of v1 to keep the
    // type honest about what's actually wired.)
  };
  estimatedContextBytes: number;
}
```

New backend service `src/server/orchestrator/services/marketplace.ts`:

```ts
// v1:
listMarketplaces(agentId): MarketplaceInfo[]
listPlugins(marketplaceId): PluginInfo[]
installPlugin(workspaceDir, marketplaceId, pluginName): InstallResult
uninstallPlugin(workspaceDir, marketplaceId, pluginName): void

// v2 adds custom-marketplace verbs:
addMarketplace(source, agentId): MarketplaceInfo
removeMarketplace(id): void
refreshMarketplace(id): MarketplaceInfo

// v3 adds enable/disable, once we have a persistence target for the flag.
```

These are pure functions in the §services layer pattern (CLAUDE.md), consumed
by both the HTTP route and a future WS message for live install progress.
Enable/disable is deferred to v3 because the flag has nowhere to persist in
v1: writing to `.claude/settings.json` is explicitly out of scope (see
"Settings-file ownership"), and a sidecar-only flag would be invisible to
the agent CLI on next spawn. v3 lands the settings-file merge layer that
also unlocks this.

### Routes

Following `add-endpoint` pattern. **Two route files**, because the surface
splits cleanly into app-wide and session-scoped halves:

- `src/server/orchestrator/api-routes-marketplace.ts` (new) — app-wide
  marketplace routes.
- `src/server/orchestrator/api-routes-files.ts` (existing) — gains the
  session-scoped plugin install/uninstall/enable verbs, matching the
  existing `GET /api/sessions/:id/skills` from doc 138 that already lives
  there.

```
# App-wide (api-routes-marketplace.ts):
GET    /api/marketplaces?agent=claude
POST   /api/marketplaces                 { source }
DELETE /api/marketplaces/:id
POST   /api/marketplaces/:id/refresh
GET    /api/marketplaces/:id/plugins

# Session-scoped (api-routes-files.ts):
POST   /api/sessions/:id/plugins/install   { marketplaceId, pluginName }
DELETE /api/sessions/:id/plugins/:marketplaceId/:pluginName

# v3 adds:
# PATCH  /api/sessions/:id/plugins/:marketplaceId/:pluginName   { enabled: bool }
```

App-wide marketplace state persists in a new
`src/server/orchestrator/marketplace-store.ts` — **SQLite via
`DatabaseManager`**, class wrapping prepared statements. This matches the
pattern used by other domain-data stores like `repo-store.ts` and
`secret-store.ts`. (The orchestrator does have JSON-file stores —
`credential-store.ts` writes `JSON.stringify` to disk at line 95 — but
those are credential-shaped: small, secret, hot-read. Marketplaces are
queryable domain data and want the SQLite branch.) A new `marketplaces`
table holds `id`, `source` (JSON-encoded), `agent_id`, `auto_update`,
`last_fetched_at`, `status`. v1 seeds it with the official Claude/Codex
catalogs at orchestrator startup and never writes to it again (since v1
doesn't expose add/remove); the table still exists from day one so v2 can
layer on without restructuring or needing *its own* additional migration
on top of v1's. (Adding the table is itself a new entry in
`src/server/shared/database.ts`'s `MIGRATIONS` array.)

### Backend-agnostic at the surface; agent-specific at the writer

`installPlugin()` dispatches on `agentId`. The skills directory layout is
**flat one level deep**, not nested per plugin — doc 138's `scanSkillsDir()`
(`src/server/shared/skill-scan.ts:52`) reads exactly `<skillsDir>/<name>/SKILL.md`
and is intentionally non-recursive. A nested `<plugin>/skills/<name>/SKILL.md`
layout would not be picked up by the existing scanner; the `/`-autocomplete
would not list plugin skills and invocation would break. So:

- **Claude** → write to `.claude/skills/<plugin>__<skill>/SKILL.md` (double
  underscore as the in-directory delimiter, filesystem-safe). Frontmatter
  `name` is set to `<plugin>:<skill>` to match Claude's canonical
  invocation token. **This requires a small amendment to doc 138's regexes**
  — both `MessageInput.tsx:265` (`/^\/([a-zA-Z0-9._-]*)$/`) and
  `agent-execution.ts:115` (`/^\/[a-zA-Z0-9._-]+/`) currently exclude `:`,
  so the autocomplete would close on the `:` and the leading-slash detector
  would miss the full token. Widen both regexes to allow `:` (e.g.
  `/^\/([a-zA-Z0-9._:-]*)$/`); call out as a v1-scoped doc 138 amendment
  in Key files.
- **Codex** → write to `.codex/skills/<plugin>__<skill>/SKILL.md` (or
  `.agents/skills/` per the directory-layout note). Tiebreaker for the
  write destination, evaluated in order: (1) if exactly one of the two
  directories exists and is non-empty, write there; (2) if both exist and
  both are non-empty, prefer the one with more entries; (3) if neither
  exists (the default), use `.codex/skills/` until the v0 spike confirms
  `.agents/skills/` is canonical. Reads scan both directories regardless.
  Frontmatter `name` set to `<plugin>:<skill>`; invocation token is
  `$<plugin>:<skill>`. Codex's catalog-injection model reads `SKILL.md`
  directly (per doc 138) so the regex amendment doesn't bind there, but
  it's harmless for Codex too.

The catalog *fetch* logic is shared (Git clone or HTTP download + JSON parse
of the manifest). Only the *write* step branches per agent.

### Install marker — managed vs hand-written skills

`.claude/skills/` is the same directory users author skills into by hand
(per doc 096). The install/uninstall flow must not stomp on user-authored
work. ShipIt marks every directory it installs with a sentinel file:

```
.claude/skills/<plugin>__<skill>/
  SKILL.md
  .shipit-installed.json   # { marketplaceId, pluginName, version, installedAt }
```

Three policies that fall out:

- **Install refuses if the target directory exists without a marker.** The
  user gets an error explaining the collision and instructions to either
  rename their hand-written skill or uninstall the existing one. We do not
  auto-merge or auto-rename.
- **Install over an existing ShipIt-managed directory is treated as
  upgrade.** Version differs → diff the new vs old `SKILL.md` and show in
  the install sheet; same version → no-op.
- **Uninstall refuses if the marker is absent or modified.** Deleting a
  user-authored directory by accident is unrecoverable; the marker is the
  consent record.

### Settings-file ownership

The dev-loop Claude harness already reads `.claude/settings.json` from the
workspace (per doc 096 — that's where the project pins `Edit/Write(.claude/skills/**)`).
v1 does **not** touch `.claude/settings.json`; the install flow only writes
`SKILL.md` files and the install marker. The collision question only opens
up in v3 (full plugin composition writes MCP server entries to
`.claude/settings.json` and `.codex/config.toml`). At that point the writer
must MERGE into the existing file, scoping its edits to a known
`extraKnownMarketplaces` / `mcpServers.<plugin-namespace>` block so a
hand-written rule in another block survives. The merge design lives in v3,
not here.

### Pick up new skills — pick the lightest primitive per backend

Two facts decide the right primitive:

- ShipIt runs Claude non-interactively via `claude -p`. `/reload-plugins`
  is CLI process-state machinery that doesn't flow through the prompt stream
  (per doc 132: built-in slash commands are CLI process-state, not
  prompts). Sending `/reload-plugins` as a chat message would either be
  echoed as prose or hit doc 138's `Skill` allowlist as a malformed
  invocation.
- `restartAgent` (doc 127) destroys and recreates the entire agent
  container — a seconds-scale operation that doc 127 itself calls out as
  overkill when a lighter alternative suffices.

So we pick by backend, using the lightest thing that works:

| Backend | Process model | What we do on install |
|---|---|---|
| Claude `claude -p` (default) | New process spawned per turn from `ClaudeProcess` (PTY) in `src/server/session/claude.ts` (`-p` arg at ~line 125, `pty.spawn("claude", …)` at ~line 190) | **Nothing.** The next user prompt naturally spawns a fresh `claude -p`, which re-scans `.claude/skills/` on startup. |
| Streaming Claude (doc 140 live-steering, if/when enabled) | Persistent worker-side process | Call `killAgent` (`services/recovery.ts:139`) — SIGKILLs the CLI process on the worker. Next turn respawns and re-scans. No container destroy. |
| Codex (`codex app-server`) | Persistent worker-side process | Same — `killAgent`. Next turn's `app-server` re-injects `<skills_instructions>` on respawn (**pending v0 spike** — see v0 build order; doc 138 verified this for `codex exec`, but `app-server`'s injection behavior on respawn must be re-verified). **Fallback if the spike is negative:** v1 ships Claude-only (the v1a/v1b split below); v1b for Codex either waits for upstream `app-server` to gain a reload mechanism or implements a session-level reload via the JSON-RPC bridge the adapter already speaks. |

`restartAgent` is explicitly NOT used here — it's the wrong tool for this
job. `killAgent` is the right primitive when one is needed at all.

Concrete sequence:

1. Install commits to the workspace (per the concurrency rules above).
2. The install button was disabled while `runner.running`, so there's
   nothing to interrupt.
3. For one-shot `claude -p`: no further action; the next turn picks it up.
   For persistent backends: call `killAgent` on the runner; next turn
   respawns and picks up the new files.
4. The user sees a status row in the install sheet: "Installed. New skills
   are available for your next message." No chat-level notification —
   installs are configuration, not conversation.

### Trust posture

Plugins execute arbitrary code on the session container. Three guards:

1. **Marketplace allowlist** — by default, only the official Anthropic/OpenAI
   catalogs are pre-added. Adding a third-party catalog requires the user to
   paste a source (no implicit discovery).
2. **Monaco preview inline by default** — the install sheet always shows the
   full `SKILL.md` body in a Monaco panel before the user clicks Install,
   not as an opt-in expansion. A list of file paths with "+N lines" tells the
   user nothing about what a skill will do; the body does. This is the GUI
   lift over the TUI's description-only detail page.
3. **Installs are auto-committed in the workspace** — a malicious plugin
   lands in git history, where it's reviewable in the PR card (§1: stay in
   ShipIt). For the **first install in a fresh repo with no PR yet**, this
   defense is weaker — the plugin is on the working branch and any
   subsequent agent turn runs with it in scope. Guard #2 (mandatory inline
   preview) is the primary defense for that case; the auto-commit is the
   audit trail.

**No sandboxing beyond what the container already provides.** A plugin
inside the session container can read the agent's credentials (Anthropic
OAuth token, GitHub token, repo Git credentials, anything in the secret
store) and can make network requests with the user's egress. A malicious
plugin can exfiltrate any of those. We do not propose to constrain that;
session containers are already a single trust zone, and plugins are
explicitly user-installed via a sheet that surfaces marketplace provenance.
But the user should know "the container is the sandbox" undersells what a
hostile plugin can do — link to the credential-store and secret-store
threat models when implementing.

**Codex-specific implication.** On Codex, the catalog-injection model (per
doc 138) lets the model pick a matching skill *even without an explicit
`$name`* — the `<skills_instructions>` block listing every discovered skill
is part of every turn's context. An installed-but-never-invoked malicious
Codex skill is therefore in scope the moment its description happens to
match a user prompt. The Monaco preview at install time is the *only* gate;
there's no "but the user has to type the name" backstop. This makes the
inline-preview defense (#2) more load-bearing for Codex than for Claude,
not less.

## Build order

Smallest valuable v1 first, layered to ship independently.

### v0 — Reconnaissance spike (~1 day, gates v1)

Four upstream-CLI unknowns pre-empt UI work. Resolve before any client or
service code lands:

- **Claude colon-in-name resolution.** ShipIt installs to a flat directory
  named `<plugin>__<skill>/` with frontmatter `name: <plugin>:<skill>`,
  bypassing Claude's `/plugin` machinery entirely (no `.claude-plugin/marketplace.json`
  registration). The whole `__`/`:` strategy assumes Claude's CLI honors a
  colon in the `name` frontmatter when the skill is discovered via raw
  filesystem scan, and resolves `/foo:bar` against a directory called
  `foo__bar`. **Verify empirically** against the pinned Claude CLI version.
  If it doesn't, the doc 138 regex amendment is wasted work — pick a
  different delimiter (likely `.` since the existing regex already allows
  it) or accept that ShipIt-installed plugins invoke under a different
  namespace than CLI-installed ones (e.g. `/<plugin>__<skill>`).
- **Codex `<skills_instructions>` injection under `app-server`.** Doc 138
  verified catalog injection for `codex exec`, but ShipIt's Codex adapter
  spawns `codex app-server` (args constructed at
  `src/server/session/agents/codex-adapter.ts:330`, `spawn` at line 335).
  Whether `app-server` re-injects the catalog on every turn (so a
  `killAgent`-and-respawn picks up newly-installed skills) is the
  actually-relevant question. **Verify against the pinned Codex CLI version.**
  If `app-server` doesn't re-inject on respawn, `killAgent` alone won't make
  new Codex skills visible — we'd need a different reload mechanism.
- **Codex project skill path.** `.codex/skills/` (doc 138 empirical against
  codex-cli 0.132.0) vs `.agents/skills/` (current OpenAI docs, aligned
  with agentskills.io). Re-verify against the Codex CLI version pinned in
  `docker/agent-cli/package-lock.json`. Pick one for writes; scan both for
  reads.
- **Codex marketplace manifest format.** Claude's
  `.claude-plugin/marketplace.json` is publicly specced; Codex's catalog
  manifest filename and schema aren't. Read OpenAI's official catalog repo
  directly (linked from <https://developers.openai.com/codex/plugins>) and
  document the fields ShipIt needs.

If any of these spikes surface more friction than expected, fall back to
**v1a-Claude then v1b-Codex** as separate releases on the same train rather
than blocking v1 on Codex. The Decisions section commits to "both backends
ship together" as the *goal*; this is the agreed-upon escape hatch if the
goal slips. The Claude colon-in-name spike is the highest-risk of the four,
because a negative result invalidates the chosen namespace strategy across
*both* backends.

### v1 — Repo-level skills, both backends, official catalogs only

Skills-only contents (no MCP/hooks/LSP/apps yet), repo-scope only (the only
scope we support — see "Install scope" above), but Claude *and* Codex from
day one, assuming v0 didn't surface anything that requires the v1a/v1b split.

1. **Backend** — `services/marketplace.ts` with `listPlugins(agentId)` and
   `installPlugin(agentId)`. Repo scope is implicit — no `scope` parameter,
   since we don't support any other. Two hard-coded catalogs in v1:
   `anthropics/claude-plugins-official` (Claude) and OpenAI's official Codex
   catalog. Fetch + parse shared; *writer* branches on `agentId` (paths in the
   Divergences table). Install marker (`.shipit-installed.json`) on every
   managed directory. Per-workspace install mutex
   (`Map<workspaceDir, Promise<InstallResult>>`) in the service module —
   NOT in any persistence store; this is runtime state only.
2. **Routes** — split across two files from day one
   (`api-routes-marketplace.ts` for app-wide, `api-routes-files.ts` for
   session-scoped; see Routes section). Marketplace collection persists in a
   new `marketplace-store.ts`, seeded with the two officials.
3. **Client** — Skills tab added to the existing Settings dialog
   (`Settings.tsx`). Dialog width is **per-tab** (Skills → `max-w-5xl` +
   `md:h-[80vh]`; other tabs stay at `max-w-2xl` + `md:h-120`). Sub-tabs:
   Discover + Installed only. Search, detail view, install sheet, **inline
   Monaco preview by default**. Marketplaces and Errors sub-tabs deferred
   to v2 since v1's catalogs are hard-coded and skills-only installs have a
   small error surface.
4. **Per-agent rendering** — the active agent (from session config) decides
   which catalog and which token convention (`/name` vs `$name`) the UI
   shows. No agent-picker in the Skills tab itself; it follows the session.
5. **Pick up new skills** — no agent restart for one-shot `claude -p` (next
   turn naturally respawns); `killAgent` (`services/recovery.ts:139`) for
   persistent backends (Streaming Claude, Codex). No `restartAgent`, no
   `/reload-plugins` injection (see "Pick up new skills" section).
6. **Install/turn concurrency** — Install button disabled while
   `runner.running` is true; path-scoped `git add`; per-workspace install
   mutex in `services/marketplace.ts`.
7. **Doc 138 regex amendment** — widen the `/`-slash regexes in
   `MessageInput.tsx` and `agent-execution.ts` to allow `:`, so
   `/<plugin>:<skill>` (Claude's canonical namespace token) works through
   the autocomplete and the leading-slash detector.
8. **Pre-clone the two seeded officials at orchestrator startup** so the
   Discover tab opens instantly the first time a user clicks it. The disk
   cost is bounded (two well-known catalogs) and the pattern matches how
   `disk-janitor.ts` cleans up at startup rather than mid-session.
   Alternative — streaming a "fetching catalog…" spinner the first time
   Discover opens — was considered and rejected: it puts seconds of
   first-impression latency on the user instead of amortizing it during
   boot.

Acceptance: a user on Claude *or* Codex can open Settings → Skills, browse the
agent's official catalog, see a skill's `SKILL.md` rendered inline in Monaco,
click Install, see the file land in `.claude/skills/<plugin>__<skill>/` or
`.codex/skills/<plugin>__<skill>/` with auto-commit, and invoke
`/<plugin>:<skill>` or `$<plugin>:<skill>` in the next turn — all inside
ShipIt. Hand-written skills with the same `<plugin>__<skill>` directory
name surface a clear collision error rather than being overwritten.

### v2 — Custom marketplaces + Errors tab

The Marketplaces sub-tab — paste a GitHub `owner/repo`, Git URL, or local
path; refresh/remove/toggle auto-update. Persisted app-wide (see Decisions).
Adds the Errors sub-tab as catalog/network/install failures become possible.

### v3 — Full plugin composition

Extend `installPlugin()` to write MCP server entries and hooks, not just
skills. Needs the corresponding scope writes in `.claude/settings.json` /
`.codex/config.toml`. Updates the "Will install" preview accordingly. This is
where the install sheet starts showing rich diffs of multi-file impact.

### v4 — Ceiling lifts beyond the CLI

- Diff view on marketplace update (show `SKILL.md` diff between old/new
  pinned SHA before applying).
- Context-cost meter aggregating installed-skill totals, with a warn-line at
  X% of model context window.
- Cross-agent portability badge (agentskills.io standard compliance).

## Scope boundary

This doc covers **discovery and install** of skills/plugins. It does **not**
cover:

- **Authoring** skills — doc 096 (`.claude/skills/` write access).
- **Invoking** skills — doc 138 (`/` autocomplete, `Skill` allowlist).
- **Slash command layer** — doc 132 (the broader `/foo` family).
- **Per-user persistent volume** — out of scope full stop; revisiting the
  volume design is its own doc, not a follow-up of this one.
- **User-scope or `$CODEX_HOME` skill scanning** — depends on the persistent
  volume, so also out of scope.
- **Publishing** ShipIt-managed catalogs — out of scope; if a team wants to
  publish, they use the upstream marketplace standard.

## Key files (anticipated)

| File | Change |
|---|---|
| `src/server/orchestrator/services/marketplace.ts` | New — marketplace + plugin listing, install/uninstall, install-marker writes |
| `src/server/orchestrator/marketplace-store.ts` | New — app-wide marketplace state (SQLite via `DatabaseManager`, prepared statements, following `repo-store.ts` / `secret-store.ts`). New `marketplaces` table. |
| `src/server/shared/database.ts` | Add the `marketplaces` table to the schema |
| `src/server/shared/skill-scan.ts` | **No change.** v1 uses the flat `<skillsDir>/<plugin>__<skill>/SKILL.md` layout so the existing scanner (which scans exactly one level deep) picks installed skills up unchanged. |
| `src/server/shared/types/domain-types.ts` | Add `MarketplaceSource`, `MarketplaceInfo`, `PluginInfo`, `SkillRef`, `InstallResult`, `InstallMarker` |
| `src/server/orchestrator/api-routes-marketplace.ts` | New — app-wide marketplace routes (GET/POST/DELETE `/api/marketplaces`, refresh, plugin listing) |
| `src/server/orchestrator/api-routes-files.ts` | Add session-scoped install/uninstall/enable routes alongside the existing `GET /api/sessions/:id/skills` from doc 138 |
| `src/server/orchestrator/services/marketplace.ts` *(install mutex)* | In-process `Map<workspaceDir, Promise<InstallResult>>` for the per-workspace install lock; same shape as `_mcpInstallMutex` in `src/server/session/session-worker.ts:133`. NOT in `RepoStore` (which is SQLite — wrong layer for runtime locks). |
| `src/server/orchestrator/services/recovery.ts` | Install service calls `killAgent` directly when a persistent agent is running (Streaming Claude / Codex). No `restartAgent`. One-shot `claude -p` needs no kill — next turn respawns. |
| `src/client/components/Settings.tsx` | Add `skills` tab; make the `DialogContent` `className` conditional on active tab (Skills → `max-w-5xl` + `md:h-[80vh]`, others stay at current `max-w-2xl` + `md:h-120`) |
| `src/client/stores/ui-store.ts` | Widen the `SettingsTab` discriminated union at line 30 to include `"skills"` — the persisted `settingsTab` state (which remembers the user's last-open tab across reloads) is typed against this union, and both type sites must agree. |
| `src/client/components/SkillsTab.tsx` | New — Discover/Installed (v1) → Marketplaces/Errors (v2) sub-tabs; lives inside Settings |
| `src/client/components/MessageInput.tsx` *(doc 138 amendment)* | Widen the slash-trigger regex at line 265 from `/^\/([a-zA-Z0-9._-]*)$/` to allow `:` so `/<plugin>:<skill>` keeps the autocomplete open through the namespace separator. |
| `src/server/orchestrator/ws-handlers/agent-execution.ts` *(doc 138 amendment)* | Widen the slash-detection regex at line 115 from `/^\/[a-zA-Z0-9._-]+/` to allow `:`, so `assembleAgentPrompt` keeps the full `<plugin>:<skill>` token at index 0 when attachments are present. |
| `src/client/components/SkillInstallSheet.tsx` | New — install sheet with inline Monaco `SKILL.md` preview |
| `src/client/stores/skills-store.ts` | New Zustand store for marketplace/plugin state |
| `src/client/hooks/useMarketplace.ts` | New API hooks |
| `src/server/shipit-docs/skills.md` | New agent-facing doc describing how installed skills behave under ShipIt (install markers, restart-on-install, no-write-to-settings-json-in-v1) |

## Decisions

- **Reimplement, don't wrap.** Agent-agnostic principle wins over inheriting CLI
  updates for free.
- **v1 covers both backends.** Claude and Codex ship together — being
  agent-agnostic at the surface means no user is left waiting for parity.
  Forces the `.codex/skills/` vs `.agents/skills/` resolution up front, which
  is the right time to do it anyway.
- **v1 is skills-only.** MCP/hooks/LSP/apps deferred to v3. They need
  scope-write logic into `settings.json`/`config.toml` that's not in v1's
  critical path.
- **Repo-level scope only — no user-scope skills.** Skills live in the
  workspace and travel with the repo via auto-commit. User-scope (and
  Codex built-in `$CODEX_HOME` scans) would need a per-user persistent
  volume mounted at `/root/.claude/` and `/root/.codex/`; that's a much
  larger piece of infra than this doc wants to take on. Out of scope, full
  stop, until/unless a separate doc revisits the volume design.
- **No ShipIt-curated catalog.** We render Anthropic's official, OpenAI's
  official, and any third-party catalog the user adds. We compete on the
  install-experience UX, not on the contents — and skipping the curation
  burden keeps the surface honest. Future re-evaluation: if upstream
  catalogs don't cover ShipIt-flavored conventions well (compose previews,
  `shipit.yaml`, PR lifecycle), revisit whether a small bundled set makes
  sense.
- **Surface lives in the Settings dialog with per-tab width.** Skill
  management is configuration, not workflow — it belongs with the other
  agent-config tabs. To fit the marketplace browser, `DialogContent`'s
  `className` becomes conditional on the active tab: Skills uses
  `max-w-5xl` + `md:h-[80vh]`; the existing form-shaped tabs stay at
  `max-w-2xl` + `md:h-120` so their single-column inputs don't float in a
  wide empty container.
- **Marketplaces are app-wide; UI filters by active agent.** One shared
  catalog list across every session (persisted in `marketplace-store.ts`
  alongside `repo-store.ts`/`secret-store.ts`), but each catalog carries an
  `agentId` and the Discover UI shows only those matching the current
  session's agent. This way the user maintains one set of marketplaces
  globally, but never sees a Codex catalog while in a Claude session and
  vice versa.
- **Project-scope installs auto-commit.** Trust is mediated by the existing PR
  review path, not by a separate "are you sure" gate.
- **Monaco preview is in the v1 install sheet.** This is the headline GUI
  affordance over the TUI; shipping it later is a missed signal.

## Open questions

(Q1 and Q2 from the earlier draft — Codex skill path and catalog manifest
format — were promoted to v0 reconnaissance spikes that gate v1.)

1. **MCP server installs (v3).** Some MCP servers in upstream catalogs (e.g.
   Claude's `github`) require user OAuth. Does the install sheet trigger the
   OAuth flow inline, or queue it as a "needs auth" item in the Errors tab?
   Probably the latter for v3 — the OAuth flow is a §3 legitimate
   external-tab exception, but it's not the install action itself.
2. **Catalog refresh cadence.** ShipIt's convention (per CLAUDE.md "Disk
   cleanup") is that periodic background timers in the orchestrator are an
   anti-pattern: `disk-janitor.ts` deliberately runs only at startup. Catalog
   refresh follows the same model: **on-demand** (user opens the Marketplaces
   tab → refresh), **on session activation** (warm pool / session switch
   hook), and **at orchestrator startup** for the seeded officials. No
   per-hour or per-day timer. If a more aggressive refresh becomes necessary
   later, treat it as its own design decision — don't sneak it in here.
3. *(Resolved in Build order step 8 — pre-clone the seeded officials at
   orchestrator startup.)*

## References

- [Claude Code — Discover and install prebuilt plugins through marketplaces](https://code.claude.com/docs/en/discover-plugins)
- [Claude Code — Extend Claude with skills](https://code.claude.com/docs/en/skills)
- [Codex — Plugins](https://developers.openai.com/codex/plugins)
- [Codex — Build plugins](https://developers.openai.com/codex/plugins/build)
- [Codex — Agent Skills](https://developers.openai.com/codex/skills)
- [agentskills.io — open standard](https://agentskills.io)
- doc 096 — `claude-skills-access`
- doc 132 — `slash-commands`
- doc 138 — `skill-invocation`
