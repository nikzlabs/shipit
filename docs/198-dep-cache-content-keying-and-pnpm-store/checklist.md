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

## Live verification follow-ups (2026-06-12)

Three gaps found running Part 2 (PR #1279) on the production canary (pnpm 11.6.0,
real worker image). All three fixed in this follow-up PR; flag defaults unchanged.

- [x] **Store now mounts at pnpm 11's relocation target.** pnpm 11 ignores
      `npm_config_store_dir` **and** `pnpm config set store-dir` (the store-dir setting
      lives only in `pnpm-workspace.yaml` now). With HOME on the container overlay fs
      (different device from `/workspace`), pnpm relocated its store to the project's
      nearest mountpoint — `/workspace/.pnpm-store/v11/` — so the platform's
      `/pnpm-store` mount stayed **empty** and nothing was shared across sessions.
      Fix: mount the shared runtime-keyed store at `/workspace/.pnpm-store`
      (`PNPM_STORE_CONTAINER_PATH`), the exact relocation target, so pnpm relocates
      straight into the shared store with zero config. Host source unchanged
      (`pnpm-store/<runtimeKey-hash>` Subpath of the state volume); `npm_config_store_dir`
      kept at the new path for older pnpm. (`container-lifecycle.ts`.)
- [x] **`.pnpm-store/` excluded from git per clone.** The relocated store is a
      mountpoint at the workspace root and the repo's `.gitignore` doesn't cover it,
      so the post-turn auto-commit committed `.pnpm-store/v11/index.db` onto the
      session branch. Fix: write `.pnpm-store/` into the session clone's
      `.git/info/exclude` at clone prep (`RepoGit.cloneFromCache`) — non-tracked, so
      the committed tree is unchanged — plus a defensive idempotent ensure in
      `GitManager.autoCommit` to heal clones made before this fix. New helper
      `ensurePnpmStoreGitExcluded` (`shared/git.ts`).
- [x] **Publish path gated on `isPnpmRepo`.** The mount-side skip
      (`prepareOverlaySpecs` → []) worked, but the post-install publish hook was not
      pnpm-gated and exported + published a never-mounted ~480 MB base generation.
      Fix: `publishDepDirOverlayBases` returns `[]` for pnpm repos at the SAME
      `isPnpmRepo` decision point the mount side uses — one detector, both sides
      (`overlay-publish.ts`).
- [x] **Tests.** store mount target + runtime-keyed Subpath; exclude written once +
      idempotent + best-effort on missing `.git`; auto-commit doesn't stage a
      relocated store; clone prep writes the exclude; publish skipped for pnpm repos
      while npm repos still publish. Flag-off byte-for-byte unchanged.

## Shelf (not scheduled)

- [ ] Content-addressed multi-base store (`depsHash → base generation`)
