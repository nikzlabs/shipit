# Checklist — orchestrator-side git trust boundary

Build sequence from [plan.md](./plan.md) §5. Requirements are cited as `(req N)`.

## Shipped

- [x] **E1 — orchestrator git on a session workspace runs as the tree's owner**
      (reqs 1, 2, 3, 11). `shared/git-tree-uid.ts` decides by **ownership**, the
      same fact git's own CVE-2022-24765 check tests, applied inside
      `safeSimpleGit` so all ~189 `createGitManager` call sites and all 13 raw
      `safeSimpleGit(workspaceDir)` sites are covered without a hand-kept list.
      Gated on `process.getuid() === 0`, so the session worker, local mode and
      every test are unchanged.
- [x] The two raw git spawns that touch a session workspace converted —
      `git-lfs-blob.ts` (`git lfs smudge` resolves `filter.lfs.smudge` from the
      repo's own config) and `github-auth.ts` (writing `credential.helper` as
      root would also leave a root-owned file inside a worker-owned `.git`).
- [x] **One global gitconfig, owned by the worker uid at 0600**, in a `/credentials`
      tightened from 0755 to **0711** (traverse, not list). It was 0644 — the PAT
      was readable by every uid in the orchestrator container.
      An earlier version of this PR wrote a *second* "token-free" config and
      pointed `GIT_CONFIG_GLOBAL` at it via the child environment. Review killed
      it and it deserved to: the file sat in a 0700 root-owned directory so the
      worker uid could not traverse to a file it owned (every dropped commit
      would have failed "Author identity unknown"); simple-git's `env(object)`
      *assigns* the executor env, so callers chaining `.env()` discarded the
      override while the uid drop stayed in force; and it was hiding a token the
      dropped git needs anyway in order to push. One config, no override,
      nothing downstream can undo it.
- [x] **E5-detect (reqs 14, 15)** — the two permission states classified and
      surfaced as persisted transcript notices, with different words each:
      "this commit is short" for an unreadable **directory**, "this turn was NOT
      committed" for an unreadable **file**. Matched on message text, never on
      an exit code (`GitError.exitCode` is `undefined` by construction).
- [x] Tests: `git-tree-uid.test.ts` (the decision, via its injection seam),
      `git-unreadable.test.ts` (both permission states against **real git**), and
      post-turn tests for the two notices plus the secret-block interaction.
- [x] **Two defects found after the first pass, both fixed:** the clean-tree
      early return escaped detection entirely (when the unreadable directory
      hid the *only* changes, git reports "nothing to commit" and exits 0 — the
      exact silent case req 14 exists for, and both original tests were blind to
      it by construction because they always kept a readable edit in the tree);
      and a `blocked` result would have retired a standing secret block even
      though nothing was staged and the scan never ran, clearing the banner on
      the lie planning#317's condition exists to prevent.

## Not shipped — tracked, and the reason each was split out

- [ ] **E2 — narrow `safe.directory=*`** so a missed call site fails closed
      rather than silently running as root (req 7). **planning#403.** Split
      because removing the `*` turns every missed site into a hard failure at
      once, on the post-turn commit path, and E1 cannot be exercised for real in
      a session container (no root; `unshare -r` refused). Land E1, observe it in
      production, then remove the `*`.
- [ ] **E3 — repo-scoped token instead of the PAT** for the dropped-uid git.
      **planning#404.** The dropped git must be able to `push`, so it needs a
      readable credential; today that is the PAT in a 0600 worker-owned file.
      Reach narrowed (every uid → root + worker uid) but `/credentials` is not
      out of scope, and **req 1 names it**. The credential is per-session and
      per-repo, so it cannot live in the boot-time, repo-less writer.
- [ ] **E4 — let the project's hooks fire again** (reqs 9, 10). Sequenced last
      by `plan.md` §5 because it is the only step that *adds* a way for the
      commit to fail, and it needs the bounded-attempt-then-`--no-verify`
      fallback to satisfy req 10.
- [ ] **Per-session uids** (req 13). **planning#405.** Until then a payload at
      the shared uid still reaches every session's workspace inside the
      orchestrator container.

## Review follow-ups — planning#407

