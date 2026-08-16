# Checklist — Git LFS support

- [x] Install `git-lfs` in the session-worker images (`prod`, `dev`) with a full
      `git lfs install --system --skip-repo`
- [x] Install `git-lfs` in the orchestrator images (`prod`, `dev`, `dogfood`) with
      `--skip-smudge`, so the clean filter protects orchestrator-side auto-commit
      without letting smudge fail `git clone --local` from the bare cache
- [x] `git-lfs.ts`: binary probe, committed-`.gitattributes` LFS detection,
      batched `git lfs pull` with a timeout, and a warning on every non-materialized
      outcome
- [x] Materialize LFS content in warm-pool provisioning
- [x] Materialize LFS content in the claim slow-clone path
- [x] Re-materialize on warm-session reuse (the `reset --hard` there re-writes stubs)
- [x] Materialize on unarchive and workspace restore, re-chowning after the
      root-written pull
- [x] `SHIPIT_GIT_LFS=off` escape hatch — detect and warn without spending the
      bandwidth (the issue's minimum-acceptable fallback)
- [x] Allow the GitHub LFS transfer host in the default and git-lifeline egress lists
- [x] Pass `SHIPIT_GIT_LFS` / `SHIPIT_GIT_LFS_TIMEOUT_MS` through the VPS compose
      orchestrator env, so the escape hatch is actually reachable on a deploy
      instead of silently no-opping like an unplumbed `OVERLAY_DEP_STORE`
- [x] Agent-facing guidance in `shipit-docs/environment.md`: check for the
      `git-lfs.github.com/spec/v1` header before blaming networking or codecs
- [x] Unit tests for detection + the status/warning contract
- [x] Dockerfile guard test for the per-role smudge asymmetry
- [x] Resolve LFS pointers in the diff viewer, which reads committed blobs and so
      is untouched by working-tree materialization (design + key files in
      `docs/017-diff-review-panel` § Git LFS images)

## nikzlabs/shipit#2349 — later tree rewrites, not just provisioning

- [x] `restoreLfsAfterTreeRewrite` in `git-lfs.ts`: one named, documented duty
      every orchestrator-side worktree rewrite owes, over the existing
      `materializeLfsWithWarning`
- [x] Restore after the rebase driver's flow — in the `finally`, so an ABORTED
      sync (which checks the pre-rebase tree back out through the same
      filter-less git) is covered too, and never between conflict iterations
- [x] Restore after the merged-branch pre-turn `reset --hard`, before the turn it
      exists to enable reads those files
- [x] Restore after `shipit branch reset-to-base` (explicit + `--force`)
- [x] Restore after a fork-merge into the active session, including its abort
- [x] Restore after a child spawn pinned to an explicit base with `reset --hard`
- [x] End-to-end regression against a real git-lfs: a skip-smudge clone, a tree
      rewrite, pointer text in a tree git calls clean, then real content back
      with the tree still clean
- [x] Wiring guards at each call site, including the negatives — no restore when
      nothing was rewritten, and none mid-conflict
- [x] Agent-facing `shipit-docs/environment.md`: syncs restore too, so stubs
      after one are a failure worth reporting rather than the expected state
