# Checklist — orchestrator-side git trust boundary

Build sequence from [plan.md](./plan.md) §5. Requirements are cited as `(req N)`.

## Shipped

- [x] **E1 — orchestrator git on a session workspace runs as the tree's owner**
      (reqs 1, 2, 3, 11). `shared/git-tree-uid.ts` decides by **ownership**, the
      same fact git's own CVE-2022-24765 check tests, applied inside
      `safeSimpleGit` so every `createGitManager` call site and every raw
      `safeSimpleGit(workspaceDir)` site is covered without a hand-kept list —
      **that choke point is one of the two shapes that reach git**, and the
      other (a raw `spawn`/`execFile` of the binary) has no choke point, so it
      is converted site by site and held there by E2's scanner.
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
      dropped git needed *at the time* in order to push. One config, no
      override, nothing downstream can undo it. (E3 below removed that last
      reason: the config is still one file and still shared, and the token is
      no longer in it.)
- [x] **E5-detect (reqs 14, 15)** — the two permission states classified and
      surfaced as persisted transcript notices, with different words each:
      "this commit is short" for an unreadable **directory**, "this turn was NOT
      committed" for an unreadable **file**. Matched on message text, never on
      an exit code (`GitError.exitCode` is `undefined` by construction).
- [x] Tests: `git-tree-uid.test.ts` (the decision, via its injection seam),
      `git-unreadable.test.ts` (both permission states against **real git**), and
      post-turn tests for the two notices plus the secret-block interaction.
- [x] **E3 — the dropped-uid git no longer needs the PAT** (reqs 1, 11).
      **planning#404.** Two halves, and neither works alone:
      `setGlobalCredentialHelper` moves the token out of the worker-readable
      `.gitconfig` into a **root-only** `/credentials/.git-credential-github`
      that the global helper `cat`s — so the shared config now carries identity,
      `commit.gpgsign`, `url.insteadOf` and `safe.directory`, and no secret at
      all; and each **remote** op on a dropped-uid tree supplies its own
      credential, the same short-lived single-repo installation token the
      session container's own broker would hand the agent
      (`getRepoScopedGitCredential`), falling back to the PAT exactly where that
      function already does. A **GitHub SSH-form origin** resolves through the
      same `url.insteadOf` rewrite `git-config.ts` installs (docs/200), because
      git connects over HTTPS for those and reading the configured URL
      literally would decline a credential the operation then needs — an
      availability regression against E1 that the reviewer caught.
- [x] The mechanism survives a caller chaining `.env()`, which is what killed
      E1's first attempt: the **shape** rides `-c` (a `credential.helper=` reset
      plus a URL-scoped replacement — argv, so nothing downstream can remove
      it), and the **secret** rides the environment of a simple-git instance
      created and consumed inside one function, so no caller exists to clobber
      it. `shared/git-remote-credential.ts` (moved down from `repo-git.ts`,
      which now re-exports it, so the plugin-repo path and this one cannot
      drift), `GitManager.remoteGit`, `resolveOrchestratorGitRemoteCredential`.
