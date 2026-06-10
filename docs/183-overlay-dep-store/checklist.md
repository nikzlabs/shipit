# Checklist — overlay-mounted rolling dependency base

> **⚠️ Design pivot (2026-06-10).** The design changed from **whole-workspace overlay** to
> **dependency-directory overlay** (declared in `shipit.yaml` `agent.dep-dirs`, default
> `[node_modules]`). See `plan.md` → "Current design" + "Rejected approaches". Net effect on this
> checklist: the daemon-overlay **mechanism** (Phases 0–2) and the **publish CAS / marker / runtime
> fingerprint / GC** (most of Phase 3) are **reused as-is**. The two items previously tracked as
> "NOT DONE — host-gated" — **source-sync re-sequencing (A)** and the **workspace-view resolver (B)**
> — are now **REJECTED, not pending**: the dep-dir design leaves `session.workspaceDir` authoritative
> and the host-side clone in place, so neither is needed. The remaining work is the **dep-dir
> implementation**, decomposed into the **7 thin phases (1 PR each)** below.

## Dependency-directory implementation — 7 phases, 1 PR each

**Granularity rule: one PR per phase.** Each phase is a thin, independently-mergeable slice that stays
**inert while `OVERLAY_DEP_STORE` is off** and ships with its own tests. Ordered by dependency.

**Invariant — the flag must NOT be enabled until Phase 6 lands.** The GC live-set and teardown only
become correct for N volumes in Phases 2/6; Phases 1–5 keep `liveOverlayScopeHashes` returning ∅ (flag
off) so `sweepOrphanedOverlayBases` stays inert regardless. The flag flip is the last step of Phase 7.

The host-matrix mount-topology gate is **cleared** (nested-overlay spike 3/3 — see "Merged foundation"
below). No empirical unknowns remain; the work from here is mechanical.

### Phase 1 — Config: read + validate `agent.dep-dirs`

- [x] Parse `agent.dep-dirs` (default `[node_modules]`) in the shipit-config parser; **literal relative
      paths only, no globs**. Added `depDirs` to `AgentConfig`/`AGENT_DEFAULTS` + `DEFAULT_DEP_DIRS`, the
      key to `KNOWN_AGENT_KEYS`, and `parseDepDirs`/`normalizeDepDir` (string→[string], wrong-type→default
      with a warning, explicit `[]`→opt-out).
- [x] **Structural** validation of each entry — relative + not absolute + no glob + no `..` segment +
      not the workspace root; invalid → dropped **with a warning** (never fatal); normalized +
      de-duplicated. **Contextual** validation ("path exists as a dependency dir and isn't tracked
      source") needs the host clone and is **deferred to Phase 2** (the parser is pure / has no
      workspace/git context).
