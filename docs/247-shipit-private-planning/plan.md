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

The last open gate — the merge-is-not-a-deploy one — is now closed. The two shim
and adapter fixes the export depends on (`9b031908`) have reached the **deployed**
shim, confirmed from a session container on 2026-08-07: `SHI-56` and `SHI-90`,
the two issues that previously came back at exactly 65,536 bytes through a pipe,
now return 119,606 and 87,179; and `createdAt` is present on the issue and on
every comment.

**Steps 4 through 8 have run** (2026-08-07). The corpus is exported to
`/persist/linear-export/` — 330 issues, 0 misses — the labels exist, the pilot
was copied as `planning#2` and signed off at gate 1, and **Pass A has created all
330 issues**. `shipit issue comment edit` also shipped and deployed in between,
which removes the one irreversible step this plan was built around; the
consequences are folded into gate 1 below.

Pass A ran in 33 minutes with no failures. The mapping is
[`mapping.tsv`](./mapping.tsv), committed here because step 10's sweep is
generated from it and gate 3 reviews that diff:

| Check | Result |
|---|---|
| Entries | 330, one per exported key, none missing or extra |
| Duplicates | none, by key or by number |
| Order | keys ascending, numbers monotonic (req 12) |
| Range | `planning#3` – `planning#332` |
| Offset | uniformly `+2` — the predicted `SHI-N → planning#(N+2)` held for all 330 |
| Open / closed | 93 open, 237 closed, exactly matching the Linear split |
| Spot-check | 10 sampled issues: title, state, labels and header all correct |

**Waiting at human gate 2.** Nothing reads the mapping until it is confirmed —
see the gate below for what to look at and why it is worth the stop.

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

A full read-only export ran against Linear (330 keys, `SHI-1…SHI-330`; no gaps,
`SHI-331` and above do not exist). The corpus, as of **2026-08-07**:

| Surface | Count |
|---|---|
| Linear issues | 330 |
| Comments | 1,390 (across 240 issues; 90 have none) |
| Issue body text | 516 KB |
| Comment text | 1.17 MB |
| Distinct labels | 20 |
| Issues with a parent (sub-issue) | 15 |
| Issues with an assignee | 75 — all one person |
| Comment authors | 1 (`nicolas.zherebtsov`, all 1,390) |

Status spread: Done 226, Backlog 79, Canceled 10, In Progress 7, Todo 7,
Duplicate 1. Priority spread: none 222, Medium 42, High 31, Low 27, Urgent 8.

The reference surface in this repository:

| Surface | Count |
|---|---|
| Distinct `SHI-N` keys referenced | 268 |
| Total mentions | 2,797 across 686 files |
| — in `src/` | 1,809 across 398 files |
| — in `docs/` | 907 across 259 files |
| Docs with an `issue:` frontmatter pointer | 196 |
| Files containing a `linear.app` URL | 224 |

And — the surface the earlier estimate missed entirely — **the corpus references
itself**: 1,174 `SHI-N` mentions and 122 `linear.app` URLs live *inside* issue
bodies and comments. Those have to be rewritten too, or the migrated tracker is
full of pointers back to the system being retired.

**Every number here is a measurement with a date on it, and the corpus is live.**
The first export, one day earlier, found 322 issues and 1,344 comments; eight
issues and 46 comments arrived in between. So these figures size the work — they
are not a checksum. Pass A's completeness check must come from the export it
actually ran against, never from a count written down here.

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
comments cross-reference each other (1,174 mentions). Writing them first and
fixing them later would mean a second edit pass over the whole corpus. That is now
merely wasteful rather than impossible: `comment edit` shipped on 2026-08-07, so a
stale cross-reference in a comment is repairable. Getting it right on the first
write is still the design — 1,390 avoidable edits is not a plan — but it is no
longer the difference between correct and permanently wrong.

The way out is to **split the copy in two, so the mapping is observed rather than
predicted**. Creating an issue is what fixes its number, and nothing about a
comment or a cross-reference influences it. So:

