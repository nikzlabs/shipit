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
- **branch path** (new): `tag = v<version-from-source>`. Cases:
  - tag absent → new release, proceed.
  - tag exists **but its GitHub Release is missing** → proceed to **repair** (a
    prior run pushed the tag but `gh release create` failed); skip tag creation,
    publish the Release. This is why the publish job checks Release existence, not
    just tag existence.
  - tag exists **and** its Release is published → no-op (nothing new).
  - A branch-path version with a prerelease suffix (`-rc.N`) is **rejected** —
    `stable` is for final releases; rc's use the tag path.
- `check` + `test` run when proceeding. **`version-guard` runs on the tag path only**:
  it compares `package.json` to `github.ref_name`, which is `stable` (not `vX.Y.Z`)
  on a branch push — so on the branch path it is **skipped** (the tag is *derived
  from* the version source, so they can't drift). This is a change from "unchanged
  gate steps."
- `publish`: **on green**, configure a CI git identity, create the annotated tag on
  `$GITHUB_SHA` (branch path only, and only if absent), push it, **re-fetch tags**,
  then — if `gh release view "$TAG"` shows none — `gh release create --generate-notes
  --verify-tag`. The tag path passes `--prerelease` for a `-rc.N` suffix.
- The `publish` job is serialized by `concurrency: { group: release-${{ needs.resolve.outputs.tag }}, cancel-in-progress: false }`
  (the resolved tag is a job output, so group at the job, not the workflow) — so a
  `stable` push and a manual `vX.Y.Z` tag push for the same version can't both
  create the tag.

Properties: the tag is only created once the build is green; `stable` is never
*moved* by CI — CI only reads HEAD's version, tags that commit, and publishes. The
*trigger* moves from a hand-run `npm run release` to **merging the bump PR**.

### Stable-channel safety — track the latest tag (Option A)

The hard requirement: a stable instance must **only ever update to a vetted,
published release** — never to a mid-CI or failed-publish commit. The
maintenance-branch model advances `origin/stable` on *merge*, **before** CI tags
and publishes, so the branch tip is transiently (and, on a failed publish,
permanently) an un-released commit. Tracking the branch tip would expose that.

**Decision: the stable channel resolves the latest *final, published* tag reachable
from `origin/stable`, not the branch tip.** The updater (`docs/162`) changes from
`reset --hard origin/stable` to resolving that tag and resetting to its commit.

**Exact resolution algorithm** (not `git describe` — that returns the *nearest tag
by commit distance*, which is wrong on a branch carrying multiple tags):
`git tag --merged origin/stable` → strict-SemVer-parse each → **filter out
prereleases** → pick the **highest version** → that tag's commit is the target.
The version display reuses the same resolved tag (not `describe --exact-match`,
which assumes the tip is a tag).

**Fail closed.** If no final tag is reachable (a freshly-created `stable`, or only
`-rc.N` tags exist), the stable channel reports **"no stable release yet"** and
does **not** update — it never falls back to the branch tip. The published-Release
check (above) means the workflow's tag+Release pair is what makes a tag eligible;
the updater selecting a tag whose Release later proves missing is prevented by the
repair path (the next `stable` push republishes it).

Consequences:

- The merge-before-publish window is **invisible** to stable users — an un-tagged
  tip is simply never selected. A failed publish strands nothing (and self-repairs).
- This **restores** `docs/162`'s own guarantee ("stable advances only to tagged
  releases"), which branch-tip tracking quietly broke.
- It is the only enforcement that works for **any repo**: branch protection (below)
  needs an admin-scoped token ShipIt can't scaffold, so it can't be the load-bearing
  guard for arbitrary repos. Tag resolution needs nothing but `git`.

Branch protection on `stable` (require the release-PR gate before merge; disallow
direct pushes) and running CI on `stable` PRs (see Phase 1 — `ci.yml` only triggers
on PRs into `main` today) remain **recommended quality gates** — they keep `stable`
clean and give reviewers a green check — but they are **no longer load-bearing for
safety**, which tag-tracking now owns.

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
  (re-running for the same version **resets** that branch via `checkout -B` and
  pushes with `--force-with-lease`, so `agentCreatePr` updates the same open PR
  rather than spawning a second; if `release/<version>` carries commits `prepare`
  didn't author — e.g. a hand-resolved conflict in the PR — it **refuses to reset**
  and surfaces that, rather than silently clobbering); `--pick` cherry-pick (hotfix)
  or merge `--from` (release from main); bump the version source (new
  `writeVersionToSource` in `release-version.ts`); commit; open the PR with `base =
  release branch`. **This needs new plumbing on `agentCreatePr`, not just a reuse:**
  today it derives head from `getCurrentBranch()` and auto-detects base as
  `main`/`master` (the only base override is the narrow `reArm.baseBranch`). So
  `prepare` must (a) leave the clone with `release/<version>` checked out so
  `getCurrentBranch()` resolves it, and (b) thread an explicit `base` override
  (generalizing `reArm.baseBranch`) so the PR targets the release branch. The
  orchestrator route drives the poller **directly** (`markPrOpened`) — the agent is
  out of the state-reporting loop.

  **The session adopts the `release/<version>` branch when the PR opens.** The
  release-status-poller card narrates the release *outcome*, but it carries no
  merge button — and the inline **PR lifecycle card** (which does) is keyed by
  `session.branch` in the PR poller, which still points at the session's own
  branch (`shipit/xxxxx`), not the release head. So the bump PR was never surfaced
  as a mergeable card and couldn't be merged from inside ShipIt (CLAUDE.md §1/§2).
  Fix (`services/release-branch-adopt.ts`, called from the `pr-opened` branch of
  the prepare route): repoint `session.branch` to `release/<version>`, `reArm` +
  `forceRefreshSession` the PR poller so it rediscovers the release PR by its new
  head, and rebroadcast `session_list`. Guarded to the session's own repo (a
  sandbox `--repo` PR lives in a different repo than the one the poller polls) and
  a no-op on a `prepare` re-run. The user then merges via the merge button they
  already know — exactly the release-branch human-act gate — and the
  release-status card continues to track publication.

