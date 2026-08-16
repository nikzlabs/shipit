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
      production, then remove the `*`. **Built, not armed** — see below. The box
      stays unchecked until it has run armed in production.
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
- [x] **The fork clone that runs as root over an untrusted tree**
      (`session-fork-merge.ts`, no `baseDir`) — handed to planning#403 rather
      than made twice, and landed there, in the E2 section below. It creates the
      destination, hands it to the worker uid, and clones at the source tree's
      uid. `plan.md` §4's "no root-side git touches the untrusted tree at all"
      was wrong until this landed; with it and the two raw-spawn sites the E2
      audit found, it holds for the paths ShipIt has today — subject to the
      scanner's named blind spots, which is a weaker claim than the sentence
      makes and is why the sentence should not be read as a guarantee.

## E2 (planning#403) — built 2026-08-16, armed by an operator, not by a merge

- [x] **E2a — the CI-side guard, on by default.**
      `git-hooks-guard-coverage.test.ts` now fails the build when a raw
      `spawn`/`execFile`/`execFileSync` of `git` **names a working directory**
      and omits `gitSpawnOverridesForTree`, alongside the hooks rule it already
      enforced. Two carriers count (`cwd`, and a `-C <dir>` argument), and an
      options object the scanner cannot read counts as a third — an unreadable
      shape fails closed instead of passing quietly. `git-tree-uid.ts`'s
      docstring, which said this rule did not exist, now says what it enforces
      and names its two blind spots (`GIT_DIR`/`--git-dir`; indirection deeper
      than one in-file `const`).
- [x] **Three sites the audit found before arming anything**, all of which armed
      E2 would have broken and all of which ran as root in an untrusted tree
      until now: `git-lfs.ts`'s `runGit` (`git grep` + `git lfs pull`, the whole
      of LFS provisioning), `git.ts`'s `getFileBufferAtCommit` (`git show`), and
      `session-fork-merge.ts:54` (fork). The fork one is the site the ownership
      predicate structurally could not see — no `baseDir` to stat — and it now
      creates its destination, hands it to the worker uid, and clones with the
      drop resolved from the source tree.
- [x] **E2b — the `*` removed behind `SHIPIT_GIT_STRICT_OWNERSHIP=1`, off by
      default.** A switch, not a deletion, because of *when* the failure lands:
      arming converts every missed site into a hard failure at once on the
      post-turn commit path, and E1 is inert outside a root orchestrator. An
      operator arms it against a running deployment and can unset it; a merge
      would need a revert and a redeploy. Arming actively `--unset-all`s the
      entry an earlier boot wrote — the gitconfig is in the persistent
      credentials volume, so "stop writing it" would have been a no-op there.
- [ ] **Arm it in production, then delete both the switch and the write.**
      **planning#410.** This is the go/no-go planning#403 reserves for a human,
      and it must not happen before E1 has been *seen* working in production —
      which, as `plan.md` §4 now records, has not been established from here.
      Filed as its own issue because a flag with no expiry becomes permanent, and
      a permanent one is a supported way to turn the boundary back off.
- [x] **A lint, not a sentence, for the corrected `-c` claim.**
      `safe.directory` is honoured from the command line as well as from
      system/global config, so ShipIt's own code could silence the refusal E2
      arms. `git-hooks-guard-coverage.test.ts` fails the build when any
      orchestrator-side source outside `git-config.ts` passes the key to git or
      sets either `GIT_CONFIG_*` environment protocol. **planning#409** owns that
      rule and any widening of it; what landed here is the narrow version E2
      needed.
- [x] **Three defects in the above, found by independent review, all fixed.**
      Two were the scanner failing **open** on its likeliest future shapes — a
      `-C` carried in an argv variable, and a spread of an options object
      declared in another module — while the docs claimed unreadable input
      failed closed. The third: `GIT_CONFIG_PARAMETERS` re-grants exactly like
      `-c` (measured), simple-git guards only `GIT_CONFIG_COUNT`, and the lint's
      own pinning test had asserted a line naming `PARAMETERS` was *not* flagged
      — pinning the gap open. Each fix is verified by injecting the shape and
      watching the build go red, not by reading the regex.
- [x] **The fork handover keys on the same predicate as the drop.** It chowned
      to the *configured* worker uid while the drop resolves from the *tree's
      owner* — not the same question. A root orchestrator with the flag unset and
      a non-root-owned source, or a worker-uid migration, would drop and then
      EACCES on a root-owned destination. Also narrowed from the fork's session
      dir to its workspace dir, so the session uid cannot unlink the `uploads/`
      and `logs/` siblings.

## Known gaps, still open

- `mergeSession`'s fallback adds a **sibling session's** workspace as a local
  remote and fetches from it. Git refuses a foreign source on a local fetch, so
  it works only while every session shares one worker uid — a constraint
  per-session uids (planning#405) inherit. Found by the E2 audit; nothing to fix
  while the uid is shared. Reasoned from two measurements rather than observed
  end-to-end (`plan.md` §4).

*This branch also listed the `unreadable` propagation and the stderr
classifiers as open gaps. **planning#407 closed both** while it was in flight —
see the section above — so those bullets are gone rather than merged. A
checklist that reports fixed work as outstanding is the same defect as one that
reports outstanding work as fixed, and this feature has now had a stale claim in
both directions.*

## Do not write up as closed

planning#384 is **not** closed by this work. E1 removes root, the Docker socket
and the credential store *as a whole* from the payload's reach on the
tree-touching and remote paths. It does not remove `/credentials` (E3), and
cross-session workspace access remains (req 13).

E2 does not close it either, and "built" is not "fail-closed". Until
`SHIPIT_GIT_STRICT_OWNERSHIP=1` is set on a running deployment, git's ownership
check is still suppressed at runtime and a missed call site still runs as root
silently. What is in force today is the CI-side rule, which catches the shape in
review — a different guarantee, and a weaker one, than git refusing at runtime.
