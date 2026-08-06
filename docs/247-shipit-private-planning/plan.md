---
issue: roadmap#SHI-304
title: ShipIt private planning
description: Track ShipIt's own planning in a private GitHub repository, and migrate off Linear by copying every issue and rewriting every reference.
---

# 247 — ShipIt private planning

Implements [requirements.md](./requirements.md). The platform mechanism this
depends on is [248 — Declared issue trackers](../248-declared-issue-trackers/plan.md);
this doc is only about ShipIt's own use of it and the one-time migration.

## Status

**Ready to execute.** Both gates are cleared, and each was probed rather than
assumed:

- **248 is deployed, not merely merged.** The `shipit` shim in a session
  container comes from the deployed orchestrator, and it addresses trackers by
  name (`--tracker NAME`), requires one on `create`, and fails closed on an
  undeclared name with the declared set listed.
- **`nikzlabs/shipit-planning` exists and the deployment's credential reaches
  it** (req 5). Declared as `planning`, it lists, enumerates labels and statuses,
  and accepts writes — a create, a comment and a close all round-tripped live.

The declaration landed on `main` in its own PR, so the tab is live. What remains
is the copy, the reference rewrite, and retiring Linear.

One gate is open, and it is the same merge-is-not-a-deploy trap: the two shim and
adapter fixes the export depends on are on `main` (`9b031908`) but **not yet in
the deployed shim** — verified from a session container, where a piped large issue
still truncates at 65,536 bytes and `createdAt` is still absent. Confirm both
before exporting.

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

## Scale — measured, not estimated

A full read-only export ran against Linear (322 keys, `SHI-1…SHI-322`; no gaps,
`SHI-323` and above do not exist). The corpus:

| Surface | Count |
|---|---|
| Linear issues | 322 |
| Comments | 1,344 (across 232 issues; 90 have none) |
| Issue body text | 515 KB |
| Comment text | 1.19 MB |
| Distinct labels | 20 |
| Issues with a parent (sub-issue) | 15 |
| Issues with an assignee | 75 — all one person |
| Comment authors | 1 (`nicolas.zherebtsov`, all 1,344) |

Status spread: Done 219, Backlog 78, Canceled 10, In Progress 7, Todo 7,
Duplicate 1. Priority spread: none 214, Medium 42, High 31, Low 27, Urgent 8.

The reference surface in this repository:

| Surface | Count |
|---|---|
| Distinct `SHI-N` keys referenced | 259 |
| Total mentions | 2,623 across 667 files |
| — in `src/` | 1,677 across 391 files |
| — in `docs/` | 869 across 249 files |
| Docs with an `issue:` frontmatter pointer | 186 |
| Files containing a `linear.app` URL | 221 |

And — the surface the earlier estimate missed entirely — **the corpus references
itself**: 1,146 `SHI-N` mentions and 120 `linear.app` URLs live *inside* issue
bodies and comments. Those have to be rewritten too, or the migrated tracker is
full of pointers back to the system being retired.

## What GitHub cannot hold

Probed against the real adapter, not inferred:

| Linear | GitHub | Disposition |
|---|---|---|
| Priority (5 levels) | none — `createIssue` **rejects** `--priority` outright | A `priority: high` label round-trips: `mapGitHubPriority` reads it back as priority "High". Verified live. 108 issues affected. |
| Workflow states (6) | open / closed only | Allowed to collapse (req 8). Backlog, Todo and In Progress all arrive open; Done, Canceled and Duplicate all arrive closed. Nothing encodes the difference. |
| Issue creation date | not settable | Recorded in the body instead (req 9). It was not even *readable* until `9b031908` added `createdAt` to `ISSUE_FIELDS` in `trackers/linear/adapter.ts`; that fix must reach the deployed shim before the export. |
| Sub-issue parent | adapter has no sub-issue support | 15 issues. Record the parent in the body. |
| Assignee | supported | All 75 are the same person, who is also the copying account. Drop it. |
| Label colors | supported | Carried from the export. |

`setStatus` does accept `canceled` and maps it to GitHub's `not_planned` close
reason, but the read path (`adapter.ts:202`) collapses every closed issue to
`completed`, so ShipIt never shows the distinction back. That is consistent with
req 8 letting the states collapse — it just means nothing is gained by passing
`canceled` rather than `closed`.

## Numbering, and the circularity it creates

GitHub assigns issue numbers sequentially and shares the sequence with pull
requests; they cannot be chosen. `SHI-137` will not become `planning#137`. The
`SHI-N → planning#M` mapping is the only authority.

That mapping is needed *before* the copy, not after — because issue bodies and
comments cross-reference each other (1,146 mentions). Writing them first and
fixing them later would mean a second edit pass over most of the corpus, and
**comment bodies cannot be edited at all** through the shim, so a
comment's cross-references would be permanently stale.