No `shipit release tag`/`publish`/`push` for final releases — publishing is CI's
job (rejected subcommands). Errors surface as actionable messages from the
orchestrator: dirty tree; **release branch absent** (offer to bootstrap it — see
below); no version source / ambiguous (monorepo) version sources; and
`--pick`/`--from` **merge conflict** (abort, name the conflicting commit, ask the
user to resolve rather than committing a broken tree).

**Prereleases (rc) keep a deterministic path too.** rc's don't go through `stable`
(they must not advance the stable channel, and with Option A a `-rc.N` tag is
ignored by the channel anyway). So `shipit release prepare --prerelease [--from <rc-branch>]`
cuts the rc by creating + pushing the `vX.Y.Z-rc.N` **tag** through the broker
(`{n}` auto-increments from the highest existing rc) — the one case the agent
"pushes a tag," but still via the command, never hand-run `git tag`. The tag path
in CI publishes it as a GitHub prerelease. (Phase 2.)
Because this path has **no PR-merge gate** (unlike final releases), the rc tag push
is itself **confirmation-gated**: `prepare --prerelease` proposes (card/chat), and
the tag is pushed only on explicit confirm — preserving `docs/171`'s "a tag push is
always confirmation-gated" rule. The broker is plumbing, not the gate.

**First-release bootstrap.** The very first release must *create* the release
branch (`docs/162` "Bootstrapping"). When `release.branch` doesn't exist on the
remote, `prepare` offers to create it off the current release commit (then bump +
PR), rather than erroring — so even bootstrapping needs no manual git.

The release card learns the PR-merge lifecycle: `release-types.ts` gains
`pr_open`/`pr_merged` phases + `prNumber`/`prUrl`/`releaseBranch`; the poller polls
the PR until merged, then falls into the existing tag/release polling
(`gating → published → released`).

