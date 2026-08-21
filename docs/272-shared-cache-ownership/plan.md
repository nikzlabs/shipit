---
issue: planning#425
title: Design — shared git cache ownership
description: One invariant for the trees ShipIt owns outside any session, the repair that enforces it, and the two clone sites that were reading it wrong.
---

# Design — shared git cache ownership

Implements [requirements.md](./requirements.md). Read that first. Extends
[docs/266 orchestrator git trust boundary](../266-orchestrator-git-trust-boundary/plan.md)
(orchestrator git runs as the uid that owns the tree) and
[docs/270 per-session worker uids](../270-per-session-worker-uids/plan.md) (that
uid differs per session).

## The invariant, stated once

> **A git tree ShipIt owns rather than a session is owned by the orchestrator's
> own identity, uniformly, and no session-derived identity ever appears inside
> it.**

Everything below is either the enforcement of that sentence or a call site that
was reading it wrong. Two consequences worth naming because they are what makes
the rest correct:

- **Orchestrator git over such a tree runs as the orchestrator** — root, in
  production — and that is safe *because* of the invariant, not in spite of it.
  `resolveGitTreeUid` declines to drop on a root-owned tree for exactly this
  reason ("the shared bare cache and `/opt/shipit` are ShipIt's own"), and that
  clearance was a claim about the disk until this change made it a repaired
  condition (req 1).
- **No recursive chown may descend into a tree that shares inodes with such a
  tree.** `clone --local` hardlinks `.git/objects`, an inode has exactly one
  owner across every link, so a chown on the clone side is a chown *inside the
  cache* (req 3).

## What production established, so nobody re-derives it

The split is purely by age and exact: every cache created on or before
2026-07-30 is uid 1000, every one from 2026-08-06 is root, zero exceptions. The
**origin is unknown** and three mechanisms are eliminated — per-session
identities landed ten days after the cutover, the Aug 3–5 ownership commits
chown no cache, and a session container cannot reach the shared volume through
its `Subpath` mount. The orchestrator has always run as root.

Two writers left the tree mixed. **Writer A** is whatever made the base trees
uid 1000. **Writer B** is the root orchestrator's own prefetch, running before
the docs/266 uid drop deployed: root ignores permissions, so it silently created
root-owned `0755` subdirectories inside uid-1000 trees. Those became landmines
the moment the drop shipped — prefetch now resolves uid 1000 from the top level
and cannot create a `.lock` inside a root-owned subdirectory. Diagnostic and
confirmed: caches whose repos went idle before the cutover are *uniformly* uid
1000; the three with later branch activity are *mixed*.

And the finding that decides the design: object **files** inside the *root-owned*
caches are owned by uid 1000, and inside `imagegen`'s by **2000024, a per-session
worker uid**. That is hardlink propagation — planning#417's mechanism, observed
in `repo-cache` and not only in the plugin store. It is why req 2 exists.

## E1 — the repair, and why repair rather than accommodate

New module `orchestrator/shared-tree-ownership.ts`, two functions over one walk:

- **`reclaimSharedTree(dir)`** — walk the tree and `lchown` every node that is
  not already the orchestrator's own uid/gid back to it. Symlinks are chowned in
  place and never followed (the `chownRecursive` semantics this repo already
  uses). Returns `{ chowned, failed }` so the caller can log a fact rather than
  an intention. It descends into `.git/objects` **on purpose** — that is the
  hardlink drift, and skipping it is what would leave `imagegen`'s cache with a
  session's uid owning objects every sibling reads.
- **`ensureSharedTreeOwnedByShipIt(dir, context)`** — the cheap gate: one stat of
  `dir`. Owner already ours → return, cost one `statSync`. Owner foreign →
  `reclaimSharedTree` plus a loud log naming the context, the old owner, and what
  it means.

