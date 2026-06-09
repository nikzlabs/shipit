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
- [ ] Confirm `volume-driver-overlay-spike.sh` once on a **Linux/VPS** daemon (expected to pass
      trivially — daemon-side overlay is standard there).
- [x] Decide host-mount mechanism, helper shape, storage layout, propagation prerequisite, and
      fallback (plan §4). See `FINDINGS.md` for evidence + live 31,396-file / ~24s measurement.

### Phase 1 — Delete the nm-store fast path (FIRST)

- [ ] **Remove the copy store + its gate wiring.** Delete `materialize`/`populateStore`,
      `findLockfile`, `isCacheableInstall`, `computeStoreKey`, `LOCKFILE_NAMES`, the store-dir
      constant + `FAST_INSTALL`/`NM_STORE` env, and the worker install-gate plumbing that calls
      them (`tryMaterializeFromStore`, store-key compute, populate)
      ([nm-store.ts](../../src/server/session/nm-store.ts),
      [session-worker.ts](../../src/server/session/session-worker.ts) install gate).
- [ ] **Keep what overlay/plain-install reuse:** relocate `runtimeKey`/`detectLibc` to a shared
      module (overlay base scope reuses it as the runtime fingerprint); keep `tuneNpmInstall`
      (`--prefer-offline --no-audit --no-fund` helps the plain install on a warm download cache).
- [ ] **Simplify the worker install path** to: valid `.shipit/.install-done` marker → skip;
      else run `agent.install` (tuned) → write marker. Download cache (`/dep-cache`, docs/075)
      stays; it's a separate subtree.
- [ ] **Cleanup:** drop nm-store writes; add a one-time `disk-janitor` sweep of
      `/dep-cache/nm-store` to reclaim space (~2.4 GB observed). Delete `nm-store.test.ts` and
      rewrite/remove `fast-install-gate.test.ts` for the simplified gate.
- [ ] Mark [148-fast-npm-install](../148-fast-npm-install/plan.md) **superseded**.

### Phase 2 — Daemon-overlay mount subsystem

Mechanism: the orchestrator (unprivileged, via `docker.sock`) has the **daemon** mount the
overlay through a `local` `type=overlay` volume. No privileged sidecar, no propagation, no
`CAP_SYS_ADMIN`. (See the rejected sidecar design in `FINDINGS.md` for why.)

- [ ] Orchestrator creates a **per-session `local`-driver `type=overlay` volume** —
      `o=lowerdir=<base>,upperdir=<session-upper>,workdir=<session-work>` using **absolute
      daemon-host paths** resolved via `docker volume inspect -f '{{.Mountpoint}}'` — and mounts
      it at `/workspace` (extend `buildMounts`); the daemon performs the overlay mount as it
      builds the container (merged view present by construction).
- [ ] **Base lives in `overlay-base/<scope-hash>/` on the workspace volume — NOT under
      `dep-cache/`.** The dep-cache subtree is mounted **rw** into every session (`/dep-cache`),
      so a base there would be writable from inside sessions and could corrupt the immutable
      lowerdir under other sessions' live mounts. The `overlay-base/` subtree must **never** be
      bind/Subpath-mounted into a session container.
- [ ] **Per-session upper/work** under `sessions/{uuid}/` (kernel forbids sharing an upperdir;
      same subtree → upper+work share an fs); **shared read-only base** across sessions.
      **`workdir` empty.**
- [ ] **Serialize** volume create/mount to avoid the overlay2 `device or resource busy` (EBUSY)
      hazard under parallel container starts.
- [ ] **Volume lifecycle + GC:** name the volume **`shipit-<sessionId[:12]>_overlay`** so the
      existing `sweepOrphanSessionVolumes` (regex `^shipit-([a-f0-9-]{12})_`, dangling, live-prefix
      check) reclaims it automatically — a crash-orphaned volume is swept once no session owns the
      prefix; a live/idle session's volume is preserved. **Avoid `shipit-overlay-<id>`** (fails the
      `<12 hex>_` regex → leaks). Stamp `shipit-managed=true` for parity. Teardown = `docker volume
      rm` on dispose. Extend `sweepOrphanedCaches` to cover unreferenced `overlay-base/<hash>/`.
- [ ] Add the workspace-view resolver before enabling overlay sessions: `session.workspaceDir`
      is storage/upperdir metadata for overlay sessions, while file/doc/git/compose/watcher and
      post-turn operations must dispatch through worker HTTP endpoints against the container's
      merged `/workspace`. Audit all direct orchestrator `fs`/`GitManager` uses against
      `session.workspaceDir` and route or prove them storage-only.
- [ ] Verify the route stays within the containment model (docs/172) — orchestrator stays
      unprivileged; session containers gain no capability.
- [x] **Production-layout spike confirmed** — `volume-driver-overlay-spike.sh` (updated to seed
      `lowerdir` under `overlay-base/<hash>/` and `upperdir`/`workdir` under `sessions/<uuid>/`,
      cross-subtree nested subpaths of one volume) ran **PASS=7 FAIL=0 on the prod VPS**
      (`shipit-16gb`, Ubuntu 24.04, docker 29.5.2, linux/amd64) — settles both the production path
      layout and a non-Docker-Desktop Linux daemon. (Mechanism also 7/7 on Docker Desktop/Windows.)
- [ ] **Size mount cost** (nice-to-have measurement, not a gate) — time a few overlay-volume
      create/mount/rm cycles on the real daemon.

### Phase 3 — Rolling-base logic wired to the real install

