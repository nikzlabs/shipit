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

### Cold-start requirement — the merge-trigger workflow must already be on the branch

**GitHub Actions evaluates a workflow file as it exists *on the branch that was
pushed*.** So merge-publish only fires once the maintenance branch carries the
merge-triggered `release.yml` (`on: push: { branches: [<branch>] }`). Two cold
states run **nothing** when a bump PR merges — the PR merges cleanly, but no tag
and no Release are produced:

- the branch has **no** `.github/workflows/release.yml` (a brand-new repo), or
- the branch still carries the **legacy tag-triggered** workflow
  (`on: push: { tags: ['v*'] }`, no `branches:` trigger).

This is a **bootstrap deadlock**: the very commit that *adds* the merge-trigger
workflow is unreleased on `main`, and only reaches the maintenance branch by being
released — which can't happen via merge-publish until the workflow is already
there. It is exactly how this bug was found: a real merge into ShipIt's own
`stable` (which still had the legacy tag-only `release.yml`) produced **no
release** and warned nothing.

**Remedies, both no-manual-git:**

- **Branch absent (true first release):** `shipit release prepare --bootstrap`
  seeds the maintenance branch off `main` — so it inherits main's merge-trigger
  workflow — then opens the bump PR. Merging it then auto-publishes.
- **Branch exists but carries the legacy / no workflow (migration):** cut **one**
  release via the **tag path** — push a `vX.Y.Z` tag on a commit that already
  carries the merge-trigger workflow (the legacy workflow on `stable` still fires
  on a tag push; the new workflow at the tagged commit gates + publishes). After
  that the workflow is on the branch and every future merge auto-publishes.

**Detection / warning (the guard):** `shipit release plan|prepare` reads the
maintenance branch's `release.yml` (`assessMergeAutoPublish` in
`release-autopublish-check.ts` → `git show origin/<branch>:.github/workflows/release.yml`,
parsed by the pure `workflowAutoPublishesOnMerge`) and attaches an **actionable
warning** when a merge won't auto-publish — naming the remedy above. The prepare
check runs *after* `prepare`'s fetch (and after a `--bootstrap` that just seeded
the branch off `main`), so the post-bootstrap state is reflected: bootstrapping
off a `main` that has the workflow yields **no** warning, while a stale `stable`
warns. The guard never hard-blocks (a deliberate bootstrap is allowed), but a
normal prepare can never *look* successful while the merge will silently no-op.

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
  or **`--from` tree-override** (release from main — see below); bump the version
  source (new `writeVersionToSource` in `release-version.ts`); commit; open the PR
  with `base = release branch`. **Content-free guard:** after the payload is applied
  and BEFORE the bump commit, `prepare` refuses an empty payload (a release identical
  to the previous one, version number aside) and names the fix (`--from <branch>`, or
  `--allow-empty` to opt into a bump-only release). The emptiness test differs by
  path: `--pick`/bare count new commits over `origin/<branch>` (`git.countCommitsAhead`);
  `--from` always synthesizes an override commit, so a commit count is meaningless —
  it instead measures the **two-dot tree diff** `origin/<branch>..HEAD`
  (`git.diffStatTwoDot`) and refuses when the incoming tree equals the release
  branch's. `--bootstrap` is exempt (the first release legitimately ships the whole
  new branch); the prerelease path never reaches the guard.

  **`--from` takes the incoming tree WHOLESALE (conflict-proof), it does NOT
  three-way merge.** A `--from main` release should ship exactly main's tree at the
  new version. A plain `git merge main` into `release/<version>` (built off
  `origin/stable`) conflicts on *every non-first* release: `stable` carries the
  prior `Release vX.Y.Z` bump that `main` lacks, while `main` independently churns
  `package-lock.json` — and can conflict on real source too if `stable` carries a
  hotfix. Bailing to "resolve manually" is a dead end: the release runs on a
  `release/<version>` branch the sandbox forbids hand-editing, and the flow is
  brokered. So `git.mergeOverride(ref)` (plumbing: `commit-tree` with tree = `ref`'s
  tree and parents `[HEAD, ref]`, then `reset --hard`) records a **2-parent merge
  commit whose tree is byte-for-byte the incoming ref's**, fully overriding stable's
  divergence, while keeping the new commit a **descendant of `origin/<branch>`** (first
  parent = release-branch tip) so the bump PR still merges into stable cleanly.
  Because the tree is *replaced* rather than merged, this **can never conflict** — a
  release `--from` never bails to manual resolution. Rationale: `stable` may carry
  cherry-picked hotfixes, but for a full `--from main` release those are
  forward-ported to `main` anyway, so `main` is the source of truth and stable's
  divergence is intentionally ignored. (`--pick` is unchanged — it deliberately
  ships a *selective* subset, so it cherry-picks rather than overriding.)

  **The current version is anchored to the release branch, NOT the working tree
  (bugfix).** The version bump PR lands only on `<release-branch>` and is *never*
  merged back to `main`, so a session working tree (branched off `main`) lags every
  release. Computing the next version from the working tree therefore proposed a
  version **at or below** what's already published — e.g. with the working tree at
  `0.2.0` and `v0.2.2` already released, `plan patch` computed a regressed `0.2.1`,
  and `prepare --from main` would have written `0.2.1` over stable's `0.2.2` in the
  bump PR (CI then derives a *lower* tag than the live one; the stable channel,
  which follows the highest reachable final tag, wouldn't even advance). The fix
  (`resolveCurrentVersion` in `release-prepare.ts`) reads the current version from
  the version source at `origin/<release-branch>` — what's actually released and
  exactly what CI reads off the merged commit — and only falls back to the working
  tree when that branch/file is absent (first release / bootstrap) or the mechanism
  isn't `release-branch` (where `main` IS the release source). It applies to the rc
  core too. Both `plan` and `prepare` fetch `origin` before reading the anchor. The
  string-level `parseVersionFromContent` (in `release-version.ts`) lets the anchor
  parse a version out of a file fetched at a git ref (`git show <ref>:<path>`)
  without a working-tree checkout, mirroring the on-disk readers.

  **This needs new plumbing on `agentCreatePr`, not just a reuse:**
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
below); no version source / ambiguous (monorepo) version sources; and a **`--pick`
cherry-pick conflict** (abort, name the conflicting commit, ask the user to resolve
rather than committing a broken tree). Note `--from` has **no** conflict error: it
takes the incoming tree wholesale (`git.mergeOverride`), so it is structurally
conflict-proof — only `--pick` can conflict.

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

