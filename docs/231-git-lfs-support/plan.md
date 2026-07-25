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
and materialize content explicitly at the end of provisioning.

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

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `SHIPIT_GIT_LFS` | unset (on) | `off` → detect and warn, but skip the download. The issue's fallback position for deployments where the bandwidth/storage cost of asset-heavy repos isn't wanted. A manual `git lfs pull` still works. |
| `SHIPIT_GIT_LFS_TIMEOUT_MS` | `300000` | Ceiling on a single `git lfs pull`. The claim slow-path is on the user's critical path, so an unbounded pull on a multi-gigabyte repo would look like a hung session. On expiry the result is `failed` with a warning naming the timeout. |

## Known gaps

- **No LFS object sharing via the bare cache.** Every session clone pays its own
  network transfer, where git objects are hardlinked from the per-remote bare
  cache. Fetching LFS into the cache and hardlinking `lfs/objects` into each
  clone (mirroring what `git clone --local` does for `.git/objects`) would remove
  the N× cost. Deliberately deferred: it introduces a shared mutable object store
  across sessions, with `git lfs prune` and cross-hardlink `chown` interactions
  that want their own design pass.
- **Local/dogfood mode degradation.** `RUNTIME_MODE=local` makes one container
  both orchestrator and agent host, so it inherits `--skip-smudge` and a manual
  `git checkout` there writes stubs. Provisioning-time materialization still runs;
  a manual `git lfs pull` covers the rest. Real session containers are unaffected.
- **Orchestrator-side worktree mutations outside provisioning** (e.g. the
  conflict-resolution and pre-turn-reset paths) can re-write stubs without a
  follow-up pull. The provisioning paths are covered; these would each need a
  `materializeLfsContent` call if they turn out to matter in practice.

## Key files

- `src/server/orchestrator/git-lfs.ts` — detection, materialization, warning wrapper
- `src/server/orchestrator/git-lfs.test.ts` — detection + status/warning contract
- `src/server/orchestrator/git-lfs-dockerfiles.test.ts` — guards the per-role
  smudge asymmetry, which can't be verified by a build in-session
- `src/server/orchestrator/warm-pool-manager.ts`, `services/claim-session.ts`,
  `services/session.ts` — call sites
- `src/server/orchestrator/egress-allowlist.ts` — LFS transfer host
- `docker/Dockerfile{.prod,.dev,.dogfood,.session-worker.prod,.session-worker.dev}`
- `src/server/shipit-docs/environment.md` — agent-facing "it's a stub, not a
  broken renderer" guidance
