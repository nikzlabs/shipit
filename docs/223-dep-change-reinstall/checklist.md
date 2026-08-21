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

### nikzlabs/shipit#2429 — say so when the re-check cannot run

- [x] `dependency-staleness.ts` — the `DependencyGap` type + its two renderings
- [x] Record a gap instead of returning silently (non-keyable install; failed re-install)
- [x] Carry the rewrite label through `onWorkspaceRewritten`, consumed per install
- [x] Clear the gap only on positive evidence (install ok, or a marker skip)
- [x] Persisted transcript notice, wired via `onDependenciesUnverified`
- [x] `dependencies` alongside `GET /api/sessions/:id/services` + `shipit service list`
- [x] Co-located tests (text, runner state, route shape, shim rendering)
- [x] Update agent-facing docs with the new signal and how to read it

### Say at setup that content-keying is off, before it costs a diagnosis

- [x] `install-content-key.ts` — predicate, once-per-command-list record, notice text
- [x] Detect in `setupServiceManager`, where the dep-input set is resolved
- [x] Re-evaluate in `applyShipitConfigChange`, outside the `agent.install` delta
- [x] `installContentKeyOff` on the diagnostics payload + the panel row
- [x] Co-located tests (predicate, once/re-arm/clear, payload, panel, both wirings)
