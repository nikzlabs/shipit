# Checklist — overlay-mounted rolling dependency base

> **⚠️ Design pivot (2026-06-10).** The design changed from **whole-workspace overlay** to
> **dependency-directory overlay** (declared in `shipit.yaml` `agent.dep-dirs`, default
> `[node_modules]`). See `plan.md` → "Current design" + "Rejected approaches". Net effect on this
> checklist: the daemon-overlay **mechanism** (Phases 0–2) and the **publish CAS / marker / runtime
> fingerprint / GC** (most of Phase 3) are **reused as-is**. The two items previously tracked as
> "NOT DONE — host-gated" — **source-sync re-sequencing (A)** and the **workspace-view resolver (B)**
> — are now **REJECTED, not pending**: the dep-dir design leaves `session.workspaceDir` authoritative
> and the host-side clone in place, so neither is needed. The remaining work is the **dep-dir
> retargeting** captured in the new "Phase 3b/4b — dependency-directory retargeting" section below.

## Dependency-directory retargeting (current remaining work)

- [ ] **Read `agent.dep-dirs` from shipit.yaml** (default `[node_modules]`) in the shipit-config
      parser; literal relative paths only (no globs). Add to `src/server/shipit-docs/shipit-yaml.md`.
- [ ] **Validate each entry** — relative + inside the workspace + not the root + not containing
      tracked files (gitignored artifact); invalid/missing → skip that dir (plain install), never break.
- [ ] **`buildOverlaySpec` → N mounts.** Emit one overlay mount per declared dep dir at its subpath
      (`/workspace/<dep-dir>`), each with its own base scope `(repo, runtime, dep-dir relpath)` and
      per-session upper/work; resolve dep dirs against the **pre-container host clone** (so the source
      parent exists; the daemon creates the artifact-leaf mountpoint). Drops the single
      `/workspace`-root mount.
- [ ] **Scope the worker snapshot to the dep dirs** (per-dir export), not the whole merged tree.
- [ ] **Compose wiring:** mount the same per-session overlay volume(s) into services at the dep-dir
      subpaths (reuse the shared-volume pattern), instead of rooting the whole workspace at the overlay.
- [ ] **Host-matrix spike:** confirm a `type=overlay` volume mounts cleanly at a target **nested under
      the `/workspace` bind** (`/workspace/node_modules`) on VPS/ext4 + Docker Desktop Mac/Windows.
- [x] **Stripped the whole-workspace *application* layer from the branch** (the parts the dep-dir
      design replaces wholesale, so the PR carries only the reusable foundation): removed
      `workspace-snapshot.ts` + the `GET /workspace/snapshot` endpoint, `buildOverlaySpec` (single
      `/workspace`-root mount) + `prepareOverlaySpec` + the overlay-spec container/`buildConfig`
      threading, `publishOverlayBaseAfterInstall` + the `publishOverlayBase` hook/callback wiring, and
      the compose-rooting override in `setupServiceManager` (+ its tests). **Kept** as reused
      foundation: `overlay-volume.ts` primitives, `overlay-base.ts` publish CAS, `install-marker.ts`,
      the `RepoGit` ancestry oracle, `GET /workspace/head-commit` (publish still needs source HEAD),
      and the gating/scope/GC helpers in `overlay-session.ts`. These get retargeted per-dep-dir by the
      items above (N mounts at subpaths, per-dir snapshot, scope key + GC gain the dep-dir relpath).

### Rejected — do NOT implement (see plan.md "Rejected approaches")

- [REJECTED] **(A) Source-sync re-sequencing** — clone/checkout/`git clean` inside the merged mount.
  Obviated: dep-dir overlay keeps the host-side clone at the normal path.
- [REJECTED] **(B) Workspace-view resolver** — routing file/doc/git/post-turn through the worker.
  Obviated: `session.workspaceDir` stays authoritative (source + `.git` on the normal mount).
- [REJECTED] **Host-visible overlay (privileged sidecar + propagation)** — privileged infra +
  Windows gap; strictly dominated by the unprivileged daemon-overlay dep-dir design.
- [REJECTED] **Globs in `dep-dirs`** — special-cases the artifact suffix for zero expressiveness gain;
  literal paths degrade benignly and are agent-maintainable.

## Disk cleanup retargeting (dep-dir)

Separate from the mount/compose retargeting above: overlay removes the per-session full `node_modules`
copy, so the dominant steady-state cost is gone, but cleanup **splits into three surfaces** and one
existing reclaim path (disk-tier escalation) must be **retargeted**, or it silently reclaims nothing
for overlay sessions. See `plan.md` → "Disk cleanup under the dep-dir design".

- [ ] **Per-`(session, dep-dir)` live-set for base GC.** Make `liveOverlayScopeHashes` enumerate one
      scope-hash per *(resumable session × declared dep dir)* (depends on the scope-key gaining the
      dep-dir relpath). Hard requirement: `sweepOrphanedOverlayBases` must never reap a base that is a
      **live overlay lowerdir** (undefined behavior), so the live-set must be complete across resumable
      (not just running) sessions. Add a test that a live session's per-dep-dir bases are all retained.
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
- [ ] **Docs sync.** Update CLAUDE.md's "Disk cleanup" section (it describes per-session teardown as
      dropping compose **named volumes**) to note that overlay sessions also carry N per-dep-dir overlay
      volumes reclaimed the same way, and update any agent-facing `shipit-docs` if escalation behavior
      changes for overlay sessions.

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

### Still unproven — the one new host spike the dep-dir design needs

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
- [ ] **Recursive file-tree watcher across the nested submount.** Confirm the agent-container watcher
      (recursive same-namespace inotify over `/workspace`) descends into the nested `node_modules`
      submount so copy-ups there surface as change events — inotify does not cross a mount boundary
      implicitly, but a recursive per-dir watcher should re-arm into the submount. Validate alongside the
      spike (see `host-overlay-spike.sh`'s inotify rung).

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
