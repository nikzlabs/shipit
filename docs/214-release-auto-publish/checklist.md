# Release auto-publish — checklist

## Phase 1 — Auto-publish CI + config
- [ ] Rework `.github/workflows/release.yml`: `on: push: { branches: [stable], tags: ['v*'] }` + `resolve` job (derive tag on branch path, no-op if tag exists, create tag on green, publish)
- [ ] Add `concurrency` group to serialize releases
- [ ] `shipit-config.ts`: add `"release-branch"` to `ReleaseMechanism`/`RELEASE_MECHANISMS`; add `branch` to `ReleaseConfig` + `KNOWN_RELEASE_KEYS` + parser (+ co-located test)
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