- **Pass A** creates all 330 issues — title, body header, labels, and the body
  text with its cross-references still in their original `SHI-N` form. Every
  number is now assigned and recorded.
- **Pass B** replays the 1,390 comments and edits the 330 bodies, rewriting
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

### Order is a requirement, which constrains the driver

Req 12 requires that of any two migrated issues, the one with the lower Linear key
gets the lower planning number. Numbers cannot be preserved, but their *order*
can, and that is what keeps "later issue, higher number" reading correctly
afterwards.

GitHub assigns numbers in creation order, so this reduces to: create strictly in
ascending key order. Two consequences for Pass A that would otherwise be tempting
to get wrong:

- **No parallelism.** Issuing creates concurrently to go faster would interleave
  their arrival at GitHub and scramble the order. Pass A is sequential, which is
  also what the pacing in *Write volume* wants anyway.
- **A failure halts rather than skips.** Skipping a failed create and retrying it
  at the end would place it after issues with higher keys, breaking the ordering
  for that one issue permanently — numbers cannot be reassigned. On a failure,
  stop, resolve it, and resume from that key.

Unrelated issues opened in the repository between keys would leave gaps but not
reorder anything, so gaps are acceptable and holes in the number sequence are
expected regardless (`planning#1` is the write probe, and the pilot consumes one).

## Write volume and pacing

The copy is roughly **2,000 brokered writes**: 330 creates + 1,390 comments + ~230
closes + ~26 label creations. Three consequences, each of which shapes the driver:

1. **No retry or backoff exists.** `trackers/github/adapter.ts` has no handling
   for `429`/secondary-rate-limit responses — a throttled request surfaces as a
   plain error. GitHub rate-limits content creation, so the driver must pace
   itself and retry on its own. **How long the whole thing takes is not a
   constraint** — it can run unattended overnight — so pace conservatively. The
   reason to pace is to avoid failures, not to finish sooner.

   **Now measured, by hitting the wall.** Pass A's 330 creates + 237 closes ran
   at ~1s spacing with no trouble. Pass B, at the same pacing, died after roughly
   **870 further writes in about 15 minutes** — GitHub's secondary limit on
   content creation, which allows on the order of 500 an hour. The sustainable
   pace is therefore **~8s between writes** (~450/hour), which is what `pass-b.py`
   uses, with a 15-minute backoff-and-retry on a 403. At that rate the comment
   replay is a ~2-hour job, which is fine — duration was never the constraint.

   **The 403 does not say "rate limit".** The shim reports it as *"the repository
   either does not exist or the connected GitHub credential cannot access it"* —
   the same text as a genuinely missing repo or a revoked token, which sends you
   to check the slug and the credential when the answer is "wait 15 minutes". The
   distinguishing signal is that **reads keep working**: a secondary limit throttles
   content creation only. Recorded as a shim finding; the driver retries rather
   than trusting the message.
2. **It must be resumable — and "per issue" is the wrong granularity.** The
   completion marker is written once an issue's comments have *all* landed, but a
   failure happens **mid-issue**: the rate limit hit `SHI-140` after 3 of its 9
   comments. A resume keyed only on the marker would have re-posted all 9 and left
   3 duplicates, silently. `pass-b.py` therefore re-reads the first issue of each
   run and skips any comment whose rendered body is already present — one extra
   read per run, since every issue *after* the failure was never touched. Matching
   on the body rather than on a count keeps it idempotent. Idle cleanup is not a hazard: `dispose()`
   refuses to reap a runner whose agent is running unless explicitly forced
   (`container-session-runner.ts:2521`), so an unattended overnight pass survives.
3. **Every write posts a persisted transcript card.** `api-routes-issues.ts` emits
   and *persists* an `issue_write_card` per write, with no suppression flag. ~2,000
   cards in one session's history is not something to inflict on a session anyone
   wants to reopen. The copy should therefore run in its **own child session**,
   archived when it finishes.

   **It didn't.** Passes A and B were run in the planning session itself, because
   the export was started there and each subsequent step simply continued. By the
   time it was noticeable the session held ~950 write cards and the user could no
   longer see the conversation between them. Nothing was lost — the run is
   unaffected — but the advice above was written before any of it existed and then
   not followed, which is the more useful thing to record. The moment to act was
   the *start of Pass B*, when the volume went from ~330 cards to ~1,700; that is
   the decision point a future copy should watch for, not the start of the whole
   job.

