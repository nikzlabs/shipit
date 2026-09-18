# Release auto-publish — checklist

## Phase 1 — Auto-publish CI + channel/config
- [x] **Stable channel follows the latest final *published* tag reachable from `origin/stable` (Option A)** — change the updater (`deployment/vps/update.sh`, `services/updates.ts`, `release-channel.ts`) from `reset --hard origin/stable` to: `git tag --merged origin/stable` → strict-SemVer parse → filter prereleases → highest → `reset --hard <that tag's commit>`. **Not** `git describe` (nearest-by-distance). **Fail closed** if no final tag ("no stable release yet"); never fall back to branch tip (+ tests)
- [x] Rework `.github/workflows/release.yml`: `on: push: { branches: [stable], tags: ['v*'] }` + `resolve` job (branch path: tag absent → release; tag exists but Release missing → **repair/publish**; tag+Release present → no-op; reject `-rc.N`)
- [x] **`version-guard` runs on the tag path only** — skip it on the branch path (`github.ref_name` is `stable`, not `vX.Y.Z`; the tag is derived from the version source so it can't drift)
- [x] CI git identity; tag `$GITHUB_SHA`; re-fetch tags; `gh release view` existence check before `gh release create`
- [x] `concurrency` on the `publish` job grouped by `needs.resolve.outputs.tag`
- [x] Run CI on `stable` PRs: add `stable` to `ci.yml` `pull_request: branches` + reconcile `paths-ignore` (note: a docs-only hotfix PR could be path-skipped — acceptable since this is a quality gate, not load-bearing)
- [x] `shipit-config.ts`: add `"release-branch"` to `ReleaseMechanism`/`RELEASE_MECHANISMS`; add `branch` + `version-source-path` (augments `versionSource`: type=how-to-parse, path=where) to `ReleaseConfig` + `KNOWN_RELEASE_KEYS` + parser; `release-branch` requires a non-tag version source (+ co-located test)
- [x] **Correct the live agent docs now**: rewrite `shipit-docs/release.md` + `prompts/releases.md` for the merge-triggered `release-branch` flow (they currently tell the agent to hand-push tags — wrong the instant CI flips)
- [x] Dogfood: add `release:` block to ShipIt's own `shipit.yaml`
- [x] Docs: `RELEASING.md` (command-primary, `scripts/release.ts` as fallback), `CLAUDE.md`, `docs/162` (reconcile the impl section to tag-resolution), `docs/171` updated

## Phase 2 — `shipit release` command
- [x] `release-version.ts`: `writeVersionToSource(detected, newVersion)` (+ unit test)
- [x] `git.ts`: `cherryPick(shas)`, `createBranchFrom/resetBranchTo`
- [x] `services/release-prepare.ts`: `planRelease` + `prepareRelease`; drive poller from the route
- [x] `agentCreatePr` plumbing: add an explicit `base` override (generalize `reArm.baseBranch`) + ensure `release/<version>` is checked out so head resolves — NOT a drop-in reuse
- [x] Routes: `api-routes-github.ts` `/release/{plan,prepare}`; `agent-ops-routes.ts` relays
- [x] Shim: `shipit-release.ts` + `dispatchRelease`/help/rejected subcommands in `shipit.ts`
- [x] Card lifecycle: `pr_open`/`pr_merged` phases (`release-types.ts`), `pr-opened` marker, `markPrOpened` + PR-merge polling, `release-flow.ts` case
- [x] Persist the long-lived `pr_open`/`pr_merged` card via `emitChatCard` (docs/188/191); rehydrate phase from live PR/tag polls
- [x] `--prerelease` rc path: `prepare --prerelease` cuts the `-rc.N` tag via the broker (auto-increment `{n}`), **confirmation-gated** (no PR-merge gate exists for rc's), never hand-run `git tag`
- [x] `prepare` re-run: `--force-with-lease`; refuse to reset `release/<version>` if it has non-`prepare` commits
- [x] Agent docs: flesh out `shipit release` command usage in `shipit-docs/release.md` (the model flip already landed in Phase 1; this adds the command specifics + `--prerelease`)
- [x] Tests: version writer, marker parse, poller transition, shim handler, card persistence round-trip

## Phase 3 — Scaffold into any repo
- [x] `templates-release.ts`: `renderReleaseWorkflow(...)` + `renderReleaseNotesConfig()` (not in `TEMPLATES`) (module since removed — see plan.md note)
- [x] Scaffolded CI reuses the shared Node version-read helper (same logic as `release-version.ts`) via `setup-node` (even in non-Node repos), not ad-hoc bash
- [x] Agent detect-missing-workflow → offer → write files → open PR
- [x] Docs: scaffold offer in `shipit-docs/release.md`

## Test cases (from the Codex + Opus design reviews)
- [x] Stable channel updater resolves the latest final tag, skipping prereleases and un-tagged tips
- [x] Merge-before-publish window: stable instance updating between merge and tag/publish stays on the prior release
- [x] Failed post-merge gate → no tag/Release; stable users unaffected
- [x] First-release bootstrap: release branch absent → `prepare` offers to create it
- [x] Existing tag → branch-path resolve no-ops (no duplicate)
- [x] Concurrent `stable` push + manual `vX.Y.Z` tag for same version → publish job serialized
- [x] `-rc.N` version on the branch path → rejected; rc via `prepare --prerelease` tag path
- [x] Lockfile root-version bump applied alongside `package.json`
- [x] Monorepo / multiple version sources → ambiguity surfaced, choice persisted to `version-source-path`
- [x] Write-side (`prepare`) and read-side (scaffolded CI) parsers agree on the version
- [x] `--pick` cherry-pick conflict → abort + actionable error, no broken commit (`--from` is now conflict-proof — see the tree-override follow-up below)
- [x] Re-running `shipit release prepare` for the same version → updates the same PR (force-with-lease; refuses if branch has non-`prepare` commits)
- [x] Release card persists across reload/switch in `pr_open`/`pr_merged`

## Follow-up — surface + merge the release PR inside ShipIt
Found exercising `shipit release prepare` end-to-end: the bump PR (head `release/<version>`)
was never surfaced as the session's inline **PR lifecycle card**, so it couldn't be merged
from inside ShipIt (CLAUDE.md §1/§2). The release-status-poller card narrated the release
*outcome* but carried no merge button. Fix: the session **adopts** the `release/<version>`
branch when `prepare` opens the PR, reusing the existing PR-card + merge plumbing.
- [x] `services/release-branch-adopt.ts`: repoint `session.branch` → `release/<version>`, `reArm` + `forceRefreshSession` the PR poller, rebroadcast `session_list` (own-repo guard; no-op on re-run)
- [x] Wire into the `/release/prepare` route's `pr-opened` branch (guarded to `remoteUrl === session.remoteUrl`)
- [x] Tests: `release-branch-adopt.test.ts` (repoint + re-arm ordering, re-run no-op, missing session, no-poller degrade)

## Follow-up — refuse a content-free release by default
Found when a real `shipit release prepare patch` (no `--pick`/`--from`) shipped a content-free
`0.2.1`: a bare `prepare` resets `release/<version>` to `origin/<release-branch>` and adds only
the version-bump commit, so the PR carries **no new commits** over what's already released — a
release identical to the previous one, version number aside. Nothing warned or stopped it.
- [x] `git.ts`: `countCommitsAhead(base, head)` (`rev-list --count base..head`)
- [x] `release-prepare.ts`: after the payload (`--pick`/`--from`) is applied and BEFORE the bump
  commit, refuse when `countCommitsAhead(origin/<release-branch>, HEAD) === 0` — error names the
  fix (`--from <branch>`, or `--allow-empty`). Exempt `--bootstrap` (first release legitimately
  ships everything on the new branch); the prerelease path never reaches the guard.
- [x] `--allow-empty` opt-out threaded through the shim → route → service
- [x] Agent docs: `shipit-docs/release.md`, `prompts/releases.md`, `shipit.ts` help
- [x] Tests: `release-prepare.test.ts` (bare refuse, `--from`/`--pick` succeed, already-merged `--from`
  refused, `--allow-empty` permits, `--bootstrap`/`--prerelease` not regressed) + shim flag mapping +
  content-free error surfacing in `shipit-release.test.ts`

## Follow-up — cold-start guard: warn when a merge won't auto-publish
Found when a real merge into ShipIt's own `stable` (still carrying the legacy tag-triggered
`release.yml`) produced **no release and warned nothing**. GitHub evaluates a workflow as it
exists *on the pushed branch*, so merge-publish silently no-ops until the merge-trigger
workflow is on the maintenance branch — a bootstrap deadlock. See plan.md "Cold-start
requirement".
- [x] `release-autopublish-check.ts`: pure `workflowAutoPublishesOnMerge(yaml, branch)` (push-trigger / branch-filter detection) + `assessMergeAutoPublish(git, branch)` (reads `origin/<branch>:release.yml`, builds the actionable warning)
- [x] `git.ts`: `showFileAtRef(ref, path)` (`git show ref:path`)
- [x] Wire into `/release/{plan,prepare}` routes (release-branch mechanism; prepare check runs after the fetch so `--bootstrap` state is reflected); `warning?` on `ReleasePlan` + `pr-opened` result
- [x] Shim (`shipit-release.ts`): surface the warning in `plan` + `prepare` output, leading the `pr-opened` output instead of the "merge to publish" line
- [x] Tests: `release-autopublish-check.test.ts` — pure detector cases (merge-trigger / tag-only / missing / wildcards / branches-ignore / bare `on: push`) + git-backed legacy-warns / absent-warns / **cold-start bootstrap auto-publishes**
- [x] Docs: plan.md cold-start section, `RELEASING.md`, `shipit-docs/release.md`, `prompts/releases.md`

## Follow-up — `--from` takes the incoming tree wholesale (conflict-proof)
Found because `shipit release prepare --from main` aborted with a merge conflict on **every**
release after the first: `release/<version>` is built off `origin/stable`, which carries the
prior `Release vX.Y.Z` bump (mutating `package.json` + `package-lock.json`) that `main` lacks,
while `main` independently churns `package-lock.json` — so `git merge main` collides on exactly
the files the version bump is about to overwrite (and on real source if `stable` carries a
hotfix). "Resolve manually" is a dead end: the release runs on a sandbox-forbidden
`release/<version>` branch via a brokered flow. The intended design is that a full `--from main`
release **equals main's tree + the bump**, fully overriding stable's divergence (stable's
hotfixes are forward-ported to main anyway), so conflicts must be structurally impossible.
- [x] `git.ts`: `mergeOverride(ref)` — `commit-tree` (tree = `ref`'s tree, parents `[HEAD, ref]`)
  then `reset --hard`: a 2-parent merge commit whose tree is byte-for-byte `ref`'s, kept a
  descendant of `origin/<release-branch>` (first parent = release tip) so the bump PR still
  merges cleanly. Plumbing-built so it's unconditional — no conflict path, no "already up to
  date" special-case.
- [x] `release-prepare.ts`: the `--from` path calls `git.mergeOverride(ref)` instead of
  `git.merge(ref)` (drops the 409 conflict bail). `--pick` is **unchanged** (it ships a
  selective subset, so it cherry-picks and can still conflict).
- [x] Content-free guard for `--from` switches to a tree test: `mergeOverride` always adds a
  commit, so `git.diffStatTwoDot(origin/<release-branch>).files === 0` (incoming tree == release
  tree) replaces the commit count; `--pick`/bare keep `countCommitsAhead`.
- [x] Tests: `git-release-ops.test.ts` (override through a real code conflict → no abort, tree ==
  incoming, 2-parent commit with release tip as first parent; tree-identity); `release-prepare.test.ts`
  (`--from` takes the override path not `merge`, opens the PR; tree-equal-to-stable `--from` refused
  as content-free)
- [x] Docs: plan.md (`--from` tree-override + tree-based guard, error-surface, rejected-alt),
  `RELEASING.md` chat-driven section, `shipit-docs/release.md`

## Follow-up — sync the released version onto `main`
The version bump lands only on `stable` (the `release/<version>` PR is never merged back to
`main`), so `main`'s `package.json` drifted behind every release — `main` kept showing the
pre-release version forever. Fix: after a successful publish on the branch path, `release.yml`
opens a chore PR that forward-ports the released version onto `main`.
- [x] `release.yml`: `sync-main` job (`needs: [resolve, publish]`, gated to the branch path +
  `publish` success) — checks out `main`, skips if already at the version (repair re-runs) or if
  the sync branch exists, else `npm version <v> --no-git-tag-version` bump on `release-sync/vX.Y.Z`,
  commit, push, and `gh pr create --base main`
- [x] PR labeled `ignore-for-release` (it merges into `main`; keep it out of the next release's
  auto-generated notes); body built with `printf` so no indentation leaks in as a markdown code block
- [x] `pull-requests: write` added at the job level (workflow only grants `contents: write`)
- [x] Docs: `RELEASING.md` ("`main`'s version is auto-synced after publish"), `prompts/releases.md`
  (merge the follow-up sync PR), plan.md Key files
- [x] Carry the same sync into the scaffolded template (`templates-release.ts`): a `sync-default-branch`
  job (default branch resolved at runtime via `gh repo view`; skipped when it equals the maintenance
  branch) + a new generic write helper `shipit-write-version.mjs` (mirrors `writeVersionToSource` so the
  sync works for package.json / Cargo.toml / pyproject.toml / VERSION, not just `npm version`). Best-effort
  `ignore-for-release` label (may not exist in a fresh repo). Scaffold now ships **four** files. (module since removed — see plan.md note)
- [x] Tests: `templates-release.test.ts` — sync job present in the rendered workflow; write helper ⇔
  `writeVersionToSource` byte-identity across all four ecosystems + lockfile bump + non-zero on missing field;
  scaffold returns four artifacts (module since removed — see plan.md note)
- [x] Dead-PR guard: `prepareFinalRelease` refuses a non-`open` `alreadyExistedReason` with a 409
  instead of forwarding it as `alreadyExisted` — the shim printed a MERGED release PR as
  "updated release PR #N", announcing a release nothing would publish
- [x] Message built from `notProgressedBecause` (`base-not-contained` → `--release-branch <base>`,
  `no-new-work` → `--from <branch>`, `base-unknown` → release a different version); merged vs closed
  worded correctly (only a merged PR is unreopenable), an absent reason says only "not open"
- [x] Tests: `release-prepare.test.ts` — OPEN still forwarded, merged/closed/absent-reason refused,
  one per-reason remedy assertion; all refusal guards verified red with the guard deleted
- [x] Docs: `shipit-docs/release.md` dead-PR guard bullet, plan.md above
- [x] Wrong-base guard: `prepareFinalRelease` requires `pr.baseBranch === releaseBranch`. An OPEN
  `release/<version>` PR into one maintenance branch was reused by a run targeting another
  (`findPullRequest` resolves by head branch, no base filter), pairing that PR with the requested
  branch in both the shim line and the lifecycle poller — merging published through the wrong branch
- [x] Checked TWICE: a preflight via the new exported `findBranchPullRequest` before `createBranchFrom`,
  because `agentCreatePr` force-pushes before it decides — inspecting only its result already voided the
  open PR's diff/checks/reviews for a run about to be refused; plus the authoritative check on the
  returned value, since the PR can be retargeted in between. The message says which fired
- [x] Branch names rendered into the suggested command go through `safeRefForCommand` (mirrors
  `safeBaseRef` in `agent-shim/gh.ts`) — a ref may legally contain `;`, `$`, `(`, `)` and quotes
- [x] Remedy text corrected: "close it and re-run" does NOT work (a closed PR still resolves, so it
  lands on the dead-PR guard); the working remedies are `--release-branch <that base>`, a different
  version, or retargeting on GitHub
- [x] `onWorkspaceRewritten` moved into a `finally` in the prepare route, GATED on a new `onTreeRewrite`
  callback that `prepareRelease` fires at each `checkout -B`. `prepareRelease` rewrites the tree before
  most of its failure paths (content-free guard, no-op-bump 500, force-push, `agentCreatePr` errors,
  both release-PR guards), so notifying only on success left the container on a stale `shipit.yaml` /
  compose file / `node_modules` — but notifying unconditionally is not free either: it can queue a
  Compose `reconcile()` (clearing the service map, poller and log followers) and open the install gate,
  tearing down install-gated preview services
- [x] Tests: `release-prepare.test.ts` preflight refusal (nothing destructive ran) + post-preflight
  refusal + injection-safe command + two acceptance guards against over-rejection;
  `integration_tests/release-prepare-rewrite-notify.test.ts` drives the real route to a post-rewrite
  failure and asserts the notification, AND to a pre-rewrite failure asserting silence. Every guard
  verified red without its fix
- [x] Docs: `shipit-docs/release.md` wrong-base guard bullet, plan.md above. Corrected plan.md's earlier
  wrong claim that over-notifying is safe because the helper is idempotent
