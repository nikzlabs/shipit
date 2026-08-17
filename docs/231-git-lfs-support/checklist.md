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

### Second pass, after independent review found the hand-enumeration short

- [x] Restore on chat **rewind** and its undo (`rollback` = `reset --hard`) — the
      most reachable version of the bug, since rewind is a first-class chat action
- [x] Restore on `POST /git/rollback`, `POST /git/pull`, and a direct
      `POST /git/rebase/abort` (the flow's `finally` covers only a flow-initiated one)
- [x] Restore in `shipit release prepare` — `checkout -B` / cherry-pick /
      merge-override, with the version-bump commit authored on top of that tree
- [x] Materialize LFS in `forkSession`, which never did: `clone --local` carries no
      `.git/lfs` and the `checkout -b` runs smudge-disabled, so a fork of an LFS
      repo was stubs all the way down
- [x] Restore on the auto-resolve **timeout** path, before its immediate
      `drainQueue` — the flow's own `finally` lands after the queued turn starts
- [x] Serialize restores per workspace: the timeout path deliberately restores
      twice against one clone, and `git lfs checkout` writes in place
- [x] Hold the runner (invariant 5) across the rebase-path restore — it runs with
      `running` false on a path that fires on idle, viewerless sessions
- [x] Tell the agent when the pre-turn reset's restore FAILED, via the reset's
      agent prefix — the issue's fallback ask, on the one path with no toast
- [x] Replace the hand-enumeration with a coverage scan
      (`git-lfs-rewrite-coverage.test.ts`): a rewriting file that never restores
      fails the build by name, and the allowlist may not go stale
- [x] Pin the orderings nothing asserted: restore before the handback, before the
      queue release, and before the timeout drain
- [x] Fix the docs/221 notice drop this uncovered: a message queued during a sync
      is released onto the DISPATCHED path, which never consumed the "your tree
      was rewritten" notice — so the turn most likely to need it never got it
- [x] Re-park that notice when the dispatched turn dies before the agent sees the
      prompt — read-and-clear would otherwise let a spawn failure burn it for good

## planning#426 — the pull had no credential, and the fork stayed silent

- [x] `git lfs pull` carries a per-remote credential resolved the way
      `GitManager.remoteGit` does, so a dropped-uid pull on a PRIVATE repo stops
      dying with `could not read Username` and silently leaving stubs
- [x] Register that resolver once at boot (`configureLfsRemoteCredentialResolver`)
      rather than threading it through twelve call sites, where an added site
      would silently opt out
- [x] Credential the fork's `fetch origin --prune` — the raw site left behind when
      `mergeSession` got a resolver in docs/266 E3
- [x] Classify a failed pull's two shapes from git-lfs's own output
      (`no-credential` = our plumbing fault, `access-denied` = the token cannot
      reach this repository), each with its own advice
- [x] Report a fork whose LFS content did not resolve: an SSE toast now, and a
      durable `pending_agent_notice` for the first turn — however much later that
      is — naming the cause and the `head -c 120` pointer-header check
- [x] Report on every non-`materialized` status, not just `failed`: `disabled` and
      `binary-missing` leave the same stubs on disk
- [x] Surface the fork's `fetch origin` failure instead of a bare `console.warn`
- [x] Give the disk janitor's orphan-branch `push --delete` an explicit
      repo-scoped credential, decline the sweep loudly when none can be resolved,
      and name which shape a failure was
- [x] Correct the `sweepOrphanMergedBranches` docstring, which still claimed the
      cache's remote URL embeds the token — a mechanism docs/262 req 19 deleted
- [x] Tests: the credential on the pull's argv and in its environment (and the
      secret in neither the argv nor the config), the unchanged no-credential
      path, both failure classifications, the notice's content and every cause,
      the fork's resolution scoped to its own workspace, the no-remote negative,
      and the janitor's credential + fail-closed decline
