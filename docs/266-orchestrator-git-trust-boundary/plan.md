---
issue: planning#384
title: Design — orchestrator-side git trust boundary
description: Five options for closing the .git route, their costs, the recommended one, and what it does not close.
---

# Design — orchestrator-side git trust boundary

Implements [requirements.md](./requirements.md). Requirements are cited as
`(req N)`.

**Status: E1 + E5-detect + E3 shipped; E2 built but not armed; E4 and the
per-session-uid follow-up outstanding.** All four open questions were answered on
2026-08-16 (`requirements.md` → Resolved questions). See
[checklist.md](./checklist.md) for exactly what landed and why each remaining
piece was split out — planning#403 (E2), planning#405 (per-session uids).

"Built but not armed" is E2's whole shape: the CI-side guard is on, and removing
`safe.directory=*` is behind `SHIPIT_GIT_STRICT_OWNERSHIP=1`, off by default.
Arming it is an operator decision to be taken against a running deployment after
E1 has been observed there — not something a merge should do. §2 (E2) says why.

**planning#384 is not closed by that work**, and the checklist says so in those
words. The drop removes root, the Docker socket and the credential store from
the payload's reach; it is not yet fail-closed (E2), a project's hooks still do
not fire (E4), and cross-session workspace access remains (req 13).

One correction to §5 from building it: the sequence says "convert the five raw
sites", and a count is the wrong unit. **Two shapes reach git.** The
`safeSimpleGit` shape is a choke point — deciding by *tree ownership* inside it
covers every call site including ones nobody has written yet, which is why the
implementation went there rather than threading a uid through call sites. The
raw `spawn` / `execFile` shape has no choke point at all, so each site is
converted by hand and E2's scanner is what turns an omission into a red build
instead of a silent root spawn.

An earlier version of this paragraph gave a number ("13"). Every gap found
since has been the shape that number did not count — `git-lfs.ts`'s
`git lfs pull`, `getFileBufferAtCommit`, the fork clone — so the number was not
merely stale, it pointed at the wrong set. Stated as a rule here, and enforced
mechanically by the scanner rule in planning#403.

## 1. The shape of the problem

Three files a session's workspace holds turn into execution somewhere ShipIt
trusts:

| # | File | Who executes it | Where that lands | Disposition |
|---|---|---|---|---|
| 1 | `.git/config`, `.git/info/attributes`, `.git/hooks/*` | git, run by the orchestrator process | **root in the orchestrator** — `/credentials`, `/var/run/docker.sock`, every session's `/workspace` | **this design** |
| 2 | `shipit.yaml` → `agent.install` | the session worker, `shell: true` (`install-controller.ts:532`), re-run on change by the watcher (`service-manager-setup.ts:1112-1127`) | the **session container**, at the session's own uid | out of scope — planning#400 |
| 3 | `docker-compose.yml` | the orchestrator, via the Docker socket (`service-manager.ts` — direct `docker compose` CLI invocations) | **the host**, via a `driver_opts` bind | out of scope — planning#386 |

Scope decided by the requester on 2026-08-16 (req 4, `requirements.md` → Resolved
questions, Q4): this feature is route 1 only, and each open route has an issue
rather than a mention.

Route 1 is the one whose fix is *relocation*. Route 3's fix is *validation*: the
product deliberately executes a project's compose file, so the answer is to
check what it declares, not to stop running it. Route 2 is the smallest — the
writer and the executor are the same uid for the npm case, so it is an
escalation only for a **plugin** container writing `shipit.yaml` to get code run
in the *agent's* container. Real, lesser, separately owned.

### Why route 1 cannot be fixed by naming keys (req 3)

Reproduced here, against git 2.39.5, with PR #2301's guard in force:

```
git -c core.hooksPath=/dev/null add -A     # ran filter.pwn.clean  → uid printed
git -c core.hooksPath=/dev/null status     # ran core.fsmonitor    → uid printed
git -c core.hooksPath=/dev/null st         # ran alias.st (!sh -c) → uid printed
```

`filter.<name>` is arbitrarily named, so the set is not enumerable; and several
of these keys are load-bearing (git-lfs *is* a `filter`), so they cannot be
blanket-disabled. `core.fsmonitor` firing on a plain `status` matters
specifically: `GitManager.autoCommit` calls `this.git.status()` at
`src/server/shared/git.ts:282`, **before** the conflict and clean-tree refusals.
A session that commits nothing at all still executes it.

There is no `GIT_CONFIG_LOCAL=/dev/null`. Repository config is always read.

### The mitigation git already has, and that ShipIt turned off

`git-config.ts:60-66` sets `safe.directory=*` in the orchestrator's global
config. Its own comment states why: with `SHIPIT_SESSION_WORKER_UID` set, each
workspace is owned by uid 1000 while the orchestrator runs git as root, and
CVE-2022-24765's ownership check refuses every such operation.

That check is exactly the control this feature wants. It is enumeration-free
(req 3) and fail-closed (req 7): git refuses *before* reading the repository's
config, so a call site nobody converted throws "detected dubious ownership"
rather than silently executing. The property the design leans on is that a
**repo-local** `safe.directory` is not honoured, so the untrusted side cannot
grant itself trust — measured while building E2, and it holds.

**Correction (2026-08-16, while building E2).** Earlier revisions of this
document, `requirements.md`, and `git-config.ts`'s own comment all added "and
never from `-c`". That is **wrong** for git 2.39.5.

State the rule, not the list. Git honours `safe.directory` from its **protected
configuration** — the system and global files, the command line, **and the
config environment protocols**. So: *anything ShipIt itself puts in a git
process's argv or environment can re-grant trust; only the repository's own
config cannot.* Measured with `GIT_TEST_ASSUME_DIFFERENT_OWNER=1` — see §4.

