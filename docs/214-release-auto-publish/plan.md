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

This doc specifies the path that closes the gap, building on an existing
**foundation** from `docs/171-release-from-ui` (SHI-71): the release lifecycle
card + poller + markers + store/UI (`release-status-poller.ts`,
`release-markers.ts`, `release-store.ts`, `ReleaseLifecycleCard.tsx`),
multi-ecosystem version detection + semver (`release-version.ts`), and the
`shipit.yaml` `release:` block (`shipit-config.ts`). That foundation is real and
ecosystem-generic, but it is **tag/marker-oriented**: the card phases are
`proposed | tagging | gating | …` (no `pr_open`/`pr_merged`), the poller is driven
by markers + `markTagged` (not a route-driven PR lifecycle), and the `release:`
config only knows `mechanism: tag-triggered | brokered` (no `release-branch`, no
`branch` field). So this doc is **new design that extends that foundation** — the
`release-branch` mechanism, the `branch` field, the `pr_open`/`pr_merged`
lifecycle, and the `shipit release` command are all to-be-built, not already
present. What's missing maps to three user asks:

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
- **branch path** (new): `tag = v<version-from-source>`. Three cases, enforcing
  the stable-channel invariant below:
  - tag does **not** exist → new release, mark it for creation.
  - tag exists **and** HEAD is exactly the tag's commit → no-op (nothing new).
  - tag exists **and** HEAD ≠ the tag's commit → **fail loudly**: `stable`
    advanced without a version bump, which would expose an un-released commit to
    stable users. Not a silent no-op.
- A branch-path version with a prerelease suffix (`-rc.N`) is **rejected** —
  prereleases must not advance the stable channel (see below); rc's use the tag path.
- `version-guard` + `check` + `test` run when proceeding (unchanged gate steps).
- `publish`: **on green**, configure a CI git identity, create the annotated tag
  on the pushed commit (branch path only), push it, then `gh release create
  --generate-notes --verify-tag` (idempotent — skip if the Release already exists).
  The tag path passes `--prerelease` for a `-rc.N` suffix.
- `concurrency: { group: release-<resolved-tag>, cancel-in-progress: false }` —
  group by the **resolved tag**, not `github.ref`, so a `stable` push and a manual
  `vX.Y.Z` tag push for the same version can't race.

Properties: the tag is only created once the build is green; `stable` is never
*moved* by CI — CI only reads HEAD's version, tags that commit, and publishes. The
maintenance-branch model (`docs/162`) is unchanged; only the *trigger* moves from
a hand-run `npm run release` to **merging the bump PR**.

### Stable-channel safety invariant

The self-update channel tracks `origin/stable` (`docs/162`), so **every commit
reachable as `origin/stable` must be a green, released (tagged) commit** —
otherwise a stable instance updates to un-gated or un-released code. The old
FF-follower model held this trivially (CI only fast-forwarded `stable` *to* a
tag). The maintenance-branch model advances `stable` on *merge*, before CI tags,
so it must be actively enforced:

1. **Branch protection on `stable`**: the release PR's `check` + `test` must pass
   **before merge**, and direct pushes to `stable` are disabled — so the commit is
   already green when it lands (the post-merge workflow gate is belt-and-suspenders).
2. **`stable` only ever advances via a version-bump release PR.** The resolve job's
   "tag exists but HEAD moved → fail" case turns any no-bump push into a loud CI
   failure rather than a silent exposure.
3. Together these keep `origin/stable` tip == the latest released commit. (Alternative
   considered: track the latest stable *tag* instead of the branch tip — rejected to
   preserve `docs/162`'s one-line `origin/stable` ref parametrization.)

## Deterministic mechanics — the `shipit release` command

The agent must not hand-edit version files or run `git tag`/`git push`. A new
brokered `shipit release` command (mirroring the `shipit issue` three-tier shim:
shim handler → worker relay → orchestrator service) wraps the deterministic logic
**orchestrator-side**, so it's centralized and works for any repo:

- `shipit release plan [<patch|minor|major|VERSION>]` — read-only: detect version
  source, compute next version (reuse `release-version.ts`), emit the existing
  `propose` marker → card shows `proposed`.
- `shipit release prepare [<bump|VERSION>] [--pick <sha>…] [--from <branch>] [--release-branch <name>]`
  — resolve the release branch (`release.branch`/flag/`stable`); create a
  **deterministic head branch** named `release/<version>` off `origin/<branch>`
  (re-running for the same version **resets** that branch via `checkout -B`, so
  `agentCreatePr` updates the same open PR rather than spawning a second); `--pick`
  cherry-pick (hotfix) or merge `--from` (release from main); bump the version
  source (new `writeVersionToSource` in `release-version.ts`); commit; open a PR
  with `base = release branch` by **reusing `agentCreatePr`**. The orchestrator
  route drives the poller **directly** (`markPrOpened`) — the agent is out of the
  state-reporting loop.

No `shipit release tag`/`publish`/`push` — publishing is CI's job (rejected
subcommands). Errors surface as actionable messages from the orchestrator:
dirty tree; **release branch absent** (offer to bootstrap it — see below); no
version source / ambiguous (monorepo) version sources; and `--pick`/`--from`
**merge conflict** (abort the cherry-pick/merge, name the conflicting commit, and
ask the user to resolve rather than committing a broken tree).

**First-release bootstrap.** The very first release must *create* the release
branch (`docs/162` "Bootstrapping"). When `release.branch` doesn't exist on the
remote, `prepare` offers to create it off the current release commit (then bump +
PR), rather than erroring — so even bootstrapping needs no manual git.

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
- **`release-branch` requires an authoritative version source.** The branch-path
  derive reads the version from a file on the merged commit, so `release-branch`
  is only valid when `release.versionSource` resolves to `package.json` /
  `Cargo.toml` / `pyproject.toml` / `VERSION` — **not** tag-only (a branch push has
  no version to read). A monorepo with multiple version files is ambiguous: the
  agent surfaces the options, the user picks, and the choice is persisted in
  `release.versionSource` (don't guess — `docs/171`). Tag-only / unresolved repos
  stay on the `tag-triggered` mechanism.

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
- `stable` stays a **maintenance branch**; CI never *moves* it — and the
  **stable-channel safety invariant** (branch protection + fail-on-no-bump) keeps
  `origin/stable` tip == the latest released commit.
- **Prereleases never advance the stable channel**: rc's are cut via the tag path
  (release-candidate branch / `-rc.N` tag), never by merging a prerelease bump into
  the release branch.

## Open questions

- **Lockfile bump** for Node: best-effort root-version string edit vs. running the
  package manager (heavier, non-deterministic). Lean best-effort.
- **Release-from-main default**: merge `origin/main` (can conflict on a truly
  diverged branch) vs. require explicit `--from`/`--pick`. Leaning: require an
  explicit `--from`/`--pick` so the PR's payload is never a surprise.
- **Non-Node version reads in CI**: Cargo/pyproject parsing in the scaffolded
  workflow's bash is brittle (`tomlq` may be absent) — prefer a tiny inline parser
  or per-ecosystem `setup-*` action; the scaffolded gate may need hand-tuning.

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
