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

- [ ] Prototype the keyless rolling base on the current substrate: mount current base →
      git fast-forward source → run real install on top → publish only for exit-0 pre-user
      installs whose recorded source base is the remote default-branch commit, via the
      commit-ancestry compare-and-swap (installs run concurrently into their own uppers)
- [ ] Measure warm-install time: `main` unchanged (warm no-op, ~marker skip) and `main`
      advanced its deps (incremental) vs. cold
- [ ] Spike the orchestrator host-side **whole-workspace** overlay mount (mount on activate,
      unmount + workdir cleanup on dispose); size its cost — the gating unknown
- [ ] Confirm host kernel/fs support overlayfs lowerdir sharing on the prod VPS (ext4)
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
- [ ] Set a **specific** depth cap (~10–20, tunable); on hit, rebuild base from empty (clean
      reinstall = drift + reproducibility reset)
- [ ] Exclude/normalize `.git` from the base (correctness — don't carry session branch refs
      forward); verify git/worktree (absolute gitdir pointers) behave on the overlay
- [ ] Gate base advance on install **exit code 0** (non-zero serves the session, isn't published)
- [ ] Re-derive on unarchive (persist source/metadata only; re-clone + reinstall) — so base
      GC only respects live mounts, not archived sessions
- [ ] Cold-start path: build base v0 from empty under the existing repo trust gate (docs/178)
- [ ] Verify compose bind-mounts using the overlay merged dir + `inotify` file watcher work
- [ ] Remove/retire the node_modules-specific `nm-store` copy store once the base supersedes it
- [ ] Optional/future: detection-free manifest fingerprint to skip no-op installs — only if
      measurements call for it
