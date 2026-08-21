---
issue: planning#425
title: A shared git cache is ShipIt's own, uniformly, and stays that way
description: What must be true for the bare caches and catalog caches ShipIt keeps outside any session — ownership, the clones cut from them, and how a failure reports itself.
---

# Requirements — shared git cache ownership

Tracked by planning#425, with planning#417 and planning#428 as the other two
faces of the same defect. Constrained by
[docs/266 requirements](../266-orchestrator-git-trust-boundary/requirements.md)
(orchestrator-side git runs as the uid that owns the tree) and
[docs/270 requirements](../270-per-session-worker-uids/requirements.md) (that uid
now differs per session). This document states **what must be true**; the design
is in [plan.md](./plan.md).

## Why these are one requirement set and not three

`/workspace/repo-cache/<hash>` is a **single** tree with three writers that hold
three different identities: the orchestrator's prefetch, a session's
`clone --local`, and a plugin generation's staging clone plus its install
handover. Nothing in the codebase stated who owns that tree, so each writer
answered for itself and production ended up with 6 of 10 caches owned by uid
1000, root-owned subdirectories inside them, and object files owned by a
per-session worker uid. The three issues are the three ways that one silence
surfaced: refs that cannot be locked (planning#425), a chown that reaches
through a hardlink into the cache (planning#417), and a root clone that a
non-root source refuses (planning#428).

## Requirements

1. A git tree that belongs to **ShipIt** rather than to a session — the bare
   caches under `repo-cache/`, the marketplace catalog caches — MUST be owned
   throughout by the identity the orchestrator itself runs as. Mixed ownership
   *within* one such tree MUST NOT persist: a cache root owned by one identity
   with a subdirectory owned by another is the defect, and the permission error
   is only its symptom.

2. Requirement 1 MUST hold on an **ongoing** basis, not once. The system
   re-creates the condition by itself: `clone --local` shares object inodes
   between a cache and every clone cut from it, so an ownership change on the
   clone side rewrites apparent ownership inside the cache. A change that
   repairs the caches once and then assumes them correct does not satisfy this.

3. Handing a session's or a plugin generation's tree over to the identity that
   will run in it MUST NOT change the apparent ownership of anything inside a
   shared cache. No session-derived identity may end up owning an inode a
   sibling session reads.

4. Creating a session from a repository MUST succeed whatever the ownership
   history of that repository's cache, and MUST still succeed when git's own
   repository-ownership check is armed
   (`SHIPIT_GIT_STRICT_OWNERSHIP`, docs/266 E2).

5. A bare-cache refresh that fails MUST NOT be reported only as a generic
   non-fatal line. When the cause is an ownership disagreement, the report MUST
   name it as one and name the identities involved — the uid the process ran as
   and the owner of the tree it touched. Staying non-fatal is correct; staying
   silent is not.

6. Where a git operation crosses an ownership boundary — a clone whose source
   and destination belong to different identities — the source MUST say **which
   tree governs** the identity the operation runs as, and **who takes the
   destination afterwards**, at the call site where the next reader will find it.

7. The CI guard that censuses clone sites MUST require **both** answers of every
   site it lists: who owns the source and who owns the destination. A guard that
   asks only about the destination passes a site that fails on its source, which
   is how planning#428 survived three audits.

8. The question planning#425 raises — *should a single stat of a tree's top
   level decide the identity git runs as for the whole tree?* — MUST be answered
   in the source, at the resolver, and not left as an open note in a runbook.

9. The debugging fact MUST be recorded somewhere durable and agent-visible: **a
   root process receiving `EACCES`/`EPERM` reads as impossible and sends the
   reader down the wrong path.** In this codebase it MUST be read first as *"the
   process dropped uid, and the tree is not uniformly owned."*

10. The work MUST state whether planning#418's fix (rebuild an unusable
    marketplace catalog cache) generalises to this class, or whether a third
    instance of the class is still waiting.

11. Every behaviour above MUST be inert wherever ShipIt is not the privileged
    owner of the tree — local mode, the dogfood inner instance, and every test
    MUST be byte-for-byte unchanged. (The docs/266 house rule: this whole class
    of mechanism cannot be exercised for real anywhere but a containerized
    production orchestrator, so it must be able to do nothing at all.)

12. The work MUST state whether planning#410 (arming
    `SHIPIT_GIT_STRICT_OWNERSHIP` in production) is unblocked by it, with the
    reason.

## Non-goals

- **Finding the origin of the original uid-1000 ownership.** Three mechanisms
  are already eliminated (per-session identities post-date the cutover by ten
  days; the Aug 3–5 ownership commits chown no cache; a session container cannot
  reach the shared volume through its `Subpath` mount), the orchestrator has
  always run as root, and the cause is probably not in this repository's
  history. Requirement 2 is what makes the origin not worth finding: the system
  re-creates the condition without help, so the fix has to survive it either
  way.
- **A user-facing surface for a lagging cache.** Requirement 5 asks for a report
  that names the cause, not a card in the chat transcript: after the repair the
  condition is self-healing and not user-actionable, and a session whose cache
  genuinely cannot be refreshed already raises an SSE error on the warm-pool
  path.

## Provenance

Requirements 1–5 and 10 are the issue bodies and the operator's on-disk
evidence, restated. Requirements 6–9 and 12 are the parent session's brief of
2026-08-17, verbatim in intent. Requirement 11 is inherited from docs/266
requirement 11 and docs/270, not supplied here.

## Open questions

None open. The two design questions this work could have had to ask were
pre-answered by the brief and are recorded below.

## Resolved questions

**Q1 — must the fix survive ongoing hardlink drift, or is a one-time repair of
the production caches enough?** Answered by the requester (parent session
brief), 2026-08-17: *"a fix that chowns the caches and moves on will re-drift.
Whatever you design must be stable under ongoing hardlink sharing. That is the
requirement."* → requirement 2, and it is what rules out a one-shot migration
script.

**Q2 — for a clone whose source and destination belong to different identities,
is the answer a uid choice or a two-step?** Answered by the requester (parent
session brief), 2026-08-17: *"There may be no single uid that satisfies both
trees, in which case the answer is a two-step — clone, then hand ownership over
— rather than a uid choice. Decide which tree governs, and say so where the next
reader will find it."* → requirement 6. The brief delegates the choice and
requires the reasoning to be written at the call site; it does not pick one.