The write-dedup window (`handleWrite`) keys on session + tracker + verb + issue id
+ content hash, so two *identical* comment bodies on the *same* issue would have
the second silently swallowed. Prefixing each replayed comment with its original
date (req 9) makes bodies distinct, which removes the hazard as a side effect.

## Export fidelity

Two defects found while probing this migration are **fixed on `main`**
(`9b031908`), both of which the copy depends on:

- `shipit issue view --comments --json` silently truncated at 65,536 bytes when
  stdout was a pipe — the shim exited without draining, so anything past the pipe
  buffer was lost and the JSON ended mid-string. Two of the 330 issues (`SHI-56`,
  `SHI-90`) hit it. `shim-exit.ts` now flushes before exiting.
- The Linear adapter's `ISSUE_FIELDS` did not select `createdAt`, so an issue's
  original creation date was unreadable. Req 9 needs it, and it is now selected.

**Both are now live in the deployed shim** — re-checked from a session container
on 2026-08-07, after an earlier check had found neither. `SHI-56` and `SHI-90`
pipe at 119,606 and 87,179 bytes rather than 65,536, and `createdAt` comes back on
the issue and on every comment. The export should still redirect to files rather
than pipe, which is a sound habit regardless of the fix.

**Comments come back newest-first.** `view --comments --json` returns them in
strictly descending `createdAt` order — SHI-56's 77 run from `2026-08-07` down to
`2026-06-17`. Pass B posts them in conversation order, so it must reverse the
array. Posting as-returned would invert all 1,390 conversations while every date
header still read correctly, which is exactly the kind of error a spot-check
passes over.

**Three labels are stuck with the wrong color, and the shim cannot fix them.**
`label create` refuses a name that already exists in any casing, and there is no
`label edit` or `label delete` — so a label that exists wrongly stays wrong:

| Wanted | Actually there | Affects | How it got there |
|---|---|---|---|
| `Feature` `#BB87FC` | `Feature` `#ededed` | 81 issues | Minted by the reachability probe with no `--color` |
| `Bug` `#EB5757` | `bug` `#d73a4a` | 66 issues | GitHub's default `bug` label — collides case-insensitively |
| `priority: high` `#D93F0B` | `priority: high` `#ededed` | 31 issues | Same probe |

All three are cosmetic: `--label` resolves case-insensitively, so `--label Bug`
applies the existing `bug`, and `mapGitHubPriority` reads the name, never the
color. The copy is unaffected.

**Nothing here has to be settled before the migration.** A GitHub label is an
object that issues reference; its name and color are properties of that object,
not values stamped onto each issue when the label is applied. So recoloring
`Feature` fixes all 81 issues at once whenever it happens, and renaming `bug` to
`Bug` carries across every issue already holding it. Deferring costs nothing and
requires no re-copy. Two paths, whenever it is wanted: the planning repo's label
settings by hand (a repo-settings page — one of the narrow legitimate link-outs),
or a `label edit` verb on the shim, which is the durable fix (docs/177).

What is *not* recoverable is a label that was never applied — which is why step 5
had to happen before Pass A and the colors did not. Mention it at gate 1 only so
the grey swatch reads as known rather than as a copy defect.

The lesson generalizes past the colors: a **probe writes into the same namespace
the migration will use**, and its leftovers are not always removable through the
product. `planning#1` is on the checklist to delete; these three labels are the
part of that probe ShipIt itself cannot clean up.

**The sub-issue parent is in the export, under a name that doesn't look like it.**
The adapter maps Linear's `parent` onto `parentIdentifier`, already in the docs/248
name form (`roadmap#SHI-113`) — so a check for a `parent` key finds nothing and
concludes the data is missing. All 15 sub-issues carry it.

