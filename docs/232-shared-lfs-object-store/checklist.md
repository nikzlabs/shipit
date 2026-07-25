# Checklist — Shared Git LFS object store

- [x] Evaluate hardlink-from-cache vs a shared `lfs.storage`, and write down why
      hardlinks win on isolation (no cross-session writable mount) and on prune
      (kernel refcounting instead of one session's reachability view)
- [x] `git-lfs-store.ts`: `SHIPIT_GIT_LFS_SHARED_STORE` flag (off by default),
      `fetchLfsIntoCache` (explicit cache-side `git lfs fetch`, since smudge is
      off), `linkLfsObjectsIntoClone` (hardlink with copy fallback on `EXDEV`)
- [x] Seed the clone from `RepoGit.cloneFromCache`, beside the `clone --local`
      whose behavior it extends
- [x] Populate the cache from `repo-prefetch.ts`, **not** `fetchCache` — the claim
      slow-path awaits that one, and an LFS fetch there would put the transfer
      back on the user's critical path
- [x] Exclude `.git/lfs/objects` data files from the ownership handback
      (`chownDirsOnlyRecursive`), so a hardlinked object can't hand the shared
      cache store to the session uid — chowning all fanout dirs at both levels so
      the worker can still add new objects
- [x] Tests: shared inode across two clones, survival of a cache-side unlink
      (the prune property), already-present objects left untouched, symlink
      refusal, flag gating, and no-throw on an uncreatable destination
- [x] Tests: the chown handback skips LFS object files but chowns both fanout
      levels, and leaves a hardlinked object's ownership alone
- [x] Pass `SHIPIT_GIT_LFS_SHARED_STORE` through the VPS compose orchestrator env
      so the flag is reachable (the trap docs/231 hit with `SHIPIT_GIT_LFS`)
- [x] Flip `SHIPIT_GIT_LFS_SHARED_STORE` to on-by-default, with `off` as the escape
      hatch — polarity matching `SHIPIT_GIT_LFS`, and an empty value (what a
      `${VAR:-}` passthrough supplies) reading as the default rather than off
- [x] Cache-side prune so default-on can't grow disk without bound: unlink an
      object only when `nlink === 1` (no clone holds it) AND it is older than
      `DISK_JANITOR_LFS_OBJECT_DAYS` (14). Rides the periodic disk-tier escalation
      pass; ungated, since with sharing off the store is empty and the walk no-ops
- [x] Prune tests: byte accounting, a hardlinked object surviving any age, a fresh
      object surviving, emptied fanout dirs removed while ones with survivors stay,
      all repo caches swept
- [ ] Confirm from the first LFS repo to provision after the flip that
      `git lfs fetch` populates `lfs/objects` in a *bare* repo and authenticates
      via the global credential helper. Both fail safe, so this is confirmation,
      not a gate. See "Verification status" in `plan.md`.
- [ ] Seed on `refreshCloneToLatestMain` too, whose `reset --hard` re-pulls