**Card persistence.** The `release-status-poller` is in-memory only, and the
`proposed`/`tagging`/`gating` phases are short-lived, so the card today is correctly
transient (rehydrated by polling on reconnect, like `pr-store`). The new
`pr_open`/`pr_merged` phases make the card **long-lived** — a release PR can sit
open for days awaiting a human merge — which crosses CLAUDE.md's "transcript cards
MUST be persisted" line. Decision: when `prepare` opens the PR, persist the card
via the `emitChatCard` recipe (`docs/188`/`docs/191`) so it survives reload/switch
and the poller rehydrates phase from the live PR + tag/Release polls on restart.
This is a required part of Phase 2, not an afterthought.

## Any repo — scaffold the workflow

When a repo has no release workflow, the agent scaffolds one and opens a PR (CI
still does the publish). This is a chat-driven file write + the existing auto-PR
flow — **not** the project-template grid (docs/171 Phase 3).

- `src/server/orchestrator/templates-release.ts` (new) — `renderReleaseWorkflow({versionSource, branch, gate, prerelease})`
  (generalized version of the workflow above) + `renderReleaseNotesConfig()`
  (generalized `.github/release.yml`). Render functions, **not** registered in the
  `TEMPLATES` array.
- **The scaffolded CI reads the version with the *same* parser as `prepare`, not
  fragile bash.** `prepare` writes the bump with `release-version.ts`'s readers; if
  the workflow re-derives the version with ad-hoc `grep`/`tomlq`, the two can
  disagree and CI tags the wrong version *silently*. So the scaffold ships a tiny
  version-read helper (the same logic as `release-version.ts`) that the workflow
  invokes, keeping write-side and read-side identical across ecosystems. Since that
  helper is Node (`release-version.ts` uses `node:fs`), the scaffolded workflow runs
  `setup-node` to read the version **even in non-Node repos** (the read step is
  ShipIt's, independent of the repo's own toolchain/gate).
- `shipit-config.ts` gains a `"release-branch"` `mechanism` value and a `branch`
  field; `release.mechanism`/`branch`/`versionSource`/`gate` parameterize the
  render and select this template vs. the simpler tag-triggered one.
- **`release-branch` requires an authoritative version source.** The branch-path
  derive reads the version from a file on the merged commit, so `release-branch`
  is only valid when the version source resolves to `package.json` / `Cargo.toml` /
  `pyproject.toml` / `VERSION` — **not** tag-only (a branch push has no version to
  read). Tag-only / unresolved repos stay on the `tag-triggered` mechanism.