Two smaller traps in the same family: `src/client/hooks/useLazyToolInput.ts`
contains a byte that makes `grep` treat it as binary, so the reference sweep needs
`grep -a` or it will skip a file that does contain a key; and the export must live
outside the git workspace (it holds private planning content) — it is written to
`/persist/linear-export/`, which is per-session, so a child session re-runs it
rather than inheriting it.

## The copy format, as piloted

`SHI-145` was copied to `planning#2` on 2026-08-07 — chosen because it exercises
every awkward part at once: a 4 KB body, four comments, two internal
cross-references, three labels (including `Bug`, which hits the case collision),
`High` priority (the grey label), and a closed state.

**Issue body** — a one-line header, then a rule, then the original body verbatim:

```markdown
> Migrated from Linear **SHI-145**, created 2026-06-14.

---

<original body>
```

The header deliberately carries **no link back to Linear**. Pass B rewrites the
122 `linear.app` URLs already in the corpus precisely because they die when Linear
is retired; minting 330 new ones in the headers would be self-defeating. Sub-issues
add `Sub-issue of SHI-224.` to the header line, which Pass B rewrites like any
other cross-reference.

**Comments** — the same shape, one blockquote line carrying the original date:

```markdown
> _Originally posted 2026-06-14._

<comment body>
```

**Everything else round-tripped as designed.** `--label Bug` resolved onto the
existing lowercase `bug`; `--label "priority: high"` read back as
`priority: High` through `mapGitHubPriority`; `status completed` closed it.

**Editing a body later works, and was verified rather than assumed.** Pass B
depends on it entirely — the pilot is copied with its cross-references still
reading `SHI-31`, and only Pass B can fix them, once the mapping exists.
`shipit issue edit planning#2 --body-file …` replaced the body, left labels,
priority and closed state untouched, and restored the original byte-for-byte on a
second edit. So a body is not a one-way write; the sequencing in this plan is a
matter of doing the work once rather than of what is possible.

That probe also exposed **two traps in the rewrite itself**:

- **The header's own key must survive.** `> Migrated from Linear **SHI-145**` is
  the origin marker required by req 9. A blanket `SHI-N → planning#M` sweep would
  rewrite it into a pointer at itself and destroy the provenance the header exists
  to carry. The rewrite has to skip the header line, or run only below the rule.
- **A Linear reference is usually a markdown link, not a bare key.** 90 of the 122
  `linear.app` URLs are `[SHI-31](https://linear.app/…/SHI-31/slug)`, where the key
  appears *twice* — once as the label, once inside the URL. Rewriting the two
  occurrences independently yields `[planning#57](https://linear.app/…/planning#57/slug)`:
  a live link to a dead system wearing the right name. The link has to be rewritten
  as a unit. The remaining 21 are bare URLs.

Three things the pilot surfaced that the plan did not have:

- **980 bare `#N` references, across 216 issues** — overwhelmingly ShipIt's own
  "Resolved by ShipIt on merge of PR #1354" comments. In Linear these are inert
  text. Inside a GitHub repository they are references, and they resolve against
  **the planning repo**, not `nikzlabs/shipit` where the PR actually lives. Pass B
  must qualify them to `nikzlabs/shipit#1354`, which is unambiguous in both
  renderers. This is the same class of miss as the corpus referencing itself: a
  string that was inert in Linear becomes active in GitHub.
- **Five titles carry a cross-reference** (`SHI-79`, `SHI-144`, `SHI-145`,
  `SHI-164`, `SHI-259`). Pass B rewrites bodies and comments; titles need the same
  treatment, and `issue edit --title` already exists.
- **Comment order is backwards between the two trackers.** Linear returns
  newest-first, GitHub oldest-first. The reversal Pass B applies is a *Linear-side*
  correction — verifying the result must not reverse a second time. The pilot's
  four comments read in the right order on both sides.

