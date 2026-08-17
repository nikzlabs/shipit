---
issue: nikzlabs/shipit#1729
title: Git LFS support
description: Install git-lfs in every image and materialize LFS content during session provisioning, so tracked assets aren't checked out as pointer stubs.
---

# Git LFS support

## The problem

Neither the orchestrator image nor the session-worker image shipped the
`git-lfs` binary. A repository that tracks assets with Git LFS stores ~130-byte
*pointer stubs* in the git object database — the real bytes live on the LFS
server and are fetched separately by the LFS filters. With no `git-lfs`, those
filters never run, so every tracked asset checks out as its stub.

Reported in nikzlabs/shipit#1729: a session on an asset-heavy repo checked out
~3,000 images and audio files as 130-byte stubs, with no `.git/lfs` cache
anywhere. The dev server ran and the UI rendered — but no artwork appeared and
audio playback failed with `Unable to decode audio data`.

The damaging part is the *silence*. Nothing reported a failure, and every
plausible-looking culprit is wrong: the reporter first blamed sandbox networking
and headless-browser codec limits. Neither was involved; the files simply had no
content. Anyone debugging a preview in an LFS repo loses the same time.

## The design

Three moving parts: install the binary, configure it differently per image role,
and materialize content explicitly at the end of provisioning — plus, since
nikzlabs/shipit#2349, re-materialize it after every *later* orchestrator-side
rewrite of a live session's worktree (§6).

### 1. `git-lfs` in every image

| Image | Install | Why |
|---|---|---|
| `Dockerfile.session-worker.prod` / `.dev` | `git lfs install --system --skip-repo` | Full LFS behaviour inside the container: `git checkout` smudges real content, committing a new asset cleans it into a pointer. |
| `Dockerfile.prod` / `.dev` / `.dogfood` (orchestrator) | `git lfs install --system --skip-repo --skip-smudge` | Clean filter on, smudge filter off — see below. |

`Dockerfile.session-worker.docker` layers on the worker base, so it inherits.

`--system` (i.e. `/etc/gitconfig`) is the only workable target. The container's
`GIT_CONFIG_GLOBAL` points at `/credentials/.gitconfig`, which is mounted
**read-only**, so a runtime `git lfs install` would fail. System config is read
alongside `GIT_CONFIG_GLOBAL`, so baking the filters at build time is what makes
LFS work at all inside a session.

### 2. Why the orchestrator skips smudge — and must not skip clean

This asymmetry is the load-bearing decision, and it's easy to get backwards in
both directions.

**Clean must stay on.** `postTurnCommit` runs *orchestrator-side* against the
session's bind-mounted workspace (`ws-handlers/post-turn.ts`). Without the clean
filter, its `git add -A` would commit **raw binaries** into an LFS repo instead
of pointers — silently corrupting the repository. So the orchestrator cannot
simply skip LFS configuration.

**Smudge must stay off.** `RepoGit.cloneFromCache` runs `git clone --local` from
the bare cache, whose `origin` at that moment is a **local filesystem path**
(`origin` is only reset to the real remote *after* the clone). With smudge
active, git would invoke `git-lfs smudge` per file against an LFS endpoint
derived from that path — which is not an LFS server — and because
`git lfs install` sets `filter.lfs.required = true`, a smudge failure **fails the
checkout**. Naively enabling LFS in the orchestrator would therefore break
cloning outright for every LFS repo: strictly worse than the stubs it set out to
fix. Skipping smudge also beats it on throughput — one batched transfer instead
of a serial per-file download.

### 3. Explicit materialization

`src/server/orchestrator/git-lfs.ts` does the work:

