# Checklist — dep-cache evolution (content-keyed install skip + pnpm shared store)

## Part 1 — content-keyed install skip (PR #1278)

- [x] **`depsHash` on the marker stamp.** Added `depsHash: string | null` to
      `InstallMarkerStamp`; bumped `INSTALL_MARKER_VERSION` 1 → 2 (a v1 marker, no
      `depsHash`, parses to `null` → clean miss); `parseMarker`/`makeMarker` carry it.
- [x] **Widened `markerMatches`.** runtime + commands must match AND
      (sourceCommit matches OR depsHash matches). `depsHashMatches` requires both
      sides non-null + equal, so a missing/`null` hash can only cause a reinstall,
      never a wrong skip.
- [x] **`deps-hash.ts`** — `depInputsForCommand` (npm/pnpm/yarn/pip/uv allowlist,
      tolerates common flags), `resolveDepsHashInputs` (override vs command-derived
      default vs commit-only fallback), `computeDepsHash` (sha256 over ordered
      `(relpath, bytes)`; `null` when no input exists), `computeInstallDepsHash`.
- [x] **Codegen safety.** Content path active only when every `agent.install` entry
      is a recognized pure dep install; otherwise commit-only.
- [x] **`agent.install-inputs` config.** Added `installInputs` to `AgentConfig`
      (default `null`), `KNOWN_AGENT_KEYS`, `parseInstallInputs` (shares
      `normalizeLiteralRelPath` with `dep-dirs`); explicit list replaces the default set.
- [x] **`/install` gate** computes `depsHash` for the current stamp
      (`session-worker.ts`, reads `install-inputs` from the resolved config). The
      empty-dep-dir contradiction check applies to both skip paths.
- [x] **Orchestrator pre-stamp** (`preStampInstallMarker`) writes `depsHash` too,
      so a later different-commit/identical-deps session content-key-skips.
- [x] **Publish/ancestry CAS unchanged** — this only widens skips.
- [x] **Docs.** `shipit-docs/shipit-yaml.md` documents `install-inputs` + the
      content-keyed skip (field table + subsection).
- [x] **Tests.** marker round-trip + legacy-miss + OR logic; `deps-hash` allowlist +
      resolution + hashing; `shipit-config` install-inputs parsing; pre-stamp carries
      `depsHash`; session-worker integration (content-match skip across commits,
      dep-edit bust, non-allowlisted stays commit-only).
- [x] **No flag defaults changed.** `OVERLAY_DEP_STORE` untouched; the content key
      is in the always-on install-marker path and is inert (null hash) unless the
      install is a recognized pure dep install or `install-inputs` is declared.

## Part 2 — pnpm shared store (PR #1279)

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
