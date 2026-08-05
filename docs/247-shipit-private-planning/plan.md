---
issue: https://linear.app/shipit-ai/issue/SHI-304
title: ShipIt private planning
description: Track ShipIt's own planning in a private GitHub repository, and migrate off Linear by copying every issue and rewriting every reference.
---

# 247 — ShipIt private planning

Implements [requirements.md](./requirements.md). The platform mechanism this
depends on is [248 — Declared issue trackers](../248-declared-issue-trackers/plan.md);
this doc is only about ShipIt's own use of it and the one-time migration.

## Status

**Not started**, and gated on [248](../248-declared-issue-trackers/plan.md) rather
than on anything here. A first version of the tracker mechanism shipped, but 248's
requirements have since replaced `--repo` with declared tracker names, so what this
migration needs is the *reworked* 248 deployed — not the version currently on
`main`. The planning repository also does not exist yet.

Sequencing that outward: references must be written in the `planning#123` form the
first time, so 248's name support has to land, ship, and reach the deployment
before the reference rewrite begins.

## Why a private repository

ShipIt's source repository is public. Planning work — roadmap, half-formed ideas,
competitive notes, security work in progress — is not something to publish as a
side effect of tracking it. A separate private repository keeps planning inline in
ShipIt (req 4) without putting it in the public repo's Issues.

Choosing GitHub Issues means accepting its feature set rather than passing a
parity gate; the comparison that led here is the
[evaluation](../246-native-issue-tracker-evaluation/plan.md).

## What stays public

The in-product bug-report flow keeps filing user reports in ShipIt's public
repository (req 6). It sits outside the tracker registry entirely
(`services/bug-report.ts`), so declaring a planning tracker cannot re-route it —
worth stating because "all issues now go to the planning repo" is exactly the
wrong summary of this change.

## Migration

### Sequencing constraints

Three facts set the order, each verified rather than assumed:

1. **A merge is not a deploy.** The `shipit` shim inside a session container comes
   from the *deployed* orchestrator, so nothing can be written to the planning
   repository until 248's rework reaches the deployment — not when it lands on
   `main`.
2. **`shipit issue list` cannot enumerate Linear.** The adapter queries
   `first: 100` with no pagination (`trackers/linear/adapter.ts`), so the list tops
   out at the 100 most-recently-updated issues. The tracker holds roughly 316
   (the highest key referenced in the repo is SHI-316; SHI-320 returns "Entity not
   found"). Enumeration must walk keys `SHI-1…SHI-316` via
   `shipit issue view <key> --comments --json`, which takes a direct pointer.
3. **Credentials are brokered.** Neither a Linear token nor a GitHub token is
   present in a session container, so every read and write goes through
   `shipit issue`. There is no direct-API shortcut available to the agent.

### Scale

| Surface | Count |
|---|---|
| Linear issues to copy | ~316 |
| Distinct issue keys referenced in the repo | 254 |
| Mentions in `src/**/*.ts(x)` | ~1,575 across 369 files |
| Mentions in `docs/` | ~809 across 244 files |
| Other (`CLAUDE.md`, `docker/`, `.github/`) | the remainder |

The reference rewrite therefore touches most files in the repository. It should
land as **one atomic PR when nothing else is in flight**, because a diff of that
shape conflicts with every open branch.

### Steps

1. **Create `nikzlabs/shipit-planning`** (req 5 — the user does this) and confirm
   the deployment's GitHub credential reaches it. The credential is account-wide
   (`githubAuthManager.getToken()`), not the repo-scoped installation token, so a
   fine-grained PAT limited to the source repository fails here. One
   `shipit issue list` against it settles that; a 403/404 surfaces as the inline
   access error.
2. **Land, release and deploy 248's rework**, then re-probe from a fresh session
   to confirm the shim addresses trackers by name. The `shipit` binary in a session
   container is the deployed orchestrator's, so a merge alone changes nothing here.
3. **Export Linear** — walk `SHI-1…SHI-316`, capturing title, body, comments
   (author, timestamp, body), labels, priority, status, and sub-issue parent.
   Read-only, and it doubles as the archive. Written outside the git workspace:
   it holds private planning content.
4. **Copy into the planning repository** in key order, so numbering lands
   predictably. Each body carries its `SHI-N` origin; comments are replayed with
   their original date in the text (req 9) — authorship needs no preservation,
   since the copying account and the original author are the same person; labels
   are created as needed; closed and canceled issues are closed after creation.
   The output is the `SHI-N → planning#M` mapping, which everything downstream
   depends on.
5. **Rewrite every reference** from that mapping in one PR (req 10): doc `issue:`
   frontmatter, inline doc mentions, code comments, `CLAUDE.md`.
6. **Retire Linear** for ShipIt's own planning (req 11) and rewrite `CLAUDE.md`'s
   tracker-sync section.

### Numbering does not survive

GitHub assigns issue numbers sequentially and shares the sequence with pull
requests; they cannot be chosen. `SHI-137` will not become `planning#137`. The
mapping is the only authority, which is why step 4 emits it as a durable artifact
rather than a side effect — and why step 5 cannot start until step 4 completes.

### Tracker names make this a one-time cost

The reference rewrite is expensive enough to be worth paying only once. Writing
the rewritten references in the **name** form (`planning#123`, requirements 10 and 13 of
[248](../248-declared-issue-trackers/plan.md)) means a later rename of the planning
repository is a one-line `shipit.yaml` edit rather than a second sweep of ~2,400
mentions. Name support is therefore a hard prerequisite for step 5, not an
optimization: without it, step 5 hard-codes a repository slug into most files in
the repository and the whole sweep has to be repeated on the first rename.

## The Linear fallback closes itself

`shipit issue create` currently hardcodes Linear as its fallback tracker
(`resolveTrackerFlag` in `agent-shim/shipit-issue.ts`), which would have meant a
bare `create` filing into a retired tracker. An earlier version of this plan
proposed an `issues.default` key to fix it. That is no longer needed:
[248](../248-declared-issue-trackers/requirements.md) req 1 removes implicit
destinations altogether and req 12 makes every operation name its tracker, so there
is no fallback left to point anywhere. The dependency is on 248 landing, not on a
separate feature.

## Non-goals

- Storing planning issues in ShipIt's public source repository.
- Making GitHub's web UI the primary planning workflow.
- Redirecting the public user bug-report flow into the planning repository.
- Continuous two-way synchronization with Linear.
- Removing Linear support from the product. Linear stays a declared tracker kind
  ([248](../248-declared-issue-trackers/requirements.md) req 3); ShipIt retires it
  for itself by not declaring it.
