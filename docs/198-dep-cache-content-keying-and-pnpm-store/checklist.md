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

### Part 1 — pre-stamp didn't content-key (post-deploy e0d521d8)

Prod canary (`overlay-canary-183`): main advanced by a README-only commit
(`b1904814`; dep files byte-identical to the pointer commit `31e225d`). A fresh
session at the new tip ran a FULL install (`install_ms=28247`, outcome
`advanced:d2g2`) instead of skipping — the headline scenario the feature targets.

Root causes:
- `preStampInstallMarker` still gated on "session HEAD equals EVERY mounted dep
  dir's pointer commit". The worker-side `markerMatches` widening (PR #1278) is
  unreachable for a fresh clone, which has no marker unless the pre-stamp fires —
  and fresh sessions are the dominant case.
- The published base pointer's marker carried only `{runtimeKey, installCommands}`
  — no `depsHash` (verified live: `overlay-base-meta/ed347cf9979cc8ed.json` gen 2),
  so the pre-stamp had no content key to compare against.

Fix (PR — content-key the pre-stamp):
- [x] **Propagate `depsHash` into base pointers.** `BasePointer.marker` and
      `PublishCandidate.markerStamp` gained `depsHash?: string | null`;
      `publishDepDirOverlayBases` computes it (`computeInstallDepsHash`, honoring
      `install-inputs`) and records it on the stamp. Legacy pointers without it
      simply never content-match → degrade to today's behavior.
- [x] **Widened the pre-stamp gate.** `preStampInstallMarker` now stamps on a
      commit MISMATCH when the pointer carries a `depsHash` that equals this
      workspace's `computeInstallDepsHash`. Every other condition is unchanged
      (generation pinned by the mount, command + runtime agreement across dep
      dirs, never clobber an existing marker). The worker gate stays the final
      authority (re-derives the hash, re-checks the empty-dir contradiction), so a
      wrong pre-stamp degrades to a reinstall, never a wrong skip.
- [x] **Truthful `sourceCommit`.** The content-path stamp records the SESSION's
      HEAD, not the pointer's.
- [x] **Tests.** Pointer marker round-trips `depsHash` (+ null when not content-
      keyable); pre-stamp fires on commit-mismatch + depsHash-match (the live
      scenario, as a regression test); does NOT fire when dep files differ, when
      the pointer lacks `depsHash` (legacy), when this workspace has no content
      key, or when commands/runtime differ.
- [x] **No flag defaults changed.**

### Part 1 — uv allowlist too narrow (PR — uv venv / uv pip)

Prod canary (2026-06-12): a repo with `agent.install: [uv venv .venv, uv pip
install -r requirements.txt]` produced markers and base pointers with `depsHash`
**absent**. `depInputsForCommand` recognized only `uv sync`, so both entries fell
to the unrecognized branch and one unrecognized entry conservatively disables the
content path for the whole stamp (correct rule, too-small allowlist).

Fix (`deps-hash.ts`, allowlist only — no flag-default changes):
- [x] **`uv venv [path]` → input-free (`[]`).** Consumes no manifest, so it must
      not disable the content path and contributes no files to the hash. New
      `isVenvCreation` accepts the `venv` positional plus an optional path
      positional (value-bearing flags that leave extra positionals → null).
- [x] **`uv pip install -r <file>` / `uv pip sync <file>` recognized.** New
      `uvPipInputs` reuses `pipRequirementInputs` for `install` (so ad-hoc
      `uv pip install foo` stays null) and bare-positional files for `sync`.
- [x] **`python3 -m venv [path]` recognized** as input-free, mirroring `uv venv`.
      (It was NOT previously recognized — the earlier pip canary's install used a
      bare `pip install -r` with no venv step.) `uv sync` unchanged.
- [x] **Tests.** `uv venv` alone → `[]`; the live canary command pair →
      `depsHash` over `requirements.txt`; `uv pip install foo` (no `-r`) → null;
      `uv pip sync file.txt` → recognized; `python3 -m venv` → `[]`.

### Part 2 — pnpm store gaps (PR #1285)

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