- [x] Documented the key in `src/server/shipit-docs/shipit-yaml.md` (field table + a "Dependency
      directories" subsection; noted it's parsed-but-gated until the overlay store is enabled).
- [x] Unit tests (default, string form, multiple + normalized, de-dup, explicit `[]` opt-out, each
      rejected-entry case, wrong-type fallback) — `shipit-config.test.ts`.
- *Inert: nothing reads `agent.depDirs` yet.*

### Phase 2 — Spec shape: scope key + `buildOverlaySpec` → N specs + GC live-set

- [x] Extended the base scope key to `(repo, runtime fingerprint, dep-dir relpath)` — `overlayScopeHash`
      gains an optional `depDir` (omitting it reproduces the legacy 2-arg hash byte-for-byte, so the
      single-base publish CAS is untouched); `OverlayScope.depDir` added + threaded through
      `scopeHashOf`. `overlayVolumeName` gains a per-dep-dir discriminator
      (`shipit-<id>_overlay-<depHash8>`, still sweep-regex-matchable).
- [x] Added `buildOverlaySpecs` → **N** `DepDirOverlaySpec` (one per declared dep dir): each with its
      own `lowerdir = overlay-base/<scope-hash>`, per-session `upper`/`work` under
      `sessions/<id>/overlay/<scope-hash>/` (so no two dep dirs share an upperdir), `mountPath =
      /workspace/<dep-dir>`, and per-dep-dir scope. Pure (no Docker/fs) — takes the state-volume
      mountpoint + dep dirs; the volume create/mount is Phase 3.
- [x] Updated `liveOverlayScopeHashes` to enumerate one scope-hash per *(resumable session × declared
      dep dir)* via an injected `resolveDepDirs`; added `depDirsForSession` (reads each session's
      `agent.dep-dirs`) and wired it at the disk-janitor call site in `index.ts`. Still returns ∅ when
      the flag is off (no config reads while inert).
- [x] Unit tests: `buildOverlaySpecs` (per-dep-dir paths/scope/mount, distinct base/upper/volume per
      dir, empty-list); per-`(session × dep dir)` live-set incl. the legacy-hash-must-not-appear guard;
      `overlayScopeHash`/`overlayVolumeName` dep-dir behavior + backward compat; `depDirsForSession`.
- *Inert: `buildOverlaySpecs` has no production caller yet (Phase 3 wires it); the live-set is ∅ while
  the flag is off.*

### Phase 3 — Mount wiring (split into 3a/3b for reviewability)

Phase 3 is materially bigger than 1–2 (it touches the hot container-creation path and needs a populator
that resolves eligibility/scope/mountpoint from `SessionInfo`, which `ContainerConfig` doesn't carry).
Split into a pure inert plumbing refactor (3a) and the flag-gated populator + integration test (3b).

#### Phase 3a — N-spec container plumbing (inert refactor)

- [x] Converted the container-lifecycle overlay plumbing from one spec to **N**: `ContainerConfig.overlaySpec`
      → `overlaySpecs: DepDirOverlaySpec[]`; `SessionContainer.overlayVolumeName` → `overlayVolumeNames[]`.
- [x] `buildMounts` no longer root-mounts an overlay; `/workspace` **always** stays the normal host-clone
      mount and each dep spec is appended as a **nested** `/workspace/<dep-dir>` volume mount.
- [x] `createContainer` creates **each** overlay volume (serialized) and records all names; the
      failure-path cleanup and `destroyContainer` `removeOverlayVolume` **every** recorded name.
- [x] Tests: `buildMounts` nested-mount unit tests (workspace stays normal; N nested mounts; uploads/dep-cache
      never overlay; non-overlay unchanged) + `session-container` create/fail/destroy with N specs.
- *Inert: no caller populates `overlaySpecs` yet (3b does).*

#### Phase 3b — Spec populator + flag-gated wiring (first phase that mounts)

- [x] Added `SessionContainerManager.prepareOverlaySpecs`: resolves eligibility + base scope
      (`resolveOverlayScope`) from `SessionInfo`, reads the session's `agent.dep-dirs`
      (`depDirsForSession`), validates against the clone, resolves the state-volume daemon-host
      mountpoint (`resolveVolumeMountpoint`), and calls `buildOverlaySpecs`. Returns `[]` when the flag
      is off / session ineligible / no state volume / nothing overlay-worthy.
- [x] Wired into the container-creation path: `createContainerForRunner` (app-lifecycle) calls
      `prepareOverlaySpecs` and threads the result through `buildConfigForWorkspace({ overlaySpecs })`
      → `buildConfig` → the 3a plumbing. Both call sites pass the session (`sessionManager.get`).
      Flag-off → `[]` → byte-for-byte unchanged.
- [x] **Contextual dep-dir validation (deferred from Phase 1)** — `validDepDirsForOverlay`: keep a dep
      dir only if its **parent exists** on the clone AND it is **git-ignored** (an artifact, not tracked
      source — `simpleGit.checkIgnore`). Any error (non-git dir, git failure) drops all (conservative).
      A dropped dir falls back to a plain install for that path; never fatal.
- [x] Tests: `validDepDirsForOverlay` (ignored-kept, tracked-source-dropped, missing-parent-dropped,
      nested, mixed-filter, non-git→[]); `prepareOverlaySpecs` (flag-off, ineligible, valid→spec anchored
      at the mountpoint, tracked-source→[], no-state-volume→[]); **end-to-end** populator →
      `buildConfigForWorkspace` → `create` mounts the volume nested at `/workspace/node_modules`.
- [ ] **(host-gated) Validate the recursive file-tree watcher descends into the nested submount**
      (same-namespace inotify across a mount boundary) — the one item the nested-overlay spike
      deliberately did not cover. Needs a running container on real overlay; see `host-overlay-spike.sh`'s
      inotify rung. Not verifiable in-environment (no real Docker overlay), like the host spikes.

### Phase 4 — Snapshot + publish, per dep dir (split into 4a/4b)

Like Phase 3, this is two coherent units: the dep-dir snapshot producer + transport (4a, inert) and the
publish-after-install orchestration + wiring (4b).

#### Phase 4a — Per-dep-dir snapshot producer + transport (inert)

- [x] Worker producer `dep-snapshot.ts`: `safeDepDirRelpath` (defense-in-depth subpath validation),
      `depSnapshotTarArgs`/`createDepSnapshotTar` — tar a **single dep dir's CONTENTS** (`-C
      <root>/<depDir> .`) so extraction lands them directly as base contents. No `.git` exclusion (a dep
      dir has no top-level repo `.git`).
- [x] Worker endpoint `GET /workspace/dep-snapshot?path=<dep-dir>` — validates the path, 404s a missing
      dir, streams the tar (destroys the stream on a tar failure so a truncated archive isn't trusted).
- [x] Orchestrator transport `overlay-snapshot.ts`: `extractTarStream` (`tar -x` into a temp dir;
      rejects on non-zero exit / source error — never a partial base; **sync mkdir** so a small buffered
      producer stream can't reach EOF before the pipe attaches) + `fetchDepSnapshotStream` (thin fetch
      glue). Split so extraction is HTTP-free / unit-testable.
- [x] Tests: `safeDepDirRelpath` (accept/normalize + reject absolute/root/escape); `depSnapshotTarArgs`
      contents-layout; `createDepSnapshotTar` real tar round-trip (nested file + symlink verbatim) +
      missing-dir rejects; `extractTarStream` round-trip + dest-mkdir + invalid-tar rejects (builds its
      own tar to respect the orchestrator↛session import boundary).
- *Inert: no caller pulls/extracts/publishes yet (4b wires it).*

#### Phase 4b — Publish-after-install orchestration + wiring

- [x] `overlay-publish.ts` → `publishDepDirOverlayBases(args, deps)`: after an eligible install (exit-0,
      pre-user, source==remote default), for each declared dep dir runs `fetchDepSnapshotStream` →
      `extractTarStream` to a temp dir → `publishBase` with the per-dep-dir scope `(repo, runtime, dep-dir)`
      and the bare-cache `isAncestor` + `currentDefaultCommit`. Reuses the `overlay-base.ts` CAS unchanged
      — only the caller/granularity is new. HTTP/tar/oracle glue is injected so the orchestration is
      unit-testable; a per-dir failure is recorded (`"error"`) and never aborts the others. Eligibility:
      `commit` from the worker's merged HEAD (`fetchWorkspaceHeadCommit`, added to `overlay-snapshot.ts`),
      `currentDefaultCommit` from the bare cache, `sourceIsDefaultBranch = commit === currentDefaultCommit`,
      `preUserInstall = true` at this setup-install seam (documented residual: uncommitted dep edits while
      HEAD still equals the default tip — hardened in Phase 7).
- [x] Wired into the install-completion seam: `setupServiceManager` calls an optional `publishOverlayBases`
      hook once after its install promise resolves (placed before the compose/adoption branches so
      compose-less projects publish too); the hook is threaded through `RunnerRegistryDeps` → `setupDeps`.
      `index.ts` constructs the runner-adapting wrapper (closes over `stateDir` + `createRepoGit` +
      `getBareCacheDir`, awaits `whenWorkerReady()`, reads `getWorkerUrl()`), gated by a cheap
      `isOverlayEnabled()` check first so a flag-off session never awaits worker readiness. Best-effort: a
      publish throw is caught and logged, never affecting the install/session.
- [x] Tests (`overlay-publish.test.ts`, 10): default-dir created base; per-dir publish into its own scope
      + cross-dir isolation (distinct scope hashes, each base holds only its own snapshot); flag-off → no
      publish; ineligible (no remoteUrl / ops) → no publish; install-failed → skipped-ineligible (no base);
      head-commit unresolvable → skipped; source≠default → skipped-ineligible (no base); tracked-source dep
      dir dropped while the ignored one publishes; per-dir error isolated from healthy dirs.

### Phase 5 — Compose services at dep-dir subpaths

- [x] `generateComposeOverride` gained an `overlayDepDirs` option (`{ depDir, volumeName }[]`). For each
      service that bind-mounts the workspace (or a subdir of it) it now **keeps** the normal
      `shipit-workspace` mount and **appends** one `type: volume` overlay mount per dep dir reachable
      through that mount, targeted at `<service-target>/<dep-dir-relative-to-the-mounted-source>` — the
      shared-volume refcount pattern, NOT the rejected root-the-service-at-overlay approach. Helpers:
      `volumeSourceTarget` (short/long form), `depDirWithinMount` (subdir reachability + relative path),
      `overlayMountsForService` (per-mount fan-out, target de-dup). Each referenced volume is declared
      `external: true` (daemon owns the overlay volume); unused volumes are not declared. A direct
      dep-dir mount whose target collides is replaced by the overlay (no duplicate-target).
- [x] Wired through `ServiceManager`: new `overlayDepDirs` option + `setOverlayDepDirs()` setter (the
      populator is async), threaded into both `generateComposeOverride` call sites. `setupServiceManager`
      resolves the specs via `containerManager.prepareOverlaySpecs` in the async start path (before the
      first `start()`) and calls the setter — `prepareOverlaySpecs` returns `[]` with no Docker call when
      the flag is off / session ineligible, so the override is byte-for-byte unchanged for non-overlay
      sessions.
- [x] Compose-generator unit tests (7, `compose-generator.test.ts`): root-mount nesting + workspace mount
      preserved + external declaration; one mount per dep dir; subdir-mount mapping + outside-mount dep dir
      skipped + only-used-volume-declared; overlay mount targets the volume root (no subpath) and the
      override never references `overlay-base/` or the `shipit-workspace` storage subpath for a dep dir;
      no overlay mount on a service without a workspace mount; absent `overlayDepDirs` → unchanged;
      direct dep-dir mount replaced (no duplicate target).

### Phase 6 — Disk cleanup retargeting (GC correctness — the gate to enabling the flag)

Overlay removes the per-session full `node_modules` copy, but cleanup splits across surfaces; this phase
makes them all correct for N volumes. See `plan.md` → "Disk cleanup under the dep-dir design".

- [ ] **Teardown removes all N per-session overlay volumes.** `destroyContainer` must
      `removeOverlayVolume` for **each** of the session's overlay specs (not one). Confirm
      `sweepOrphanSessionVolumes`' `^shipit-([a-f0-9-]{12})_` regex reclaims every crash-orphaned
      `shipit-<id>_overlayN`; add a test with N>1.
- [ ] **Extend disk-tier escalation (docs/161) volume removal to N dep-dir volumes.** The `hot → light`
      rung (`reclaimToLight`) reclaims deps by dropping the per-session compose named volumes via
      `removeVolumesOnDispose` → `containerManager.destroy()` (with a `ServiceManager.stop({ removeVolumes:
      true })` + `pruneVolumes` fallback), keeping the host checkout — there is **no host-path `rm` of
      `node_modules`** to skip. `destroyContainer` already calls `removeOverlayVolume` for the single
      Phase-2 overlay volume, so today one overlay volume is reclaimed on `hot → light`. Extend
      `destroyContainer` to drop **all N** per-dep-dir overlay volumes; add a test with N>1. Note the
      `pruneVolumes`/`pruneSessionVolumes` fallback can't reach overlay volumes (it filters
      `label=shipit-session=<id>`, but overlay volumes are labeled `shipit-session=true`); the
      crash-orphan backstop is the `sweepOrphanSessionVolumes` `^shipit-([a-f0-9-]{12})_` sweep — confirm
      it matches `shipit-<id>_overlayN`. Safe by construction — each upper is a pure disposable cache,
      re-derived on next mount. Most-likely-missed change (it lives outside the overlay code path).
- [ ] **Flatten/swap reclaim.** Confirm depth-cap flatten via `copySnapshotToBase`'s atomic swap
      rm's the old base generation (transient double-disk during the swap; live mounts keep pinned
      inodes). Add/confirm a test.
- [ ] **Verify the per-`(session, dep-dir)` live-set end-to-end.** The enumeration itself lands in
      Phase 2; here confirm the GC contract holds across the whole pipeline — `sweepOrphanedOverlayBases`
      never reaps a base that is a **live overlay lowerdir** for any resumable (not just running)
      session. Add a test that all of a live session's per-dep-dir bases are retained.
- [ ] **Docs sync.** Update CLAUDE.md's "Disk cleanup" section (it describes per-session teardown as
      dropping compose **named volumes**) to note that overlay sessions also carry N per-dep-dir overlay
      volumes reclaimed the same way, and update any agent-facing `shipit-docs` if escalation behavior
      changes for overlay sessions.

### Phase 7 — Enable path + measure & tune

- [ ] Wire the overlay-spec into the **warm-pool standby** + **on-activation** paths so warm-claimed
      sessions get the dep-dir overlay (today they would silently run plain).
- [ ] Measure warm-install on the **containerized** path (`main` unchanged / `main`-advanced / cold;
      separate network from extract/link). Set the final depth cap from measurement.
- [ ] **Flip `OVERLAY_DEP_STORE` on** (the user's call) — only after Phases 1–6 are all merged and the
      flag invariant above is satisfied.

### Rejected — do NOT implement (see plan.md "Rejected approaches")

- [REJECTED] **(A) Source-sync re-sequencing** — clone/checkout/`git clean` inside the merged mount.
  Obviated: dep-dir overlay keeps the host-side clone at the normal path.
- [REJECTED] **(B) Workspace-view resolver** — routing file/doc/git/post-turn through the worker.
  Obviated: `session.workspaceDir` stays authoritative (source + `.git` on the normal mount).
- [REJECTED] **Host-visible overlay (privileged sidecar + propagation)** — privileged infra +
  Windows gap; strictly dominated by the unprivileged daemon-overlay dep-dir design.
- [REJECTED] **Globs in `dep-dirs`** — special-cases the artifact suffix for zero expressiveness gain;
  literal paths degrade benignly and are agent-maintainable.

---

## Merged foundation (on `main`, flag OFF)

Everything in this section is **already merged** and inert behind `OVERLAY_DEP_STORE` (default off).
It is the design-agnostic substrate the dep-dir retargeting above builds on — the daemon-overlay
mechanism, the publish compare-and-swap, and the gating/scope/GC plumbing. **No caller populates an
overlay spec yet**, so nothing mounts an overlay and non-overlay sessions are byte-for-byte unchanged.
(History note: this checklist previously tracked a *whole-workspace* overlay design through Phases 0–5;
that application layer was stripped on the pivot to dep-dir overlay. The items below reflect only what
is actually on `main` now.)

### Mechanism (proven + merged)

- [x] **Daemon-performed overlay via the `local` `type=overlay` volume driver.** The orchestrator
      (unprivileged, via `docker.sock`) creates a per-session volume whose `o=lowerdir,upperdir,workdir`
      point at daemon-host paths; the daemon performs the `mount -t overlay` as it builds the container —
      no privileged sidecar, no `CAP_SYS_ADMIN`, no cross-container propagation.
      [`overlay-volume.ts`](../../src/server/orchestrator/overlay-volume.ts): `createOverlayVolume`,
      `resolveVolumeMountpoint`, `removeOverlayVolume`, `OverlaySpec`, `overlayScopeHash`,
      `overlayBaseDir`/`OVERLAY_BASE_SUBDIR`, name `shipit-<id[:12]>_overlay` (orphan-GC regex match).
- [x] **Host spikes — whole-workspace (root) topology.** `volume-driver-overlay-spike.sh` (7/7 on
      Docker Desktop/Windows-WSL2 and prod VPS/ext4) and `shared-volume-spike.sh` (8/8 on all three
      targets) proved daemon-overlay, copy-up isolation, immutable shared base, concurrent shared-lower
      mounts, and one shared volume refcount-shared across agent + compose service containers — all with
      the overlay **at the `/workspace` root**. The dep-dir design needs one more topology (see "still
      unproven" below).

### Publish + scope + GC (merged)

- [x] **Publish compare-and-swap** ([`overlay-base.ts`](../../src/server/orchestrator/overlay-base.ts)) —
      advance the base only for exit-0 pre-user installs whose recorded source base is the remote default
      commit, when the candidate strictly descends the base (`git merge-base --is-ancestor`) under a
      per-scope lock; ordered by **commit ancestry not wall-clock**; force-push divergence triggers a
      lineage reset from empty. Depth-cap flatten (`DEFAULT_DEPTH_CAP=16`), `BasePointer` persistence,
      `copySnapshotToBase` atomic temp-dir swap + `utimes` (the GC mtime contract). 14 tests, real git repo.
- [x] **Git-ancestry oracle** ([`repo-git.ts`](../../src/server/orchestrator/repo-git.ts)) — `isAncestor`
      spawns git directly and resolves on `code === 0`, avoiding the simple-git `.raw()` exit-1 trap that
      would otherwise make the CAS *always advance* (latent bug caught + fixed). `resolveDefaultBranchCommit`
      resolves the bare cache's local default-branch tip. Tested.
- [x] **Runtime fingerprint + scope** ([`overlay-session.ts`](../../src/server/orchestrator/overlay-session.ts)) —
      `overlayRuntimeKey()` = `<image id|digest>|<arch>`, computable **before** the container exists (the
      base scope must pick the lowerdir at create time). `isOverlayEnabled` / `isOverlayEligible`
      (flag + remote + non-ops) / `resolveOverlayScope`. Flag-off path is inert everywhere.
- [x] **Base GC live-set.** `liveOverlayScopeHashes(sessionManager.listAll())` enumerates every
      non-evicted repo-backed non-ops session → `overlayScopeHash(remoteUrl, overlayRuntimeKey())`, wired
      into `runDiskJanitor` so `sweepOrphanedOverlayBases` never reaps a base that is a live lowerdir.
      Reads the durable session DB (not the runner registry); returns ∅ when the flag is off.
      **NOTE:** the scope key must gain the **dep-dir relpath** before the flag is enabled — tracked under
      "Disk cleanup retargeting" above.
- [x] **Stamped install marker** ([`install-marker.ts`](../../src/server/session/install-marker.ts)) —
      `.shipit/.install-done` stamps source commit + runtime fingerprint + install command; skip only on
      exact match; a legacy bare-timestamp marker parses to `null` → safe one-time reinstall. The worker
      `/install` gate computes + checks + whiteouts a stale marker, writes on install success.
- [x] **nm-store fast path deleted** (the old lockfile-keyed copy store + its worker gate are gone);
      plain `agent.install` (tuned `--prefer-offline --no-audit --no-fund`) is the current behavior.
      `runtimeKey`/`detectLibc`/`tuneNpmInstall` relocated to
      [`install-runtime.ts`](../../src/server/session/install-runtime.ts) for reuse.
      [148-fast-npm-install](../148-fast-npm-install/plan.md) marked superseded.

### Stripped from the branch (the whole-workspace *application* layer)

Removed because the dep-dir design replaces it wholesale — **not** because it was wrong. The PR carries
only the reusable foundation above; these get rebuilt **per-dep-dir** by the retargeting section at the
top of this file.

- [x] `workspace-snapshot.ts` + the `GET /workspace/snapshot` endpoint (whole-tree tar → per-dep-dir export).
- [x] `buildOverlaySpec` (single `/workspace`-root mount) + `prepareOverlaySpec` + the overlay-spec
      threading through `buildConfig`/`buildConfigForWorkspace`/`createContainerForRunner` (→ N mounts at
      dep-dir subpaths).
- [x] `publishOverlayBaseAfterInstall` + the `publishOverlayBase` hook/callback wiring through `index.ts`
      → `runner-registry-factory` → `service-manager-setup` (→ per-dep-dir publish).
- [x] The compose-rooting override in `setupServiceManager` (rooted every service mount at the overlay
      root — the *opposite* of the dep-dir design, which mounts overlays at subpaths).
- [x] **Kept** `GET /workspace/head-commit` — publish still needs the source HEAD.

### Host-spike status — the dep-dir mount-topology gate (CLEARED)

- [x] **Nested-overlay-under-the-`/workspace`-bind topology — PROVEN, gate cleared (3/3).** The merged
      spikes proved overlay at the `/workspace` **root**; the dep-dir design instead keeps `/workspace`
      a normal bind (host clone: source + `.git`, authoritative) and mounts each dep dir as a separate
      `type=overlay` volume at a **nested subpath**. [`prototype/nested-overlay-spike.sh`](./prototype/nested-overlay-spike.sh)
      passed on all three targets — **Docker Desktop/Windows-WSL2 PASS=13/0 (amd64), Docker Desktop/Mac
      PASS=13/0 (arm64), and prod VPS `shipit-16gb`/ext4 PASS=14/0 with rung 7 (the real host-bind
      parent) executed** — so nested merged dep view, copy-up isolation, source/`.git` coexistence,
      multi-depth + absent-leaf auto-creation, concurrent shared-base (no EBUSY), and agent+service
      sharing all hold, including under a real host bind on ext4 (the literal prod topology). See
      [`FINDINGS.md`](./FINDINGS.md). **Carry-forward:** prod must resolve dep dirs against the host
      clone so the parent dir is real (don't rely on the daemon's `mkdir -p` of an absent parent).
- One thing the nested spike deliberately did **not** cover — the recursive file-tree watcher
  descending into the nested submount (same-namespace inotify across a mount boundary) — is now tracked
  as a verification bullet in **Phase 3** (where the nested mount first exists), not here.

### Obviated by the pivot — do NOT implement

The whole-workspace design required two large host-gated subsystems. The dep-dir design keeps
`session.workspaceDir` authoritative (source + `.git` on the normal bind), so **both are rejected, not
pending** (mirrored in the "Rejected" section at the top):

- [REJECTED] **Source-sync re-sequencing** — clone/checkout/`git clean` inside a merged whole-workspace
  mount. The host clone stays at the normal path, so there is nothing to re-sequence.
- [REJECTED] **Workspace-view resolver** — routing file/doc/git/compose/watcher/post-turn through worker
  HTTP because `session.workspaceDir` would be only an upperdir. Under the dep-dir design it stays the
  real host checkout, so no resolver is needed.
- [REJECTED] **Warm-pool standby *root* overlay mount** as previously framed. Re-scoped: warm-claimed
  sessions will gain the **dep-dir** overlay spec via the same retargeting; until then a warm-claimed
  session just pays a full install (harmless while the flag is off).

### Measure & tune (after the dep-dir mount works)

- [ ] Measure warm-install time on the **containerized** path (not dogfood/local): `main` unchanged
      (warm overlay no-op ~marker skip), `main` advanced deps (incremental), and cold. Separate **network**
      (download cache) from **extract/link** (what overlay removes) — a warm download cache alone still
      pays ~full materialization (~24s / 31,396 files observed).
- [ ] Set the final depth cap from measurement.
