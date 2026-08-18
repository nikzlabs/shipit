# Checklist — Dependency-change auto-reinstall (#1622)

- [x] Push install commands + resolved dep-input set to the runner (`service-manager-setup.ts`)
- [x] Detect dep-input changes in the `file_changes` handler (`isDepInputChange`)
- [x] Bracketed mid-session reinstall reusing `setInstallRunning` + `runInstall`
- [x] 30s cooldown throttle with trailing-edge coalescing
- [x] Clear the throttle timer on dispose
- [x] Co-located unit tests (predicate + throttle)
- [x] Update agent-facing docs (environment.md, preview.md)
- [ ] Extend the install-gate integration test (CI-run; OOMs in-session)

## nikzlabs/shipit#2429 — orchestrator-side tree rewrites

- [x] `onWorkspaceRewritten` — the shared config-re-read + dependency-re-check call
- [x] `ContainerSessionRunner.notifyWorkspaceRewritten` (gated on a dep-input set)
- [x] Wire the sync/rebase driver (clean + conflicts-resolved paths)
- [x] Wire the rollback route and `shipit branch reset-to-base`
- [x] Wire the pre-turn auto-reset of a merged branch
- [x] Sweep the remaining `restoreLfsAfterTreeRewrite` sites: rebase abort, git
      pull, session merge, rewind (WS), `release prepare` (own clone only)
- [x] Unit tests (runner gate + helper ordering/fail-safety + the four call sites)
- [x] Update agent-facing docs (shipit-yaml.md, environment.md, preview.md)