- `repoDeclaresLfs(dir, ref)` — greps the **committed** `.gitattributes` files
  for `filter=lfs` (`git grep -l -e filter=lfs HEAD -- '*.gitattributes'`).
  Chosen over `git lfs ls-files` for three reasons: it works *without* the
  binary (so we can still warn when it's missing — the whole point), it's one
  ref-scoped grep instead of a full tree walk, and the same call works against a
  bare cache and a checked-out workspace alike. The `*.gitattributes` pathspec
  catches nested declarations, since git pathspec globs cross `/`.
- `materializeLfsContent(dir)` — runs a single batched `git lfs pull`, returning
  a status (`not-an-lfs-repo` / `materialized` / `binary-missing` / `disabled` /
  `failed`) with an actionable `warning` on every non-happy outcome.
- `materializeLfsWithWarning(dir, label, warn)` — the wrapper every call site
  uses. Routes warnings to the caller's sink and swallows throws: LFS is an
  asset-quality concern, and no failure in it may take down session provisioning.

**Ordering constraints** (all three matter):

1. **After** the final worktree-materializing `git checkout -b` — an earlier pull
   is overwritten by the pointers that checkout re-writes.
2. **After** `configureGitCredentials` — a private repo's LFS endpoint needs the
   helper.
3. **Before** `handWorkspaceBackToWorker` / `chownTreeToSessionWorker` — the pull
   writes as root, so the chown has to come last or the agent can't edit the
   files.

Call sites, all at that same point in their path:

| Path | File |
|---|---|
| Warm-pool provisioning (off the critical path) | `warm-pool-manager.ts` |
| Claim slow-clone (on the user's critical path) | `services/claim-session.ts` |
| Warm-session reuse — `rollback` is a `reset --hard`, which re-writes stubs | `services/claim-session.ts` (`refreshCloneToLatestMain`) |
| Unarchive + workspace restore | `services/session.ts` (`materializeLfsAndChown`) |

The warm-reuse case is cheap despite looking redundant: the objects are already
in `.git/lfs`, so `git lfs pull` degenerates to a local checkout with no network
transfer.

### 4. Never fail silently

The issue's own framing — *"silent failure is the worst outcome here"* — drives
the diagnostics. Any outcome that leaves stubs on disk produces a warning:

- Provisioning paths broadcast it over SSE (`sseBroadcast("error", …)`), so it
  surfaces as a toast rather than only in `journalctl`.
- Restore paths have no broadcaster in scope and log instead.
- `src/server/shipit-docs/environment.md` gains a **Git LFS** section teaching the
  agent to run `head -c 120 <asset>` and look for the
  `git-lfs.github.com/spec/v1` header *before* blaming networking or codecs —
  the exact misdiagnosis the reporter hit.

### 5. Egress

`github-cloud.s3.amazonaws.com` is added to `EGRESS_DEFAULT_ALLOWLIST` and to
`EGRESS_GITHUB_LIFELINE_HOSTS`. GitHub's LFS
batch API hands back signed URLs on either `objects.githubusercontent.com`
(already allowed) or that S3 bucket, depending on repo and API vintage. It's
needed for `git lfs pull` *and* `git lfs push` — a Network-off sandbox with the
`git` capability would otherwise push refs pointing at LFS objects the remote
never received. Added as an **exact** host, never `.amazonaws.com`: the bare
suffix would open every S3 bucket on the internet as an exfil target.

### 6. Later tree rewrites, not just provisioning

Provisioning is not the only place the orchestrator writes a session's worktree,
and the original design covered only that half. Reported in
nikzlabs/shipit#2349: a session was rebased onto its base while idle, and the one
LFS-tracked image the rebase touched came back as 130 bytes of pointer text.

The reporter's evidence is what makes it a *rewrite-path* bug rather than a repo
or environment one, and each half is worth keeping:

- **Only the paths the rewrite touched went stale.** Four other LFS-tracked
  images elsewhere in the repo still held their real content.
- The repo's LFS config was correct and complete, and no `GIT_LFS_SKIP_SMUDGE`
  was set anywhere in the session.
- Nothing was lost — the object was in `.git/lfs/objects` *and* on the remote.
  Only the working copy was wrong.

That is exactly what §2's smudge asymmetry predicts. The rewrite runs the
**orchestrator's** git, which has smudge disabled by design, so it re-materializes
every path it touched from the object database — which for a tracked asset holds
the pointer, not the bytes.

What makes it worse than a missing file is that nothing *anywhere* says so. The
pointer in the index never changed, so `git status` reports the tree **clean**;
the agent then hands 130 bytes of text to an image, font, texture, or model
decoder, and the failure surfaces as corrupted rendering some distance from the
cause. The reporter found it only because a tool that digests its own outputs
compared the file against a recorded digest and reported it as hand-edited.

**The fix** is `restoreLfsAfterTreeRewrite(dir, operation, warn?)` in
`git-lfs.ts` — a thin, named wrapper over `materializeLfsWithWarning` that gives
the duty one place to be documented and one symbol to grep for. Every
orchestrator-side path that rewrites an existing session's worktree calls it:

| Path | File | Rewrite |
|---|---|---|
| Sync / rebase / auto-conflict-resolve | `services/rebase-driver.ts` | `git rebase`, `--continue`, `--abort` |
| Merged-branch auto-reset (pre-turn) | `services/pre-turn-reset.ts` | `reset --hard origin/<base>` |
| `shipit branch reset-to-base` | `services/pre-turn-reset.ts` | same |
| Fork-merge into the active session | `services/session-fork-merge.ts` | `git merge` (and its abort) |
| Child spawn pinned to an explicit base | `services/child-sessions.ts` | `reset --hard <base>` |
| Chat **rewind** and its undo | `ws-handlers/rollback-handlers.ts` | `rollback` = `reset --hard` |
| `POST /git/rollback`, `POST /git/pull`, `POST /git/rebase/abort` | `api-routes-git.ts` | `reset --hard`, merge, abort |
| `shipit release prepare` | `services/release-prepare.ts` | `checkout -B`, `cherry-pick`, merge-override |

**That table is enumerated by a test, not by hand.**
`git-lfs-rewrite-coverage.test.ts` scans the orchestrator for the worktree-
rewriting `GitManager` calls and raw argv forms, and fails naming any file that
rewrites without restoring — with an allowlist that must carry a reason and may
not go stale. The rule it encodes is the one `git-tree-uid.ts` states for its own
problem: *a hand-converted list is stale the moment someone adds one more, and
the failure is silent.* Not hypothetical — the first cut of this fix enumerated
the first five rows by hand, and an independent review found the last three plus
the fork gap below. Every one was the reported bug verbatim.

**Adjacent gap closed at the same time:** `forkSession` never materialized LFS at
all, so forking an LFS repo produced a workspace where *every* asset was a stub —
the original docs/231 bug in full. Two causes, both in that function:
`git clone --local` does not carry `.git/lfs` (docs/232), and the `checkout -b`
runs through the smudge-disabled git. It now makes the same
`materializeLfsWithWarning` call every other provisioning path does.

Three properties of those call sites are load-bearing, and each is pinned by a
test:

1. **They restore on the FAILURE paths too.** `git rebase --abort` and the merge
   abort check the pre-rewrite tree back out through the same filter-less git, so
   a sync that failed leaves stubs just as a sync that succeeded does. That's why
   the rebase driver restores in its `finally` (guarded by a flag set just before
   the first worktree-writing op) rather than on its two success paths.
2. **They never restore mid-conflict.** A conflicted LFS path is pointer *text*
   carrying conflict markers; smudging it would destroy the very conflict the
   agent is being asked to resolve. The restore waits for a settled tree.
3. **They restore before the queue drains and before the handback.** A turn
   queued during a sync must not start against the stubs — that is the reported
   failure — and the ownership chown still has to have the last write. The
   auto-resolve **timeout** path needs its own restore to get this: its teardown
   aborts the rebase and then drains immediately, while the flow is still waiting
   for the killed resolution turn to settle, so the flow's `finally` alone lands
   *after* the queued turn has started. A test drives the timeout and asserts the
   order.

The restore is **serialized per workspace** (`git-lfs.ts`) and runs under the
CLAUDE.md invariant-5 **post-turn hold** on the rebase path. Both follow from
where it sits: the timeout path deliberately restores twice against one clone,
and `git lfs checkout` writes the working file *in place* (measured against
git-lfs 3.3.0 — same inode before and after, mode preserved), so two writers
interleave inside one asset rather than one simply losing; and the restore runs
with `running` already false on a path that fires precisely on idle, viewerless
sessions, which is exactly when the idle enforcer would otherwise destroy the
container mid-pull.

That in-place write is also why an ownership argument reasoned from `git checkout`
does not transfer. `git checkout` unlinks and recreates, so the *directory's*
permission governs; git-lfs needs the *file*, and gets away with a read-only one
by chmod'ing around the write — which only its owner may do. A same-owner `0444`
file therefore succeeds and proves nothing about a root-owned file under a
dropped uid, which is EACCES. In the shipped configuration the question doesn't
arise: docs/266 makes the rewrite drop to the tree's owner, so the files are
worker-owned and `runGit` drops to the same uid.

**A neighbouring guarantee this broke, and then fixed.** The restore's few
milliseconds widened the window in which the sync flow still holds the session,
and that turned an intermittent hole deterministic: a message sent while the sync
settles is QUEUED, `releaseQueuedTurn` releases it onto `runner.dispatch`, and the
docs/221 "your working tree was rewritten" notice was consumed only on the
INTERACTIVE path. So the turn most likely to need it never got it. docs/221 had
listed the dispatched drain as a deliberate non-goal on the reasoning that
"nothing is lost — the user's next interactive turn still delivers it", which is
true of the database row and false of the guarantee: that queued message IS the
user's next turn, and it runs dispatched. `dispatched-turn.ts` now drains it too,
and re-parks it if that turn dies before the agent sees the prompt — read-and-clear
is what makes delivery exactly-once and what would otherwise let a spawn failure
burn the only warning that the tree was rewritten. The doc's non-goal is struck
through with the correction.

**Where a failed restore is reported.** The rebase path has an SSE toast. The
pre-turn reset has no toast in scope, so a restore that leaves stubs appends a
sentence to the reset's **agent prefix** — the issue's own fallback ask, aimed at
the one party about to read those files. The remaining sites log.

It runs `git lfs pull`, not `git lfs checkout`. A checkout would have been enough
for the reported case (the object was already local), but a sync onto a moved
base can introduce assets this clone has never seen, and `git lfs checkout`
leaves those as stubs while exiting 0. When every object is already local the
pull makes no network call, so the common case stays cheap; a repo that doesn't
use LFS costs one `git grep`.

The auto-resolve **timeout** teardown is the one deliberate omission: killing the
agent makes the resolution turn reject, so `runRebaseFlow`'s own `finally`
aborts and restores against the same clone. A second pull there would race that
one for no added coverage.

### 7. The pull needs a credential of its own (planning#426)

Two earlier changes stacked into a silent regression that the planning#410
production soak surfaced as **46 occurrences** of
`fatal: could not read Username for 'https://github.com'`:

- **docs/266-orchestrator-git-trust-boundary E1** made orchestrator-side git on a
  session workspace run as that workspace's uid. `git-lfs.ts`'s `runGit` spreads
  `gitSpawnOverridesForTree`, so the LFS pull drops too.
- **E3** moved the PAT out of the worker-readable gitconfig into a **root-only**
  file the global helper `cat`s. A dropped-uid git gets EACCES there, so the
  global helper answers nothing.

Git then falls through to the next helper in the list, and on a session workspace
that is the **local** one `configureGitCredentials` writes
(`github-auth.ts:configureGitCredentials`):
`/usr/local/bin/shipit-git-credential`, the *container's* broker, which does not
exist on the orchestrator. So nothing answers at all.

**Both halves of that were measured, not inherited** (CLAUDE.md: "verify an
inherited guarantee at the source"), against git 2.39.5 and git-lfs 3.3.0:

1. **The fall-through produces the soak's error verbatim.** A global helper that
   exits without output (the EACCES `cat` case) plus a local
   `credential.helper = /usr/local/bin/shipit-git-credential` that does not exist
   yields exactly `fatal: could not read Username for '<origin>': terminal
   prompts disabled`. Git does *not* report the missing helper binary — it falls
   through silently and then asks for a username, which is why this degraded with
   nothing anywhere naming the cause.
2. **`-c` reaches `git lfs`, and git-lfs uses it.** `git -c credential.helper=
   -c credential.<origin>.helper=<h> lfs pull` against an endpoint that answers
   `401` invoked `<h>` with `get` and retried the batch request carrying
   `Authorization: Basic <base64(user:pass)>`. So the credential does cross the
   `git` → `git-lfs` → `git credential fill` boundary; git re-derives
   `GIT_CONFIG_PARAMETERS` for the child from its own `-c`, which is why
   `sanitizeGitEnv` dropping the *inherited* variable is not a conflict.

`GitManager` had already been given the fix for its own remote ops
(`shared/git.ts` `remoteGit`). Two raw sites were left behind, and they are
exactly the two the soak named:

| Site | Consequence before the fix |
|---|---|
| `git lfs pull` (`git-lfs.ts` `runGit`) | Every provisioning and tree-rewrite path silently left pointer stubs on a **private** LFS repo. |
| `forkSession`'s `fetch origin --prune` (`services/session-fork-merge.ts`) | Anonymous fetch → stale `origin/*` refs → the diff inflation that fetch exists to prevent. `mergeSession` already took a resolver; the fork did not. |

The pull now resolves its own credential through
`resolveTreeRemoteCredential(dir, "origin", …)`, exactly as `GitManager` does.
The resolver is registered **once at boot** by
`configureLfsRemoteCredentialResolver` (`app-di.ts`) rather than threaded through
`materializeLfsContent` / `materializeLfsWithWarning` /
`restoreLfsAfterTreeRewrite`: there are twelve call sites, the resolver is a
process-wide singleton either way, and a hand-kept list of "the ones that pass a
resolver" is stale the moment someone adds one more — **silently**, because a
missing credential does not fail the pull, it leaves stubs. Same reasoning
`git-tree-uid.ts` gives for its own choke point. Unregistered means "resolve
nothing", which is the pre-fix behaviour and what every unit test wants.

It resolves **after** the `usesLfs` gate, so a non-LFS repo still costs one
`git grep` and no remote-URL read; and it is `null` on every path that is not a
dropped-uid git (every test, local mode, the root-owned bare cache), where root
git reads the global helper and the pull is byte-for-byte unchanged.

**The two shapes are now separated, because they need different fixes.**
`LfsFailure` classifies a failed pull from git-lfs's own output (all of these exit
2, so the code cannot distinguish them): `no-credential` is a plumbing fault on
our side — git's `could not read Username` and git-lfs's
`Git credentials for <url> not found`; `access-denied` is a legitimate outcome
(401/403 — the stored token has no access to this repository) that must still be
*reported* rather than swallowed. Each carries its own advice.

**The reporting half, which is a defect on its own terms.** This is
planning#382's shape: the reason existed and reached one surface while the
surface the reader actually reads stayed silent. A fork of an LFS repo opened
with a complete tree, every tracked file present, and each of those files holding
~130 bytes of pointer text — so a build, a test, or an agent reading an asset got
**plausible wrong data** rather than a missing file, which is worse than the fork
refusing outright. `forkSession` now takes two sinks (`ForkReportSinks`, wired by
`forkReportSinks`), because the two readers are different:

- `warn` → an SSE toast now, the same surface every other provisioning path's LFS
  warning uses. A fork is user-initiated, so someone is looking. It also replaced
  the fetch failure's bare `console.warn`.
- `noticeForAgent` → a durable `pending_agent_notice` (docs/221's slot) on the
  **new** session, delivered as a `[System] …` line on its first turn — which may
  be tomorrow, long after any toast. `buildLfsUnresolvedAgentNotice` names the
  cause and teaches the one cheap check (`head -c 120 <path>` → look for
  `version https://git-lfs.github.com/spec/v1`), which is the check that
  distinguishes "this asset is a stub" from the misdiagnoses the original
  docs/231 reporter lost time to. It says "may", not "are": a batched pull can
  fail part-way.

Every non-`materialized` status is reported, not just `failed` — `disabled` and
`binary-missing` leave stubs on disk in exactly the same way.

**The janitor's orphan-branch deletion**, the third path the soak named, is a
different fault and is fixed differently. Its `push --delete` runs root-side
against the root-owned bare cache, so no uid drop applies and the global helper
should answer; the docstring on `sweepOrphanMergedBranches` claimed the cache's
remote URL "embedded the current token", but docs/262 req 19 made `setRemoteUrl`
**strip** embedded credentials, so the mechanism it named was deliberately
deleted and nothing replaced it. That push therefore had no credential of its own
and depended entirely on ambient config. It now resolves an explicit repo-scoped
credential (it already knows `owner`/`repo`), which also brings
`GIT_TERMINAL_PROMPT=0`, so an absent credential fails fast and classifiably; and
the sweep **declines loudly** when no credential can be resolved rather than
pushing into a username prompt nobody can answer. Its failure log now names which
shape happened.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `SHIPIT_GIT_LFS` | unset (on) | `off` → detect and warn, but skip the download. The issue's fallback position for deployments where the bandwidth/storage cost of asset-heavy repos isn't wanted. A manual `git lfs pull` still works. |
| `SHIPIT_GIT_LFS_TIMEOUT_MS` | `300000` | Ceiling on a single `git lfs pull`. The claim slow-path is on the user's critical path, so an unbounded pull on a multi-gigabyte repo would look like a hung session. On expiry the result is `failed` with a warning naming the timeout. |

Both are read from the **orchestrator's own process env**, so both need an
explicit passthrough in `deployment/vps/docker-compose.yml` — without it,
exporting them on the host silently no-ops (the same trap `OVERLAY_DEP_STORE`
documents in that file). They're wired as `${VAR:-}`, and an empty value is
inert for both: `"" !== "off"` leaves LFS on, and `Number("")` fails the `> 0`
check so the timeout keeps its default.

## Deployment

No manual steps: a normal update rebuilds all five images, and `deploy.sh`
already builds `session-worker`, `shipit`, `egress-sidecar`, and
`session-worker-docker` from the current checkout. The changed `RUN` lines
invalidate Docker's cache at that layer, so no `FORCE_REBUILD=1` is needed. The
egress-allowlist addition ships with the orchestrator restart in the same
deploy.

One transitional caveat: sessions and warm-pool clones that were provisioned
*before* the upgrade keep their stubs on disk. Materialization runs at
provisioning, and `refreshClaimedSession`'s docs/145 fast-path can skip the
refresh (hence the re-materialize) when a pre-fetched clone is already in sync
with the bare cache — so a pre-upgrade warm session can be claimed without a
pull. Sessions provisioned after the upgrade are unaffected, the pool self-heals
as it cycles, and `git lfs pull` in the session fixes any straggler now that the
binary is present.

## Known gaps

- **No LFS object sharing via the bare cache.** Every session clone pays its own
  network transfer, where git objects are hardlinked from the per-remote bare
  cache. Fetching LFS into the cache and hardlinking `lfs/objects` into each
  clone (mirroring what `git clone --local` does for `.git/objects`) removes the
  N× cost. Deferred from this doc because it introduces a shared object store
  across sessions, with `git lfs prune` and cross-hardlink `chown` interactions
  that wanted their own design pass. **Now designed and implemented in
  `docs/232-shared-lfs-object-store` (planning#238)**, behind
  `SHIPIT_GIT_LFS_SHARED_STORE=1` — that doc resolves both concerns: kernel
  hardlink refcounting makes prune safe, and `.git/lfs/objects` data files are
  excluded from the ownership handback exactly as `.git/objects` already was.
- **Surfaces that read committed blobs, not the working tree.** Materialization
  fixes the *checkout*; anything reading `git show <ref>:<path>` still sees the
  pointer stub, because that's genuinely what the commit contains. The diff
  viewer hit this and is fixed separately in
  `docs/017-diff-review-panel` (§ Git LFS images) via `git-lfs-blob.ts`, which
  follows the pointer into `.git/lfs/objects` and falls back to `git lfs smudge`.
  Any future blob-reading surface (a commit-history file preview, a PR-side
  render) needs the same resolution step — it does **not** come for free from
  provisioning.
- **Local/dogfood mode degradation.** `RUNTIME_MODE=local` makes one container
  both orchestrator and agent host, so it inherits `--skip-smudge` and a manual
  `git checkout` there writes stubs. Provisioning-time materialization still runs;
  a manual `git lfs pull` covers the rest. Real session containers are unaffected.
- ~~**Orchestrator-side worktree mutations outside provisioning** (e.g. the
  conflict-resolution and pre-turn-reset paths) can re-write stubs without a
  follow-up pull.~~ It mattered in practice — reported as
  nikzlabs/shipit#2349 and closed by
  [§6 below](#6-later-tree-rewrites-not-just-provisioning).

## Key files

- `src/server/orchestrator/git-lfs.ts` — detection, materialization, warning
  wrapper, the per-remote credential the pull carries (§7), failure
  classification, and the unresolved-LFS agent notice
- `src/server/orchestrator/git-lfs.test.ts` — detection + status/warning contract
- `src/server/orchestrator/git-lfs-dockerfiles.test.ts` — guards the per-role
  smudge asymmetry, which can't be verified by a build in-session
- `src/server/orchestrator/warm-pool-manager.ts`, `services/claim-session.ts`,
  `services/session.ts` — provisioning call sites
- `services/rebase-driver.ts`, `services/pre-turn-reset.ts`,
  `services/session-fork-merge.ts`, `services/child-sessions.ts` — the §6
  tree-rewrite call sites, each with a wiring guard in its own `.test.ts`
- `src/server/orchestrator/app-di.ts` — the one-time
  `configureLfsRemoteCredentialResolver` registration (§7)
- `src/server/orchestrator/startup-janitor.ts` — the orphan-branch sweep's
  explicit repo-scoped credential and its fail-closed decline (§7)
- `src/server/orchestrator/egress-allowlist.ts` — LFS transfer host
- `docker/Dockerfile{.prod,.dev,.dogfood,.session-worker.prod,.session-worker.dev}`
- `src/server/shipit-docs/environment.md` — agent-facing "it's a stub, not a
  broken renderer" guidance
