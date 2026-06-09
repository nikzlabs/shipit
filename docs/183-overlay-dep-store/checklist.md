# Checklist — overlay-mounted rolling workspace base

Design proposal. Core decisions: **overlay the whole workspace** (environment-agnostic, no
keys / no lockfile detection); **keyless rolling base per `(repo, runtime fingerprint)`**;
**base publish restricted to exit-0 pre-user installs whose recorded source base is the remote
default-branch commit, advancing only forward by `main`-commit ancestry** (installs into a
session's own upper never race; publish is a commit-ancestry compare-and-swap, loser just
skips); upgrade the existing marker/`headChanged` skip to a stamped source-commit +
runtime-fingerprint + install-command marker; **depth-cap-triggered clean reinstall** (specific
tunable cap); **re-derive on unarchive**; **exit-0 base-advance gate**; cold start builds v0
from empty under the **existing** repo trust gate.

**Mechanism decided** (plan §4 "Host-mount design decisions"): unprivileged orchestrator (via
`docker.sock`) creates a per-session **`local`-driver `type=overlay` volume** so the **Docker
daemon performs the overlay mount** as it builds the session container — merged view present
**by construction**, with **no privileged sidecar, no `CAP_SYS_ADMIN`, and no cross-container
mount propagation**. Base (lowerdir) in a dedicated **`overlay-base/<hash>/`** subtree (NOT
`dep-cache`, which is mounted rw into sessions — would corrupt the immutable lower); per-session
upper/work in the session subtree (kernel forbids sharing an upperdir); absolute daemon-host paths
via `docker volume inspect`. **Proven on Docker Desktop/Windows-WSL2** (`volume-driver-overlay-spike.sh`
7/7), the host where the rejected sidecar/propagation approach failed → **all four documented
targets (VPS, Docker Desktop/Mac, Docker Desktop/Windows, Linux) are overlay-eligible.** Plain
`agent.install` remains the fallback only for hosts without overlayfs at all; `nm-store` is
**removed entirely**.

## Implementation phases

Ordered. **Phase 1 deletes nm-store first** (clean, self-contained simplification), then the
overlay subsystem is built on top. Interim note: between Phase 1 and Phase 3, fast-path-eligible
repos lose the copy acceleration and pay a full `agent.install` (warm download cache, no network)
per fresh session — a conscious, temporary regression until overlay lands.

### Phase 0 — Prototypes & decisions (DONE)

- [x] Prototype the keyless rolling base on the current substrate: mount current base →
      sync source in the merged workspace → run real install on top → publish only for exit-0
      pre-user installs whose recorded source base is the remote default-branch commit, via the
      commit-ancestry compare-and-swap (installs run concurrently into their own uppers)
      — `prototype/rolling-base.ts` + `run-rolling-base.ts` (33/33 against a real git repo).
- [x] Confirm overlay substrate (mount / CoW / immutable base / depth / bind-mount / teardown)
      — WSL2/ext4 19/19 + Docker Desktop/Mac 21/21 (`host-overlay-spike.sh`, `run-in-docker.sh`).
- [x] Verify compose bind-mount over the merged dir + `inotify` (create + copy-up)
      — Docker Desktop/Mac 21/21; bind-mount-corroborated on WSL2.