That phrasing is deliberate, and it is requirement 3's own lesson applied to
prose rather than to code. This document has already had an enumeration
falsified **twice**: once when `-c` turned out to be honoured after being
documented as never honoured, and again when `GIT_CONFIG_PARAMETERS` turned out
to exist beside the `GIT_CONFIG_COUNT` a corrected-but-still-closed list named.
A third vector will not announce itself either, so the sentence a reader
inherits has to be the rule that covers one, not a longer list to be falsified
next.

**It is not a hole, and the next reader should not read it as one.** The
boundary rests on the repo-local half, which holds: the untrusted side owns
`.git/config` and still cannot grant itself trust. A `-c` and an environment
variable come from **ShipIt's own argv and environment**, which the repository
never supplies.

What it inverts is a *maintenance* rule. ShipIt's own code could silence the
refusal E2 arms, one `-c safe.directory=*` at a time — most plausibly by someone
debugging "git suddenly refuses this path" the fastest way rather than the right
way. That is worth a lint rather than a sentence, so
`git-hooks-guard-coverage.test.ts` now fails the build when any orchestrator-side
source outside `git-config.ts` passes the key to git or sets either
`GIT_CONFIG_*` environment protocol. **planning#409** owns that rule and any
widening of it; the version here is the narrow one E2 needed.

**Git has TWO such environment protocols, and ShipIt's existing guard covers only
one.** Measured on git 2.39.5: `GIT_CONFIG_PARAMETERS="'safe.directory=*'"`
re-grants exactly like `-c`. simple-git's `blockUnsafeOperationsPlugin` does
**not** refuse it — `vulnerabilityCheck` flags `GIT_CONFIG_COUNT` and returns
nothing for `GIT_CONFIG_PARAMETERS`, verified by calling it directly.
`RepoGit.sanitizeGitEnv` strips both, but only on its own call chains; a raw
`spawn` forwarding `process.env` does not. Found by independent review, which
also noted that the first version of the lint's pinning test asserted a line
naming `GIT_CONFIG_PARAMETERS` was *not* flagged — pinning the gap open. Both
protocols are covered now.

The `*` was the right call for the problem it solved (docs/150 §7 activation).
It is the wrong shape now.

## 2. Options

### Option A — sanitize `.git/config` before each orchestrator git op

Rewrite or strip the dangerous keys immediately before running git.

- **Cost:** none structural; no deploy change.
- **Breaks:** nothing.
- **Why rejected:** fails req 3 (`filter.<any>.clean` is not enumerable, and the
  set grows with git) and is racy by construction — the untrusted side owns
  `.git/config` and the directory it sits in, so it can rewrite between the
  sanitize and the op. A control that can be won by a loop is not a boundary.

### Option B — make the control files unwritable in place

Root-own `.git/config`, `.git/info/`, `.git/hooks/`, and set the sticky bit on
`.git` so the session uid can still create `index.lock` but cannot unlink or
rename a root-owned file.

- **Cost:** moderate; no new processes, no containers.
- **Breaks:** in-container `git config --local` (the agent does run it),
  `git lfs install`, `git worktree add`, submodule setup — all write `.git/config`
  via lock+rename. `chownWorkspaceGitToSessionWorker` must learn a carve-out.
- **Why rejected:** it is a per-path allowlist of "which files inside `.git` does
  git execute", which is req 3 again in a different costume — a new git release
  that reads an executable path from a new location under `.git` re-opens it. It
  also breaks legitimate agent behaviour to buy a partial answer.

### Option C — run orchestrator-side git in a container

Either in the session worker container over the existing worker HTTP channel, or
in a short-lived executor container spawned from the same machinery as
`plugin-cli-run.ts`.

- **Cost:** highest isolation available — a mount namespace holding only that
  session's tree, no `/credentials`, no Docker socket.
- **Breaks:** **req 6.** The post-turn commit acquires a dependency on Docker
  and on a container being up. Invariant 2 exists precisely because the commit
  must run on paths where the agent process has died; a container-death path
  now has no commit at all, and uncommitted work has no reflog entry. Latency
  across 189 call sites, many of them read-only polls, is the secondary cost.
  A per-session warm executor mitigates latency but not availability.
- **Verdict:** the right *destination* if Q2 is answered (b), not the first
  step.

### Option D — exclude `.git` from the plugin mount

- **Why rejected:** fails req 2. It closes the plugin writer and leaves the npm
  `postinstall` writer, which is the larger blast radius. Explicitly the
  re-framing the requester ruled out.

### Option E — run git as the uid that owns the tree, and re-arm git's ownership check ✅

**Recommended.** Two halves that only work together:

**E1. Orchestrator-side git on a session workspace runs as the workspace's
owning uid, never as root.** simple-git supports this natively —
`spawnOptions: { uid, gid }` (`simple-git/dist/src/lib/plugins/spawn-options-plugin`,
typed in `dist/src/lib/types/index.d.ts`), so the change lands inside
`safeSimpleGit` and the `createGitManager` factory (`app-di.ts:437`) plus the
five raw sites listed in `requirements.md`. Repo-controlled config still
executes — but at the authority of the uid that wrote it, which is no
escalation (Q2).

**E2. Narrow `safe.directory=*`.** Once root no longer runs git on
worker-owned trees, the `*` has no remaining purpose, and removing it turns
every missed call site into a loud refusal instead of a silent execution
(req 7). This is the half that makes E robust against code nobody has written
yet. It is enumeration-free (req 3): the guard is "is this tree mine", not "is
this key dangerous".

