# 149 — Skill Install UX checklist

## v0 spike (Claude only)

- [x] **Claude colon-in-name + flat-dir layout** — verified empirically against
  the Claude CLI shipped in `docker/agent-cli/package-lock.json`
  (`@anthropic-ai/claude-code@2.1.140`). A skill written to
  `.claude/skills/testplugin__hello/SKILL.md` with frontmatter
  `name: testplugin:hello` resolves under both `/testplugin:hello` and natural
  language ("Use the testplugin:hello skill") in `claude -p` mode. v1's chosen
  namespace strategy is correct for Claude. See the assistant message log for
  the spike transcript.
- [ ] **Codex `<skills_instructions>` injection under `app-server`** — deferred;
  v1 ships Claude-only per the user's chosen scope (v1a). v1b for Codex picks
  this up.
- [ ] **Codex project skill path** (`.codex/skills/` vs `.agents/skills/`) — deferred to v1b.
- [ ] **Codex marketplace manifest format** — deferred to v1b.

## v1a — Claude-only repo-scope installs (this branch)

### Backend
- [x] Types: `MarketplaceSource`, `MarketplaceInfo`, `MarketplaceStatus`,
  `PluginInfo`, `SkillRef`, `InstallMarker`, `InstalledPluginInfo`,
  `InstallResult` (`src/server/shared/types/domain-types.ts`).
- [x] SQLite migration 17 — `marketplaces` table
  (`src/server/shared/database.ts`).
- [x] `MarketplaceStore` (`src/server/orchestrator/marketplace-store.ts`) with
  `list`/`get`/`seedIfMissing`/`setFetchStatus`.
- [x] `services/marketplace.ts` — catalog fetch, plugin listing,
  install/uninstall, install marker, per-workspace mutex
  (`withWorkspaceLock`).
- [x] `GitManager.commitPaths(paths, message)` — path-scoped commit for the
  install flow (`src/server/shared/git.ts`).
- [x] `postTurnCommit()` takes the per-workspace mutex via `withWorkspaceLock`
  to serialize with install operations (`ws-handlers/post-turn.ts`).
- [x] `api-routes-marketplace.ts` — app-wide list / refresh / plugin listing /
  SKILL.md preview routes.
- [x] Session-scoped install / list-installed / uninstall routes added to
  `api-routes-files.ts`.
- [x] Background pre-clone of seeded official catalog at orchestrator startup
  (`index.ts`); skipped in test mode.
- [x] Install marker (`.shipit-installed.json`) writes + collision/upgrade
  refusal rules.
- [x] `killAgent` called after install/uninstall so persistent backends drop
  their cached skill list.

### Client
- [x] `useSkillsStore` Zustand store with fetch/install/uninstall actions.
- [x] `SkillsTab` component — Discover + Installed sub-tabs, search, per-marketplace
  fetch-failed Retry row (v1 stand-in for the v2 Errors sub-tab).
- [x] `SkillInstallSheet` with inline Monaco preview, per-skill picker, install
  guard tooltips.
- [x] Settings dialog: Skills tab inserted in the General group between
  Instructions and MCP, with `max-w-5xl` + `h-[80vh]` per-tab width.
- [x] `SettingsTab` union widened in `ui-store.ts`.
- [x] Doc 138 amendment: `/`-autocomplete regex in `MessageInput.tsx` widened
  to allow `:` for `/<plugin>:<skill>` invocation tokens.
- [x] Codex agent shows a friendly "v1b" empty state instead of a half-broken tab.

### Tests
- [x] `services/marketplace.test.ts` — 12 unit tests covering plugin listing
  filters, install (rewrite + marker + path-scoped commit), collision
  detection, uninstall safety, Codex refusal, mutex serialization, and
  frontmatter rewriting.
- [x] `integration_tests/marketplace.test.ts` — 4 end-to-end HTTP route tests
  through `buildApp()`: seeded catalog list, plugin listing from a
  pre-populated cache, install + list + uninstall round-trip, missing-field
  validation.
- [x] `SkillsTab.test.tsx` — 4 component tests: Discover list rendering,
  Installed list rendering, Codex empty state, fetch-failed Retry row.