Pass A itself is [`pass-a.py`](./pass-a.py), committed beside this doc so the
format gate 1 signs off on is reviewable as code rather than as prose. It renders
in ascending key order, runs strictly sequentially, halts on the first failure,
appends to the mapping as each number comes back, and resumes from that mapping if
interrupted. `--dry-run` renders and validates all 330 while writing nothing —
every title non-empty, every label resolving against the repository's 32, every
status type mapped, every header well-formed. Building it surfaced three more
findings:

- **`SHI-1` … `SHI-4` are Linear's own onboarding boilerplate**: "Get familiar
  with Linear", "Set up your teams", "Connect your tools", "Import your data",
  all Canceled on the workspace's creation day. Real work starts at `SHI-5`.
  They are copied anyway. Skipping them would put a hole in the mapping and
  strand any reference to them, for the sake of four closed issues nobody sees in
  the default view; a faithful 1:1 copy is worth more than a tidier repository.
- **27 issues have no description at all.** Rendering the header, a rule and then
  nothing leaves a dangling divider, so the rule is emitted only when there is a
  body under it.
- **Only 89 of the ~118 `linear.app` URLs point at an issue.** The rest are
  attachment uploads, Linear's own documentation, a Slack invite and design-review
  links. Pass B must rewrite the issue links and **leave the others alone** — they
  have no key to map, and a blanket URL rewrite would mangle them. The upload
  links die with the workspace either way; nothing can be done about that, and the
  export is the archive.

## Where a human has to look

Four points in this migration need a person, not a passing test. They are marked
**Human gate** in the steps below. Each one is here because the check is either a
judgement call or a last cheap moment before something becomes expensive or
impossible to undo — not merely because it is important.

Everything else is the agent's to verify and report: the corpus counts, the
mapping's completeness, that ordering is monotonic (req 12), that every create
returned the expected number, that lint and typecheck pass. Those are assertions,
and an assertion that needs a human is a missing assertion.

### Gate 1 — the pilot, before the format is repeated 330 times

**Look at:** `planning#2` in the Issues tab — the copied `SHI-145`. Specifically —

- Does the body header read well? It carries the `SHI-N` origin and the original
  creation date, and it will sit at the top of all 330.
- Do the replayed comments read as a conversation? Each is prefixed with its
  original date, and the prefix format is what makes a two-year-old discussion
  legible or noisy.
- Do labels and the `priority: …` label look right, and does the priority read
  back correctly in the list? This is also where the three known-wrong label
  colors show up — `bug` lowercase and off-red, `priority: high` grey.
- How do the bare `#N` PR references render? The pilot's comments mention
  `#1354` and `#1453`, which live in `nikzlabs/shipit`, not here. This is the
  finding that most needs a look at a real rendered issue.

**Not checkable at this gate:** whether a rewritten cross-reference *resolves*
when clicked. A single piloted issue has nothing to point at — its targets are
created in Pass A. The pilot is therefore copied in Pass A's form, with
cross-references still reading `SHI-31`; judging the rewritten form is gate 2's
job, once the mapping exists. This gate was originally written as if one issue
could check resolution, which by construction it cannot.

**Why a human:** every one of these is "does this read well", which no test
asserts.

**Cost of getting it wrong: no longer permanent.** This gate was written when a
comment, once posted, could not be changed — the shim had no comment-edit, and
deletion existed only through a write card's Undo, which is gone once the copy
session's cards age out. `shipit issue comment edit` shipped on 2026-08-07
(docs/177) and is **live in the deployed shim**, verified by editing a comment on
`planning#1` end to end. A wrong comment format is now a second pass over 1,390
comments rather than a permanent defect, and wall-clock is not a constraint here,
so that is a real remedy rather than a theoretical one.

The gate stays, for a smaller reason than before: it is far cheaper to read one
issue than to re-drive 1,390 writes. But it is no longer a one-way door, and it
should not be treated as one — the remaining irreversible act in this migration
is creating the issues themselves, since a number, once assigned, is never reused.

### Gate 2 — after Pass A, before the reference sweep

**Look at:** the tracker list, and the mapping artifact. Specifically —

- Are there 330 issues, and does spot-checking a handful against their Linear
  originals show the right title, labels and open/closed state?
