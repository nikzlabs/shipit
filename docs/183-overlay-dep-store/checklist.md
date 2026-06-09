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

**Mechanism decided** (plan §4 "Host-mount design decisions"): unprivileged orchestrator drives
a **long-lived privileged sidecar** (via `docker.sock`) that overlay-mounts under a **dedicated
self-bind `rshared` mountpoint** the daemon sees; base in the **dep-cache** subtree, per-session
upper/work/merged in the session subtree, mounted via the existing volume-Subpath mechanism.
Requires **shared mount propagation on the daemon host** (Docker Desktop ✓ proven; systemd VPS
✓ expected; bare docker-ce-in-WSL2 lacks it → that install **falls back to a plain full
`agent.install`**). `nm-store` is **removed entirely**, not kept as a fallback.

## Implementation phases

Ordered. **Phase 1 deletes nm-store first** (clean, self-contained simplification), then the
overlay subsystem is built on top. Interim note: between Phase 1 and Phase 3, fast-path-eligible
repos lose the copy acceleration and pay a full `agent.install` (warm download cache, no network)
per fresh session — a conscious, temporary regression until overlay lands.

### Phase 0 — Prototypes & decisions (DONE)

- [x] Prototype the keyless rolling base on the current substrate: mount current base →
      git fast-forward source → run real install on top → publish only for exit-0 pre-user
      installs whose recorded source base is the remote default-branch commit, via the
      commit-ancestry compare-and-swap (installs run concurrently into their own uppers)
      — `prototype/rolling-base.ts` + `run-rolling-base.ts` (33/33 against a real git repo).
- [x] Confirm overlay substrate (mount / CoW / immutable base / depth / bind-mount / teardown)
      — WSL2/ext4 19/19 + Docker Desktop/Mac 21/21 (`host-overlay-spike.sh`, `run-in-docker.sh`).
- [x] Verify compose bind-mount over the merged dir + `inotify` (create + copy-up)
      — Docker Desktop/Mac 21/21; bind-mount-corroborated on WSL2.
- [x] Prove cross-container mount propagation **on Docker Desktop/Mac** (`propagation-spike.sh`):
      works **iff the daemon host has shared propagation** + a dedicated self-bind `rshared`
      mountpoint. Docker Desktop/Mac ✓ no setup; bare docker-ce-in-WSL2 ✗ (→ plain-install
      fallback). Requirement = documented host prerequisite, not a portability blocker.
- [x] **Confirm propagation on the prod VPS** — `propagation-spike.sh` rung A2 ran on the prod
      systemd VPS (docker 29.5.2, linux/amd64) and reported **PROPAGATED on the plain run, no
      host setup**. Overlay-on-VPS proven; the Phase 1 nm-store regression now has a guaranteed
      end date on the primary target.
- [ ] **OPEN — confirm Docker Desktop propagation survives a VM restart.** The LinuxKit VM is
      recreated routinely; if it returns with `/` private, local Mac/Windows installs silently
      drop to the slow fallback. Either prove persistence or rely on the Phase 2 re-arm probe.
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

### Phase 2 — Host-mount sidecar subsystem (the gating subsystem)

- [ ] Build the **long-lived privileged sidecar**: mount/unmount API over a local unix socket;
      sets up a dedicated self-bind `rshared` mountpoint once; performs the overlay mount
      (lower + per-session upper/work → merged) on activate, unmount + workdir cleanup on dispose.
- [ ] Orchestrator drives the sidecar (it stays unprivileged); session mounts the `merged` dir
      via the existing volume-Subpath mechanism (`buildMounts`). **Verify the overlay actually
      surfaces through the volume-Subpath mount** — the spike only proved a *direct* bind-mount;
      a Subpath mount must still see the nested overlay via propagation, which is untested.
- [ ] **Startup capability probe (re-run on every daemon/VM start, not one-time):** detect shared
      mount propagation on the daemon host → enable overlay, else fall back to plain
      `agent.install`. Must **re-verify/re-arm on each boot** to cover the Docker Desktop
      VM-restart case (VM may return with `/` private). Document the prerequisite
      (`MountFlags=shared` for self-hosted bare-WSL docker-ce; VPS provisioner guarantees it).
- [ ] Make `disk-janitor` (and archive flows) aware of **live overlay mounts** — unmount before
      removing workdir/merged (teardown ordering hazard the spike confirmed).
- [ ] Verify the host-mount route stays within the containment model (docs/172).
- [ ] Confirm overlayfs + propagation on the **prod VPS** (ext4, systemd) and **size mount/unmount
      cost** (the remaining nice-to-have measurements).

### Phase 3 — Rolling-base logic wired to the real install

- [ ] Scope the base per `(repo, runtime fingerprint)` — image digest + arch + libc + relevant
      runtime ABI/version (Node native-module ABI, CPython impl + major.minor / ABI tag). Reuses
      the relocated `runtimeKey`.
- [ ] Base (lowerdir) under the per-repo **dep-cache** subtree; per-session upper/work/merged in
      the session subtree; mount base + run `agent.install` on top into the session's own upper.
- [ ] Upgrade `.shipit/.install-done` to a **stamped marker** (source commit + runtime fingerprint
      + install command); skip install only on exact match; non-default checkout / mismatch
      whiteouts the marker first.
- [ ] **Publish compare-and-swap:** advance the base only for **exit-0 pre-user installs whose
      recorded source base is the remote default commit**, and **only if the candidate strictly
      descends the base** (`git merge-base --is-ancestor`), under a short per-`(repo, runtime
      fingerprint)` lock. Order by commit ancestry, not publish time; skip stale/diverged
      (force-push) publishes. *(Logic validated in `prototype/rolling-base.ts`.)*
- [ ] Gate base advance on install **exit code 0** (non-zero serves the session, isn't published).
- [ ] **Depth-cap flatten:** set a specific cap (~10–20, from measurement); on hit rebuild base
      from **empty** (clean reinstall = drift + reproducibility reset).
- [ ] **Exclude/normalize `.git`** from the base (don't carry session branch refs forward);
      verify git/worktree absolute gitdir pointers behave on the overlay.
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
- [ ] Production-wire compose bind-mount over the merged dir + file watcher (behavior already
      verified in Phase 0).

### Phase 5 — Measure & tune

- [ ] Measure warm-install time **on the containerized path** (NOT dogfood/local mode): `main`
      unchanged (warm overlay no-op, ~marker skip), `main` advanced deps (incremental), and cold.
      Separate **network** (download cache) from **extract/link** (what overlay removes) — a warm
      download cache alone still pays ~full materialization (~24s / 31,396 files observed).
- [ ] Set the final depth cap from measurement.
- [ ] Optional/future: detection-free manifest fingerprint to skip no-op installs — only if
      measurements call for it.