- [ ] Scope the base per `(repo, runtime fingerprint)` — image digest + arch + libc + relevant
      runtime ABI/version (Node native-module ABI, CPython impl + major.minor / ABI tag). Reuses
      the relocated `runtimeKey`.
- [ ] Base (lowerdir) under the dedicated **`overlay-base/<hash>/`** subtree (NOT `dep-cache` —
      see Phase 2); per-session upper/work in the session subtree; mount base + run `agent.install`
      on top into the session's own upper.
- [ ] Source sync runs **inside the merged `/workspace`** from a git checkout/index that knows the
      base commit, then resets/checks out the target commit and runs `git clean -ffdx` (or an
      equivalent explicit whiteout pass) before install/activation. This must create whiteouts for
      lowerdir files deleted since the base; do not rely on a pre-container host checkout into the
      upperdir.
- [ ] Upgrade `.shipit/.install-done` to a **stamped marker** (source commit + runtime fingerprint
      + install command); skip install only on exact match; non-default checkout / mismatch
      whiteouts the marker first.
- [ ] **Publish compare-and-swap:** advance the base only for **exit-0 pre-user installs whose
      recorded source base is the remote default commit**, and when the candidate strictly
      descends the base (`git merge-base --is-ancestor`) under a short per-`(repo, runtime
      fingerprint)` lock. Order by commit ancestry, not publish time; skip stale/behind
      publishes, but if the candidate is the current remote default and has diverged from the
      base (force-push), perform a lineage reset by rebuilding/publishing from empty or rotating
      to an equivalent new generation keyed by the rewritten default HEAD. *(Logic validated in
      `prototype/rolling-base.ts`; lineage-reset handling must be added.)*
- [ ] Gate base advance on install **exit code 0** (non-zero serves the session, isn't published).
- [ ] **Depth-cap flatten:** set a specific cap (~10–20, from measurement); on hit rebuild base
      from **empty** (clean reinstall = drift + reproducibility reset).
- [ ] **Exclude/normalize `.git`** from the base (don't carry session branch refs forward);
      verify git/worktree absolute gitdir pointers behave on the overlay.
- [ ] Publish/flatten from a worker-exported merged-workspace snapshot, not the host upperdir
      alone, so lowerdir-only source/dependency files are preserved in the next base.
- [ ] **Cold start:** build base v0 from empty under the existing repo trust gate (docs/178).

### Phase 4 — Session lifecycle integration

- [ ] Wire the on-activation install (`service-manager-setup.ts`) — the idempotent backstop for
      trust-deferred repos, pool misses, and re-created runners — to the overlay path + publish
      rule; the stamped marker makes repeats no-ops.
- [ ] Enforce publish eligibility across creation paths: generic agent-spawned children use the
      normal `origin/HEAD` claim path (eligible); **exclude** Ops source-pinned sessions, any
      session whose source base isn't the remote default commit, and sessions with user/agent
      dependency edits before publish (`child-sessions.ts`).
- [ ] **Re-derive on unarchive** (persist source/metadata only; re-clone + reinstall) so base GC
      only respects **live** mounts, not archived sessions.
- [ ] **Spike: shared `type=overlay` volume across agent + compose containers** (Open Q #4 gate).
      Run `prototype/shared-volume-spike.sh` (written; needs a real Docker host — it can't run
      from a session container, which by design has no `docker.sock`). It proves concurrent
      first-use of **one** per-session `type=overlay` volume mounted into the agent `docker run`
      **and** ≥2 service containers. Assert: **(a)** the upperdir appears **exactly once** as an
      `overlay` mount in the daemon host's `/proc/self/mountinfo` (one mount, not N — the decisive
      check); **(b)** ~50 cold-race trials (`volume rm`+create each iteration, no inter-start
      delay) with **zero** `EBUSY`/`device or resource busy`/`upperdir is in-use`; **(c)** a write
      in the agent container is visible in a service container and `inotify` fires in a service
      container (HMR path); **(d)** teardown↔startup overlap leaves the merged view intact. Run on
      prod systemd VPS (ext4) + Docker Desktop/Mac + Docker Desktop/Windows-WSL2. **Overlay-session
      preview support is gated on this spike going green.**
- [ ] **Wire the shared overlay volume into compose** (after the spike). For overlay-eligible
      sessions, point `opts.workspaceVolume` at the per-session overlay volume name
      (`shipit-<sessionId[:12]>_overlay`) instead of `shipit-workspace` so `rewriteVolumes` +
      the `external: true` declaration give every service the merged view by subpath
      (`compose-generator.ts`). Ensure no service mounts an `overlay-base/` lowerdir subpath or a
      bare-upperdir subpath. Then wire the file watcher over that merged mount.
- [ ] Route production file/doc/git/compose/watcher/post-turn flows through the workspace-view
      resolver so the UI, PR/diff data, rollback/rebase/push/pull, and auto-commit operate on
      the same merged tree the agent sees.

### Phase 5 — Measure & tune

- [ ] Measure warm-install time **on the containerized path** (NOT dogfood/local mode): `main`
      unchanged (warm overlay no-op, ~marker skip), `main` advanced deps (incremental), and cold.
      Separate **network** (download cache) from **extract/link** (what overlay removes) — a warm
      download cache alone still pays ~full materialization (~24s / 31,396 files observed).
- [ ] Set the final depth cap from measurement.
- [ ] Optional/future: detection-free manifest fingerprint to skip no-op installs — only if
      measurements call for it.
