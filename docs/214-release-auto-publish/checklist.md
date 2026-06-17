# Release auto-publish — checklist

## Phase 1 — Auto-publish CI + config
- [ ] Rework `.github/workflows/release.yml`: `on: push: { branches: [stable], tags: ['v*'] }` + `resolve` job (derive tag on branch path; no-op only if HEAD == existing tag commit; **fail** if tag exists but HEAD moved; reject `-rc.N` on branch path; create tag on green; publish)
- [ ] CI git identity before tagging; idempotent `gh release create` (skip if Release exists)
- [ ] `concurrency` grouped by **resolved tag** (not `github.ref`)
- [ ] Enforce the stable-channel invariant: branch protection on `stable` (gate passes before merge; no direct pushes) — document in `RELEASING.md`
- [ ] `shipit-config.ts`: add `"release-branch"` to `ReleaseMechanism`/`RELEASE_MECHANISMS`; add `branch` to `ReleaseConfig` + `KNOWN_RELEASE_KEYS` + parser; `release-branch` requires a non-tag `versionSource` (+ co-located test)
- [ ] Dogfood: add `release:` block to ShipIt's own `shipit.yaml`
- [ ] Docs: `RELEASING.md`, `CLAUDE.md`, `docs/162`, `docs/171` updated to the merge-triggered model

## Phase 2 — `shipit release` command
- [ ] `release-version.ts`: `writeVersionToSource(detected, newVersion)` (+ unit test)
- [ ] `git.ts`: `cherryPick(shas)`, `createBranchFrom/resetBranchTo`
- [ ] `services/release-prepare.ts`: `planRelease` + `prepareRelease` (reuse `agentCreatePr`); drive poller from the route
- [ ] Routes: `api-routes-github.ts` `/release/{plan,prepare}`; `agent-ops-routes.ts` relays
- [ ] Shim: `shipit-release.ts` + `dispatchRelease`/help/rejected subcommands in `shipit.ts`
- [ ] Card lifecycle: `pr_open`/`pr_merged` phases (`release-types.ts`), `pr-opened` marker, `markPrOpened` + PR-merge polling, `release-flow.ts` case
- [ ] Agent docs: `shipit-docs/release.md` + `prompts/releases.md` (use `shipit release prepare`, never hand-edit/tag)
- [ ] Tests: version writer, marker parse, poller transition, shim handler

## Phase 3 — Scaffold into any repo
- [ ] `templates-release.ts`: `renderReleaseWorkflow(...)` + `renderReleaseNotesConfig()` (not in `TEMPLATES`)
- [ ] Agent detect-missing-workflow → offer → write files → open PR
- [ ] Docs: scaffold offer in `shipit-docs/release.md`

## Test cases (from the Codex design review)
- [ ] No-bump push to `stable` (tag exists, HEAD moved) → CI fails loudly
- [ ] Release PR gate fails → cannot merge to `stable` (branch protection)
- [ ] First-release bootstrap: release branch absent → `prepare` offers to create it
- [ ] Existing tag at a different SHA → resolve-job failure, not a duplicate
- [ ] Concurrent `stable` push + manual `vX.Y.Z` tag for same version → serialized (concurrency by resolved tag)
- [ ] `-rc.N` version on the branch path → rejected (prereleases don't advance stable)
- [ ] Lockfile root-version bump applied alongside `package.json`
- [ ] Monorepo / multiple version sources → ambiguity surfaced, choice persisted
- [ ] `--pick`/`--from` merge conflict → abort + actionable error, no broken commit
- [ ] Re-running `shipit release prepare` for the same version → updates the same PR (deterministic `release/<version>` branch)