**Mechanism-aware confirm message.** The `proposed` card's "Confirm & publish"
button injects a chat reply that becomes the agent's marching orders, so its
wording must match the repo's mechanism. `release-types.ts`'s `ReleaseStatusSummary`
carries a `mechanism` field (sourced authoritatively from `shipit.yaml`
`release.mechanism` in `release-flow.ts`, with the propose marker as an optional
override, defaulting to `tag-triggered`). For `release-branch` the reply tells the
agent to bump + open/merge the version-bump PR and let CI tag on merge; for
`tag-triggered` it keeps the bump + annotated-tag + push wording. The per-mechanism
text lives in the pure `release-confirm-message.ts` builder so it's unit-tested
independently of `App.tsx`.

**Card-injected provenance + judgment framing.** The injected reply is templated,
not hand-typed, but the agent receives it on the same surface as a real user
instruction and so could mistake the canned wording for a deliberate directive.
That was actively harmful for the old release-branch string ("Do NOT create or
push a tag"): during a **cold start** the documented remedy is a one-time tag-path
bootstrap — which the card already flags via its auto-publish/cold-start warning —
so an absolute prohibition contradicted the very fix. The builder now mirrors
`action-checklist-message.ts`: every variant leads with a provenance marker
(`[Release card → Confirm & publish]`) and frames the body as *intent* ("I approved
publishing this version") plus a "re-check current state before acting" clause. The
release-branch variant keeps the safety intent (let CI tag on merge) but phrases it
as "check the card's auto-publish/cold-start warning first, and adapt if a merge
won't tag yet" rather than an absolute "never push a tag". The cold-start `warning`
is not threaded into the builder (the card type carries no such field today); the
message points the agent at the card's warning generically instead.

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
- **The scaffold also forward-ports the version onto the default branch** — a
  `sync-default-branch` job mirroring ShipIt's own (the release bump lands only on
  the maintenance branch, so the default branch's version source would drift behind
  every release). It resolves the default branch at runtime (`gh repo view`, so no
  extra config; works for `main`/`master`), skips when that equals the maintenance
  branch, and opens a chore PR (`release-sync/vX.Y.Z`) best-effort labeled
  `ignore-for-release`. Because the bump must be ecosystem-generic (not `npm version`),
  the scaffold ships a **write helper** `shipit-write-version.mjs` mirroring
  `writeVersionToSource` — the write-side twin of the read helper, keeping the synced
  version byte-identical to what the release command writes. The scaffold is now
  **four** files; a `templates-release.test.ts` round-trip asserts write/read parity.
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
- **Release-from-main default**: require an explicit `--from`/`--pick` so the PR's
  payload is never a surprise (resolved). The conflict concern is moot: `--from`
  now takes the incoming tree wholesale (`git.mergeOverride`) instead of a
  three-way merge, so a diverged branch can never conflict.
- **Tag-resolution cost in the updater**: resolving "latest final tag reachable
  from `origin/stable`" needs a tag fetch + semver sort skipping prereleases —
  cheap, but a small addition to today's one-line `reset --hard`. Confirm it fits
  `update.sh` + `checkForUpdates()` cleanly.

## Key files

- `.github/workflows/release.yml`, `.github/release.yml` — the auto-publish CI;
  `.github/workflows/ci.yml` — add `stable` to `pull_request: branches`. The
  `sync-main` job in `release.yml` (branch path, after a green publish) opens a
  chore PR forward-porting the released version onto `main` (the bump lands only
  on `stable`, so `main` would otherwise drift behind every release) — labeled
  `ignore-for-release`, idempotent on repair re-runs.
- `docs/162` updater (`deployment/vps/update.sh`, `services/updates.ts`,
  `release-channel.ts`) — resolve the latest final tag reachable from `origin/stable`.
- `src/server/shared/shipit-config.ts` — `release-branch` mechanism + `branch` + `version-source-path`.
- `src/server/orchestrator/release-version.ts` — reuse detection/semver; add `writeVersionToSource`; `parseVersionFromContent` + the `parse*(raw)` cores for reading a version out of a file fetched at a git ref (the release-branch anchor).
- `src/server/orchestrator/services/release-prepare.ts` (new), `services/github.ts` (`agentCreatePr`), `src/server/shared/git.ts` (`cherryPick`, `showFileAtRef`, `mergeOverride` — the conflict-proof `--from` tree override). `resolveCurrentVersion` anchors the current version to `origin/<release-branch>` rather than the lagging working tree.
- `src/server/orchestrator/release-autopublish-check.ts` (new) — cold-start guard: detect whether merging into the maintenance branch will auto-publish (the branch's workflow has a push trigger for it) and build the actionable warning.
- `src/server/orchestrator/services/release-branch-adopt.ts` (new) — repoint `session.branch` to `release/<version>` + re-arm the PR poller so the bump PR surfaces as the inline (mergeable) PR lifecycle card.
- `src/server/session/agent-shim/shipit.ts` + `shipit-release.ts` (new), `agent-ops-routes.ts`, `api-routes-github.ts`.
- `release-types.ts`, `release-markers.ts`, `release-status-poller.ts`, `services/release-flow.ts` — `pr_open`/`pr_merged` lifecycle; `mechanism` on the card (resolved from `shipit.yaml` in `release-flow.ts`).
- `src/client/utils/release-confirm-message.ts` (new) — pure, mechanism-aware builder for the "Confirm & publish" reply; consumed by `App.tsx` (`handleReleaseConfirm`), threaded via `ReleaseLifecycleCard` → `MessageList`/`MessageCards` `onReleaseConfirm(version, mechanism)`.
- `src/server/orchestrator/templates-release.ts` (new) — scaffolding; renders the
  workflow (incl. the `sync-default-branch` job), notes config, and the read +
  write version helpers (`templates-release-files/shipit-{read,write}-version.mjs`).
- `src/server/shipit-docs/release.md`, `orchestrator/prompts/releases.md`, `RELEASING.md`, `CLAUDE.md` — agent + maintainer guidance.
- Related: `docs/162-release-channels/plan.md`, `docs/171-release-from-ui/plan.md`.
