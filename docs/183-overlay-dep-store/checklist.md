# Checklist — overlay-mounted rolling workspace base

Design proposal. Decisions this iteration: **overlay the whole workspace** (environment-
agnostic, no keys / no lockfile detection); **keyless rolling base per `(repo, runtime)`**;
keep the existing marker/`headChanged` skip; **depth-cap flatten only**; prototype the
rolling-base logic first, then the host mount (which stays the gating risk).

- [ ] Prototype the keyless rolling base on the current substrate: mount current base →
      git fast-forward source → run real install on top → advance via optimistic CAS
- [ ] Measure warm-install time: `main` unchanged (warm no-op, ~marker skip) and `main`
      advanced its deps (incremental) vs. cold
- [ ] Spike the orchestrator host-side **whole-workspace** overlay mount (mount on activate,
      unmount + workdir cleanup on dispose); size its cost — the gating unknown
- [ ] Confirm host kernel/fs support overlayfs lowerdir sharing on the prod VPS (ext4)
- [ ] Make `disk-janitor` + archive flows aware of live overlay mounts before teardown
- [ ] Verify the host-mount route stays within the containment model (docs/172)
- [ ] Confirm git fast-forward behaves on the overlay and the source diff in the upper
      layer stays small (`t → t'`)
- [ ] Scope the base per `(repo, runtime fingerprint)` so a base is never reused across
      incompatible runtimes (arch + libc + interpreter)
- [ ] Decide CAS loser semantics (keep merged tree locally, skip publish) + transient disk
- [ ] Integrate with the warm pool so pre-install seeds/advances the base, not duplicates it
- [ ] Set the depth-cap flatten threshold; confirm flatten-only bounds drift acceptably
- [ ] Remove/retire the node_modules-specific `nm-store` copy store once the base supersedes it
- [ ] Exclude/normalize `.git` from the base (correctness — don't carry session branch refs
      forward); verify git/worktree (absolute gitdir pointers) behave on the overlay
- [ ] Gate base advance on install **exit code 0** (non-zero serves the session, isn't published)
- [ ] Re-derive on unarchive (persist source/metadata only; re-clone + reinstall) — so base
      GC only respects live mounts, not archived sessions
- [ ] Cold-start path (build base v0 from empty); trust-gate base creation as warm-pool does
- [ ] Verify compose bind-mounts using the overlay merged dir + `inotify` file watcher work
- [ ] Reproducibility backstop: decide if an occasional clean rebuild is needed beyond flatten
- [ ] Optional/future: detection-free manifest fingerprint to skip no-op installs — only if
      measurements call for it

Resolved this iteration: single-user sharing scope; capture-as-is (no secret filter);
re-derive on unarchive; exit-0 base-advance gate.