- [x] Prove cross-container mount propagation (`propagation-spike.sh`): works **iff the daemon
      substrate provides shared propagation** + a dedicated self-bind `rshared` mountpoint. It
      **splits by substrate, not by "is it Docker Desktop"**:
      Docker Desktop/**Mac** ✓ no setup; Docker Desktop/**Windows (WSL2 backend)** ✗ confirmed
      (no user-applicable fix → plain-install fallback; an earlier draft mislabelled this run as
      "bare docker-ce-in-WSL2"); native docker-ce in a WSL2 distro = untested.
- [x] **Confirm propagation on the prod VPS** — `propagation-spike.sh` rung A2 ran on the prod
      systemd VPS (docker 29.5.2, linux/amd64) and reported **PROPAGATED on the plain run, no
      host setup**. Overlay-on-VPS proven; the Phase 1 nm-store regression now has a guaranteed
      end date on the primary target.
- [x] ~~Confirm Docker Desktop/Mac propagation survives a VM restart~~ — **MOOT under
      daemon-overlay** (no propagation, no re-arm probe). Was a gate only for the rejected sidecar.
- [x] ~~Classify native docker-ce-in-WSL2 propagation~~ — **MOOT under daemon-overlay** (the
      `local` `type=overlay` mount needs no shared propagation; the daemon performs it).
- [x] **Mechanism decided — daemon-performed overlay via the `local` volume driver.**
      [`prototype/volume-driver-overlay-spike.sh`](./prototype/volume-driver-overlay-spike.sh)
      ran on **Docker Desktop/Windows-WSL2** (the decisive host — `docker-desktop`, docker
      29.4.1, where the sidecar/propagation approach failed) and reported **PASS=7 FAIL=0**:
      unprivileged merged visibility, copy-up to a per-session upper, immutable shared base, two
      concurrent sessions over one read-only base with no EBUSY. **Decision: adopt daemon-overlay,
      drop the privileged sidecar + the propagation prerequisite (and the startup probe / re-arm /
      unmount-ordering they implied).** **All four documented targets are overlay-eligible.**
- [x] Confirm `volume-driver-overlay-spike.sh` once on a **Linux/VPS** daemon — satisfied by the
      prod-VPS production-layout run recorded under Phase 2 (`shipit-16gb`, Ubuntu 24.04, docker
      29.5.2, PASS=7/7).
- [x] Decide host-mount mechanism, helper shape, storage layout, propagation prerequisite, and
      fallback (plan §4). See `FINDINGS.md` for evidence + live 31,396-file / ~24s measurement.

### Phase 1 — Delete the nm-store fast path (FIRST)

- [x] **Remove the copy store + its gate wiring.** Deleted `materialize`/`populateStore`,
      `findLockfile`, `isCacheableInstall`, `computeStoreKey`, `LOCKFILE_NAMES`, the store-dir
      constant + `FAST_INSTALL`/`NM_STORE` env, and the worker install-gate plumbing that called
      them (`computeFastPath`, `tryMaterializeFromStore`, `tryPopulateStore`, the `FastPathPlan`
      type, and the synchronous `{ completed: true }` HTTP-response path + the matching runner
      branch). `nm-store.ts` removed entirely
      ([session-worker.ts](../../src/server/session/session-worker.ts) install gate,
      [container-session-runner.ts](../../src/server/orchestrator/container-session-runner.ts),
      [warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts)).
- [x] **Keep what overlay/plain-install reuse:** relocated `runtimeKey`/`detectLibc` (overlay
      base scope reuses them as the runtime fingerprint) and `tuneNpmInstall`
      (`--prefer-offline --no-audit --no-fund` helps the plain install on a warm download cache)
      into [install-runtime.ts](../../src/server/session/install-runtime.ts).
- [x] **Simplify the worker install path** to: valid `.shipit/.install-done` marker → skip;
      else run `agent.install` (each command tuned via `tuneNpmInstall`) → write marker. Download
      cache (`/dep-cache`, docs/075) stays; it's a separate subtree.
- [x] **Cleanup:** dropped nm-store writes; turned the disk-janitor's mtime-based
      `sweepStaleNmStores` into a one-time wholesale `sweepDeadNmStores` of
      `dep-cache/<hash>/nm-store` (~2.4 GB observed), removing the `DISK_JANITOR_NM_STORE_DAYS`
      knob. Deleted `nm-store.test.ts`, replaced `fast-install-gate.test.ts` with
      `install-gate.test.ts` (keeps the docs/162 first-connect resync backstop), and replaced the
      worker's fast-path tests with a plain-install marker-skip test.
- [x] Mark [148-fast-npm-install](../148-fast-npm-install/plan.md) **superseded**.

### Phase 2 — Daemon-overlay mount subsystem

Mechanism: the orchestrator (unprivileged, via `docker.sock`) has the **daemon** mount the
overlay through a `local` `type=overlay` volume. No privileged sidecar, no propagation, no
`CAP_SYS_ADMIN`. (See the rejected sidecar design in `FINDINGS.md` for why.)

- [x] Orchestrator creates a **per-session `local`-driver `type=overlay` volume** —
      `o=lowerdir=<base>,upperdir=<session-upper>,workdir=<session-work>` — and mounts it at
      `/workspace` (extend `buildMounts`); the daemon performs the overlay mount as it builds the
      container (merged view present by construction). **Done:** new
      [`overlay-volume.ts`](../../src/server/orchestrator/overlay-volume.ts) (`createOverlayVolume`,
      `resolveVolumeMountpoint` for the `docker volume inspect` absolute paths, `OverlaySpec`);
      `buildMounts` gained an `overlayWorkspaceVolume` arg mounting the overlay volume at the
      `/workspace` **root** (no subpath), with `/uploads` + `/dep-cache` left on the state volume;
      `createContainer` creates the volume when `config.overlaySpec` is set. **Inert until a caller
      populates `overlaySpec` (Phase 3/4) — non-overlay sessions are byte-for-byte unchanged.**
- [x] **Base lives in `overlay-base/<scope-hash>/` on the workspace volume — NOT under
      `dep-cache/`.** Encoded as `overlayBaseDir()` + `OVERLAY_BASE_SUBDIR` in `overlay-volume.ts`,
      with the read-only-lower / never-mounted-into-a-session rationale in the docstring. (Actually
      *writing* base contents is Phase 3; this fixes the layout + the GC target.)
- [x] **Per-session upper/work** under `sessions/{uuid}/`; **shared read-only base** across
      sessions; **`workdir` empty.** Captured as the `OverlaySpec` contract (`upperdir`/`workdir`
      are absolute daemon-host paths the caller supplies; the docstring states the same-fs +
      empty-workdir kernel rules). The concrete path computation per session lands in Phase 3.
- [x] **Serialize** volume create/mount to avoid the overlay2 `device or resource busy` (EBUSY)
      hazard — `createOverlayVolume` runs through a single-writer async mutex (`serialize`).
- [x] **Volume lifecycle + GC:** volume named **`shipit-<sessionId[:12]>_overlay`** (matches
      `sweepOrphanSessionVolumes`' `^shipit-([a-f0-9-]{12})_` regex → automatic orphan reclaim;
      test added), `shipit-managed=true` label stamped, teardown = `docker volume rm` in
      `destroyContainer` (+ the create-failure path). Added `sweepOrphanedOverlayBases` for
      `overlay-base/<hash>/` dirs, **gated on a live-scope-hash source** (NOT the repo-url
      `liveHashes` set — that would delete every live base) with an mtime fallback; the source is
      wired in Phase 3, so the sweep is skipped until then.
- [ ] **DEFERRED to Phase 4** — workspace-view resolver: `session.workspaceDir` is storage/upperdir
      metadata for overlay sessions, while file/doc/git/compose/watcher and post-turn operations
      must dispatch through worker HTTP endpoints against the container's merged `/workspace`. This
      is the broad "audit every direct orchestrator `fs`/`GitManager` use" task and only matters
      once overlay sessions are actually *enabled* (Phase 4), so it is tracked there rather than
      blocking the mount subsystem.
- [x] Verify the route stays within the containment model (docs/172) — the orchestrator gains no
      capability (it already holds `docker.sock`); the daemon performs the mount; session
      containers gain no capability (the overlay volume is an ordinary `-v name:/workspace` mount,
      `CapAdd`/`CapDrop` unchanged in `createContainer`).
- [x] **Production-layout spike confirmed** — `volume-driver-overlay-spike.sh` (updated to seed
      `lowerdir` under `overlay-base/<hash>/` and `upperdir`/`workdir` under `sessions/<uuid>/`,
      cross-subtree nested subpaths of one volume) ran **PASS=7 FAIL=0 on the prod VPS**
      (`shipit-16gb`, Ubuntu 24.04, docker 29.5.2, linux/amd64) — settles both the production path
      layout and a non-Docker-Desktop Linux daemon. (Mechanism also 7/7 on Docker Desktop/Windows.)
- [ ] **Size mount cost** (nice-to-have measurement, not a gate) — time a few overlay-volume
      create/mount/rm cycles on the real daemon.

### Phase 3 — Rolling-base logic wired to the real install

- [x] Scope the base per `(repo, runtime fingerprint)`. **Done** — the orchestrator-side
      fingerprint is `overlayRuntimeKey()` (`overlay-session.ts`): `<SESSION_WORKER_IMAGE_ID |
      IMAGE_DIGEST>|<arch>`. A worker-image digest pins libc + Node ABI, so image+arch is an
      ABI-correct fingerprint computable BEFORE the container exists (the base scope must pick the
      `lowerdir` at create time, so it can't wait for the worker's `runtimeKey()`). Feeds
      `overlayScopeHash(repoUrl, runtimeKey)` for the base pointer, volume, and GC.
- [x] Base (lowerdir) under the dedicated **`overlay-base/<hash>/`** subtree; per-session upper/work
      in the session subtree; mount base + run `agent.install` on top into the session's own upper.
      **Done** — `buildOverlaySpec` (`overlay-session.ts`) resolves the daemon-host absolute paths
      (`lowerdir = <vol mountpoint>/overlay-base/<hash>`, `upperdir`/`workdir` under
      `sessions/<id>/overlay-{upper,work}`), ensures the (empty for cold-start v0) base dir exists,
      **preserves the upper across container recreations** (it holds the session's `.git` + work),
      and resets the scratch workdir. Wired into container creation via
      `SessionContainerManager.prepareOverlaySpec` → `buildConfigForWorkspace({ overlaySpec })` →
      the existing Phase-2 `createContainer` overlay-volume path. The install runs unchanged inside
      the merged `/workspace`.
- [ ] **NOT DONE — host-gated. Source sync inside the merged `/workspace`.** The clone/checkout/reset
      + `git clean -ffdx` (whiteout pass for lowerdir-deleted files) must run **inside the merged
      mount after the container starts**, not the current pre-container host clone into
      `session.workspaceDir`. Until this lands, an overlay session's merged `/workspace` would NOT
      contain the source/`.git` (the host clone lands in the storage subtree, which is no longer the
      merged root). **This is the load-bearing re-sequencing the plan §3 step 2 flags and is the
      reason the `OVERLAY_DEP_STORE` flag must stay OFF until host validation.** Tracked with the
      workspace-view resolver in Phase 4.
- [x] Upgrade `.shipit/.install-done` to a **stamped marker** (source commit + runtime fingerprint
      + install command); skip install only on exact match; non-default checkout / mismatch
      whiteouts the marker first. **Done** — new
      [`install-marker.ts`](../../src/server/session/install-marker.ts) (pure
      `serialize`/`parse`/`markerMatches`, version-gated; a legacy bare-timestamp marker parses to
      `null` → safe one-time reinstall). The worker `/install` gate
      ([session-worker.ts](../../src/server/session/session-worker.ts)) computes the stamp
      (`git rev-parse HEAD` via `readSourceCommit`, `runtimeKey()`, the raw `commands`), skips only
      on an exact match, and whiteouts a stale/mismatched marker before reinstalling; the marker is
      written on install success. Covered by `install-marker.test.ts` (14 unit tests) + worker
      integration tests (same-command skip, changed-command re-run). *The base captures `.shipit/`
      (only `.git` is excluded), so a fresh session over an unchanged-`main` base reads a valid
      stamp from the lowerdir and skips at ~0.*
- [x] **Publish compare-and-swap:** advance the base only for **exit-0 pre-user installs whose
      recorded source base is the remote default commit**, and when the candidate strictly
      descends the base (`git merge-base --is-ancestor`) under a short per-`(repo, runtime
      fingerprint)` lock. Order by commit ancestry, not publish time; skip stale/behind
      publishes, but if the candidate is the current remote default and has diverged from the
      base (force-push), perform a lineage reset by rebuilding/publishing from empty.
      **Done** — ported the validated prototype into production
      [`overlay-base.ts`](../../src/server/orchestrator/overlay-base.ts) (`publishBase`,
      per-scope in-process lock, `BasePointer` persistence in the `overlay-base-meta/` sibling
      subtree, `OverlayScope`/`PublishCandidate` types) **with the force-push lineage reset
      added** (`reset` outcome on a diverged eligible candidate). Covered by
      [`overlay-base.test.ts`](../../src/server/orchestrator/overlay-base.test.ts) (14 tests, real
      git repo): created/advanced/flattened/reset/skipped-equal/skipped-not-forward/skipped-ineligible,
      ancestry-not-walltime ordering, concurrent convergence, scope isolation, mtime stamp.
      *Still to wire (Phase 4): the `isAncestor` oracle over the bare cache, the snapshot/install
      caller, and `currentDefaultCommit` (the caller must pass the repo's current `origin/HEAD`
      under the lock so a stale install that diverges because `main` advanced normally skips
      instead of triggering a base-clobbering reset — see the `publishBase` contract).*
- [x] Gate base advance on install **exit code 0** (non-zero serves the session, isn't published)
      — enforced by `publishBase`'s eligibility check (`skipped-ineligible`).
- [x] **Depth-cap flatten:** rebuild base from **empty** on hit (clean reinstall = drift +
      reproducibility reset) — `flattened` outcome + `shouldFlattenNext()` so the session prep
      path can clean-reinstall before the snapshot. `DEFAULT_DEPTH_CAP = 16`; final value set in
      Phase 5 from measurement.
- [x] **Exclude/normalize `.git`** from the base (don't carry session branch refs forward).
      **Done** — the snapshot export ([`workspace-snapshot.ts`](../../src/server/session/workspace-snapshot.ts))
      excludes the **top-level** `.git` via `--exclude ./.git` (a nested `vendor/foo/.git` is kept
      as ordinary source); `SNAPSHOT_EXCLUDES` keeps the one-exclusion rationale in one place.
      Worktree/gitdir absolute-pointer behavior on the overlay was already settled by the Phase-0
      spike (Open Q #2 — a linked worktree's absolute gitdir pointer resolves on the merged dir).
- [x] Publish/flatten from a worker-exported merged-workspace snapshot, not the host upperdir
      alone, so lowerdir-only source/dependency files are preserved in the next base. **Worker
      producer done** — `createWorkspaceSnapshotTar` streams the **merged** `/workspace` as a tar
      (whiteouts already resolved by the merged view, symlinks verbatim) and the worker exposes it
      at `GET /workspace/snapshot`; covered by [`workspace-snapshot.test.ts`](../../src/server/session/workspace-snapshot.test.ts)
      (6 tests: `.git` excluded, nested `.git` kept, symlinks preserved, install marker round-trips,
      missing-path rejects). *Still to wire (Phase 4): the orchestrator pulls the stream over HTTP,
      extracts it into a temp dir on the state volume, and passes that dir as
      `PublishCandidate.snapshotDir` to `publishBase`.*
- [x] **Cold start:** build base v0 from empty under the existing repo trust gate (docs/178).
      **Done** — `buildOverlaySpec` creates an empty `overlay-base/<hash>` lowerdir when no base
      exists, and `publishOverlayBaseAfterInstall` → `publishBase` emits the `created` outcome on the
      first exit-0 default-branch install. The existing trust gate in `setupServiceManager` (and the
      warm-pool pre-install skip) already defers install for untrusted remotes, so v0 creation rides
      that decision with no new gate.
- [x] **Wire the overlay-base GC live source + honor its contract** (the Phase 2 sweep
      `sweepOrphanedOverlayBases` is gated on this — see code review). Two hard requirements,
      else the mtime fallback can reap a live base out from under a mount: (a) **publish must
      stamp the top-level `overlay-base/<hash>` dir** (atomic temp-dir + rename over the path, or
      `fs.utimes`) on every advance — the scope-hash is stable across commits, so nested-only
      writes leave the dir's own mtime stale **— DONE: `copySnapshotToBase` swaps a temp dir into
      place and `utimes` it, asserted by the GC-contract test**; (b) `DiskJanitorDeps.liveOverlayScopeHashes` must
      return a **complete, authoritative** snapshot of every base any *resumable* (not just
      running) session could mount **— DONE: `liveOverlayScopeHashes(sessionManager.listAll())`
      (`overlay-session.ts`, wired in `index.ts`) enumerates every non-evicted repo-backed non-ops
      session and maps it to `overlayScopeHash(remoteUrl, overlayRuntimeKey())`. It reads the durable
      session DB (not the in-memory runner registry), so the startup-timing window before
      reconciliation is moot — an archived/evicted session is excluded (re-derived on unarchive),
      everything else is kept. Returns ∅ when the flag is off, keeping the sweep inert.**

### Phase 4 — Session lifecycle integration

- [x] Wire the on-activation install (`service-manager-setup.ts`) — the idempotent backstop for
      trust-deferred repos, pool misses, and re-created runners — to the overlay path + publish
      rule; the stamped marker makes repeats no-ops. **Done** — `setupServiceManager` chains a
      fire-and-forget `publishOverlayBase(sessionId, workerUrl)` off the install promise on `ok`.
      The callback is built in `index.ts` (closes over the bare-cache `createRepoGit`/`getBareCacheDir`
      + `stateDir`), resolves `currentDefaultCommit` + the `isAncestor` oracle from the bare cache, and
      calls `publishOverlayBaseAfterInstall`. A re-created runner after user edits self-excludes
      because HEAD has moved off the default tip (`sourceIsDefaultBranch` false → short-circuit).
- [x] Enforce publish eligibility across creation paths. **Done by construction** — eligibility is a
      pure function of session state at publish time, not the creation path: `publishOverlayBaseAfterInstall`
      pulls the worker's HEAD and publishes **only** when it equals the repo's current default commit
      (`sourceIsDefaultBranch`). Ops source-pinned sessions are excluded up front (`isOverlayEligible`
      rejects `kind === "ops"`); any non-default checkout (historical branch, `--shipit-source` pin)
      or a user/agent commit moves HEAD off the default tip and self-excludes. Generic agent-spawned
      children branch from `origin/HEAD` like manual sessions, so they're eligible iff their HEAD is
      still the default tip — the same test, no per-path special-casing.
- [x] **Re-derive on unarchive** — **already satisfied, no change needed.** `unarchiveSession`
      (`services/session.ts`) removes the workspace and re-clones from the bare cache + re-fetches;
      it never restores an `upperdir`. We never persist the per-session overlay upper, so base GC's
      `liveOverlayScopeHashes` only counts non-evicted sessions — an archived session's base is
      reclaimable and re-derived (cold-start v0 or a fresh install on the current base) on unarchive.
      Confirmed by reading the unarchive flow; documented here so the invariant is explicit.
- [x] **Spike: shared `type=overlay` volume across agent + compose containers** (Open Q #4 gate).
      `prototype/shared-volume-spike.sh` proves concurrent first-use of **one** per-session
      `type=overlay` volume mounted into the agent `docker run` **and** ≥2 service containers:
      **(a)** the upperdir backs **exactly one** overlay superblock (one daemon mount + bind-share,
      not N — the decisive check); **(b)** cold-race trials with **zero**
      `EBUSY`/`upperdir is in-use`; **(c)** the HMR **polling** substrate — the agent's writes are
      visible (fresh content + updated mtime) to a *service* container (dev servers poll;
      cross-container inotify is a non-gating data point that, as expected, did not fire);
      **(d)** teardown↔startup overlap leaves the merged view intact. **Matrix complete — PASS=8/8
      on all three hosts:** Docker Desktop/Windows-WSL2 (amd64, 25 trials), Docker Desktop/Mac
      (arm64, 25 trials), prod VPS `shipit-16gb` (Ubuntu 24.04/**ext4**, 50 trials). See
      [`FINDINGS.md`](./FINDINGS.md). **Open Q #4 resolved.**
- [x] **Wire the shared overlay volume into compose + the agent container** (Open Q #4 mechanism
      proven). Steps:
  - [x] `overlayVolumeName(session)` resolver — already exists (`overlay-volume.ts`); eligibility +
        spec construction live in `overlay-session.ts` (`isOverlayEligible`, `resolveOverlayScope`,
        `buildOverlaySpec`). Non-overlay sessions stay byte-for-byte unchanged (flag off / no remote).
  - [x] **Agent container — `buildMounts`** already takes the distinct `overlayWorkspaceVolume` arg
        (Phase 2) mounting the overlay volume at `/workspace` root only; `/uploads` + `/dep-cache`
        stay on `shipit-workspace`. **Now populated**: `prepareOverlaySpec` builds the spec →
        `buildConfigForWorkspace({ overlaySpec })` → `createContainer` creates the volume + mounts it.
  - [x] **Compose services:** `setupServiceManager` now points `wsVolume` at the container's recorded
        `overlayVolumeName` and sets `wsSubpath = ""` for overlay sessions, so `generateComposeOverride`
        roots every service mount at the merged tree (no generator change). Keyed on the container's
        actual `overlayVolumeName` so compose follows what the container really mounted.
  - [x] **Ordering:** unchanged — `createContainer` `docker volume create`s the overlay volume before
        the agent container starts (Phase 2); compose `up` happens later in `setupServiceManager` and
        refcount-shares the same `external` volume (spike-proven safe).
  - [~] **Secrets:** overlay relies on the existing out-of-workspace `serviceEnvDir` mode
        (`serviceEnvFiles` absolute paths) — already the production default, so env files don't depend
        on the merged workspace. The `x-shipit-secrets` entrypoint-script mount uses an absolute host
        `entrypointSourcePath` (not workspace), so it's also unaffected. **No code change; flagged for
        host validation that both resolve correctly over the overlay volume.**
  - [x] **Tests:** compose-generator unit tests added (`compose-generator.test.ts`) — overlay override
        roots service mounts at the overlay volume, never the `shipit-workspace` storage subpath nor
        `overlay-base/`; subdir subpath stays relative to the merged root. (A live integration test —
        preview service sees `node_modules` from the lowerdir — is host-gated.)
  - [x] File watcher: the agent-container file-tree watcher is same-namespace inotify over `/workspace`
        (the merged mount), already correct — no change.
- [ ] **NOT DONE — warm-pool standby overlay mount.** A session that claims a warm standby reuses the
      standby container, which is built (`warm-pool-manager.ts`) WITHOUT an `overlaySpec` — so warm-
      claimed sessions silently run plain (non-overlay). The warm pool is the primary prep path the
      plan targets, so it needs `prepareOverlaySpec` wiring once source-sync lands. Until then the
      on-activation backstop in `setupServiceManager` still runs install + (for genuine overlay
      containers) publish; a warm-claimed session just pays a full install. Harmless while the flag
      is off; flagged so it isn't forgotten when enabling.
- [ ] **NOT DONE — host-gated. Route production file/doc/git/compose/watcher/post-turn flows through a
      workspace-view resolver.** For an overlay session `session.workspaceDir` is only the upperdir, so
      the orchestrator must read/write the merged tree via worker HTTP (file tree/content/edit, doc
      discovery, Git reads + mutations, rollback/rebase/push/pull, PR/diff stats, post-turn
      auto-commit/auto-push). This is the broad "audit every direct `fs`/`GitManager` use against
      `session.workspaceDir`" task. **Paired with the Phase-3 source-sync re-sequencing, this is the
      remaining work that the `OVERLAY_DEP_STORE` flag gates** — overlay must NOT be enabled in
      production until both land and pass host-matrix validation. The publish path already side-steps
      this for its one need (it reads HEAD + the snapshot via worker endpoints, not the host upperdir).

### Phase 5 — Measure & tune

- [ ] Measure warm-install time **on the containerized path** (NOT dogfood/local mode): `main`
      unchanged (warm overlay no-op, ~marker skip), `main` advanced deps (incremental), and cold.
      Separate **network** (download cache) from **extract/link** (what overlay removes) — a warm
      download cache alone still pays ~full materialization (~24s / 31,396 files observed).
- [ ] Set the final depth cap from measurement.
- [ ] Optional/future: detection-free manifest fingerprint to skip no-op installs — only if
      measurements call for it.
