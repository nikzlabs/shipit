# Release auto-publish — checklist

## Phase 1 — Auto-publish CI + channel/config
- [ ] **Stable channel follows the latest final *published* tag reachable from `origin/stable` (Option A)** — change the updater (`deployment/vps/update.sh`, `services/updates.ts`, `release-channel.ts`) from `reset --hard origin/stable` to: `git tag --merged origin/stable` → strict-SemVer parse → filter prereleases → highest → `reset --hard <that tag's commit>`. **Not** `git describe` (nearest-by-distance). **Fail closed** if no final tag ("no stable release yet"); never fall back to branch tip (+ tests)
- [ ] Rework `.github/workflows/release.yml`: `on: push: { branches: [stable], tags: ['v*'] }` + `resolve` job (branch path: tag absent → release; tag exists but Release missing → **repair/publish**; tag+Release present → no-op; reject `-rc.N`)
- [ ] **`version-guard` runs on the tag path only** — skip it on the branch path (`github.ref_name` is `stable`, not `vX.Y.Z`; the tag is derived from the version source so it can't drift)
- [ ] CI git identity; tag `$GITHUB_SHA`; re-fetch tags; `gh release view` existence check before `gh release create`
- [ ] `concurrency` on the `publish` job grouped by `needs.resolve.outputs.tag`
- [ ] Run CI on `stable` PRs: add `stable` to `ci.yml` `pull_request: branches` + reconcile `paths-ignore` (note: a docs-only hotfix PR could be path-skipped — acceptable since this is a quality gate, not load-bearing)
- [ ] `shipit-config.ts`: add `"release-branch"` to `ReleaseMechanism`/`RELEASE_MECHANISMS`; add `branch` + `version-source-path` (augments `versionSource`: type=how-to-parse, path=where) to `ReleaseConfig` + `KNOWN_RELEASE_KEYS` + parser; `release-branch` requires a non-tag version source (+ co-located test)
- [ ] **Correct the live agent docs now**: rewrite `shipit-docs/release.md` + `prompts/releases.md` for the merge-triggered `release-branch` flow (they currently tell the agent to hand-push tags — wrong the instant CI flips)
- [ ] Dogfood: add `release:` block to ShipIt's own `shipit.yaml`
- [ ] Docs: `RELEASING.md` (command-primary, `scripts/release.ts` as fallback), `CLAUDE.md`, `docs/162` (reconcile the impl section to tag-resolution), `docs/171` updated

## Phase 2 — `shipit release` command
- [ ] `release-version.ts`: `writeVersionToSource(detected, newVersion)` (+ unit test)
- [ ] `git.ts`: `cherryPick(shas)`, `createBranchFrom/resetBranchTo`
- [ ] `services/release-prepare.ts`: `planRelease` + `prepareRelease`; drive poller from the route
- [ ] `agentCreatePr` plumbing: add an explicit `base` override (generalize `reArm.baseBranch`) + ensure `release/<version>` is checked out so head resolves — NOT a drop-in reuse
- [ ] Routes: `api-routes-github.ts` `/release/{plan,prepare}`; `agent-ops-routes.ts` relays
- [ ] Shim: `shipit-release.ts` + `dispatchRelease`/help/rejected subcommands in `shipit.ts`
- [ ] Card lifecycle: `pr_open`/`pr_merged` phases (`release-types.ts`), `pr-opened` marker, `markPrOpened` + PR-merge polling, `release-flow.ts` case
- [ ] Persist the long-lived `pr_open`/`pr_merged` card via `emitChatCard` (docs/188/191); rehydrate phase from live PR/tag polls
- [ ] `--prerelease` rc path: `prepare --prerelease` cuts the `-rc.N` tag via the broker (auto-increment `{n}`), **confirmation-gated** (no PR-merge gate exists for rc's), never hand-run `git tag`
- [ ] `prepare` re-run: `--force-with-lease`; refuse to reset `release/<version>` if it has non-`prepare` commits
- [ ] Agent docs: flesh out `shipit release` command usage in `shipit-docs/release.md` (the model flip already landed in Phase 1; this adds the command specifics + `--prerelease`)
- [ ] Tests: version writer, marker parse, poller transition, shim handler, card persistence round-trip

## Phase 3 — Scaffold into any repo
- [ ] `templates-release.ts`: `renderReleaseWorkflow(...)` + `renderReleaseNotesConfig()` (not in `TEMPLATES`)
- [ ] Scaffolded CI reuses the shared Node version-read helper (same logic as `release-version.ts`) via `setup-node` (even in non-Node repos), not ad-hoc bash
- [ ] Agent detect-missing-workflow → offer → write files → open PR
- [ ] Docs: scaffold offer in `shipit-docs/release.md`

## Test cases (from the Codex + Opus design reviews)
- [ ] Stable channel updater resolves the latest final tag, skipping prereleases and un-tagged tips
- [ ] Merge-before-publish window: stable instance updating between merge and tag/publish stays on the prior release
- [ ] Failed post-merge gate → no tag/Release; stable users unaffected
- [ ] First-release bootstrap: release branch absent → `prepare` offers to create it
- [ ] Existing tag → branch-path resolve no-ops (no duplicate)
- [ ] Concurrent `stable` push + manual `vX.Y.Z` tag for same version → publish job serialized
- [ ] `-rc.N` version on the branch path → rejected; rc via `prepare --prerelease` tag path
- [ ] Lockfile root-version bump applied alongside `package.json`
- [ ] Monorepo / multiple version sources → ambiguity surfaced, choice persisted to `version-source-path`
- [ ] Write-side (`prepare`) and read-side (scaffolded CI) parsers agree on the version
- [ ] `--pick`/`--from` merge conflict → abort + actionable error, no broken commit
- [ ] Re-running `shipit release prepare` for the same version → updates the same PR (force-with-lease; refuses if branch has non-`prepare` commits)
- [ ] Release card persists across reload/switch in `pr_open`/`pr_merged`
