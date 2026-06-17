---
issue: https://linear.app/shipit-ai/issue/SHI-172
title: Auto-publish releases via a maintenance branch, driven by a deterministic command
description: Cut a release fully from ShipIt — the agent opens a version-bump PR into the release branch, you merge it, CI auto-tags and publishes. No manual git, works for any repo.
---

# Release auto-publish (maintenance-branch, merge-triggered)

## Context

Cutting a release in ShipIt should be fully hands-off: you describe intent in
chat, the **agent** does the mechanical work, and everything happens inside
ShipIt (CLAUDE.md §1/§5). Today it isn't. The maintenance-branch model
(`docs/162-release-channels`) made `stable` a branch you cut releases *from*, but
the only documented path was manual — `git checkout stable / cherry-pick /
npm run release / git push` run by hand. That's the failure mode the product
principles forbid.

This doc specifies the path that closes the gap, building on what already exists.
Much of `docs/171-release-from-ui` (SHI-71) is **already built and ecosystem-
generic**: the release lifecycle card + poller + markers + store/UI
(`release-status-poller.ts`, `release-markers.ts`, `release-store.ts`,
`ReleaseLifecycleCard.tsx`), multi-ecosystem version detection + semver
(`release-version.ts`), and the `shipit.yaml` `release:` block (`shipit-config.ts`).
What's missing is exactly three things, mapping to three user asks:

1. **Auto-publish** — CI that tags + publishes on merge to the release branch.
2. **Deterministic mechanics** — a command that does the bump/branch/cherry-pick/PR
   so the agent can't fumble it (it tagged the wrong commit once).
3. **Any repo** — scaffold the CI workflow into arbitrary repos, not just ShipIt.

Relationship to existing docs: `docs/162` owns the stable/edge channel + the
`stable` maintenance branch; `docs/171` owns the broader "release from ShipIt for
any repo" vision (its Phase-1 *agent-pushes-the-tag* mechanism is **superseded for
release-branch repos** by this doc). This doc is the concrete, decided mechanism
that ties them together.

## The model

`stable` (configurable per repo) is a long-lived **maintenance branch**. A release
is cut by **merging a version-bump PR into it**. Two user scenarios are the *same*
mechanism, differing only in the PR's payload:

| Scenario | PR payload |
|---|---|
| Release from latest `main` | bring `main`'s content + version bump |
| Hotfix on an existing release | cherry-pick specific commit(s) + version bump |

The **human-act gate is merging the PR** (rendered inline as the PR card). CI does
the irreversible publish. The agent never pushes a tag.

## Mechanism — CI auto-publish (one workflow, two triggers, self-publishing)

**Constraint that dictates the shape:** a tag pushed by a workflow using the
default `GITHUB_TOKEN` does **not** trigger another `on: push: tags` workflow. So
a naive "auto-tag on stable push" job would push a tag the publish workflow never
sees. Resolution: **one** workflow that gates, tags, *and* publishes in the same
run — no reliance on re-trigger, and no PAT (a PAT can't be safely scaffolded into
arbitrary repos).

`.github/workflows/release.yml` triggers on `push: { branches: [<release-branch>], tags: ['v*'] }`
with a `resolve` job:

- **tag path** (existing rc / manual tags): `tag = ref_name`, don't create a tag.
- **branch path** (new): `tag = v<version-from-source>`; if the tag already exists
  → no-op (a `stable` push with no bump must not release); else mark it for creation.
- `version-guard` + `check` + `test` run when proceeding (unchanged gate steps).
- `publish`: **on green**, create the annotated tag on the pushed commit (branch
  path only) and push it, then `gh release create --generate-notes --verify-tag`
  (+ `--prerelease` for a `-rc.N` suffix).
- `concurrency: { group: release-${{ github.ref }}, cancel-in-progress: false }`
  serializes pushes so two can't race the tag-exists check.

Properties: the tag is only created once the build is green (stricter than the old
"tag, then CI" order); routine `stable` pushes with no version bump cost one tiny
`resolve` job and stop; `stable` is never *moved* by CI — CI only reads HEAD's
version, tags that commit, and publishes. The maintenance-branch model
(`docs/162`) is unchanged; only the *trigger* moves from a hand-run
`npm run release` to **merging the bump PR**.

## Deterministic mechanics — the `shipit release` command

The agent must not hand-edit version files or run `git tag`/`git push`. A new
brokered `shipit release` command (mirroring the `shipit issue` three-tier shim:
shim handler → worker relay → orchestrator service) wraps the deterministic logic
**orchestrator-side**, so it's centralized and works for any repo:

- `shipit release plan [<patch|minor|major|VERSION>]` — read-only: detect version
  source, compute next version (reuse `release-version.ts`), emit the existing
  `propose` marker → card shows `proposed`.