**Why one stat is a complete gate for the operational failures, even though the
drift can hide deeper.** Both production failures need a **foreign top level**:
the prefetch EACCES needs the resolver to drop (it stats the top level), and
`fatal: detected dubious ownership` is git checking the repository *root*. A
tree whose root is ours and whose insides drifted breaks nothing today — the
orchestrator runs as itself and ignores the modes — it is an isolation defect,
which is what E4's boot pass is for. So the gate on the hot path is cheap and
the expensive walk is not on it.

**Which operations can fail at all, which is what decides where the gate goes.**
The drop is resolved from the tree's **top level**, so the identity git runs as
always owns the top level by construction. A write *at* the top level therefore
cannot fail — which is why `setRemoteUrl` (`config.lock` in the cache root) kept
working throughout the incident and needs no gate, and why the failures are
exactly the operations that write **deeper**: a ref lock under
`refs/heads/shipit/` (planning#425), and a clone that reads the whole object store
(planning#428). `fetchCache` and `cloneFromCache` are those two operations.

**Why repair and not accommodate.** The alternative is to teach the resolver to
handle a mixed tree, and there is no uid that can: the only identity that can
write all of a mixed tree is root, and running root over a tree a non-root uid
owns is precisely the escalation docs/266 exists to prevent (that uid can plant
a `.git/config` payload and choose the identity it executes at). A mixed shared
tree therefore has **no safe drop at all**, and the only correct move is to stop
it being mixed. That is also the answer to requirement 8 — see E3.

**Why the target is "the orchestrator's own uid" and not the literal 0.** In
production they are the same. Writing it as `process.getuid()` makes the
mechanism inert rather than wrong wherever the orchestrator is not root (local
mode, dogfood, every test): the whole module gates on `getuid() === 0`, mirroring
`resolveGitTreeUid`'s own inertness, so req 11 holds by construction and the
injection seam (`getuid`/`statOwner`/`lchown`) is what the tests drive.

**Where the gate is called: the two `RepoGit` operations that failed, not
`ensureBareCache`.** `ensureBareCache`'s docstring says it is "called by every
path that operates on a bare cache" — and that is a claim, not a contract:
`warm-pool-manager.ts` builds its `RepoGit` with `createRepoGit(cacheDir)` and
never goes through it. So the gate sits at the top of `RepoGit.fetchCache` and
`RepoGit.cloneFromCache`, which every path — prefetch, claim, warm pool,
unarchive, plugin fetch — provably reaches.

## E2 — the two clone sites, and which tree governs

### `RepoGit.cloneFromCache` (planning#428)

A bare `safeSimpleGit()`: no `baseDir`, so no drop, so **root**. Root reading a
uid-1000 cache is `fatal: detected dubious ownership` once armed, and 6 of 10
caches were uid 1000 — most repositories could not start a session. The site had
no docstring, which is part of why three audits missed it.

**The destination half is already correct, verified at the source, so this is not
the question.** `cloneFromCache` ends with `handWorkspaceBackToWorker(sessionDir)`
(`repo-git.ts:320`) — the object-aware handover, with the ordering and the
hardlink reasoning argued in place above it. The requirement's anticipated
"two-step" was already half built; requirement 6's open half is narrower than it
looks:

> **As which identity may ShipIt read a shared cache it does not own?**

**Answer: as itself, having first made the cache its own (E1).** git's ownership
check tests the repository being *read*, and `clone --local` can only hardlink an
object file the cloning identity may link (`protected_hardlinks` is 1 on the
deploy hosts) — both hard constraints are properties of the source, so the source
governs. Root is the right identity **because** E1 makes the source ShipIt's own;
it is not a default nobody chose.

The one alternative that survives a first glance is to drop to the *source's
current* owner — uid 1000 — and read the cache as it. Two things kill it, and the
second is the more important: the destination is `<sessionDir>/workspace` and the
session directory is **0700 owned by the session's own identity** (docs/270 req
1), so a clone running as uid 1000 cannot traverse into the tree it is writing;
and adopting a foreign uid to read our own cache would make ShipIt's git run as
an identity whose provenance is *unknown* — the very thing requirement 1 exists
to stop. `session-fork-merge.ts` drops to its source's uid for the opposite
reason: there the source is a session workspace untrusted code can write, so
reading it as root would be the escalation. A shared cache is the mirror case.

Note what this deliberately does *not* copy from `session-fork-merge.ts`. That
path drops to the **source session's** uid and temporarily re-seals the
destination to it, because its source is a session workspace that untrusted code
can write and therefore must never be read as root. A shared cache is the
opposite case: nothing untrusted can write it (verified — `buildMounts` binds the
workspace, per-session credentials, uploads, scratch, session state, the plugin
store, the dep cache and the pnpm store, and never the cache), so the correct
identity is ShipIt's own and the fork's dance would buy nothing and cost the
hardlinks.

### `plugin-install.ts`'s staging handover (planning#417)

`chownTreeToSessionWorker(job.stagingDir)` is a plain `chownRecursive` over a
tree `checkoutCommit` populated by `clone --local` from the shared plugin bare
cache — which lives under the same `repo-cache/<hash>` root as every session's
cache. So it hands the *cache's* object files to whichever session installed
last, and with them chmod and rewrite rights over content every other generation
and every sibling session reads.

Replaced with a new `handPluginCheckoutToWorker(checkoutDir)`: the object-aware
`.git` walk (object *directories*, never object data files) plus the full
worktree walk. It is `handWorkspaceBackToWorker` **minus the dep-dir
exclusion**, and the difference is deliberate:

- The dep-dir skip exists to bound a walk over a populated `node_modules` that
  the worker already owns. A fresh plugin checkout has no populated dep dir, and
  if the repository *commits* one it is part of the overlay's **lower** dir — so
  it must be worker-owned or the install fails on its first copy-up.
- The object-awareness is what closes planning#417, and it is safe on the same
  terms as the session workspace: a plugin install never rewrites a git object
  in place, and a root-owned `0444` object is world-readable.

The existing comment's constraint is preserved, not narrowed away: overlayfs
takes the merged directory's permissions from the **lower** dir, and the lower
dir's root and every worktree file below it are still chowned. Only the
immutable object data files are left alone.

### Inherited claims this design leans on, checked at the source

Two of the sentences this work would otherwise have inherited are wrong, and both
are the kind that a later change reasons from:

- **`ensureBareCache`'s "called by every path that operates on a bare cache".**
  False: `warm-pool-manager.ts` builds its `RepoGit` with
  `createRepoGit(cacheDir)` and fetches and clones without going through it. This
  is why E1's gate is at the two `RepoGit` operations and not at the funnel.
- **`session-worker-uid.ts`'s "`cloneFromCache` ends with
  `chownTreeToSessionWorker(sessionDir)`".** Stale — it ends with
  `handWorkspaceBackToWorker`, the object-aware composite, which is *stronger*
  than the claim. The conclusion the docstring draws survives; the sentence a
  future reader would have copied does not. Corrected in place.

Recorded rather than fixed silently, because the argument in
`resolveGitDirOwner`'s docstring ("why session setup is unaffected") rests on the
second one, and it has already been corrected once before for the same reason.

## E3 — should a one-stat drop decide a whole tree?

**No — and the fix is not to stat more, it is to make the tree uniform.**
Recorded in `git-tree-uid.ts` at the fall-through, where the next reader is.

Statting more is a dead end in both directions. Statting the whole tree is
O(tree) per git invocation on a path whose docstring already argues for
microseconds; statting a *sample* (`.git/objects`, say, which the arming runbook
left open as a question) trades one silent wrong answer for another, because
nothing makes the sample representative. And, as E1 argues, a mixed tree has no
correct answer to return: root escalates, the tree's owner cannot write the
foreign parts. So the resolver keeps its one stat, and this change makes the
uniformity it assumes an **enforced** condition for the trees ShipIt owns rather
than an inherited belief.

The fall-through is kept for the case it is genuinely right for — a path that
belongs to no session and to no ShipIt cache, e.g. a host-bind dev tree owned by
the developer. What is added is legibility: the **first** time the fall-through
drops to a non-root owner for a given tree, it says so, once, with the uid it
chose. A bounded map keys the once-ness; it is not a cache of the decision (the
decision stays uncached and per-call, deliberately).

## E4 — the boot pass, and legibility

- **Boot pass.** `startup-janitor.ts` gains a step that runs `reclaimSharedTree`
  over every child of `repo-cache/` and `marketplace-cache/`, reporting a node
  count. Boot-only is the right cadence per CLAUDE.md's split: this is leftover
  state from previous incarnations, not something that grows with the clock. It
  is what actually repairs the existing hardlink drift, and it is fail-safe — a
  failed `lchown` is logged and skipped, leaving exactly today's behaviour.
- **Prefetch diagnosis (req 5).** The bare-cache fetch failure stays non-fatal
  and stops being anonymous: an ownership-shaped failure is logged as one, with
  the uid the process runs as, the cache's owner, and the sentence that would
  have saved the days this cost — *a root process getting `EACCES` means it
  dropped uid and the tree is not uniformly owned.*

## E5 — the guard asks both questions (req 7)

`git-hooks-guard-coverage.test.ts`'s bare-`safeSimpleGit()` census recorded one
`why` per site, and every entry answered about the **destination**. planning#428
is a failure on the **source**, so the census cleared the site that broke
production, 21/21, against the deployed build.

Two changes:

1. Each census entry becomes `{ count, source, destination }`, and the rule
   asserts both are stated. A site cannot be listed by answering half the
   question any more.
2. A second census over **every `"clone"` argv literal**, not just the bare
   ones — the shape Table B2 of the arming runbook audits by hand, moved into
   CI with the same two fields. Stated gap, because an unstated one is worse:
   simple-git's `.clone()` *method* form is not matched by the pattern; there is
   exactly one such site (`marketplace.ts`'s `cloneCatalog`) and it is censused
   by the bare rule with both answers.

## Does planning#418's fix generalise? (req 10)

**Its shape does; the fix itself does not, and there is no third instance
waiting.**

planning#418 made an unusable marketplace catalog cache *recoverable* — rebuild
into a staging sibling and swap by rename, which needs write permission on the
parent only — and made a still-readable stale cache servable. That is the right
answer for a shallow catalog clone whose whole content is re-derivable from a
URL. It does not transfer to `repo-cache`: a rebuild there means re-cloning
hundreds of megabytes from GitHub, discarding the object inodes every live
session clone hardlinks, and depending on the network at exactly the moment
recovery is needed. The cheap generalisation of the same idea — *make the state
recoverable instead of permanently wedged, and log the identities on the
recovery path* — is what E1 and E4 do.

**No third instance.** The shared git trees the orchestrator writes are:
`repo-cache/<hash>` (this work; the plugin bare caches live under the same root,
so they are covered by the same pass), `marketplace-cache/<id>` (covered by the
same pass here, which is more than planning#418 did — that fix recovers a broken
cache and does not prevent the drift that broke it), `/opt/shipit` and the
`mkdtemp` template scaffolds (root-owned by construction, on no clone-and-chown
path). `dep-cache/` and the overlay dep store are shared too, but by an explicit
and different contract — group ownership via `shareTreeWithAllSessions` — which
is stated where it happens and is not this class.

## Does this unblock planning#410? (req 12)

**Yes for both blockers, with one condition on the soak.** planning#428's
`fatal: detected dubious ownership` needs a non-root **source**, and planning#425's
ref-lock EACCES needs a foreign **top level**; E1's gate removes both before any
git runs, on every path that reaches a cache. Arming remains an operator action
and is not part of this change.

The condition is planning#428's own lesson, and it is about the soak plan rather
than the code: *one surface had two populations and only one was sampled.* The
soak exercised `cloneFromCache` against `reward-tag`, whose cache is root-owned,
and never against one of the six uid-1000 caches. A re-arm should claim-exercise
a cache from **each** ownership class — which, after this change, means verifying
the repair log fired for the previously-foreign ones.

## The debugging note (req 9)

Kept in three places on purpose, because the one that cost the time was the
absence of it anywhere: `git-tree-uid.ts`'s docstring (where the drop is
decided), `CLAUDE.md`'s key patterns (always-on, and shared with Codex through
the `AGENTS.md` symlink), and the `git-architecture` skill (auto-disclosed to
both backends).