*Built 2026-08-16 (planning#403), in two pieces with different risk.*

**E2a — the CI-side guard, on by default.**
`git-hooks-guard-coverage.test.ts` already failed the build when a raw git
spawn omitted `gitArgsWithHooksDisabled`; it now also fails when a raw git
spawn that names a working directory omits `gitSpawnOverridesForTree`. Two
carriers count as naming one — a `cwd` option and a `-C <dir>` argument — each
read through one level of in-file `const` indirection, including an object
literal's own spreads. Anything unresolvable counts as naming one, so the
unreadable case fails closed rather than passing quietly. This is what makes the
`safeSimpleGit` choke point complete: **the choke point covers every simple-git
caller, and a raw `spawn`/`execFile` bypasses it entirely** — which is how two
live sites survived E1.

*Hardened after independent review, which found the first version fail-**open**
in its two most likely future shapes: a `-C` carried in an argv variable, and a
spread of an options object declared in another module. Both were classified as
"no working directory" while the docs claimed unreadable input failed closed —
true then only for the identifier branch. Both are now resolved and both are
verified by injecting the shape and watching the build go red. The blind spots
that remain are named in `git-tree-uid.ts` rather than implied away: the
environment (`GIT_DIR`, `GIT_WORK_TREE`), the inherited process cwd, indirection
deeper than one in-file `const`, and a binary that is not a quoted `git`
literal.*

**E2b — removing the `*`, behind `SHIPIT_GIT_STRICT_OWNERSHIP=1`, off by
default.** The switch exists because of *when* the failure lands, not whether it
is correct. Arming it converts every missed site into a hard failure at once, on
the post-turn commit path, where uncommitted agent work has no reflog entry
(invariant 2) — and E1 is inert unless the process is root, so nothing outside a
production orchestrator can exercise it. A switch makes the decision an operator
one, taken against a running deployment and reversible by unsetting it, instead
of a merge that needs a revert and a redeploy to undo. Arming is not a no-op
write: the gitconfig lives in the persistent credentials volume, so it actively
`--unset-all`s the entry an earlier boot wrote. The intended end state is still
deletion — of both the switch and the write — once it has run armed in
production.

**What the audit found before arming it** (2026-08-16, planning#403). Three
orchestrator-side git paths could reach a session workspace without dropping,
and all three are fixed in the same change:

| Site | Shape | What armed E2 would have done |
|---|---|---|
| `git-lfs.ts` `runGit` | raw `spawn`, `cwd` = the workspace | `repoDeclaresLfs`'s `git grep` and `materializeLfsContent`'s `git lfs pull` refuse → **LFS provisioning breaks**, and until then both ran as root in an untrusted tree |
| `git.ts` `getFileBufferAtCommit` | raw `execFile`, `cwd` = the workspace | `git show <rev>:<path>` refuses → binary file-at-commit reads break |
| `session-fork-merge.ts:54` | `safeSimpleGit()` with **no `baseDir`**, `clone --local <session workspace>` | the clone refuses on the SOURCE repo → **fork breaks** (planning#407, first bullet) |

The fork site is the one the ownership predicate structurally could not see —
there is no `baseDir` to stat — and the reason it stayed unconverted is real:
dropping alone would leave the clone unable to create its root-owned destination
under `sessionsRoot`. The fix is to create the destination first, hand it to the
worker uid, and then clone with the drop resolved from the source tree.

Everything else is either root-owned (`/opt/shipit` in `build-id.ts`,
`services/updates.ts`, `services/shipit-source.ts`; the bare caches in
`repo-git.ts`, `plugin-generations.ts`) or has no local tree at all
(`marketplace.ts` clones from a URL). Those carry the drop call anyway, where
they name a directory, so the answer comes from the filesystem rather than from
an assumption that ages.

One residual, not fixed: `mergeSession`'s fallback adds a *sibling session's*
workspace as a local remote and fetches from it. Git refuses a foreign source on
a local fetch (measured), so this works only while every session shares one
worker uid. Per-session uids (planning#405) must handle it; it is recorded here
rather than in that issue's absence.

**E3. The credential the unprivileged git can reach must be no broader than
what the session container already holds.** This is not optional garnish, and
the file it turns on is worse than assumed. Verified here:
`setGlobalCredentialHelper` (`git-config.ts:240-245`) writes the **raw PAT
verbatim** into the orchestrator's `GIT_CONFIG_GLOBAL` as an inline
`!f() { echo "password=<token>"; …}` helper; `git-config.ts:28` creates
`/credentials` with `mkdirSync(dir, { recursive: true })` and **no mode**
(0755 under the default umask), and `git config --global` writes `.gitconfig`
0644. So the PAT is world-readable inside the orchestrator container. Today no
non-root process runs there; E1 would create one, which is exactly the trade E3
exists to refuse. Two parts: **tighten the file** (`/credentials` to 0700,
`.gitconfig` to 0600 — worth doing on its own merits, independently of this
feature), and **do not point the unprivileged git at it**. ShipIt already has
both pieces for the second: the *sanitized* container gitconfig
(`writeContainerGitConfig`, `git-config.ts:137`) and the brokering
`shipit-git-credential` helper backed by the **repo-scoped** credential path
(`services/github.ts:233`, docs/172 Gap 2-R / planning#81). Point the
unprivileged git at those. A repo-scoped token for the session's own repo is
something the session container can already obtain, so stealing it gains
nothing — which is what makes E1 sound rather than a credential downgrade in
disguise.

**Shipped (planning#404), and the shape changed twice on contact.** Two
mechanisms this section implies were measured and rejected before the third was
built; the measurements are worth keeping because both look right on paper.

- **Pointing the dropped git at the *sanitized container* config**
  (`writeContainerGitConfig`) needs a second `GIT_CONFIG_GLOBAL`, which is only
  expressible through the child environment — the mechanism E1 already tried and
  reverted, because simple-git's `env(object)` *assigns* the executor
  environment and any caller chaining `.env()` discards it while the uid drop
  stays in force. Nothing on the command line can name a global config file.
- **Pulling the token into the shared config by reference**
  (`include.path = <root-only file>`) fails harder, and measurably: against git
  2.39.5 an unreadable `include.path` is `fatal: unable to access …` on *every*
  git command, so the dropped git would not even run `status`. Its neighbour
  behaves in the opposite direction — an unreadable `GIT_CONFIG_GLOBAL` is
  *silently ignored* — which is what makes the pair worth recording rather than
  reasoning about.

So the shipped shape splits the **secret**, not the file. `.gitconfig` stays
one file, still shared with the worker uid, and now carries no secret: the PAT
moves to a root-only `/credentials/.git-credential-github` that the global
`credential.helper` `cat`s. Root reads it; the dropped git gets EACCES, the
helper prints nothing (stderr discarded, so E5-detect's classifiers see no new
noise), and git moves to the next helper — the repo-scoped one the operation
supplies for itself. That supply rides `-c` for its *shape*
(`credential.helper=` reset plus a URL-scoped replacement, which no `.env()`
can remove) and the process environment for its *secret*, on a simple-git
instance created and consumed inside one function so no caller exists to chain
`.env()` onto it. Neither half is sufficient alone, which is the whole content
of the trap E1 hit. Key files: `shared/git-remote-credential.ts`,
`GitManager.remoteGit`, `services/github.ts`'s
`resolveOrchestratorGitRemoteCredential`.

The independent review of that PR changed two more things, both worth keeping
as findings rather than as quiet edits:

- **The shared `.gitconfig` is now root-owned 0644, not worker-owned 0600.** E1
  handed it to the worker uid because it carried the inline PAT. With the secret
  gone, that ownership was the sharper half of the same problem: owning a file
  is permission to *write* it, and root-side git reads this one — so a payload
  could have written `credential.helper = !<attacker>` and had it execute **as
  root** on the next bare-cache fetch, which is requirement 1's exact worst case
  through requirement 3's exact key class. Neither that nor the `insteadOf`
  variant needs the file to be readable, so tightening the mode would not have
  helped; the writability was the whole bug.
- **A GitHub SSH-form origin follows the `insteadOf` rewrite.** `git-config.ts`
  rewrites `git@github.com:` and `ssh://git@github.com/` to HTTPS globally
  (docs/200), so git never speaks SSH for those and does ask for an HTTPS
  credential — but `getRemotes` reports the *pre-rewrite* spelling, so reading
  it literally declined a credential the operation then needed. That was a real
  availability regression against E1, and the only one the review found.

Two consequences worth stating, because they are the reason this is not a
downgrade and not an availability risk:

- **Every failure degrades to E1's behaviour, never to a failed operation.** No
  resolver, no drop, a non-HTTPS remote, a resolver that returns null or
  throws, a mint that exceeds its 5s deadline — each falls back to the git that
  would have run anyway. `getRepoScopedGitCredential` already falls back to the
  PAT when an App is not configured or a mint fails, so "the dropped git has no
  credential" is not a reachable state while the orchestrator holds a token.
- **The commit path never touches any of it.** `autoCommit` is local, so it
  acquires no network dependency (req 6). Pinned by a test that asserts the
  resolver is *not* consulted during a commit.

**E4. Let the project's hooks fire again on the session-workspace path**
(req 9, decided 2026-08-16). Once E1 lands, PR #2301's `core.hooksPath` override
is no longer doing security work there — it is only suppressing a project's own
`pre-commit` formatter on a commit the project would expect it to run on. Drop
it for git that runs at the session's uid. Two constraints come with it:

- **Keep the override everywhere orchestrator git still runs as root** — the
  bare cache, `/opt/shipit`, and anything E1 has not converted. There it is
  still defence in depth, and dropping it wholesale would re-open the route on
  exactly the paths that still matter.
- **A hook must not be able to lose the turn's work (req 10).** `git commit`
  exits non-zero when `pre-commit` fails, and never returns when it hangs;
  either way `autoCommit` throws and the turn's edits stay uncommitted with no
  reflog entry. So the commit needs a bounded hook attempt and a fallback:
  run it with hooks, and on a non-zero exit or a timeout, re-run with
  `--no-verify` and surface a persisted notice saying the hook failed and what
  it printed. The commit always lands; the user always learns the hook did not
  pass. Sequencing note — the retry must stay inside the same `postTurnStep`
  and before the drain, so invariants 1 and 3 are unaffected.

**E5. Compose services that declare an explicit `user:` (req 12).** This is the
one place where dropping root has a cost that is not purely security, and it was
raised in review rather than found by the design.

The setup, verified at `compose-generator.ts`: an egress-**contained** service is
*required* to declare a numeric, non-root `user:` that is neither reserved UID
(`:988-1002`), and ShipIt never overrides an explicit one — `:1387` fills in
`${workerUid}:${workerUid}` only when `svc.user === undefined`, and the comment
there says so outright ("we never override a deliberate choice"). Compose
services share the workspace. So a workspace can legitimately hold files, and
directories, owned by a uid that is neither root nor the session's.

Today root-side git ignores that entirely — root overwrites, unlinks and reads
regardless of ownership. Unprivileged git will not. **How it fails was measured,
not argued** — see the split below, which corrects an earlier draft of this
section.

### The measured behaviour (git 2.39.5)

Three cases, run here against throwaway repos. The parent session measured the
first two independently and got the same result; case A is the addition.

| Case | Setup | Outcome |
|---|---|---|
| **A** — tracked content under an unreadable **dir** | `pgdata/PG_VERSION` committed, then `pgdata` unreadable | `status` exit **0**, `add -A` exit **0**, commit says *"nothing to commit, working tree clean"*, exit 1. **HEAD keeps `pgdata/PG_VERSION`** — no spurious deletion is staged. |
| **B** — a real turn plus an unreadable NEW **dir** | `tracked.txt` edited (the turn's work), `pgdata/` new and unreadable | `status` exit **0**, `add -A` exit **0**, **commit exit 0**, `1 file changed`. `pgdata/` is simply **absent from HEAD**. The only signal is `warning: could not open directory 'pgdata/': Permission denied` on stderr. |
| **C** — tracked file in a non-writable dir | `locked/` mode 555, `locked/f.txt` tracked | `checkout` → `error: unable to unlink old 'locked/f.txt': Permission denied`, exit **255**. `reset --hard` → `fatal: Could not reset index file`, exit **128**. |
| **D** — unreadable **FILE** in a readable dir | `d/f.txt` mode 000, `other.txt` also edited by the turn | `status` exit **0**, listing **both** files modified — so every `autoCommit` refusal check passes. Then `add -A` → `error: open("d/f.txt"): Permission denied` / `error: unable to index file 'd/f.txt'` / `fatal: updating files failed`, exit **128**, and **nothing is staged at all — including `other.txt`**. |

Case D is the one a reader will not predict from the other rows, so it is worth
stating twice: **one unreadable file anywhere in the tree costs the entire
turn's commit**, not just its own path. `git add -A` is all-or-nothing here.

**What happens to that failure in ShipIt — exercised, not inferred.**
`autoCommit` calls `await this.git.add("-A")` at `shared/git.ts:299` with no
`try`/`catch`. Running the real `simple-git` from this repo's `node_modules`
against a case-D tree:

- `status()` **resolves**, `isClean()` is `false`, and `.modified` lists both
  files — confirming the refusal checks upstream of the `add` all pass.
- `add("-A")` **rejects** with a `GitError` carrying the three git error lines.
  The mechanism is `errorDetectionPlugin` (`simple-git/dist/cjs/index.js:1364-1374`),
  which turns a non-zero task exit into `new GitError(void 0, stderr)`.
- **`err.exitCode` is `undefined` on that object, by construction rather than by
  accident.** `errorDetectionPlugin` *receives* `exitCode` in its context and
  then builds `new GitError(void 0, error.toString("utf-8"))` — the code is
  available to the plugin and is simply not carried onto the thrown error. So a
  detector must match on the message text; one keyed on an exit code can never
  fire, and would look correct in review.

So D throws out of `autoCommit`, lands on the `postTurnStep` path, and is logged
and continued per invariant 3. Not silent — but its outcome is **total**: the
whole turn stays uncommitted in the working tree with only a log line, which is
the worst user-visible outcome of the four.

So the failure does not split in two. It splits in **three**, and the split is
by *what the user loses*, not by how loud git is:

- **"This commit is short."** Case B — an unreadable **directory**. Exit 0
  throughout, subtree omitted, the turn commits and reports success. Silent.
- **"This commit did not happen."** Case D — an unreadable **file**. `add`
  exits 128, nothing is staged including unrelated work, and the turn's entire
  diff stays in the working tree. Not silent, but total.
- **"This operation refused."** Case C — a worktree-mutating op against a
  non-writable directory. Already loud, already non-zero, and it fails *before*
  doing half the job.

Case A bounds the first of those in the one direction that matters: git does
**not** stage a deletion for tracked content it cannot read, so this can never
destroy already-committed work. What it loses is *new or changed* content under
the unreadable directory. Bad, but recoverable by retry once the permission is
fixed, rather than a rewrite of history. The same bound applies to D — nothing
was staged, so nothing was lost from history either; the turn's work is still on
disk.

### The archetype — why this is not exotic

There are two archetypes, one per failure class, and neither is exotic.

**For case B (unreadable directory): a bind-mounted database data directory.**
PostgreSQL *requires* mode `0700` on its data dir and refuses to start
otherwise; MySQL and Redis are similar. A service declaring `user: 999` with
`./pgdata:/var/lib/postgresql/data`, in a project that forgot to gitignore
`pgdata/`, produces it exactly.

**For case D (unreadable file): a secret-like file at a restrictive mode inside
an ordinary directory.** `./certs/server.key` at `0600` owned by `user: 999`, a
generated keypair, a socket's credential file. The directory is unremarkable and
readable; one file inside it is not.

The two behave differently under the habit that usually saves people. For B,
gitignoring the directory removes the collision entirely — git never descends
into an ignored directory, so there is nothing to fail on. For D that habit does
**not** help: ignoring `certs/` only helps if the ignore actually covers the one
restrictive file, and the common pattern is to ignore a directory whose *other*
contents are committed.

So the checkable statement is narrower than "foreign-uid content", but it is two
statements rather than one: a foreign-uid unreadable **directory** that is not
gitignored, or a foreign-uid unreadable **file** that is not gitignored. The
second is the one that costs a whole turn.

### The handling: surface it, do not restore root

Three reasons, and no new question, because req 12 and `CLAUDE.md` invariant 2
between them already decide it:

1. **It is a pre-existing limit, not a new one.** The agent runs as the session's
   uid too. A compose service writing content the agent cannot read or replace
   has already broken the agent — today ShipIt's root-side git papers over that
   at commit time, which hides the breakage rather than fixing it. E1 makes
   ShipIt's git exactly as capable as the agent, which is the correct
   relationship between the two.
2. **The realistic collision surface is narrow**, per the asymmetry above:
   gitignored service output — `dist/`, `.next/`, `node_modules/.vite`, and a
   correctly-ignored `pgdata/` — is invisible to git entirely.
3. **Both alternatives are worse.** "Chown the worktree to the session uid
   before each op" overrides the deliberate `user:` req 12 protects, and needs a
   root pass over the tree on the hot path. "Keep worktree-mutating ops as root"
   is the original bug, since every git op reads `.git/config`.

So requirement 12 is satisfied by changing **nothing** about compose: the session
starts, the services run, the explicit `user:` is still honoured.

### E5-detect — required, on the git side, and it must CLASSIFY (reqs 14, 15)

**This is not optional and it is not a compose-validation warning.** Three
things follow from the measurement.

**1. Detection must match two patterns, not one.** A detector keyed only on
`could not open directory` catches case B and misses case D completely — and D
is the one where the user loses the whole turn's commit. It must also match the
`add` failure: `unable to index file` / `open(...): Permission denied`. Note
from the exercised run that `GitError.exitCode` is `undefined`, so the match is
on message text; keying on an exit code produces a check that never fires.

**2. It must classify, not merely warn.** The two cases call for different words
and different urgency, and collapsing them into one "permission problem" notice
would be a worse outcome than either:

| | Trigger | git behaviour | What the user is told |
|---|---|---|---|
| **B** | unreadable **directory** | exit 0, stderr warning, subtree omitted | *"This commit is short."* The commit landed; these paths are missing from it. |
| **D** | unreadable **file** | `add` exit 128, **nothing staged** | *"This commit did not happen."* The turn's work — all of it — is still uncommitted in the working tree. |
| **C** | non-writable dir, worktree-mutating op | exit 255 / 128 | Already loud; needs the message improved, not detection. |

B is a persisted notice on a commit that exists. D is an error about a commit
that does not, and it must name the blocking path — otherwise the user is left
with a turn that visibly did work and a branch that has none of it. Both follow
the shape of the existing secret-scan and merged-push notices, which is the
pattern to copy.

**3. Compose-time validation cannot cover either, and offering it would be the
obvious wrong answer.** The restrictive mode is set by the **running service at
runtime** — postgres chmods its own data directory at initdb, a keygen step
writes `0600` — and is declared nowhere in the compose file. A static check of
`user:` versus the worker uid would miss both archetypes while looking like it
had handled them. A compose-time hint may still be worth having, but it must
never be counted as the mitigation.

The loud half still needs its own polish: the EACCES from case C should name the
path, its owner, and the service that most likely wrote it, not a bare errno.

**Costs and breakage, stated plainly:**

- **Residual: cross-session workspace access.** A payload that executes during
  an orchestrator git op runs at uid 1000 inside the orchestrator container,
  which mounts **every** session's workspace at `/workspace`, all owned by that
  same uid. Host root, the Docker socket and the credential store are closed;
  session-to-session is not. Q3 asks whether to fix this now with per-session
  uids or file it. **This is the honest limit of the recommendation and must not
  be described as "closed".**
- **Loopback surface.** The dropped-uid process shares a network namespace with
  the orchestrator's HTTP API. Any orchestrator endpoint that trusts "reached me
  over loopback" is reachable by the payload. Not audited here — see §4.
- **Root writes into `.git` must drop too.** `github-auth.ts:393` writes
  `credential.helper` into the workspace config with `execFileSync` as root. Left
  as-is it creates a root-owned `config` inside a 1000-owned `.git`, breaking the
  agent's in-container `git config`. It converts with the rest.
- **`chownWorkspaceGitToSessionWorker` becomes largely redundant** — git's own
  writes land at the right uid already. A per-turn tree walk goes away. Do not
  delete it blind: uploads and CI-fix logs are written by other root paths.
- **Local mode is a no-op.** `sessionWorkerUid()` returns `null` when
  `SHIPIT_SESSION_WORKER_UID` is unset (`session-worker-uid.ts:16-25`), which is
  the dogfood inner instance and every test. Gated exactly like docs/150 §7, so
  behaviour is byte-for-byte unchanged there.
- **git-lfs.** `git-lfs-blob.ts:151` spawns `git lfs smudge`; under E1 it runs
  unprivileged, and a hostile `filter.lfs.smudge` executes at the session's own
  uid. Acceptable under Q2(a), and unchanged in kind from today's in-container
  behaviour.

## 3. Check against the post-turn invariants (req 5)

`CLAUDE.md` lists **five**, not four. Checking the recommendation (E) against
each by name:

1. **The queue never drains before the finished turn's work is committed.**
   Unaffected. `tryDrain` still awaits the same local commit; E changes the uid
   of the spawned `git`, not the sequencing or the awaiting.
2. **Every terminal path runs the commit, including where the agent process
   dies.** Unaffected, and this is the reason E beats C: the commit stays an
   in-orchestrator child process with no dependency on the container or on
   Docker (req 6). All four `runCommitAndPr` entry points in `turn-executor.ts`
   behave identically.
3. **The commit must be UNSKIPPABLE — every preceding step runs through
   `postTurnStep`.** Unaffected structurally. E adds two new *failure modes*,
   and neither may be swallowed. First, a uid/permission mismatch surfaces as
   EACCES from git — an unprivileged git that cannot write `.git/index.lock`
   looks exactly like a clean tree if the error is discarded, so it needs a
   loud, distinct log line. Second, E4 re-enables project hooks, so a failing or
   hanging `pre-commit` can now fail the commit; req 10 is what forbids that,
   and the bounded-attempt-then-`--no-verify` fallback in E4 is what satisfies
   it. E4 is the only part of this design that *adds* a way for the commit to
   fail, which is why it carries its own requirement rather than riding along.

   **This invariant is the one E5 lands on hardest.** Invariant 3 exists because
   a commit that silently does less than it appears to is undetectable after the
   fact, and the measured status/add behaviour is exactly that: exit 0, a
   `warning:` on stderr that simple-git drops, and a subtree missing from the
   commit. E5-detect (reqs 14 and 15) is not a nicety attached to the compose
   story — it is what keeps this design compliant with invariant 3.

   The unreadable-**file** case (D) is invariant 3's other half. It *throws*
   rather than lying, so `postTurnStep` logs it and continues exactly as
   designed — but "logged and continued" is the correct handling for a step that
   was not the commit, and here it IS the commit. Invariant 3 keeps the process
   healthy; it does not tell the user their turn produced nothing. That is why
   req 15 exists as a requirement rather than as trust in the existing
   machinery.
4. **A branch whose work shipped under a different SHA returns to base via
   `shipit branch reset-to-base --force`, never a rebase.** Unaffected. Same git,
   same commands, different uid.
5. **Post-turn work is held on a lease, and the push does not live on the
   runner.** Unaffected. The push still runs from
   `services/auto-push-scheduler.ts` under `beginPostTurnWork`; E changes who the
   spawned `git push` runs as and which credential it carries (E3), not where
   the scheduler lives. E3 adds one thing *inside* that lease — a mint that can
   take up to 5s — which is why the deadline exists: the lease is
   deadline-bounded, and an unbounded network call under it could outlive it.

Option C fails 2 and 6 and is rejected on that basis. Options A, B and D satisfy
all five and fail the requirements instead.

## 4. What I could not verify

Stated as gaps, not as inherited guarantees (req 8, `CLAUDE.md` "Verify an
inherited guarantee at the source").

- **Verified, and worse than assumed: the orchestrator's global gitconfig was
  world-readable and held the raw PAT.** Read at `git-config.ts:240-245`
  (verbatim token in the inline helper) and `git-config.ts:28` (`mkdirSync` with
  no `mode`). I read the writers; I did not stat a live deployment, so the
  effective mode depended on the orchestrator's umask — the default gives 0755
  on the directory and 0644 on the file. Fixed: E1 took the directory to 0711
  and the config to 0600, and E3 took the token out of the config altogether.
- **E3's mechanism choice is measured, not reasoned.** Run here against git
  2.39.5: an unreadable `GIT_CONFIG_GLOBAL` is silently ignored (exit 0, no
  warning), an unreadable `include.path` is `fatal:` on every command, a
  `!f() { cat <file>; }; f` helper resolves normally for a reader and prints
  nothing for a non-reader, and an empty `-c credential.helper=` really does
  reset a helper list a global config has already populated. The last of those
  is the one the whole design rests on and is pinned by a test that runs real
  git, not a fake.
- **E3's dropped-uid branch is exercised only through its injection seam.** The
  *decision* (which ops resolve a credential, with what remote, and which must
  never) is covered against real git via `GitManagerOptions.gitTreeUidDeps`. The
  **setuid spawn itself is still not exercised** — same reason as everything
  else in this document: no root, `unshare -r` refused. So "a git running as uid
  1000 gets EACCES on the root-only credential file and continues to the next
  helper" is inferred from the kernel's permission check plus the measured
  helper behaviour, not observed end to end.
- **Not measured: how long a repo-scoped mint takes in production.** The 5s
  deadline on `resolveOrchestratorGitRemoteCredential` is chosen as "well past a
  healthy two-request mint, far short of a hang", not from a distribution. It
  fails toward the PAT, so a badly-chosen value costs tightness rather than
  availability — but nobody has watched it fire.
- **Verified: `RepoGit`'s bare cache is not mounted into any container.**
  `buildMounts` (`container-lifecycle.ts:297-519`) binds exactly the workspace,
  the per-session credentials dir, uploads (ro), scratch, session state, the
  plugin store (ro), the dep cache and the pnpm store — plus explicit host
  mounts for ops sessions only. The bare cache is not among them, and the four
  `addSessionMount` calls are all in `plugin-cli-run.ts`. Root-side git in the
  cache is therefore not a second instance of this bug. *(One thing that mount
  list does show and this design does not address: `perSessionCredentialsDir` is
  bound `rw` into the session container.)*
- **Not checked: whether any orchestrator HTTP endpoint authorizes on "came from
  loopback".** The residual in §2 depends on this. I did not audit
  `agent-ops-routes.ts` or the credential-broker route's auth.
- **The simple-git rejection is exercised, not inferred.** The parent session
  flagged its own claim here as an inference from "no try/catch plus documented
  behaviour". It was run: `add("-A")` against a case-D tree rejects with a
  `GitError` (`simple-git/dist/cjs/index.js:1364-1374`), and `status()` resolves
  first. The one detail neither of us predicted is that `err.exitCode` is
  `undefined` on that error, which is what a detector would most naturally key
  on.
- **E5 is now measured, and the measurement corrected it.** An earlier draft of
  this section asserted that the collision "fails visibly". That was reasoning,
  not measurement, and it was **wrong for the path that matters most** — the
  status/add path fails silently. The three cases in §2 were run here and
  independently by the parent session; the two we both ran agree. This is the
  clearest example in this document of why an unverified claim that a failure is
  *visible* is worse than no claim at all: it is precisely the claim that stops
  anyone from building detection.
- **Still not exercised: a genuinely foreign-OWNED directory.** Both
  measurements used mode bits on a self-owned directory (`chmod 000` / `555`),
  because neither session could create a foreign-owned one — no root, and
  `unshare -r` is refused in the session container ("Operation not permitted").
  The kernel check is the same one (a `0700` directory denies the "other" class,
  which is what a differently-owned git process falls into), so the outcome
  should be identical — but the ownership dimension itself is inferred, not
  observed.
- **Not surveyed: how common the archetype actually is.** The postgres-style
  `0700` data directory makes the case concrete, but no scan was done of real
  projects for a non-gitignored, foreign-uid, unreadable directory. That governs
  how *often* req 14's detection fires, not whether it is needed.
- **Not checked: git's behaviour on `receive-pack`/`upload-pack` config when a
  local path is used as a remote.** Irrelevant under E (no root-side git touches
  the untrusted tree at all), but it would matter for any variant that keeps a
  privileged half operating across the boundary.
- **Reproduced, not inherited:** the `filter.clean` / `core.fsmonitor` /
  `alias` executions in §1, and simple-git's `spawnOptions: {uid, gid}` support.
  Both were run/read here.
- **E2's refusals ARE measured — through git's own test hook, not through real
  ownership** (2026-08-16, planning#403). `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`
  makes git 2.39.5 treat every repository as foreign, which is the same code
  path a real foreign uid takes and the closest a rootless session container can
  get to it. What was run:

  | Command | Result |
  |---|---|
  | `git -C <foreign> status` / `rev-parse` / `grep` / `show` | `fatal: detected dubious ownership in repository at '<dir>'`, exit 128 |
  | `git clone --local <foreign> dest` | refuses on the **source**: `… at '<src>/.git'` |
  | `git -C <trusted> fetch <foreign-path>` | refuses on the source, exit 128 |
  | repo-local `safe.directory=*` | **not** honoured — the refusal stands |
  | `-c safe.directory=*`, and `GIT_CONFIG_COUNT`+`GIT_CONFIG_KEY_0` | **honoured** — corrects the claim in §1 |
  | global `safe.directory` naming only the worktree path | accepted; the gitdir does not need its own entry |

  What this does **not** show: that the refusal fires on the exact
  worktree-owned-but-gitdir-not combination, since the hook forces every path to
  look foreign at once. `chownWorktreeRecursive` chowns the workspace root
  itself and `chownGitMetadataRecursive` covers `.git`, so the two should not
  diverge — read, not observed.
- **`GIT_CONFIG_PARAMETERS` measured, and simple-git's blind spot with it**
  (2026-08-16, planning#403, found by review). `GIT_CONFIG_PARAMETERS="'safe.directory=*'"`
  re-grants like `-c` on git 2.39.5, and `@simple-git/argv-parser`'s
  `vulnerabilityCheck` returns `['allowUnsafeConfigEnvCount']` for
  `GIT_CONFIG_COUNT` and `[]` for `GIT_CONFIG_PARAMETERS` — called directly, not
  inferred from its docs.
- **Not verified: the sibling-workspace local fetch, as a real foreign fetch.**
  `mergeSession`'s fallback is reasoned from two measurements (a local
  `clone --local` from a foreign source is refused; a local fetch reads the
  source through `git-upload-pack`, which runs the same check) plus the
  `GIT_TEST_ASSUME_DIFFERENT_OWNER` fetch result. Nobody could produce a
  genuinely foreign-owned source here, so the composition is read, not observed.
- **Not verified: that the drop actually engages in production.** Everything in
  E1 hangs on the workspace root being owned by the worker uid at the moment
  `resolveGitTreeUid` stats it — a root-owned root means no drop, silently and
  with no error anywhere. That is exactly what "observe E1 in production" has to
  establish before E2b is armed, and it cannot be established from here.
- **Route 2 and route 3 were read, not exercised.** I read
  `install-controller.ts:521-540` (`spawn(command, { shell: true })`),
  `service-manager-setup.ts:1112-1127` (the unconditional re-run on an
  `agent.install` delta), and `service-manager.ts`'s header stating it invokes
  the `docker compose` CLI directly from the orchestrator. I did not build a
  working `driver_opts` proof; planning#386 did that analysis.

## 5. If the recommendation is accepted

All four questions are answered (2026-08-16), so this sequence is live.

Sequence:

1. Thread the owning uid through `safeSimpleGit` and `createGitManager`; convert
   the five raw sites. Gated on `sessionWorkerUid()`, so unset = today.
2. Point unprivileged git at a sanitized global config + the repo-scoped
   brokering helper (E3), and tighten `/credentials` to 0700 / `.gitconfig` to
   0600. **Shipped, with two corrections this step got wrong** (see E3 above):
   `/credentials` is **0711**, not 0700 — 0700 denies *traversal*, so the
   dropped git could not reach a file it owned — and there is no second
   config, because nothing on the command line can name a global config file
   and the environment is not a durable channel. The secret was split out of
   the one config instead.
3. Remove `safe.directory=*`; replace with nothing. Any survivor fails loudly.
   *Built as `SHIPIT_GIT_STRICT_OWNERSHIP=1`, off by default — see §2 (E2b) for
   why the removal is a switch an operator arms rather than something a merge
   does, and for the three sites the pre-arming audit found and fixed.*
4. Drop the `core.hooksPath` override on the session-workspace path only, and
   add the bounded-hook-then-`--no-verify` fallback with its persisted notice
   (E4, reqs 9 and 10). Last, because it is the only step that adds a way for
   the commit to fail — everything before it must be settled first.
5. Extend `git-hooks-guard-coverage.test.ts`'s idea — it already fails the build
   when a `git` process is spawned without `gitArgsWithHooksDisabled` — to also
   fail when a session-workspace git spawn carries no uid. Note that step 4
   narrows what that test asserts rather than removing it: the override must
   still be present on every root-side git spawn. *Done (E2a). The rule is
   "names a working directory", not "targets a session workspace": the scanner
   cannot tell whose tree a runtime path is, and `gitSpawnOverridesForTree`
   resolves to `{}` on a root-owned one, so demanding it everywhere costs
   nothing and removes the judgement call.*
6. **E5-detect (reqs 14 and 15) — not optional, and not a compose-time check.**
   Capture stderr from the auto-commit's `status` and `add -A` and match **two**
   patterns on message text (not exit code): `could not open directory` → *"this
   commit is short"*, a persisted notice naming the paths; `unable to index
   file` / `open(...): Permission denied` → *"this commit did not happen"*, a
   reported failure naming the blocking path. Then make the loud half legible
   too — the case-C EACCES should name the path, its owner and the likely
   service rather than a bare errno. Sequence this **with** step 1, not after
   it: step 1 is what introduces both paths, so shipping them apart leaves a
   window where a turn commits short, or does not commit at all, with no trace.
7. File the per-session-uid follow-up (req 13). The route-2 issue is already
   filed as planning#400.

The follow-up in step 7 inherits req 12: per-session uids change
`SHIPIT_SESSION_WORKER_UID` from one global value into an allocated one, so its
design has to say what happens when an allocated uid **collides with an explicit
`user:`** a project already declared, and it must never allocate
`EGRESS_RESOLVER_UID` (911) or `EGRESS_PROXY_UID` (912) — the netns firewall
exempts both by owner-match, so a workload at either uid escapes egress
containment (`session-worker-uid.ts:33-60`). That constraint belongs in the
follow-up's own requirements, and this note is the handoff.

## Key files

- `src/server/shared/git.ts` — `GitManager`; `autoCommit` at `:275`, `status()` at `:282`.
- `src/server/shared/git-hooks-guard.ts` — PR #2301's `core.hooksPath` guard and its own statement of what it does not cover.
- `src/server/orchestrator/app-di.ts:437` — the `createGitManager` seam.
- `src/server/orchestrator/git-config.ts:60-66` — `safe.directory=*`; `:137` `writeContainerGitConfig`.
- `src/server/orchestrator/session-worker-uid.ts` — uid gating and the `.git` chown.
- `src/server/orchestrator/ws-handlers/post-turn.ts:159` — the auto-commit call site.
- `src/server/orchestrator/services/github.ts:218,233` — credential broker, PAT and repo-scoped.