The way out is to **split the copy in two, so the mapping is observed rather than
predicted**. Creating an issue is what fixes its number, and nothing about a
comment or a cross-reference influences it. So:

- **Pass A** creates all 322 issues — title, body header, labels, and the body
  text with its cross-references still in their original `SHI-N` form. Every
  number is now assigned and recorded.
- **Pass B** replays the 1,344 comments and edits the 322 bodies, rewriting
  cross-references from the mapping Pass A produced.

The split is what makes the mapping observed rather than guessed. It also draws
the line the steps follow: both passes are tracker-only, and the repo-wide sweep
comes after them as the migration's single diff.

Predicting `SHI-N → planning#(N + offset)` and asserting each create would also
work — the repository is empty apart from `planning#1` and the pilot, and nothing
else opens issues or PRs there — but it buys nothing that Pass A doesn't, and it
resolves the numbering risk at the latest possible moment instead of the earliest.
The prediction survives only as a cheap consistency check inside Pass A.

Renaming the Linear tracker to `planning` first, and sweeping references to
`planning#SHI-304` ahead of the copy, does **not** work as a shortcut: a name
bound to a GitHub destination requires a numeric suffix
(`issue-ref-resolution.ts:281`), so every such reference would break at the swap.
The identifier is what the migration changes; the name is already stable.

This is why nothing else may open an issue or PR in the planning repository while
the copy runs.

## Write volume and pacing

The copy is roughly **2,000 brokered writes**: 322 creates + 1,344 comments + ~230
closes + ~26 label creations. Three consequences, each of which shapes the driver:

1. **No retry or backoff exists.** `trackers/github/adapter.ts` has no handling
   for `429`/secondary-rate-limit responses — a throttled request surfaces as a
   plain error. GitHub rate-limits content creation, so the driver must pace
   itself and retry on its own. Measure the first hundred writes and set the pace
   from what actually comes back rather than from a documented number.
2. **It must be resumable.** At any survivable pace this runs for hours, across
   more than one turn. The mapping and a per-issue completion marker are appended
   to disk after each write, so a restart skips what is already done. Re-running a
   completed step must be a no-op, not a duplicate.
3. **Every write posts a persisted transcript card.** `api-routes-issues.ts` emits
   and *persists* an `issue_write_card` per write, with no suppression flag. ~2,000
   cards in one session's history is not something to inflict on a session anyone
   wants to reopen. The copy therefore runs in its **own child session**, which is
   archived when it finishes.

The write-dedup window (`handleWrite`) keys on session + tracker + verb + issue id
+ content hash, so two *identical* comment bodies on the *same* issue would have
the second silently swallowed. Prefixing each replayed comment with its original
date (req 9) makes bodies distinct, which removes the hazard as a side effect.

## Export fidelity

Two defects found while probing this migration are **fixed on `main`**
(`9b031908`), both of which the copy depends on:

- `shipit issue view --comments --json` silently truncated at 65,536 bytes when
  stdout was a pipe — the shim exited without draining, so anything past the pipe
  buffer was lost and the JSON ended mid-string. Two of the 322 issues (`SHI-56`,
  `SHI-90`) hit it. `shim-exit.ts` now flushes before exiting.
- The Linear adapter's `ISSUE_FIELDS` did not select `createdAt`, so an issue's
  original creation date was unreadable. Req 9 needs it, and it is now selected.

**Neither is live in the deployed shim yet** — checked from a session container:
the piped form still returns exactly 65,536 bytes and `createdAt` is still absent.
This is the same merge-is-not-a-deploy gap the sequencing constraints call out for
248, and it gates the export: run it only after confirming from a fresh session
that a piped large issue returns its full length and that `createdAt` comes back.
Until then the export must redirect to files and never pipe, which is a sound
habit regardless.

Two smaller traps in the same family: `src/client/hooks/useLazyToolInput.ts`
contains a byte that makes `grep` treat it as binary, so the reference sweep needs
`grep -a` or it will skip a file that does contain a key; and the export must live
outside the git workspace (it holds private planning content) — it is written to
`/persist/linear-export/`, which is per-session, so a child session re-runs it
rather than inheriting it.

## Steps

1. ~~Create the planning repository and confirm the credential reaches it.~~ Done.
2. ~~Land, release and deploy 248.~~ Done.
3. ~~Add `createdAt` to the Linear adapter, and stop the shim truncating piped
   output.~~ Both on `main` (`9b031908`) — but confirm they have reached the
   **deployed** shim before step 4, since the export depends on both.
4. **Export Linear** — 322 keys, `view --comments --json` redirected to a file per
   key, resumable, outside the workspace. Read-only, and it doubles as the
   archive. Already run once; the copy session re-runs it for itself.
5. **Create the labels** the corpus uses — the 20 from Linear with their colors,
   plus the four `priority: …` labels that carry priority across. Workflow state
   contributes none (req 8).