> A root process receiving `EACCES`/`EPERM` reads as impossible. In this
> codebase, read it first as **"the process dropped uid, and the tree is not
> uniformly owned."**

## The independent review, and the one finding that was refuted

ShipIt's configured reviewer (a different model family) checked the branch against
all twelve requirements and found them met. Three findings were acted on: the
`isAncestor` comment still asserted the cache was root-owned as a static fact, the
gate's "before any git touches a shared cache" was imprecise, and
`ensureBareCache`'s own docstring still carried the false funnel claim that this
work corrects elsewhere. All three were stale or over-broad *sentences* — the class
this feature keeps tripping over.

Its **headline** finding was wrong, and how it was wrong is worth keeping. It read
`noteForeignTreeDrop` as firing for every session workspace under per-session uids
— "a stream of false positives telling the operator a session's tree belongs to no
session" — on the stated grounds that "`resolveGitTreeUid` has NO session
awareness". It has: `sessionIdForPath(dir) !== null` is the statement immediately
above the fall-through, and in production both roots are configured
(`index.ts:154`), so every workspace and every per-session credential subtree
returns before the log. Refuted at the source, then **pinned in
`git-tree-uid.test.ts`** rather than argued — a session path resolving to a
2000000-range tree owner must produce no log line. The misread is cheap to make
from a diff, so the docstring now names the guard and the line instead of
describing the behaviour.

