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
project + user scopes, install/enable/disable/uninstall) and lifts the ceiling
where a GUI gives us leverage the TUI doesn't (Monaco preview of SKILL.md,
context-cost meter, diff on marketplace update).

This builds on:

- **doc 096** — `.claude/skills/` access (Layer A harness permission + file-tree
  visibility). Status: done.
- **doc 138** — Skill *invocation* via `/name` (Claude) and `$name` (Codex), and
  the `/`-autocomplete menu fed by `services/skills.ts`. Status: done.

Doc 138 already wired discovery for *project* skills the user has *already
authored*. This doc covers the next layer up: discovery and install of skills
the user **hasn't** authored — from public catalogs, the agent's official
marketplaces, and team-internal sources.

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
| Plugin manifest | `.claude-plugin/plugin.json` (per plugin), `.claude-plugin/marketplace.json` (per catalog). Pinned to commit SHA in catalog entries. |

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

### Surface: a Skills sidebar tab

Add **Skills** as a top-level sidebar tab next to the existing surfaces. The
panel renders four sub-tabs that mirror the CLI floor:

1. **Discover** — browse the active agent's catalogs. Search bar at top.
   Cards show name, description, source marketplace, **context-cost estimate**,
   last-updated date, and a "Contains: 3 skills, 1 MCP server" capsule.
2. **Installed** — what's already in the workspace, grouped by scope
   (Project / User / Built-in). Each row: enable toggle, scope chip,
   uninstall overflow.
3. **Marketplaces** — add (paste GitHub shorthand, Git URL, or local path),
   list, refresh, remove, toggle auto-update. The official Anthropic/OpenAI
   catalogs come pre-added per active agent.
