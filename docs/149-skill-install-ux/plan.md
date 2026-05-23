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
(`src/client/components/Settings.tsx`), alongside the current Agent / GitHub /
Git / Instructions / MCP / Advanced tabs. Skill management is configuration,
not turn-by-turn workflow, so it belongs with the other agent-config affordances.

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
2. **Installed (v1)** — what's already in the workspace. Each row: enable
   toggle, marketplace + plugin chip, uninstall overflow. v1 lists only
   plugins ShipIt itself installed (identified by the install marker — see
   "Backend-agnostic at the surface; agent-specific at the writer"). Skills
   the user wrote by hand under `.claude/skills/` show up in the existing
   `/`-autocomplete (doc 138) but are not listed here, since this surface is
   "what's installed *from a marketplace*."
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
   that happen to be in the working tree. CLAUDE.md already calls this out
   for the git-commit flow generally; the install path follows the same rule.
3. **Two-tab race in the same repo.** Two browser tabs on different sessions
   in the same repo both clicking Install at the same time would race on the
   git index and on the `.claude/skills/` directory. Resolution: a
   per-repo install lock (in the orchestrator's `RepoStore`, alongside the
   existing per-repo state) serializes installs across sessions of the same
   repo. Second install waits for the first to commit, then runs.

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
listMarketplaces(agentId): MarketplaceInfo[]
addMarketplace(source, agentId): MarketplaceInfo
removeMarketplace(id): void
refreshMarketplace(id): MarketplaceInfo
listPlugins(marketplaceId): PluginInfo[]
installPlugin(workspaceDir, marketplaceId, pluginName): InstallResult
uninstallPlugin(workspaceDir, marketplaceId, pluginName): void
enablePlugin / disablePlugin
```

These are pure functions in the §services layer pattern (CLAUDE.md), consumed
by both the HTTP route and a future WS message for live install progress.

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
PATCH  /api/sessions/:id/plugins/:marketplaceId/:pluginName   { enabled: bool }
```

