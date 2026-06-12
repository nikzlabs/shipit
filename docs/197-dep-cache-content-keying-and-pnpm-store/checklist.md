# Checklist — dep-cache evolution (content-keyed install skip + pnpm shared store)

## Part 1 — content-keyed install skip (DONE)

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

## Part 2 — pnpm shared store volume (NOT STARTED)

- [ ] Detect pnpm repos and skip the `node_modules` overlay for them (EXDEV defeats
      pnpm hardlinks across the overlay boundary).
- [ ] Mount a shared per-`(runtime)` content-addressed pnpm store on the workspace
      filesystem so `pnpm install` hardlinks natively.
- [ ] Measure: per-session upper size (pnpm overlay full-copy ~464 MB → expected
      near-zero) and install time.
