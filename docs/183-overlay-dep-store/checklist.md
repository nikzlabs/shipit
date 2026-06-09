# Checklist — overlay-mounted rolling workspace base

Design proposal. Core decisions: **overlay the whole workspace** (environment-agnostic, no
keys / no lockfile detection); **keyless rolling base per `(repo, runtime fingerprint)`**;
**base publish restricted to exit-0 pre-user installs whose recorded source base is the remote
default-branch commit, advancing only forward by `main`-commit ancestry** (installs into a
session's own upper never race; publish is a commit-ancestry
compare-and-swap, loser just skips); upgrade the existing marker/`headChanged` skip to a
stamped source-commit + runtime-fingerprint + install-command marker; **depth-cap-triggered
clean reinstall** (specific tunable cap); **re-derive on unarchive**; **exit-0 base-advance
gate**; cold start builds v0 from empty under the **existing** repo trust gate. Prototype the
rolling-base logic first; the host mount stays the gating risk.

- [x] Prototype the keyless rolling base on the current substrate: mount current base →
      git fast-forward source → run real install on top → publish only for exit-0 pre-user
      installs whose recorded source base is the remote default-branch commit, via the
      commit-ancestry compare-and-swap (installs run concurrently into their own uppers)
      — done in `prototype/rolling-base.ts` + `run-rolling-base.ts` (33/33 pass against a
      real git repo); see `FINDINGS.md`
- [ ] Measure warm-install time **on the containerized path** (NOT dogfood/local mode, which
      has no overlay and may bypass the shared download cache): `main` unchanged (warm overlay
      no-op, ~marker skip), `main` advanced its deps (incremental), and cold. Separate the
      **network** cost (download cache) from the **extract/link** cost (what overlay removes) —
      a warm download cache alone still pays ~full extract (~24s observed for ShipIt's tree)
- [~] Spike the orchestrator host-side **whole-workspace** overlay mount (mount on activate,
      unmount + workdir cleanup on dispose); size its cost — the gating unknown.
      Substrate **confirmed** — passed **WSL2/ext4 19/19** and **Docker Desktop/Mac 21/21**
      (`prototype/run-in-docker.sh`, named-volume substrate, incl. inotify). **Mechanism
      decided** (see plan §4 "Host-mount design decisions"): a **long-lived privileged
      sidecar** driven by the orchestrator over a unix socket performs the overlay mount with
      shared propagation (orchestrator stays unprivileged); overlay state lives in the
      **workspace volume** with the shared base under the **dep-cache** subtree and per-session
      upper/work/merged under the session subtree, mounted via the existing volume-Subpath
      mechanism. Nice-to-have: prod (non-WSL) kernel run + mount/unmount timing — see
      `FINDINGS.md`
- [ ] Confirm host kernel/fs support overlayfs lowerdir sharing on the prod VPS (ext4)
- [x] Prove **cross-container mount propagation** for the sidecar design (`propagation-spike.sh`):
      the sidecar's overlay mount reaches a separate session container **iff the daemon host has
      shared mount propagation** and the mount lands under a **dedicated self-bind `rshared`
      mountpoint**. **Docker Desktop/Mac: works with no setup (proven).** Bare docker-ce-in-WSL2:
      private `/`, fails (runtime `make-rshared` not honored) → that install falls back to copy.
      Requirement = documented host prerequisite, not a portability blocker. Where overlay is
      unavailable, fall back to a **plain full `agent.install`** (NOT a copy store — see the
      nm-store removal item; the download cache keeps it fast). Remaining: one confirming run on
      a systemd VPS (expected pass). See `FINDINGS.md`.
- [ ] Make `disk-janitor` aware of live overlay mounts before teardown
- [ ] Verify the host-mount route stays within the containment model (docs/172)
- [ ] Confirm git fast-forward behaves on the overlay and the source diff in the upper
      layer stays small (`t → t'`)
- [ ] Scope the base per `(repo, runtime fingerprint)` so a base is never reused across
      incompatible runtimes (image digest + arch + libc + relevant runtime ABI/version, e.g.
      Node native-module ABI and Python implementation + major.minor / ABI tag)
- [ ] Restrict base *publish* to **exit-0 pre-user installs whose recorded source base is the
      remote default-branch commit**; any session still installs into its own upper layer (no
      install serialization). Eligibility is by **source base + exit-0 + ancestry**, not by the
      literal branch name or which code path ran the install — so an on-activation install for
      a normal session cut from `origin/HEAD` **is** eligible (it's how trust-deferred repos
      build v0). Generic agent-spawned children also use the normal `origin/HEAD` claim path.
      Exclude internal Ops source-pinned sessions, any session whose source base is not the
      remote default commit, and sessions with user/agent dependency edits before publish
      (child-sessions.ts)
- [ ] Wire the on-activation install (service-manager-setup.ts) — the idempotent backstop for
      trust-deferred repos, pool misses, and re-created runners — to feed the base under the
      same publish rule; stamp `.shipit/.install-done` with source commit + runtime fingerprint
      + install command so repeats are no-ops only when the stamp matches
- [ ] Stamp each base with its source **`main` commit**; on publish advance **only if the
      candidate strictly descends the base** (`git merge-base --is-ancestor`), under a short
      per-`(repo, runtime fingerprint)` lock for atomic read-compare-swap. Order by commit
      ancestry, not publish time; skip stale/diverged (force-push) publishes
      — *logic validated in `prototype/rolling-base.ts` (ancestry CAS, force-push skip,
      late-older-loser, ~2.3ms ancestry / ~0.1ms lock); production wiring still to do*
- [ ] Set a **specific** depth cap (~10–20, tunable); on hit, rebuild base from empty (clean
      reinstall = drift + reproducibility reset)
      — *flatten-from-empty behavior validated in `prototype/rolling-base.ts` (cap=16,
      depth resets, generation bumps); final value to be set from host measurement*
- [ ] Exclude/normalize `.git` from the base (correctness — don't carry session branch refs
      forward); verify git/worktree (absolute gitdir pointers) behave on the overlay
- [ ] Gate base advance on install **exit code 0** (non-zero serves the session, isn't published)
- [ ] Re-derive on unarchive (persist source/metadata only; re-clone + reinstall) — so base
      GC only respects live mounts, not archived sessions
- [ ] Cold-start path: build base v0 from empty under the existing repo trust gate (docs/178)
- [x] Verify compose bind-mounts using the overlay merged dir + `inotify` file watcher work
      — confirmed on Docker Desktop/Mac (`prototype/run-in-docker.sh`, 21/21 incl. inotify
      create + copy-up) and bind-mount-corroborated on WSL2
- [ ] **Remove `nm-store` entirely** (not kept as a fallback): delete the copy store and all its
      machinery — `materialize`/`populateStore`, `findLockfile`, `isCacheableInstall`,
      `computeStoreKey`, the store-key plumbing in the worker install gate
      ([nm-store.ts](../../src/server/session/nm-store.ts), [148](../148-fast-npm-install/plan.md)).
      Where overlay is unavailable the worker just runs `agent.install` as it does today,
      warmed by the **download cache** (`/dep-cache`, docs/075) which is a separate subtree and
      stays. Two paths only: overlay or plain full install. (`runtimeKey`/runtime-fingerprint
      logic is reused by the overlay base scope, so keep that part.)
- [ ] Optional/future: detection-free manifest fingerprint to skip no-op installs — only if
      measurements call for it