- [x] **Two mechanisms measured and rejected first**, both of which read as
      obviously correct: a second `GIT_CONFIG_GLOBAL` (expressible only through
      the environment — E1's reverted attempt), and pulling the token in by
      `include.path` (against git 2.39.5 an unreadable include is `fatal:` on
      *every* command, while an unreadable `GIT_CONFIG_GLOBAL` is *silently
      ignored* — opposite behaviours from neighbouring features).
- [x] **Availability, checked against invariant 2 and req 6.** Every failure
      degrades to E1's behaviour rather than to a failed operation: no drop, a
      non-HTTPS remote, a resolver that declines or throws, or a mint that
      exceeds its 5s deadline all fall back to the git that would have run
      anyway, and `getRepoScopedGitCredential` already falls back to the PAT.
      The **commit** path never resolves a credential at all — pinned by a test.
- [x] The raw dropped-uid **network** sites carry the same credential, or they
      would silently degrade to anonymous on every private repo:
      `fetchAndResolveDefaultBranch` (claim + warm pool), `mergeSession`'s
      `origin` fetch, and — found by sweeping for network ops rather than for
      pushes — **`git lfs smudge`** (`git-lfs-blob.ts`), which authenticates its
      transfer through `git credential fill` exactly as a push does, and whose
      failure mode is an LFS asset rendering as pointer text in the diff viewer.
      Two sites need nothing: `session-fork-merge`'s post-clone fetch runs
      *before* `chownTreeToSessionWorker`, on a still-root-owned tree, and
      `git lfs pull` (`git-lfs.ts` `runGit`) does not drop at all — it is a raw
      spawn E1 never converted, so it still reads the root config.
- [x] Tests: `git-remote-credential.test.ts` (the `-c` bundle against **real
      git**, including that the empty reset really does clear an inherited
      helper — the property the whole design rests on),
      `git-remote-credential-wiring.test.ts` (which `GitManager` ops ask, via
      the `gitTreeUidDeps` seam), and the deadline / PAT-fallback cases in
      `github-credential.test.ts`.
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
- [x] **The precondition for arming: an exhaustive call-site audit and an
      operator runbook.** planning#410. [arming-runbook.md](./arming-runbook.md)
      — every orchestrator git executor with a verdict per site, the residual
      blind spots each with a reason, and the ordered arm/watch/rollback
      procedure with the real log strings per surface (post-turn commit,
      auto-push, LFS provisioning, fork, plugin activation). The audit is by
      *executor*, not by call site: `safeSimpleGit(dir)` is one verdict covering
      ~189 `createGitManager` callers, and the raw spawns are enumerated
      individually.
- [x] **The gap that audit found, fixed.** `plugin-generations.ts`'s
      `checkoutCommit` — the **inverse** of the shape the first audit hunted:
      not root git on a session tree but dropped git on a tree ShipIt itself
      left `root:root`. A bare `safeSimpleGit()` clone (root, no ownership
      predicate) into `<sessionDir>/state/plugins/…`, then
      `safeSimpleGit(targetDir)`, which drops to the session's uid. It fails
      today (`.git/config.lock` EACCESes) and would fail one step earlier once
      armed. Fixed the way `cloneFromCache` was: the object-aware
      `handWorkspaceBackToWorker` between the two calls.
- [x] **The claim that hid it, corrected at the source.** `safeSimpleGit`'s own
      comment said it "covers call sites nobody has written yet". It resolves the
      drop from `baseDir`, so it is complete for the tree a call site **reads**
      and blind to a tree it **creates** — a `clone` names its destination as an
      *argument*, never as `baseDir`. That is the general statement, and it tells
      the next reader which sites to distrust; "one missed site" does not. Every
      tree-creating site was then re-checked under the second question ("what
      owns the tree it writes into"), and the rest answer it correctly —
      `session-fork-merge.ts`, `templates.ts` ×2, `marketplace.ts`,
      `repo-git.ts`, `route-registry.ts`.
- [x] **A CI census for the shape, so the next one is not found by a human
      audit two cycles later.** Every bare `safeSimpleGit()` — the sharpest case
      of that blindness, no `baseDir` at all — is listed in
      `git-hooks-guard-coverage.test.ts` with what owns its destination. A
      tripwire for the literal shape, NOT a fail-closed guarantee over the
      class: review found the first version waved through `safeSimpleGit(undefined)`
      and `safeSimpleGit("")` (now caught), and a variable that is `undefined`
      at runtime reaches no regex at all (said in place, not papered over). Neither
      known instance of this bug was visible at runtime: the drop is gated on
      `getuid() === 0`, so the suite, the dogfood instance and a laptop pass
      either way. That is also why the runbook opens by telling an operator a
      green local run proves nothing about the armed path.
- [x] **Six findings from the independent review of that work, all addressed.**
      Three were the audit failing its own exhaustiveness claim: a raw spawn
      missing from the table (`repo-git.ts:387`), `updates.ts` counted at half
      its 10 sites, and a "grepped: none" for variable-binary spawns that was
      simply wrong — there are three (none of them git), and the grep behind the
      claim missed them because it required the binary on the *same line* as the
      call. Two were overclaims: the census was bypassable by spelling
      (`safeSimpleGit(undefined)`, `safeSimpleGit("")` — now caught, with the
      variable case named as out of reach rather than papered over), and the
      fix's docstring stated the shared-cache hardlink protection as settled
      when `plugin-install.ts:321` plain-chowns the same tree minutes later
      (**planning#417**, filed; not an arming blocker — git's ownership check
      reads the repository root, not object files). One was an operator
      correction: the auto-push failure's transcript copy is `emitMessage`,
      transport-only, so the runbook now points at the durable log ring.
- [ ] **Arm it in production, then delete both the switch and the write.**
      **planning#410.** This is the go/no-go planning#403 reserves for a human,
      and it must not happen before E1 has been *seen* working in production —
      which, as `plan.md` §4 now records, has not been established from here.
      Filed as its own issue because a flag with no expiry becomes permanent, and
      a permanent one is a supported way to turn the boundary back off.
- [x] **A lint, not a sentence, for the corrected `-c` claim.**
      `safe.directory` is honoured from git's *protected configuration*, which is
      everything ShipIt itself supplies — system/global files, the command line,
      the config env protocols — and never the repository's own config. So
      ShipIt's own code could silence the refusal E2 arms.
      `git-hooks-guard-coverage.test.ts` fails the build when any
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

## E1 follow-up — the first production failure, 2026-08-16

- [x] **`.git` is handed to the uid that will RUN git in it, not to the uid a
      variable names.** The first thing E1 broke in production, reported hours
      after it landed: the post-turn auto-commit died with
      `fatal: could not open '.git/COMMIT_EDITMSG': Permission denied`.

      `chownWorkspaceGitToSessionWorker` answered "who does the container run
      as" (`SHIPIT_SESSION_WORKER_UID`) while `safeSimpleGit` answered "who owns
      this tree" (`resolveGitTreeUid`) — two questions, one directory. Where they
      disagree the dropped git EACCESes inside a `.git` handed to someone else:
      with the **variable unset** while a drop still applies, nothing repairs a
      root-owned file in `.git` ever again; under a **worker-uid migration** the
      handback chowned `.git` *away* from the uid git runs as on every turn, so
      it could never converge. Both now resolve through one predicate,
      `resolveGitDirOwner` — the same correction this feature already made on the
      fork path, on the path that carries a turn's work.

      **This is the third time the two-predicate mistake has been made in
      docs/266** (fork handover, this, and the ordering half of planning#412).
      The shape is always the same: `resolveGitTreeUid` is not
      `SHIPIT_SESSION_WORKER_UID`, and code written before E1 assumed one uid
      existed. Any *remaining* site that pairs a drop with a chown should be read
      with that in mind rather than trusted.
- [x] **The repair also runs BEFORE the commit**, not only in the post-turn
      `finally`. Measured why it matters: git raises this at **commit** time,
      *after* `git add -A` has already succeeded (exit 128), so the turn's work is
      left **staged and uncommitted** — `CLAUDE.md` invariant 2's unrecoverable
      case. Post-hoc repair alone converges only on the next turn, and only if
      there is one. Costs a second bounded O(fanout) walk (~0.5 ms on this repo's
      own clone), inside the existing workspace lock.
- [x] **Tests, with the blind spot named.** `git-unreadable.test.ts` gained a
      real-git block for an unwritable `.git/COMMIT_EDITMSG`: every case in that
      file made a **worktree** path unreadable, so the entire `.git` dimension was
      blind by construction — which is how a failure on the commit path shipped
      unnoticed. It also pins that git's wording here
      (`could not open '<path>'`) is NOT the add-time classifier's shape
      (`open(<path>)`), which is why the user got the generic req-15 notice.
      `session-worker-uid.test.ts` covers the predicate through the injection
      seam **and the wiring** — the decision tests alone would pass against a
      `chownWorkspaceGitToSessionWorker` that still called `sessionWorkerUid()`,
      which is precisely the defect being fixed. Verified red without the fix
      (`[1500,1500]` where `[1000,100]` is required), not merely green with it.
- [x] **Five things the independent review caught, all fixed.** (1) The
      docstring's safety argument for session setup was **false at the source** —
      it claimed a fresh clone is still root-owned at handback time, when
      `repo-git.ts:312` chowns the whole clone before any handback runs. The
      conclusion held for a different reason, which is the worse kind of wrong:
      it is the reasoning a future edit leans on. Restated as the invariant (at
      every handback site the tree's owner is either the configured uid or root,
      and both answers are unchanged) with the false version called out rather
      than quietly deleted. (2) **The fix's whole observable effect was
      untested** — delete the pre-commit call and every new test still passed,
      because the ownership tests pin the *decision* and not the *ordering*.
      `post-turn.test.ts` now pins it in both directions, including the throwing
      path, and was verified red without the call. (3) `handWorkspaceBackToWorker`
      still early-returned on the configured uid, so the `.git` repair was
      skipped on rebase / pre-turn-reset / claim / fork-merge / container
      re-create in exactly the case the post-turn path had just been fixed for —
      the same two-predicate mismatch, one level up. The two halves are now gated
      separately, with the reason stated. (4) The real gid was asserted on one
      metadata file only, leaving a `uid`-for-`gid` typo on the object-store and
      LFS branches green. (5) A pre-existing test named "no-op when the flag is
      unset" now describes a contract that no longer exists and passes only
      because the suite runs unprivileged.
- **Not verified, same limit as the rest of E1:** the setuid spawn and genuine
  foreign ownership. The states are produced with mode bits on self-owned files,
  because a session container has no root and `unshare -r` is refused. What is
  measured is the failure mechanism and the decision; what is inferred is that
  the chown reaches it in production.

  Named precisely, because the review sharpened it: the substitution reproduces
  the **failure** faithfully (`open(O_WRONLY)` on a `0444` file is refused for
  its owner exactly as for a stranger) but not the **recovery** — the test chmods
  where production must chown. So the two halves of the remedy are each tested
  and their *combination* is not. That gap needs root to close and is the same
  one `plan.md` §4 already owns.

## Known gaps, still open

- **`git lfs pull` drops uid, but the workspace is handed back to the worker
  uid AFTER it runs** — a live regression on `main`, owned by **planning#412**,
  which carries the four call sites, the two now-false comments that justified
  the ordering, and the measurement that settles it. Raised from this branch,
  which predicted the shape before E2's conversion landed; the write-up lives on
  the issue and deliberately not here, so it has one owner rather than two.
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
and the credential store from the payload's reach on the tree-touching and
remote paths, and E3 removes the PAT from what the dropped uid can read at all
— so requirement 1's named credential store is now out of reach rather than
partly in it.

E2 does not close it either, and **"built" is not "fail-closed"**. Until
`SHIPIT_GIT_STRICT_OWNERSHIP=1` is set on a running deployment, git's ownership
check is still suppressed at runtime and a missed call site still runs as root
silently. What is in force today is the CI-side rule, which catches the shape in
review — a different guarantee, and a weaker one, than git refusing at runtime.

A project's own hooks still do not fire (E4, reqs 9 and 10). Cross-session
workspace access at the shared uid remains (req 13, planning#405).

**Correction, 2026-08-16.** This section used to end "nothing here has been
exercised with a real uid drop". That is no longer true, and it was the stale
claim that mattered most: E1 *has* now run against a production orchestrator,
and the first thing it did was fail — the `.git/COMMIT_EDITMSG` case in the E1
follow-up section above. Read that as the correction to `plan.md` §4's "not
established from here", not as a contradiction of it: what was missing was
production exposure, and the exposure produced a defect rather than a
confirmation. E2's go/no-go (planning#410) should weigh that, because arming
`SHIPIT_GIT_STRICT_OWNERSHIP=1` converts this class of mismatch from an EACCES on
one path into a hard refusal on every one.