- **Monorepo version source needs a path.** Today `release.versionSource` only
  holds an ecosystem identifier (`"package.json"`), not a path like
  `packages/api/package.json`. Add a path-capable field `version-source-path` that
  **augments** (does not replace) `versionSource`: `versionSource` tells the reader
  *how* to parse (which ecosystem), `version-source-path` tells it *where*. So a
  monorepo sets `versionSource: package.json` + `version-source-path: packages/api/package.json`.
  When multiple version files are detected the agent surfaces the options, the user
  picks, and the choice is persisted (don't guess — `docs/171`).

## Phasing

1. **Auto-publish CI + channel/config + agent-doc correction** (extends PR #1488).
   Rework `.github/workflows/release.yml` to the two-trigger + `resolve` shape;
   **change the stable-channel updater (`docs/162`) to resolve the latest final
   published tag reachable from `origin/stable` instead of the branch tip
   (Option A)**; add the `release-branch` mechanism + `branch` field to
   `shipit-config.ts`; run CI on `stable` PRs (add `stable` to `ci.yml`'s
   `pull_request: branches` + reconcile `paths-ignore`); dogfood via a `release:`
   block in ShipIt's own `shipit.yaml`; update `RELEASING.md`, `CLAUDE.md`,
   `docs/162`, `docs/171`. **Also correct the agent-facing docs now** —
   `shipit-docs/release.md` + `prompts/releases.md` already exist and tell the agent
   to hand-push tags (the old flow); for a `release-branch` repo that becomes wrong
   the instant the CI flips, so the merge-triggered guidance lands in Phase 1.
2. **`shipit release` command.** `writeVersionToSource`; `git.ts` `cherryPick` +
   `createBranchFrom`; `services/release-prepare.ts`; the `agentCreatePr`
   base-override + checked-out-head plumbing; routes + relay; shim handler +
   dispatch; `pr_open`/`pr_merged` card phases **with `emitChatCard` persistence**;
   the confirmation-gated `--prerelease` rc path.
3. **Scaffold into any repo.** `templates-release.ts` (+ the shared Node version-read
   helper run via `setup-node`) + the agent detect/offer flow + the
   `version-source-path` config field.

**`scripts/release.ts` fate:** kept as the maintainer-on-`stable` fallback (local
bump + tag) — still works, handy for manual/bootstrap cases — but once Phase 2
lands, `RELEASING.md` documents `shipit release prepare` + merge as the *primary*
path and the script as the fallback.

## Decisions (settled)

- **Single `stable` maintenance branch** (one release line); branch-per-release is
  deferred unless ShipIt ever supports multiple concurrent versions.
- **Stable channel follows the latest final tag reachable from `origin/stable`
  (Option A)**, not the branch tip — closes the merge-before-publish window, works
  for any repo, and restores `docs/162`'s "stable advances only to tagged releases"
  guarantee. Branch protection + CI-on-`stable`-PRs are quality gates, not the
  safety mechanism.
- Auto-publish via **one workflow, two triggers, self-publishing** — not a PAT
  (avoids the `GITHUB_TOKEN` recursion foot-gun and an unscaffoldable secret).
- Deterministic mechanics live **orchestrator-side**, surfaced via a thin
  `shipit release` shim — centralized, any-repo, agent can't fumble them.
- The poller is driven **server-side from the prepare route**, not an agent-echoed
  marker; the long-lived `pr_open`/`pr_merged` card is **persisted** (`emitChatCard`).
- Prereleases never advance the stable channel; rc's are cut via the tag path
  (`shipit release prepare --prerelease`), never by merging into `stable`.

## Open questions

- **Lockfile bump** for Node: best-effort root-version string edit vs. running the
  package manager (heavier, non-deterministic). Lean best-effort.
- **Release-from-main default**: merge `origin/main` (can conflict on a truly
  diverged branch) vs. require explicit `--from`/`--pick`. Leaning: require an
  explicit `--from`/`--pick` so the PR's payload is never a surprise.
- **Tag-resolution cost in the updater**: resolving "latest final tag reachable
  from `origin/stable`" needs a tag fetch + semver sort skipping prereleases —
  cheap, but a small addition to today's one-line `reset --hard`. Confirm it fits
  `update.sh` + `checkForUpdates()` cleanly.

## Key files

- `.github/workflows/release.yml`, `.github/release.yml` — the auto-publish CI;
  `.github/workflows/ci.yml` — add `stable` to `pull_request: branches`.
- `docs/162` updater (`deployment/vps/update.sh`, `services/updates.ts`,
  `release-channel.ts`) — resolve the latest final tag reachable from `origin/stable`.
- `src/server/shared/shipit-config.ts` — `release-branch` mechanism + `branch` + `version-source-path`.
- `src/server/orchestrator/release-version.ts` — reuse detection/semver; add `writeVersionToSource`.
- `src/server/orchestrator/services/release-prepare.ts` (new), `services/github.ts` (`agentCreatePr`), `src/server/shared/git.ts` (`cherryPick`).
- `src/server/orchestrator/services/release-branch-adopt.ts` (new) — repoint `session.branch` to `release/<version>` + re-arm the PR poller so the bump PR surfaces as the inline (mergeable) PR lifecycle card.
- `src/server/session/agent-shim/shipit.ts` + `shipit-release.ts` (new), `agent-ops-routes.ts`, `api-routes-github.ts`.
- `release-types.ts`, `release-markers.ts`, `release-status-poller.ts`, `services/release-flow.ts` — `pr_open`/`pr_merged` lifecycle.
- `src/server/orchestrator/templates-release.ts` (new) — scaffolding.
- `src/server/shipit-docs/release.md`, `orchestrator/prompts/releases.md`, `RELEASING.md`, `CLAUDE.md` — agent + maintainer guidance.
- Related: `docs/162-release-channels/plan.md`, `docs/171-release-from-ui/plan.md`.