6. **Pilot: copy exactly one issue and stop.** Pick one that exercises the awkward
   parts — a long body, several comments, at least one internal `SHI-N`
   cross-reference, a label and a priority — and copy it end to end. Then look at
   it in the Issues tab and decide whether the body header, the dated comments and
   the rewritten cross-references read the way they should. Everything downstream
   repeats this 322 times, so the format is far cheaper to change here than after.
   The pilot's issue number is consumed either way, so Pass A's consistency check
   accounts for it rather than assuming an untouched repository.
7. **Sync to the latest `main`.** Everything after this point is measured against
   the working tree — the mapping is applied to it, and the sweep rewrites it — so
   the copy starts from a current base rather than a stale one.
8. **Pass A — create all 322 issues** in key order: title, labels, and a body
   carrying its `SHI-N` origin, its original creation date and, for the 15
   sub-issues, its parent. Cross-references stay in their original `SHI-N` form
   for now. Closed issues are closed after creation. Every assigned number is
   appended to the `SHI-N → planning#M` mapping as it comes back, which makes the
   mapping complete and *observed* at the end of this pass.
9. **Pass B — finish the tracker side.** Replay the 1,344 comments with their
   original dates (req 9), and edit the 322 bodies so their internal
   cross-references point at `planning#M`. Both are tracker writes against the
   mapping Pass A produced; **nothing in this repository changes**, so this step
   opens no PR and can run for as long as the pacing requires.
10. **Rewrite every reference in this repository** from that mapping, in one PR
    (req 10): doc `issue:` frontmatter, inline doc mentions, code comments,
    `CLAUDE.md`. 2,623 mentions across 667 files — it conflicts with every open
    branch, so it lands when nothing else is in flight. This is the only step of
    the migration that produces a diff.
11. **Retire Linear** for ShipIt's own planning (req 11): drop the `roadmap`
    declaration from `shipit.yaml` and rewrite `CLAUDE.md`'s tracker-sync section.

Steps 4–9 are the child session's work, with a stop at the pilot for a human look;
they touch only the tracker. Steps 10 and 11 are this repository's, and are the
only two that produce a diff. Splitting there keeps the long, slow, resumable
write job entirely separate from the one atomic PR that has to be timed against
everything else in flight.

**Nothing past step 2 has run.** The only writes made to the planning repository
so far are the reachability probe described under Status — `planning#1`, closed,
plus the handful of labels it minted.

## Tracker names make this a one-time cost

The reference rewrite is expensive enough to be worth paying only once. Writing
the rewritten references in the **name** form (`planning#123`,
[248](../248-declared-issue-trackers/plan.md) reqs 10 and 15) means a later rename
of the planning repository is a one-line `shipit.yaml` edit rather than a second
sweep of 2,600 mentions. Name support is a hard prerequisite for step 6, not an
optimization: without it, step 6 hard-codes a repository slug into most files in
the repository and the whole sweep has to be repeated on the first rename.

## Inline badges stop working unless the linkifier learns the name form

`remarkLinkifyIssues` (`src/client/utils/linkify-issues.ts`) is what turns an
issue reference in chat prose into an in-app badge, and its matcher — a bare
uppercase key, `[A-Z][A-Z0-9]*-\d+` — predates the name form. Today that shows up
as a cosmetic split: `roadmap#SHI-319` badges only the `SHI-319` half and leaves
`roadmap#` as plain text.

After this migration it is not cosmetic. Every reference becomes `planning#57`,
which has no uppercase prefix and no `-digits`, so it does not match at all and
inline badges stop rendering entirely. The paths routed through `resolveIssueRef`
are unaffected — doc frontmatter chips, PR-card chips, markdown hrefs — because
prose is the one surface that never went through the resolver
(`tracker-link.ts:47-49` deliberately handles hrefs only).

Tracked as [SHI-323](https://linear.app/shipit-ai/issue/SHI-323). It is not a
gate on the copy, but it should land before the reference rewrite, or the sweep
will visibly degrade every inline mention in the chat transcript at once.

## After Linear is undeclared

Undeclaring `roadmap` makes every historical `SHI-N` reference fail closed
([248](../248-declared-issue-trackers/requirements.md) req 11) — which is the
point, and why the reference rewrite precedes it. Two residues are accepted rather than
fixed: git history keeps the old references, and issue cards persisted in old
session transcripts point at a tracker that is no longer declared. Those cards
render as static badges and their Undo still resolves, per 248's carve-out.

## Non-goals

- Storing planning issues in ShipIt's public source repository.
- Making GitHub's web UI the primary planning workflow.
- Redirecting the public user bug-report flow into the planning repository.
- Continuous two-way synchronization with Linear.
- Removing Linear support from the product. Linear stays a declared tracker kind
  ([248](../248-declared-issue-trackers/requirements.md) req 3); ShipIt retires it
  for itself by not declaring it.
- Preserving Linear issue *numbers*. The mapping is the authority.