The lesson generalizes in both directions: an out-of-family reviewer is the right
place to send an impossibility claim, *and* a finding it hands back is a claim to
check at the source like any other. The two corrections in the section above were
found the same way.

## Rejected alternatives

- **`--no-hardlinks` on every clone from a shared cache** (planning#417's option
  1). Closes the class outright and costs a full object-store copy per session
  and per plugin generation — 142 MiB for the ShipIt repo. docs/270 already made
  the opposite trade for session clones deliberately, and object-aware walks are
  what it bought; `session-fork-merge.ts` pays the copy only because its source's
  objects are root-owned while its clone must run non-root, which is not the
  case here.
- **A one-shot migration that chowns the production caches.** Refused by
  requirement 2: hardlink sharing re-creates the condition, so a migration is a
  fix with an expiry date.
- **An env flag to arm the repair.** docs/266 needed a switch because arming
  turns every missed site into a hard failure at once. A repair is the opposite:
  its failure mode is "nothing happened", which is today's behaviour. A flag
  would only add a state in which the fix is deployed and not working.
- **Re-cloning a foreign-owned bare cache** (planning#418's shape). See above —
  disproportionate, and it discards inodes live clones share.
- **Teaching the resolver to stat deeper.** See E3.

## Key files

| File | Role |
|---|---|
| `orchestrator/shared-tree-ownership.ts` | **New.** The invariant, the cheap gate, and the reclaim walk. |
| `orchestrator/repo-git.ts` | Gate at `fetchCache` / `cloneFromCache`; `cloneFromCache`'s missing ownership docstring. |
| `orchestrator/plugin-install.ts` | Object-aware staging handover instead of the plain recursive chown. |
| `orchestrator/session-worker-uid.ts` | `handPluginCheckoutToWorker`; the plain-`chownRecursive` callers are now a censused list. |
| `orchestrator/repo-prefetch.ts` | Ownership-shaped fetch failures report as ownership failures. |
| `orchestrator/startup-janitor.ts` | Boot pass over both cache roots. |
| `shared/git-tree-uid.ts` | The answer to "should one stat decide a whole tree", and the once-per-tree fall-through log. |
| `shared/git-hooks-guard-coverage.test.ts` | Census asks source **and** destination; clone-argv census. |
| `docs/266-…/arming-runbook.md` | Tables B/B2 corrected; the open `.git/objects` question answered. |