- Does the list read in a sensible order — lowest Linear key first (req 12)?
- Does the mapping cover every key, with no duplicates?
Cross-reference *resolution* is still not checkable here, and moving it to this
gate (as an earlier revision did) was wrong: Pass A deliberately leaves references
in their `SHI-N` form, so nothing is rewritten until Pass B. The check belongs to
the post-Pass-B round trip, which is the first moment a rewritten reference exists.

**Why a human:** the agent asserts all of this, but the sweep that follows rewrites
2,797 references in 686 files from this mapping. A wrong mapping propagates into
every file in the repository, and the mistake is far cheaper to catch as 330 rows
than as a 686-file diff.

**Cost of getting it wrong:** a bad mapping means a bad sweep, and the sweep is
the migration's only diff.

### Gate 3 — the reference sweep PR

**Look at:** the diff, with attention to what a mechanical rewrite gets wrong
rather than to what it gets right —

- Did anything get rewritten that shouldn't have? `SHI-N`-shaped text inside a
  string literal, a test fixture, or a historical PR reference is not necessarily
  a pointer to migrate. `notable-files.test.ts` already contains a deliberately
  stale path of this kind.
- Did the doc `issue:` frontmatter land in the name form (`planning#57`) rather
  than a backend address?
- Was `src/client/hooks/useLazyToolInput.ts` included? It is flagged binary by
  `grep`, so a sweep without `grep -a` silently skips it.

**Why a human:** this is normal PR review, but at a size where "looks fine" is not
a reading. Review it by *category* — frontmatter, code comments, prose, fixtures —
rather than file by file.

**Cost of getting it wrong:** merged into `main` and conflicting with every open
branch, so a follow-up correction is its own disruptive sweep.

### Gate 4 — before retiring Linear

**Look at:** whether anything still depends on Linear that this plan hasn't
accounted for. Undeclaring `roadmap` makes every remaining `SHI-N` reference fail
closed — which is intended, but only *after* the sweep has rewritten them.

**Why a human:** the check is "are we actually done with it", which is about how
the tracker is used day to day, not about what the code does.

**Cost of getting it wrong:** low and recoverable — re-declaring `roadmap` in
`shipit.yaml` restores access. This gate is a pause, not a point of no return.

## Steps

1. ~~Create the planning repository and confirm the credential reaches it.~~ Done.
2. ~~Land, release and deploy 248.~~ Done.
3. ~~Add `createdAt` to the Linear adapter, and stop the shim truncating piped
   output, then confirm both have reached the **deployed** shim.~~ Done —
   `9b031908` is live, verified from a session container on 2026-08-07.
4. ~~**Export Linear** — 330 keys, `view --comments --json` redirected to a file
   per key, resumable, outside the workspace. Read-only, and it doubles as the
   archive.~~ Done 2026-08-07 — `/persist/linear-export/`, 330 files, 0 misses,
   44 seconds. `/persist` is per-session, so a different session re-runs
   `fetch.sh` rather than inheriting the output.
5. ~~**Create the labels** the corpus uses — the 20 from Linear with their colors,
   plus the four `priority: …` labels that carry priority across. Workflow state
   contributes none (req 8).~~ Done 2026-08-07 — 21 created, all 24 now resolve.
   Three arrived with the wrong color and **cannot be corrected through the
   shim**; see below.
6. ~~**Pilot: copy exactly one issue and stop.**~~ Done 2026-08-07 — `SHI-145` →
   `planning#2`, chosen because it exercises a 4 KB body, four comments, two
   cross-references, three labels including the colliding `Bug`, `High` priority
   and a closed state. The format it established is written up under *The copy
   format, as piloted*. **Waiting at Human gate 1.** Everything downstream repeats
   this 330 times, so the format is far cheaper to change now than after. The
   pilot consumed `planning#2`, so Pass A's consistency check starts from #3
   rather than assuming an untouched repository.
7. **Sync to the latest `main`.** Everything after this point is measured against
   the working tree — the mapping is applied to it, and the sweep rewrites it — so
   the copy starts from a current base rather than a stale one.
