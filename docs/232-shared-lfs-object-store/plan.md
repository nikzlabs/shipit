---
issue: https://linear.app/shipit-ai/issue/SHI-236
title: Shared Git LFS object store
description: Hardlink LFS objects out of the bare repo cache into each session clone, so an asset-heavy repo is downloaded once per host instead of once per session.
---

# Shared Git LFS object store

Follow-up to `docs/231-git-lfs-support` — the "No LFS object sharing via the bare
cache" known gap, tracked as SHI-236.

## The problem

docs/231 made LFS content materialize during provisioning, but nothing is shared.
Every session clone on an asset-heavy repo pays its own full network transfer,
where plain git objects are hardlinked from the per-remote bare cache for free.
N sessions on one repo = N complete downloads; two sequential sessions on the
same repo don't help each other.

It bites hardest exactly where it hurts most: the transfer sits on the claim
slow-path bounded by `SHIPIT_GIT_LFS_TIMEOUT_MS` (default 5 min), so on a large
repo a timeout leaves pointer stubs on disk *and* the next session repeats the
whole download from scratch. Within a session a retry resumes — git-lfs writes
each object as it completes — but across sessions there is nothing to resume from.

**Two independent causes**, both verified empirically. Fixing either alone
changes nothing:

1. **`git clone --local` does not carry `.git/lfs`.** It hardlinks `.git/objects`
   (confirmed: an object file shares one inode between cache and clone) and
   rebuilds refs/config, but sibling `.git` subdirectories aren't copied. A fresh
   clone starts with an empty LFS store.
2. **The bare cache has no LFS objects to share.** LFS content is only fetched by
   the smudge filter or an explicit `git lfs fetch`, and the mirror fetch does
   neither — the orchestrator installs LFS with `--skip-smudge` by design
   (docs/231 §2, load-bearing: with smudge on, `git clone --local` from the cache
   fails the checkout outright). So the cache's `lfs/objects` is empty even in
   principle.

## The design

Populate the cache-side store off the critical path, then hardlink it into each
clone — mirroring exactly what `clone --local` already does for `.git/objects`.

### Approach chosen: cache-side fetch + hardlink

`src/server/orchestrator/git-lfs-store.ts`:

- `fetchLfsIntoCache(bareRepoDir)` — an explicit `git lfs fetch origin` in the
  bare cache. Called from `repo-prefetch.ts`, **not** `RepoGit.fetchCache`: the
  claim slow-path awaits `fetchCache`, so an LFS fetch there would land a
  multi-minute transfer on the user's critical path — the exact cost this is
  meant to move *off* it. Plain `fetch` (not `--all`) resolves objects for the
  cache's current ref; `--all` would pull every version of every asset ever
  committed, unboundedly larger than the working set.
- `linkLfsObjectsIntoClone(bareRepoDir, sessionDir)` — walks the cache's
  `lfs/objects` two-level fanout and hardlinks each object into the clone's
  `.git/lfs/objects`, falling back to a copy on `EXDEV` (cache and sessions on
  different filesystems — costs disk instead of network, still the trade we
  want). Called from `RepoGit.cloneFromCache`, right beside the `clone --local`
  it extends.

The link step is deliberately **not authoritative**: it needn't be complete or
even correct about what the session needs. Anything it misses — an object
committed after the last cache fetch, a link that failed — is still downloaded by
the subsequent `materializeLfsContent` pull. That's what keeps this a pure
optimization with no correctness surface: it can only turn a network transfer
into a local link, never the reverse.

### Rejected: a shared `lfs.storage`

Pointing every clone's `lfs.storage` at one shared directory is fewer lines and
worse on two counts:

- **Isolation.** The store would have to be bind-mounted into every session
  container for in-container LFS to work, giving every agent write access to a
  directory every other session reads — one session could corrupt or poison
  another's assets. Hardlinks share the *bytes* without sharing a writable
  namespace: a session sees only the links it was given, and the object files
  stay root-owned and are never chowned, so the agent can read them and cannot
  rewrite them.
- **Prune.** `git lfs prune` in one session against a genuinely shared store can
  evict objects another live session still needs, since it prunes on its own
  reachability view. With hardlinks the **kernel does the refcounting**: each
  clone drops only *its* link and the inode survives while any link remains.

