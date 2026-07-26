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
- [x] Confirm `git lfs fetch` populates `lfs/objects` in a *bare* repo — measured
      against a synthetic LFS repo now that git-lfs 3.3.0 ships in the session
      image. Confirmed **conditionally**: the no-ref form fails outright on a
      dangling `HEAD`, the explicit-ref form always works
- [x] Fix the two HEAD dependencies the measurement exposed — `resolveCacheFetchRef`
      resolves a concrete branch, used for BOTH `repoDeclaresLfs` detection (which
      greps `HEAD` by default and exits 128 on a dangling one) and the fetch itself
- [x] Verify the rest of the chain against the production shape: a smudge-off
      clone yields a 129-byte stub, seeding shares one inode, and `git lfs pull`
      succeeds from the seeded object alone after the cache's copy is deleted
- [x] Confirm the LFS endpoint authenticates via the global credential helper
      against a real **private** LFS repo — settled on `nicolasalt/delve` (~3,015
      LFS-tracked files): 0 pointer stubs, and all 3,003 distinct objects at
      `nlink=18`. Since `clone --local` never hardlinks `.git/lfs`, `nlink > 1`
      can only come from seeding, which requires an authenticated cache-side fetch
      against a private remote. Uniform (not mixed) nlink also shows the cache
      held the complete object set before the clone
- [ ] Verify the session-side egress allowlist entry
      (`github-cloud.s3.amazonaws.com`) with a **sandboxed** session running
      `git lfs pull`/`push` itself. Not covered by the above — that transfer ran
      orchestrator-side — and a sandbox couldn't be used for it, since a sandbox
      has its own ShipIt-managed git dir rather than a clone of the target repo
- [ ] Seed `refreshCloneToLatestMain` from the cache too. NOTE: this is a
      *network* win only — it avoids downloading objects added to main since the
      clone was cut. It does NOT make the warm-reuse path faster; the dominant
      cost there is the worktree rewrite, which seeding can't touch (see
      "Known gaps")
- [ ] (Deferred by decision, not oversight) Gate the warm-reuse `git lfs pull` on
      a reset having actually run. Kept unconditional for now: it doubles as a
      self-heal for a clone left holding stubs. Revisit if claim latency on an
      asset-heavy repo is measured to matter