8. **Pass A — create all 330 issues** in ascending key order (req 12): title,
   labels, and a body carrying its `SHI-N` origin, its original creation date
   and, for the 15 sub-issues, its parent. Cross-references stay in their original
   `SHI-N` form for now. Closed issues are closed after creation. Every assigned
   number is appended to the `SHI-N → planning#M` mapping as it comes back, which
   makes the mapping complete and *observed* at the end of this pass.
   **Human gate 2 at the end of this step**, before anything reads the mapping.
9. **Pass B — finish the tracker side.** Replay the 1,390 comments with their
   original dates (req 9) — **reversing each issue's array, since the Linear
   export returns comments newest-first** — and rewrite references in the 330
   bodies, the 1,390 comments and the **5 titles** that carry one. Three rewrites,
   not one: internal `SHI-N` → `planning#M` from the mapping (1,174), `linear.app`
   URLs → the same (the **89** that point at an issue; the other ~29 are uploads,
   Linear docs and a Slack invite, with no key to map), and the **980 bare `#N`**
   PR references → the qualified `nikzlabs/shipit#N`, since inside this repository
   a bare `#N` points here rather than at the source repo. All tracker writes
   against the mapping Pass A produced; **nothing in this repository changes**, so
   this step opens no PR and can run for as long as the pacing requires.

   [`pass-b.py`](./pass-b.py) implements it, and
   [`test-rewrite.py`](./test-rewrite.py) pins the rewrite rules against the traps
   this migration found the hard way — the markdown link rewritten as a unit, the
   non-issue URLs left alone, the header's own key surviving, and `#1354` inside
   inline or fenced code not being a reference at all. That last one matters at
   this volume: 980 bare-number rewrites across a corpus full of shell snippets
   would otherwise corrupt code samples in a way no count would reveal.
10. **Rewrite every reference in this repository** — **Human gate 3.** From that mapping, in one PR
    (req 10): doc `issue:` frontmatter, inline doc mentions, code comments,
    `CLAUDE.md`. 2,797 mentions across 686 files — it conflicts with every open
    branch, so it lands when nothing else is in flight. This is the only step of
    the migration that produces a diff.
11. **Retire Linear** for ShipIt's own planning — **Human gate 4.** (req 11): drop the `roadmap`
    declaration from `shipit.yaml`, and rewrite every part of `CLAUDE.md` that
    names Linear as the destination — see below, it is more than one section.

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

## `CLAUDE.md` names Linear in seven places, not one

This repository's own guideline — *create a tracker issue for every design doc* —
is written into `CLAUDE.md` with Linear as the named destination, so retiring
Linear means rewriting the guideline, not just the config. It spans three
sections:

| Line | What it says |
|---|---|
| 306 | `issue:` frontmatter shape — "Linear = full URL without the title slug" |
| 326 | Sync the tracker item; "not `gh issue`, `gh api`, or a Linear MCP" |
| 328 | "Doc has an `issue:` pointer (Linear *or* GitHub)" |
| 329 | "Create a **Linear** issue to track it… it defaults to Linear… If Linear isn't connected, the command says so" |
| 333 | The where-does-a-fact-live test routes coordination facts to "**Linear**" |
| 340 | The surface table's row is "**The Linear issue**" |
| 342 | "let Linear hold live state and cross-issue relations" |

Most of these become `planning` at step 11. The right end state is mostly
*tracker-neutral* wording — "the tracked issue" rather than a named backend —
since 248 made the destination a declaration rather than a built-in; only the
places that must name a destination should say `planning`.

**Two of them are already wrong, before any migration**, and are tracked
separately as [SHI-324](https://linear.app/shipit-ai/issue/SHI-324):

- Line 329's "it defaults to Linear" describes behaviour 248 req 13 deleted.
  `create` now requires `--tracker NAME`, so an agent following this line runs a
  bare `create` and has it rejected.
- Line 306's `issue:` guidance predates req 15's name form, so it teaches the
  backend-address shape as the one to write.

Those two are a live defect in instructions every turn loads, so they are worth
fixing now rather than waiting for step 11.

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