That second point is what dissolves the concern docs/231 named as the reason for
deferral. It also makes a **cache-side** prune safe for live sessions, which is
what keeps the cache's store from growing without bound (see Known gaps).

### The chown interaction — why `.git/lfs/objects` must not be chowned

This is the other deferral reason, and it turned out to have an existing
precedent rather than needing a new mechanism.

`chownWorkspaceGitToSessionWorker` (docs/150 §7) hands `.git` back to the worker
uid after any orchestrator-side git op. It already treats `.git/objects`
specially: object **directories** are chowned so the worker can add new objects,
but the immutable `0444` data files are skipped. `.git/lfs/objects` previously
fell through to the generic branch and was chowned *in full* — which, once
objects are hardlinks into the cache, would hand the **shared cache store** to
the session uid and let one session's agent rewrite objects every other session
reads. An inode has exactly one owner across every link.

So the LFS store now gets the same treatment, via `chownDirsOnlyRecursive`:
chown every directory, never a regular file. Two differences from the
`.git/objects` case, both deliberate:

- It can't stop at the immediate children. LFS uses a **two-level** fanout
  (`<ab>/<cd>/<oid>`), so a root-owned `<ab>/` would stop the worker from
  creating a new `<cd>/` inside it when it commits an asset whose oid shares that
  prefix. The walk is O(fanout dirs), not O(1).
- Skipping the files is safe on its own terms too, by the same argument as
  `.git/objects`: LFS objects are content-addressed and immutable, so the worker
  only ever reads an existing one or creates a new one. `unlink` — what
  `git lfs prune` needs — is governed by the *directory's* permissions, which are
  worker-owned.

This half is **not** flag-gated: it's a correctness fix (and a saving) for the
plain docs/231 behavior that shipped in #1731, independent of any sharing.

### Rollout — on by default

Sharing shipped opt-in for one release as a canary, then flipped to **on**, with
`SHIPIT_GIT_LFS_SHARED_STORE=off` as the escape hatch. The polarity now matches
`SHIPIT_GIT_LFS` (unset = on, `off` = off) so the two LFS knobs read the same way,
and an empty value — what a `${VAR:-}` compose passthrough supplies when the
operator sets nothing — means "default", not "off".

What makes default-on defensible isn't the soak, it's the failure mode. Every
function is best-effort and the seeding step is non-authoritative, so being wrong
about LFS degrades to "no speedup", never "broken session": a failed cache fetch
or an unmakeable link just means the session's own `git lfs pull` downloads the
object, exactly as before docs/232.

For a repo that doesn't use LFS this is genuinely inert rather than merely cheap —
one `git grep` per background prefetch sweep (`repoDeclaresLfs` answers no) and
one `existsSync` per clone.

What default-on *does* spend is **disk**, which is why the cache-side prune below
landed in the same change rather than staying a follow-up: with sharing on for
every LFS repo, an unpruned cache store grows with asset churn indefinitely.

Note the flag needs a passthrough in `deployment/vps/docker-compose.yml` to be
reachable at all — the orchestrator reads it from its own process env (the trap
docs/231 hit with `SHIPIT_GIT_LFS`).

### Cache-side prune — `nlink` as the liveness signal

`steady-state-reclaim.ts` gained a sweep over `repo-cache/<hash>/lfs/objects`
that unlinks an object when **both** hold: no session clone hardlinks it
(`nlink === 1`) and nothing has touched it inside the retention window
(`DISK_JANITOR_LFS_OBJECT_DAYS`, default 14). It rides the periodic disk-tier
escalation pass, which per `CLAUDE.md` is where sweeps that grow with the clock
belong — and this one does grow with the clock *inside a live cache*, which the
existing whole-directory cache sweep can't help with (that only fires once the
repo itself goes cold, which for an actively-used asset-heavy repo is never).

Two properties make it safe with **no** coordination with live sessions, and
neither needs a reachability computation:

- **`nlink` is a free, exact liveness signal.** Seeding hardlinks the cache's
  object, so `nlink > 1` means some clone still holds it. Only `nlink === 1`
  objects are touched — so the unlink genuinely frees bytes *and* cannot affect a
  live session. This is the hardlink choice paying off a second time: the kernel
  already tracks what a shared `lfs.storage` would have forced us to compute, and
  it can't be stale.