App-wide marketplace state persists in a new
`src/server/orchestrator/marketplace-store.ts` following the existing
patterns of `repo-store.ts` and `secret-store.ts` — JSON file in the
orchestrator data dir. v1 may seed it with the official Claude/Codex
catalogs and never write to it (since v1 doesn't expose add/remove); the
store still exists from day one so v2 can layer on without restructuring.

### Backend-agnostic at the surface; agent-specific at the writer

`installPlugin()` dispatches on `agentId`. The skills directory layout is
**flat one level deep**, not nested per plugin — doc 138's `scanSkillsDir()`
(`src/server/shared/skill-scan.ts:52`) reads exactly `<skillsDir>/<name>/SKILL.md`
and is intentionally non-recursive. A nested `<plugin>/skills/<name>/SKILL.md`
layout would not be picked up by the existing scanner; the `/`-autocomplete
would not list plugin skills and invocation would break. So:

- **Claude** → write to `.claude/skills/<plugin>__<skill>/SKILL.md` (double
  underscore as the in-directory delimiter; the file's frontmatter `name`
  field is set to `<plugin>:<skill>` to match Claude's canonical invocation
  token). Existing scanner picks it up unchanged.
- **Codex** → write to `.codex/skills/<plugin>__<skill>/SKILL.md` (or
  `.agents/skills/` per the directory-layout note; write to whichever the
  user's existing skills already use, defaulting to `.codex/skills/` until
  `.agents/skills/` is confirmed canonical). Frontmatter `name` set to
  `<plugin>:<skill>`; invocation token is `$<plugin>:<skill>`.

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

### Pick up new skills — restart the agent process

After install/uninstall, ShipIt restarts the session's agent process via the
existing `restartAgent` flow (doc 127). This applies to **both** backends —
ShipIt runs Claude non-interactively via `claude -p`, where `/reload-plugins`
is process-state CLI machinery that doesn't flow through the prompt stream
(per doc 132: built-in slash commands are CLI process-state, not prompts).
Sending `/reload-plugins` as a chat message would either be echoed as prose
or, worse, hit doc 138's `Skill` allowlist as a malformed skill invocation.

Concrete sequence:

1. Install commits to the workspace (per the concurrency rules above).
2. If a turn is in flight, the install button was already disabled, so
   there's nothing to interrupt.
3. ShipIt calls the existing `restartAgent` path. The agent process exits and
   the next user prompt spawns a fresh one that picks up the new files
   (Claude re-scans `.claude/skills/`; Codex re-injects
   `<skills_instructions>`).
4. The user sees a status row in the install sheet: "Installed.
   New skills are available for your next message." No chat-level
   notification — installs are configuration, not conversation.

This makes Claude and Codex symmetric, costs one cold-start per install
(milliseconds), and avoids the "what does the CLI actually do in headless
mode" trap.

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

## Build order

Smallest valuable v1 first, layered to ship independently.

### v0 — Reconnaissance spike (~½ day, gates v1)

Two Codex-side unknowns pre-empt UI work. Resolve before any client or
service code lands:

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

If either spike reveals more friction than expected (e.g. Codex's catalog
format isn't stable or requires a vendor SDK), fall back to **v1a-Claude
then v1b-Codex** as separate releases on the same train rather than blocking
v1 on Codex. The Decisions section commits to "both backends ship together"
as the *goal*; this is the agreed-upon escape hatch if the goal slips.

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
   managed directory. Per-repo install lock via `RepoStore`.
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
5. **Pick up new skills** — restart the agent process via the existing
   `restartAgent` flow for both backends after a successful install. No
   `/reload-plugins` injection (see "Pick up new skills" section).
6. **Install/turn concurrency** — Install button disabled while
   `runner.running` is true; path-scoped `git add`; per-repo lock.

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
| `src/server/orchestrator/marketplace-store.ts` | New — app-wide marketplace state (JSON file in the orchestrator data dir, following `repo-store.ts` / `secret-store.ts`) |
| `src/server/shared/skill-scan.ts` | **No change.** v1 uses the flat `<skillsDir>/<plugin>__<skill>/SKILL.md` layout so the existing scanner (which scans exactly one level deep) picks installed skills up unchanged. |
| `src/server/shared/types/domain-types.ts` | Add `MarketplaceSource`, `MarketplaceInfo`, `PluginInfo`, `SkillRef`, `InstallResult`, `InstallMarker` |
| `src/server/orchestrator/api-routes-marketplace.ts` | New — app-wide marketplace routes (GET/POST/DELETE `/api/marketplaces`, refresh, plugin listing) |
| `src/server/orchestrator/api-routes-files.ts` | Add session-scoped install/uninstall/enable routes alongside the existing `GET /api/sessions/:id/skills` from doc 138 |
| `src/server/orchestrator/repo-store.ts` | Extend with per-repo install lock state |
| `src/server/orchestrator/ws-handlers/...` | Wire the post-install agent-restart trigger through the existing `restartAgent` flow (doc 127) |
| `src/client/components/Settings.tsx` | Add `skills` tab; make the `DialogContent` `className` conditional on active tab (Skills → `max-w-5xl` + `md:h-[80vh]`, others stay at current `max-w-2xl` + `md:h-120`) |
| `src/client/components/SkillsTab.tsx` | New — Discover/Installed (v1) → Marketplaces/Errors (v2) sub-tabs; lives inside Settings |
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
3. **First-install latency for OpenAI's Codex catalog.** Git clone of a
   third-party catalog repo can take seconds to tens of seconds on a cold
   container. Either pre-clone the seeded officials during orchestrator
   startup (acceptable: it's a one-time cost per orchestrator boot) or
   stream a "fetching catalog…" state into the Discover tab the first time
   it opens. Pick one before v1 ships.

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