- `shipit release prepare [<bump|VERSION>] [--pick <sha>…] [--from <branch>] [--release-branch <name>]`
  — resolve the release branch (`release.branch`/flag/`stable`); branch off
  `origin/<branch>`; `--pick` cherry-pick (hotfix) or merge `--from` (release from
  main); bump the version source (new `writeVersionToSource` in `release-version.ts`);
  commit; open a PR with `base = release branch` by **reusing `agentCreatePr`**
  (idempotent on an open PR). The orchestrator route drives the poller **directly**
  (`markPrOpened`) — the agent is out of the state-reporting loop.

No `shipit release tag`/`publish`/`push` — publishing is CI's job (rejected
subcommands). Errors (dirty tree, unknown release branch, no version source,
cherry-pick conflict) surface as actionable messages from the orchestrator.

The release card learns the PR-merge lifecycle: `release-types.ts` gains
`pr_open`/`pr_merged` phases + `prNumber`/`prUrl`/`releaseBranch`; the poller polls
the PR until merged, then falls into the existing tag/release polling
(`gating → published → released`).

## Any repo — scaffold the workflow

When a repo has no release workflow, the agent scaffolds one and opens a PR (CI
still does the publish). This is a chat-driven file write + the existing auto-PR
flow — **not** the project-template grid (docs/171 Phase 3).

- `src/server/orchestrator/templates-release.ts` (new) — `renderReleaseWorkflow({versionSource, branch, gate, prerelease})`
  (generalized version of the workflow above; per-ecosystem version read) +
  `renderReleaseNotesConfig()` (generalized `.github/release.yml`). Render
  functions, **not** registered in the `TEMPLATES` array.
- `shipit-config.ts` gains a `"release-branch"` `mechanism` value and a `branch`
  field; `release.mechanism`/`branch`/`versionSource`/`gate` parameterize the
  render and select this template vs. the simpler tag-triggered one.

## Phasing

1. **Auto-publish CI + config** (extends PR #1488). Rework
   `.github/workflows/release.yml` to the two-trigger + `resolve` shape; add the
   `release-branch` mechanism + `branch` field to `shipit-config.ts`; dogfood via a
   `release:` block in ShipIt's own `shipit.yaml`; update `RELEASING.md`,
   `CLAUDE.md`, `docs/162`, `docs/171`.
2. **`shipit release` command.** `writeVersionToSource`; `git.ts` `cherryPick` +
   `createBranchFrom`; `services/release-prepare.ts`; routes + relay; shim handler
   + dispatch; `pr_open`/`pr_merged` card phases; agent docs
   (`shipit-docs/release.md`, `prompts/releases.md`).
3. **Scaffold into any repo.** `templates-release.ts` + the agent detect/offer flow.

## Decisions (settled)

- Auto-publish via **one workflow, two triggers, self-publishing** — not a PAT
  (avoids the `GITHUB_TOKEN` recursion foot-gun and an unscaffoldable secret).
- Deterministic mechanics live **orchestrator-side**, surfaced via a thin
  `shipit release` shim — centralized, any-repo, agent can't fumble them.
- The poller is driven **server-side from the prepare route**, not an agent-echoed
  marker — the agent is fully out of the state-reporting loop.
- `stable` stays a **maintenance branch**; CI never *moves* it.

## Open questions

- **Lockfile bump** for Node: best-effort root-version string edit vs. running the
  package manager (heavier, non-deterministic). Lean best-effort.
- **Release-from-main default**: merge `origin/main` (can conflict on a truly
  diverged branch) vs. require explicit `--from`/`--pick`.
- **Monorepo / non-Node**: a single derived `vX.Y.Z` assumes one authoritative
  version; surface ambiguity and persist `release.versionSource` (don't guess).
  Cargo/pyproject parsing in CI bash is brittle — the scaffolded gate may need
  hand-tuning.

## Key files

- `.github/workflows/release.yml`, `.github/release.yml` — the auto-publish CI.
- `src/server/shared/shipit-config.ts` — `release-branch` mechanism + `branch`.
- `src/server/orchestrator/release-version.ts` — reuse detection/semver; add `writeVersionToSource`.
- `src/server/orchestrator/services/release-prepare.ts` (new), `services/github.ts` (`agentCreatePr`), `src/server/shared/git.ts` (`cherryPick`).
- `src/server/session/agent-shim/shipit.ts` + `shipit-release.ts` (new), `agent-ops-routes.ts`, `api-routes-github.ts`.
- `release-types.ts`, `release-markers.ts`, `release-status-poller.ts`, `services/release-flow.ts` — `pr_open`/`pr_merged` lifecycle.
- `src/server/orchestrator/templates-release.ts` (new) — scaffolding.
- `src/server/shipit-docs/release.md`, `orchestrator/prompts/releases.md`, `RELEASING.md`, `CLAUDE.md` — agent + maintainer guidance.
- Related: `docs/162-release-channels/plan.md`, `docs/171-release-from-ui/plan.md`.
