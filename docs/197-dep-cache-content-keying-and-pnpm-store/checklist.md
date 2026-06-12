# Checklist — dep-cache evolution (docs/197)

## Part 1 — content-keyed install skip

- [ ] Extend `InstallMarkerStamp` with `depsHash` (+ version bump)
- [ ] Per-PM canonical input set + `hashFiles`-style sha256
- [ ] Recognized-pure-install-command allowlist (codegen hazard gate)
- [ ] `agent.install-inputs` escape hatch
- [ ] Widen the `/install` gate match (sourceCommit OR depsHash)
- [ ] Orchestrator pre-stamp writes `depsHash` too
- [ ] shipit-docs: `install-inputs` field

## Part 2 — pnpm shared store (this PR)

- [x] pnpm detection (`isPnpmRepo`) — packageManager > install command > lockfile,
      one decision point next to `validDepDirsForOverlay`
- [x] `prepareOverlaySpecs` returns `[]` for pnpm repos (skip overlay)
- [x] `preparePnpmStore` — shared `<stateDir>/pnpm-store/<runtimeKey-hash>` dir,
      gated on overlay eligibility + workspace state volume
- [x] Container mount (`PNPM_STORE_CONTAINER_PATH`, same-superblock Subpath) +
      `npm_config_store_dir` env, wired through `buildConfig`/`buildContainerConfig`
- [x] Lazy store-dir creation at container-create time
- [x] Wired into both agent-container creation paths (cold/restart + warm standby)
- [x] disk-janitor `sweepStalePnpmStores` — keeps the live store, reaps
      stale-runtime/cold stores past `DISK_JANITOR_CACHE_DAYS`
- [x] shipit-docs: pnpm shared-store section + `pnpm patch` in-place-mutation caveat
- [x] Tests: detection precedence, overlay-skip + store mount/env, npm unchanged,
      flag-off unchanged, janitor sweep
- [x] All behind the existing `OVERLAY_DEP_STORE` flag (flag-off byte-for-byte unchanged)

## Shelf (not scheduled)

- [ ] Content-addressed multi-base store (`depsHash → base generation`)