- **Content-addressing makes deletion recoverable.** Dropping an object the cache
  still wanted costs a re-download on the next `git lfs pull`, not a broken
  checkout. That's what lets an age heuristic be good enough.

Deliberately **not** `git lfs prune`: that needs the binary, its bare-repo support
is unverified, and it prunes on a reachability view this doesn't need. An mtime +
`nlink` sweep is testable with plain filesystem calls. It's also **ungated** — a
deployment that turned sharing off still has objects to reclaim, and with sharing
off the store is empty so the walk no-ops.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `SHIPIT_GIT_LFS_SHARED_STORE` | unset (**on**) | `off`/`0`/`false`/`no` disables the cache-side fetch and the hardlink seeding. Any other value, including empty, is the default (on). |
| `SHIPIT_GIT_LFS_CACHE_FETCH_TIMEOUT_MS` | `900000` | Ceiling on the cache-side `git lfs fetch`. Generous because it runs in the background pre-fetcher, off the critical path. |
| `DISK_JANITOR_LFS_OBJECT_DAYS` | `14` | Age at which an unreferenced (`nlink === 1`) cache-side LFS object is unlinked. Tighter than the 30-day cold-artifact window: these are superseded asset versions in a *live* repo, and a wrong delete costs only a re-download. |

## Verification status

The hardlink/seeding half is covered by unit tests that assert the property that
matters — **shared inode**, survival of a cache-side unlink, symlink refusal,
flag gating — because those are plain filesystem behavior.

The prune sweep is likewise covered by filesystem-level tests: an old unlinked
object is reclaimed with its byte count, an object a clone hardlinks survives any
age, a recently-touched one survives, emptied fanout dirs are removed while ones
with survivors stay, and every repo cache on the host is swept.

The `git lfs fetch origin`-in-a-bare-repo half could **not** be exercised in a
session container: the deployed session image predates #1729's merge, so
`git lfs` isn't on PATH here (`git: 'lfs' is not a git command`). Two assumptions
therefore remain unverified in production, and the default was flipped **before**
they were confirmed — a deliberate call, because both fail safe (see below) and
the deployment is single-user. They're still worth confirming from the first LFS
repo that provisions after the flip:

1. `git lfs fetch` populates `lfs/objects` in a **bare** repo.
2. Its endpoint resolves credentials through the global helper. `repo-prefetch.ts`
   normalizes the cache's `origin` to the plain URL for exactly this reason (no
   embedded token), so LFS should authenticate the same way `git fetch` does —
   but that's reasoning, not a measurement.

Both fail safe: a failed fetch leaves the cache store empty, the seeding step
finds nothing to link, and provisioning behaves exactly as it does today.

## Key files

- `src/server/orchestrator/git-lfs-store.ts` — flag, cache fetch, hardlink seeding
- `src/server/orchestrator/git-lfs-store.test.ts` — inode sharing, prune survival,
  flag gating, symlink refusal
- `src/server/orchestrator/session-worker-uid.ts` — `chownDirsOnlyRecursive` and
  the `.git/lfs/objects` branch
- `src/server/orchestrator/repo-git.ts` — `cloneFromCache` seeds the clone
- `src/server/orchestrator/repo-prefetch.ts` — populates the cache store off the
  critical path
- `src/server/orchestrator/git-lfs.ts` — docs/231 detection + materialization
  this builds on

## Known gaps

- **Prune is age-based, not reachability-based.** The sweep can drop an object
  that no clone currently links but that the *next* session would have wanted,
  costing it a re-download. Deliberate: reachability would mean either the
  unverified `git lfs prune` or reimplementing its ref walk, to avoid a cost that
  is bounded by one download of a superseded asset version. Revisit only if the
  re-download rate turns out to matter.
- **Only the clone path is seeded.** `refreshCloneToLatestMain`'s `reset --hard`
  re-materializes pointers and re-pulls; it could seed from the cache first for
  the same win. Left out to keep the first cut to one call site.
- **The two unverified `git lfs fetch` assumptions** above.
