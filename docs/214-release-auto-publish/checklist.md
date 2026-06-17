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
- [x] `templates-release.ts`: `renderReleaseWorkflow(...)` + `renderReleaseNotesConfig()` (not in `TEMPLATES`)
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
- [x] `--pick`/`--from` merge conflict → abort + actionable error, no broken commit
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