- [x] **The eviction data-loss path (the priority item).** `tier-escalation`'s
      pre-eviction commit gated the wipe on `isClean()`, which is **true** for
      content git cannot read — so a subtree the session uid could not open
      answered "nothing uncommitted here" and the checkout, its only copy, was
      deleted. Root read everything, so the gate was correct by accident until
      the uid drop. It now asks `GitManager.inspectWorkingTree()` — clean AND
      fully readable — before and after the commit, and an unreadable path is a
      block in its own right (`kind: "unreadable"`, with its own notice naming
      the path). Guarded by two real-git tests in `disk-tier-escalation.test.ts`,
      both of which fail without the change.
- [x] **`unreadable` reaching every `autoCommit` caller** (reqs 14, 15). The
      words moved into `services/unreadable-workspace-notice.ts` and are now
      used by the post-turn commit, the `gh pr create` / late-consult flush
      (`services/github.ts`), the UI file save (`api-routes-files.ts`) and the
      fallback turn commit (`turn-executor.ts`, via a new `SystemTurnDeps`
      field). The two `templates.ts` sites are the deliberate exceptions, with
      the reason stated at each: a root-owned `mkdtemp` and a workspace that is
      being created, neither of which has a transcript or a foreign uid.
      Requirement 15 also now covers the commits that fail for a cause ShipIt
      canNOT classify: `post-turn.ts` reports the failure and rethrows, instead
      of letting `postTurnStep` turn it into a log line.
- [x] **Three things the independent review caught in the above.** (1) An
      `omitted` result does not imply a commit — when the unreadable directory
      hides the only changes, `autoCommit` returns a null hash, and the notice
      said "this commit is short… everything else was committed normally" about
      a commit that did not exist. That is req 15's outcome in req 14's words,
      the exact collapse the two requirements were split to prevent; the
      formatter now takes `committed` and every caller passes its own hash.
      (2) `agentCreatePr` aborted on a secret-blocked flush but not on a
      `blocked` one, so it opened a PR without the work the flush existed to
      include — the failure mode its own comment names, wired for one of its two
      causes. (3) The eviction notice asserted the content "exists only here",
      which is false for the postgres archetype (committed, pushed, and made
      unreadable at boot); it now says ShipIt cannot check, and names archiving
      as the way to free the disk now.
- [x] **The stderr classifiers.** The file regex is keyed on the permission
      cause (`open(...): Permission denied`) instead of matching
      `unable to index file` cause-agnostically, so an EIO or a file deleted
      mid-add is no longer reported as "fix that path's permissions". The
      orchestrator pins `LC_ALL=C` (`git-config.ts`) so the wording is git's
      own rather than the deployment's locale — set on the process environment
      because simple-git can carry neither an env override (`env()` assigns) nor
      a forwarded `process.env` (the unsafe-env plugin refuses it over
      `GIT_CONFIG_GLOBAL`). Residual, recorded: the **directory** case still
      depends on git's wording, because there git exits 0 and the warning is the
      only trace. The **file** case no longer does — the rejection itself proves
      the turn committed nothing. The pin lives in its own
      `pinGitMessageLocale()` called *outside* `app-di.ts`'s
      `if (!process.env.GIT_CONFIG_GLOBAL)` gate: folded into
      `initGlobalGitConfig` it was skipped on exactly the deployments that
      already have a locale of their own (review finding). An operator's
      existing `LC_ALL` is overridden — determinism is the point — but logged,
      never dropped silently.

      Two residuals recorded rather than fixed: a pre-eviction commit that
      throws for an *unclassifiable* reason still ends at `warnStuck` and
      `"skipped"`, so the session is pinned with a throttled log line and no
      card (not req 15 — no turn — but the same shape the notices exist to
      remove); and a gitignored unreadable subtree is still wiped, which is
      unchanged from the root-side behaviour since git never committed ignored
      content either.
- [ ] **The fork clone that runs as root over an untrusted tree**
      (`session-fork-merge.ts`, no `baseDir`) is NOT fixed here. It is being
      fixed alongside E2 by the planning#403 work, which touches the same file —
      creating the destination, handing it to the worker uid, then cloning at
      the source tree's uid. Left to that change rather than made twice.
      `plan.md` §4's "no root-side git touches the untrusted tree at all" is
      still wrong until it lands.

## Do not write up as closed

planning#384 is **not** closed by this work. E1 removes root, the Docker socket
and the credential store *as a whole* from the payload's reach on the
tree-touching and remote paths. It does not remove `/credentials` (E3), it is
not yet fail-closed (E2), and cross-session workspace access remains (req 13).
