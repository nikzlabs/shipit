---
issue: planning#384
title: Design — orchestrator-side git trust boundary
description: Five options for closing the .git route, their costs, the recommended one, and what it does not close.
---

# Design — orchestrator-side git trust boundary

Implements [requirements.md](./requirements.md). Requirements are cited as
`(req N)`.

**Status: design only.** Open questions Q1–Q4 in `requirements.md` are
unresolved, so no implementation code has been written (`CLAUDE.md`,
requirements discipline step 2).

## 1. The shape of the problem

Three files a session's workspace holds turn into execution somewhere ShipIt
trusts:

| # | File | Who executes it | Where that lands | Disposition |
|---|---|---|---|---|
| 1 | `.git/config`, `.git/info/attributes`, `.git/hooks/*` | git, run by the orchestrator process | **root in the orchestrator** — `/credentials`, `/var/run/docker.sock`, every session's `/workspace` | **this design** |
| 2 | `shipit.yaml` → `agent.install` | the session worker, `shell: true` (`install-controller.ts:532`), re-run on change by the watcher (`service-manager-setup.ts:1112-1127`) | the **session container**, at the session's own uid | out of scope — needs its own issue (req 4, Q4) |
| 3 | `docker-compose.yml` | the orchestrator, via the Docker socket (`service-manager.ts` — direct `docker compose` CLI invocations) | **the host**, via a `driver_opts` bind | out of scope — planning#386 (req 4, Q4) |

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
rather than silently executing. The same comment records the property the design
leans on — `safe.directory` is honoured **only** from system/global config,
never from a repo-local one and never from `-c`, so the untrusted side cannot
grant itself trust.

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

**Keep PR #2301's `core.hooksPath` guard.** It costs nothing and it stops a
project hook from firing on an operation the user did not ask for. It is
defence in depth under E, not the boundary — that is the reading PR #2301 warned
against.

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
   `postTurnStep`.** Unaffected structurally. E adds one new *failure mode*: a
   uid/permission mismatch surfaces as EACCES from git rather than a silent
   no-op. That must be a loud, distinct log line, not a swallowed catch — an
   unprivileged git that cannot write `.git/index.lock` looks exactly like a
   clean tree if the error is discarded.
4. **A branch whose work shipped under a different SHA returns to base via
   `shipit branch reset-to-base --force`, never a rebase.** Unaffected. Same git,
   same commands, different uid.
5. **Post-turn work is held on a lease, and the push does not live on the
   runner.** Unaffected. The push still runs from
   `services/auto-push-scheduler.ts` under `beginPostTurnWork`; E changes who the
   spawned `git push` runs as and which gitconfig it reads (E3), not where the
   scheduler lives.

Option C fails 2 and 6 and is rejected on that basis. Options A, B and D satisfy
all five and fail the requirements instead.

## 4. What I could not verify

Stated as gaps, not as inherited guarantees (req 8, `CLAUDE.md` "Verify an
inherited guarantee at the source").

- **Verified, and worse than assumed: the orchestrator's global gitconfig is
  world-readable and holds the raw PAT.** Read at `git-config.ts:240-245`
  (verbatim token in the inline helper) and `git-config.ts:28` (`mkdirSync` with
  no `mode`). I read the writers; I did not stat a live deployment, so the
  effective mode depends on the orchestrator's umask — the default gives 0755 on
  the directory and 0644 on the file. Folded into E3.
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
- **Not checked: git's behaviour on `receive-pack`/`upload-pack` config when a
  local path is used as a remote.** Irrelevant under E (no root-side git touches
  the untrusted tree at all), but it would matter for any variant that keeps a
  privileged half operating across the boundary.
- **Reproduced, not inherited:** the `filter.clean` / `core.fsmonitor` /
  `alias` executions in §1, and simple-git's `spawnOptions: {uid, gid}` support.
  Both were run/read here.
- **Route 2 and route 3 were read, not exercised.** I read
  `install-controller.ts:521-540` (`spawn(command, { shell: true })`),
  `service-manager-setup.ts:1112-1127` (the unconditional re-run on an
  `agent.install` delta), and `service-manager.ts`'s header stating it invokes
  the `docker compose` CLI directly from the orchestrator. I did not build a
  working `driver_opts` proof; planning#386 did that analysis.

## 5. If the recommendation is accepted

Sequence, once Q1–Q4 are answered:

1. Thread the owning uid through `safeSimpleGit` and `createGitManager`; convert
   the five raw sites. Gated on `sessionWorkerUid()`, so unset = today.
2. Point unprivileged git at a sanitized global config + the repo-scoped
   brokering helper (E3).
3. Remove `safe.directory=*`; replace with nothing. Any survivor fails loudly.
4. Extend `git-hooks-guard-coverage.test.ts`'s idea — it already fails the build
   when a `git` process is spawned without `gitArgsWithHooksDisabled` — to also
   fail when a session-workspace git spawn carries no uid.
5. File the per-session-uid follow-up (Q3) and the route-2 issue (Q4).

## Key files

- `src/server/shared/git.ts` — `GitManager`; `autoCommit` at `:275`, `status()` at `:282`.
- `src/server/shared/git-hooks-guard.ts` — PR #2301's `core.hooksPath` guard and its own statement of what it does not cover.
- `src/server/orchestrator/app-di.ts:437` — the `createGitManager` seam.
- `src/server/orchestrator/git-config.ts:60-66` — `safe.directory=*`; `:137` `writeContainerGitConfig`.
- `src/server/orchestrator/session-worker-uid.ts` — uid gating and the `.git` chown.
- `src/server/orchestrator/ws-handlers/post-turn.ts:159` — the auto-commit call site.
- `src/server/orchestrator/services/github.ts:218,233` — credential broker, PAT and repo-scoped.