### Quality
- [x] `npm run lint` — clean.
- [x] `npm run typecheck` — clean.
- [x] `npm run test:dev` — passes 125 tests in this branch's affected slice
  (incl. the new dir-name regression + the scanner test) on top of the wider
  suite.
- [x] Browser dogfooding via Playwright MCP against a local `RUNTIME_MODE=local`
  inner orchestrator and Vite. Surfaced and fixed two bugs that the v1a unit
  tests didn't catch (see below). Verified end-to-end: Discover lists 14
  plugins from `claude-plugins-official`, install sheet renders the Monaco
  preview by default, install commit lands path-scoped, Installed sub-tab
  updates, Uninstall removes the dir + commits, and the `/<plugin>:<skill>`
  autocomplete fires in the composer (including for the hookify dir/name
  mismatch case) without a page reload.

### Bugs found during dogfooding (both fixed)
- [x] **Install/uninstall didn't refresh the composer's `/`-autocomplete
  cache.** `useSkillsStore.install` updated only `installed` (the Installed
  sub-tab); the `useFileStore.skills` array that feeds `MessageInput`'s
  autocomplete stayed stale until page reload. Fix: install/uninstall now also
  call `useFileStore.getState().fetchSkills(sessionId, activeAgentId)` so the
  next `/` keystroke sees the new skill.
- [x] **Catalog `dirName` vs frontmatter `name:` mismatch broke install +
  preview for some upstream plugins.** `hookify` (and any plugin whose
  `skills/<dir>/SKILL.md` frontmatter `name:` doesn't equal `<dir>`) failed
  both `readPluginSkillBody` (Monaco preview 404) and `installPlugin` (ENOENT
  reading the source SKILL.md). Fix: `scanSkillsDir` now emits an optional
  `dirName` field carrying the on-disk folder; `SkillRef` carries it through
  the catalog listing; install + preview path-construction sites use
  `dirName ?? name`. The invocable name, frontmatter rewrite, and install
  target dir continue to use the user-facing `name` (so `/<plugin>:<name>`
  resolves as before). Regression test added in `marketplace.test.ts` +
  `skill-scan.test.ts`.

## v1b — Codex support

Tracked but out of scope for this branch. Requires the v0 spikes that were
deferred above:

- [ ] Verify `codex app-server` re-injects `<skills_instructions>` on respawn
  so `killAgent` is sufficient for Codex skill reload.
- [ ] Re-verify whether `.codex/skills/` or `.agents/skills/` is canonical
  in the pinned Codex CLI version.
- [ ] Document Codex's marketplace manifest format from the official catalog.
- [ ] Lift the `agentId !== "claude"` guard in `services/marketplace.ts`
  (`installPlugin`) and the Codex empty-state branch in `SkillsTab.tsx`.
- [ ] Add `.codex/skills/` writer with frontmatter `name: <plugin>:<skill>`.
- [ ] Seed the official Codex catalog row in `marketplace-store` startup.

## v2 — Custom marketplaces + Errors sub-tab

- [ ] Marketplaces sub-tab UI (add / remove / refresh / toggle auto-update).
- [ ] `addMarketplace` / `removeMarketplace` / `refreshMarketplace` service +
  routes.
- [ ] Errors sub-tab promoting the per-marketplace fetch-failed rows from v1's
  Discover header into a dedicated surface, plus install-error rows.
- [ ] `disk-janitor.ts` sweep for orphan `marketplace-cache/<id>/` dirs whose
  id is no longer in the table.

## v3 — Full plugin composition

- [ ] Plugins with hooks / MCP / commands / agents — install writes settings-file
  merges into `.claude/settings.json` scoped to a known block, preserving
  unrelated user entries.
- [ ] Enable/disable verbs (now there's a persistence target).
- [ ] Multi-file "Will install" preview in the install sheet (MCP block, hooks,
  etc., not just `SKILL.md`).
- [ ] Upgrade flow: when a pin-SHA changes, diff old → new in the install sheet
  before applying.

## v4 — Ceiling lifts beyond the CLI

- [ ] Aggregate context-cost meter across every installed skill, with a
  warn-line at X% of the model context window.
- [ ] Cross-agent portability badge (agentskills.io compliance check).
