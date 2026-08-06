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

Declaring the tracker in `shipit.yaml` is split into its own PR so the tab
appears without waiting on this doc's review. What remains after that is the
copy, the reference rewrite, and retiring Linear.

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
| Issue creation date | not settable | Recorded in the body instead (req 9). Not currently even *readable*: `ISSUE_FIELDS` in `trackers/linear/adapter.ts` selects `updatedAt` but not `createdAt`, so the copy needs that one line added first. |
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

The repo-wide sweep sits between them, against a mapping that is already true.

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

## Export fidelity — a shim bug to route around

`shipit issue view --comments --json` **silently truncates at 65,536 bytes when
stdout is a pipe.** The shim exits via `process.exit()` without draining stdout, so
anything past the pipe buffer is lost; the JSON simply ends mid-string. Two of the
322 issues (`SHI-56`, `SHI-90`) hit it. The same output redirected to a file is
complete — `SHI-56` is 116,795 bytes and parses.

The export therefore redirects to files and never pipes. This is not specific to
the migration: any agent running `shipit issue view … --json | jq` on a large
issue gets silently truncated data, which is worth fixing separately.

Two smaller traps in the same family: `src/client/hooks/useLazyToolInput.ts`
contains a byte that makes `grep` treat it as binary, so the reference sweep needs
`grep -a` or it will skip a file that does contain a key; and the export must live
outside the git workspace (it holds private planning content) — it is written to
`/persist/linear-export/`, which is per-session, so a child session re-runs it
rather than inheriting it.

## Steps

1. ~~Create the planning repository and confirm the credential reaches it.~~ Done.
2. ~~Land, release and deploy 248.~~ Done.
3. **Export Linear** — 322 keys, `view --comments --json` redirected to a file per
   key, resumable, outside the workspace. Read-only, and it doubles as the
   archive. Already run once; the copy session re-runs it for itself.
4. **Add `createdAt`** to the Linear adapter's `ISSUE_FIELDS` so an issue's
   original date can be read at all (req 9). One line, and a prerequisite of the
   copy rather than part of it.
5. **Create the labels** the corpus uses — the 20 from Linear with their colors,
   plus the five `priority: …` labels that carry priority across. Workflow state
   contributes none (req 8).
6. **Pilot: copy exactly one issue and stop.** Pick one that exercises the awkward
   parts — a long body, several comments, at least one internal `SHI-N`
   cross-reference, a label and a priority — and copy it end to end. Then look at
   it in the Issues tab and decide whether the body header, the dated comments and
   the rewritten cross-references read the way they should. Everything downstream
   repeats this 322 times, so the format is far cheaper to change here than after.
   The pilot's issue number is consumed either way, so the prediction in step 7
   accounts for it rather than assuming an untouched repository.
7. **Pass A — create all 322 issues** in key order: title, labels, and a body
   carrying its `SHI-N` origin, its original creation date and, for the 15
   sub-issues, its parent. Cross-references stay in their original `SHI-N` form
   for now. Closed issues are closed after creation. Every assigned number is
   appended to the `SHI-N → planning#M` mapping as it comes back, which makes the
   mapping complete and *observed* at the end of this pass.
8. **Rewrite every reference in this repository** from that mapping in one PR
   (req 10): doc `issue:` frontmatter, inline doc mentions, code comments,
   `CLAUDE.md`. 2,623 mentions across 667 files — it conflicts with every open
   branch, so it lands when nothing else is in flight. Because the mapping is
   already true, this step waits for a convenient moment rather than for the rest
   of the copy.
9. **Pass B — replay the 1,344 comments** with their original dates (req 9), and
   edit the 322 bodies to rewrite their internal cross-references. This is the
   larger half by write count and the one with no ordering constraints left.
10. **Retire Linear** for ShipIt's own planning (req 11): drop the `roadmap`
    declaration from `shipit.yaml` and rewrite `CLAUDE.md`'s tracker-sync section.

Steps 3–7 and 9 are the child session's work, with a stop at the pilot for a human
look. Steps 8 and 10 are this repository's. Step 8 needs only Pass A, which is why
the copy is split there.

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

## After Linear is undeclared

Undeclaring `roadmap` makes every historical `SHI-N` reference fail closed
([248](../248-declared-issue-trackers/requirements.md) req 11) — which is the
point, and why step 6 precedes step 7. Two residues are accepted rather than
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