4. **Errors** — load failures, missing dependencies (e.g. LSP binaries),
   marketplace fetch errors. Each row has a "Ask agent to fix" CTA that drops a
   contextual prompt into chat (e.g. *"install the rust-analyzer binary so the
   `rust-analyzer-lsp` plugin works"*) — keeps us §5-compliant: the *agent*
   runs the fix, not a hidden shell button.

This is a chat-shaped surface (per §5): skills *are* chat tools, so a sidebar
that manages them is "configure my chat" — not a category mistake like a
"click to run npm test" button. The trigger that opens it can also be `/`-led
in the composer (a "Browse skills…" affordance at the bottom of the existing
`/`-autocomplete menu added in doc 138).

### Install flow

Click "Install" on a Discover card → opens an **Install sheet**:

```
┌─────────────────────────────────────────────┐
│  commit-commands                            │
│  by anthropic-official  ·  updated 3d ago   │
├─────────────────────────────────────────────┤
│  Scope:  [ Project (.claude/skills/) ▾ ]    │
│                                             │
│  Will install:                              │
│    📄  skills/commit/SKILL.md     +52 lines │
│    📄  skills/push/SKILL.md       +38 lines │
│    🔌  mcp: gh-helper             (network) │
│                                             │
│  Context cost: ≈ 1.2 KB / turn              │
│                                             │
│  [Preview SKILL.md]   [Cancel]  [Install]   │
└─────────────────────────────────────────────┘
```

"Preview SKILL.md" opens a read-only Monaco panel — this is the **ceiling
lift**: TUIs can only show a description; we can show the full body, frontmatter
included, before the user commits. Same Monaco component the diff viewer uses,
so it's free.

Project-scope installs write to `.claude/skills/` (or `.codex/skills/`) and
are picked up by the existing auto-commit. The user sees the same diff card
they'd see for any other agent edit.

### Install scopes — three levels, mapped to ShipIt's realities

| Scope | Claude path | Codex path | Persistence | Implementation cost |
|---|---|---|---|---|
| **Project** | `.claude/skills/` | `.codex/skills/` | Workspace, committed, travels with PR | **Cheap** — file write + auto-commit. v1 ships this first. |
| **User** | `~/.claude/skills/` | `~/.codex/skills/` | Mounted volume, survives session destruction | **Yak-shave** — needs a per-user persistent volume mounted at `/root/.claude/` (and `/root/.codex/`). Punt to follow-up. |
| **Local** | `.claude/settings.local.json` (gitignored) | (Codex equivalent unclear) | Workspace, not committed | **Medium** — same as project but written under a gitignored path. v2. |

The **user-scope volume** is the main piece of new infra. It would solve
multiple problems at once: user-scope skills, persistent agent auth state, and
Codex built-in `$CODEX_HOME` skills (currently container-only and not
orchestrator-reachable per doc 138). Worth scoping as its own follow-up doc
once v1 ships.

### Reimplement, don't wrap

Two paths considered:

- **Wrap** the CLI: drive `/plugin install foo@bar` through the agent process
  and render the TUI's output state. Fast, inherits CLI updates for free, but
  locks us to Claude semantics (Codex's verbs differ) and to whatever the TUI
  chooses to surface — we can't easily add the Monaco preview or context-cost
  meter.
- **Reimplement**: fetch `marketplace.json` ourselves, write files to
  `.claude/skills/` directly, manage `extraKnownMarketplaces` in
  `.claude/settings.json`. More code, but agent-agnostic and gives us full
  rendering control. Doc 138 already chose this shape for the *invocation*
  side (the `/`-autocomplete is reimplemented, not a CLI wrap).

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
    skills:     SkillRef[];   // {name, description}
    mcpServers: McpServerRef[];
    hooks:      HookRef[];
    apps?:      AppRef[];     // Codex-only
    lspServers?: LspRef[];    // Claude-only
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
installPlugin(workspaceDir, marketplaceId, pluginName, scope): InstallResult
uninstallPlugin(workspaceDir, marketplaceId, pluginName): void
enablePlugin / disablePlugin
```

These are pure functions in the §services layer pattern (CLAUDE.md), consumed
by both the HTTP route and a future WS message for live install progress.

### Routes

Following `add-endpoint` pattern, mounted under
`api-routes-files.ts` (same family as `GET /api/sessions/:id/skills` from doc
138):

```
GET    /api/marketplaces?agent=claude
POST   /api/marketplaces                 { source }
DELETE /api/marketplaces/:id
POST   /api/marketplaces/:id/refresh
GET    /api/marketplaces/:id/plugins
POST   /api/sessions/:id/plugins/install   { marketplaceId, pluginName, scope }
DELETE /api/sessions/:id/plugins/:marketplaceId/:pluginName
PATCH  /api/sessions/:id/plugins/:marketplaceId/:pluginName   { enabled: bool }
```

Marketplaces are app-wide (not per-session), so list/add/refresh/delete hang
off `/api/marketplaces`. Installs are workspace-scoped, so they hang off the
session.

### Backend-agnostic at the surface; agent-specific at the writer

`installPlugin()` dispatches on `agentId`:

- **Claude** → write to `.claude/skills/<plugin>/<skill>/SKILL.md`. Register MCP
  servers in `.claude/settings.json` under the plugin's namespace. Plugin
  skills land under a `<plugin>:` namespace prefix matching Claude's convention.
- **Codex** → write to `.codex/skills/<plugin>/<skill>/SKILL.md` (scan both
  `.codex/skills/` and `.agents/skills/` per the directory-layout note above
  — write to whichever the user's existing skills already use, defaulting to
  `.codex/skills/` until `.agents/skills/` is confirmed canonical). MCP servers
  to `.codex/config.toml`.

The catalog *fetch* logic is shared (Git clone or HTTP download + JSON parse
of the manifest). Only the *write* step branches per agent.

### Reload without restart

After install/uninstall/enable/disable, ShipIt emits a WS message to the
session worker that:

1. **Claude** sessions: tells the running agent (via existing agent channels)
   to call `/reload-plugins` if one is active, otherwise no-op (next turn picks
   it up).
2. **Codex** sessions: triggers a soft reset of the agent process so the next
   turn re-scans `<skills_instructions>`. Codex's docs note that restarts are
   sometimes needed; we make the restart automatic and invisible.

This is the same general shape as the `restartAgent` flow used by doc 127.

### Trust posture

Plugins execute arbitrary code on the session container. Three guards:

1. **Marketplace allowlist** — by default, only the official Anthropic/OpenAI
   catalogs are pre-added. Adding a third-party catalog requires the user to
   paste a source (no implicit discovery).
2. **"Will install" preview before commit** — the install sheet always lists
   every file, MCP server, hook, etc. before the user clicks Install. This is
   the same preview Claude CLI v2.1.145 added.
3. **Project-scope installs are auto-committed** — so a malicious plugin lands
   in git history, where it's reviewable in the PR card (§1: stay in ShipIt)
   alongside any other agent edits.

We do **not** sandbox plugin code beyond what the session container already
provides. The container *is* the sandbox; plugins can do whatever the agent
already can.

## Build order

Smallest valuable v1 first, layered to ship independently.

### v1 — Project-scope skills from the official catalog (Claude only)

The thinnest slice that's clearly better than the TUI and avoids the user-scope
volume yak-shave.

1. **Backend** — `services/marketplace.ts` with `listPlugins` and
   `installPlugin(scope: "project")`. Hard-code the official
   `anthropics/claude-plugins-official` catalog source for v1. Skill-only
   contents — MCP/hooks/LSP deferred.
2. **Route** — `GET /api/marketplaces/claude-plugins-official/plugins` and
   `POST /api/sessions/:id/plugins/install`.
3. **Client** — Skills sidebar tab with Discover + Installed sub-tabs. Search,
   detail view, install sheet, Monaco preview of `SKILL.md`. No Errors/
   Marketplaces tabs yet (the catalog is hard-coded).
4. **Reload** — emit the existing `restartAgent`-equivalent after install.

Acceptance: a user can browse the official Anthropic catalog inside ShipIt,
preview a skill's `SKILL.md`, install it to `.claude/skills/`, see the
auto-commit land, and invoke `/<plugin>:<skill>` in the next turn — all
without leaving ShipIt and without typing a shell command.

### v2 — Codex parity

Repeat v1 for Codex. The hard-coded catalog points at OpenAI's official Codex
plugin catalog (per <https://developers.openai.com/codex/plugins>). Writer
branches on `agentId`. Re-verifies the `.codex/skills/` vs `.agents/skills/`
question and locks in the canonical path.

### v3 — Custom marketplaces

Marketplaces sub-tab — add/remove/list/refresh/toggle auto-update for
third-party catalogs. Persisted in `~/.shipit/marketplaces.json` (or
equivalent app-wide store). Powers team-internal catalogs.

### v4 — Full plugin composition

Extend `installPlugin()` to write MCP server entries and hooks, not just
skills. Needs the corresponding scope writes in `.claude/settings.json` /
`.codex/config.toml`. Updates the "Will install" preview accordingly.

### v5 — User-scope volume

Per-user persistent volume mounted at `/root/.claude/` and `/root/.codex/`.
Unlocks user-scope installs, persistent agent auth, and Codex built-in skill
scans. Likely its own design doc once v1–v4 land.

### v6 — Ceiling lifts beyond the CLI

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
- **Per-user persistent volume** — flagged as the major dependency for v5,
  but its own design.
- **Publishing** ShipIt-managed catalogs — out of scope; if a team wants to
  publish, they use the upstream marketplace standard.

## Key files (anticipated)

| File | Change |
|---|---|
| `src/server/orchestrator/services/marketplace.ts` | New — marketplace + plugin listing, install/uninstall, scope writes |
| `src/server/shared/skill-scan.ts` | Reuse `scanSkillsDir()` for `<plugin>/skills/<name>/SKILL.md` reads |
| `src/server/shared/types/domain-types.ts` | Add `MarketplaceSource`, `MarketplaceInfo`, `PluginInfo`, `SkillRef`, `InstallResult` |
| `src/server/orchestrator/api-routes-files.ts` | Mount the new routes (or split into `api-routes-marketplace.ts` if the surface grows) |
| `src/server/orchestrator/ws-handlers/...` | Reload-after-install message + agent restart trigger |
| `src/client/components/SkillsPanel.tsx` | New sidebar — Discover/Installed/Marketplaces/Errors tabs |
| `src/client/components/SkillInstallSheet.tsx` | New — install sheet with Monaco preview |
| `src/client/stores/skills-store.ts` | New Zustand store for marketplace/plugin state |
| `src/client/hooks/useMarketplace.ts` | New API hooks |
| `src/server/shipit-docs/skills.md` | New agent-facing doc describing how installed skills behave under ShipIt |

## Decisions

- **Reimplement, don't wrap.** Agent-agnostic principle wins over inheriting CLI
  updates for free.
- **v1 is project-scope only.** User-scope needs a persistent volume; defer.
- **Marketplaces are app-wide, not session-scoped.** Same catalog visible across
  every session — matches how users think about extensions.
- **Project-scope installs auto-commit.** Trust is mediated by the existing PR
  review path, not by a separate "are you sure" gate.
- **Monaco preview is in the v1 install sheet.** This is the headline GUI
  affordance over the TUI; shipping it later is a missed signal.
- **Skills-only contents in v1.** MCP/hooks/LSP/apps deferred to v4. They need
  scope-write logic into `settings.json`/`config.toml` that's not in v1's
  critical path.

## Open questions

1. **Codex project skill path.** `.codex/skills/` (doc 138 empirical) vs
   `.agents/skills/` (current OpenAI docs). Resolve empirically against the
   Codex CLI version pinned in `docker/agent-cli/package-lock.json` before
   v2 lands.
2. **Codex marketplace manifest format.** Public docs describe
   `.codex-plugin/plugin.json` for individual plugins, but the catalog
   manifest's filename and schema aren't fully specced publicly. May need to
   read OpenAI's official catalog repo directly.
3. **Reload semantics for Codex.** Does running Codex re-scan the skill
   catalog mid-session, or only on next `codex exec`? If the latter, v2 just
   needs to invalidate on the next turn — no restart needed.
4. **MCP server installs (v4).** Some Claude MCP servers in the catalog (e.g.
   `github`) require user OAuth. Does the install sheet trigger the OAuth
   flow inline, or queue it as a "needs auth" item in the Errors tab?
   Probably the latter for v4 — the OAuth flow is a §3 legitimate
   external-tab exception, but it's not the install action itself.
5. **Catalog auto-update cadence.** Claude refreshes at session start by
   default. Our model is different (long-lived sessions, warm pool). A
   periodic refresh on the orchestrator (once per hour?) feels right but
   needs benchmarking against catalog repo Git clone times.

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
