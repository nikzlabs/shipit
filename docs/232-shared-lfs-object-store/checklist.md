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
- [ ] **Canary soak** — verify the two assumptions that couldn't be exercised in a
      session container (no `git-lfs` on PATH there): that `git lfs fetch`
      populates `lfs/objects` in a *bare* repo, and that its endpoint authenticates
      through the global credential helper. Both fail safe. See "Verification
      status" in `plan.md`.
- [ ] Default the flag on once the soak is clean
- [ ] Cache-side `git lfs prune` with a chosen retention window (safe thanks to
      refcounting, but bare-repo support is unverified)
- [ ] Seed on `refreshCloneToLatestMain` too, whose `reset --hard` re-pulls
