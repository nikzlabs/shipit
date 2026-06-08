---
title: Tracker-backed priorities (doc decoupling)
description: Move priority and work-status out of design-doc frontmatter into the issue tracker. Docs become reference material with an issue: pointer; the docs list groups by checklist state instead of status.
issue: https://linear.app/shipit-ai/issue/SHI-28
---

# Tracker-backed priorities

Tracks Linear issue **TRACKER-28 — "Decouple priorities from documents."**

> **Scope note.** This doc originally bundled two things: (1) stripping
> `priority`/`status` from doc frontmatter, and (2) a new inline **Issues tab**
> that renders tracker issues so "what's next" stays inside ShipIt. Part (1)
> shipped (TRACKER-28, Done). Part (2) did **not** ship with it and is now tracked
> separately as **TRACKER-67** with its design in
> **`docs/170-inline-tracker-issues`**. This doc is now the reference for the
> decoupling migration only. See "The §1/§2 gap" below — shipping (1) without
> (2) left a live product-principle hole that 170 closes.

## Goal

Priority — and, by extension, work-status — should live where work is actually
coordinated: the issue tracker. A design doc used to do two jobs at once. It was
the **spec** (what we're building and why) *and* the **work item** (its
`status`/`priority` frontmatter decided where it sorted and whether it was
"active"). TRACKER-28 separates those jobs:

- **Docs become reference material.** What the thing is, why, how. They no
  longer carry `priority` or `status`. They keep an optional `issue:` pointer to
  the issue that tracks the work.
- **Issues become the prioritized work queue.** Priority and status live in
  Linear and GitHub Issues.

## Why this matters

The `priority` frontmatter field coupled the spec to its scheduling. A doc can
be a finished, approved design while the *work* is still mid-flight, or
vice-versa — conflating them forces one field to lie. The trackers already model
priority, status, assignee, and cross-PR threading correctly; duplicating a
thinner version in markdown frontmatter means two sources of truth that drift.

### The §1/§2 gap (why docs/170 exists)

Removing priority from docs has a direct consequence dictated by **CLAUDE.md
§1/§2**: the moment priority leaves the docs, the "what's urgent?" question has
no home inside ShipIt. If the answer is "go look in Linear," the work cycle
starts in another tab — which §1 calls a product failure. The original plan was
to ship the decoupling and the inline replacement surface **together** for
exactly this reason.

In practice the decoupling shipped and the inline surface did not, so ShipIt is
currently in that gap: priority is gone from the docs and there is no inline
"what's next" surface. Closing it is `docs/170-inline-tracker-issues` (TRACKER-67) —
read-only, priority-sorted Issues tab with a start-session action. That work is
no longer bundled here; it is tracked on its own issue so this completed
migration stays Done.

## Non-goals (migration)

- **A 1:1 doc↔issue mapping.** One issue can spawn several PRs and reference
  several docs; one doc can be referenced by several issues. The `issue:`
  pointer is a convenience link, not a foreign-key constraint.
- **Replacing the checklist UI.** The sibling `checklist.md` progress badge
  (`docs/114`) stays — it remains the only *in-doc* progress signal and now also
  drives doc grouping.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Priority on docs | **Removed** | The whole point of TRACKER-28. |
| Status on docs | **Removed too** (not just priority) | Status conflates design-maturity with work-state; the tracker owns work-state. |
| Checklist UI | **Kept** | Local, deterministic, network-free progress signal; now also the grouping key for the docs list. |
| Doc↔issue link | **`issue:` frontmatter pointer** | Lets ShipIt resolve the linked issue and cross-navigate (jump-to-issue) without a 1:1 constraint. |
| Docs list grouping (no status) | **By checklist state** — Active (incomplete or no checklist) vs Done (100%), Done collapsed | Checklist is local and needs no tracker round-trip to group. |
| Linear `issue:` pointer | **Full URL / fully-qualified always** | Unambiguous across any number of Linear workspaces a deployment might wire up. |

## Frontmatter after this change

```yaml
---
title: Tracker-backed priorities        # unchanged (optional; defaults to filename)
description: One-line summary.           # unchanged (docs/138)
---
```

- **Removed:** `status`, `priority`.
- **`issue:`** accepts a tracker-qualified pointer.
  - **Linear: always a full URL without the title slug** (e.g.
    `https://linear.app/<workspace>/issue/TRACKER-28`). Bare `TRACKER-28` is *not*
    accepted — the full URL keeps the pointer unambiguous if a deployment ever
    wires up more than one Linear workspace.
  - **GitHub:** `owner/repo#123` or a full issue URL.
  - The tracker is inferred from the shape; an explicit `tracker:` is
    unnecessary.
- A doc with **no** `issue:` is pure reference.

## Migration of existing docs

The existing docs all carried `status:` and (some) `priority:`. "Inert" had to
be specified precisely, because `status` was load-bearing across both layers and
a half-migrated repo would render wrong:

- **Server:** `parseStatusFromFrontmatter` and the entire `customStatus` concept
  (`markdown.ts`, `domain-types.ts`) are **deleted**, not left dangling. Every
  `status`/`priority` reader is removed in the same change as the parser, so no
  caller is left expecting a value the parser no longer produces.
- **Field stripping vs parser change — ordering.** The parser/type change and
  the field-stripping cleanup pass must land **together** (one PR), or the
  stripping must come **first**. The forbidden order is "parser stops reading
  status while docs still carry it AND code still keys off it" — the
  half-migrated state where the docs list mis-buckets every doc at once.
- A doc that still physically contains a `status:`/`priority:` line after the
  change is harmless: the new parser simply doesn't read those keys. The cleanup
  pass removes the dead lines and adds `issue:` pointers where a tracking issue
  exists.

CLAUDE.md and `src/server/shipit-docs/design-docs.md` describe the new
frontmatter (this is agent-facing behavior) and were updated as part of the
migration.

## Docs list (DocsViewer) after this change

- **No** priority badge, **no** priority sort, **no** status buckets.
- Grouped by **checklist state**:
  - **Active** — checklist incomplete, *or* no checklist at all.
  - **Done** — checklist 100% complete; rendered in a collapsed group.
- Known edge case: a finished reference doc with no checklist stays in
  **Active** forever (nothing marks it complete). Acceptable; a possible
  refinement is to fold docs whose linked issue is *closed* into Done, but that
  reintroduces a tracker dependency into grouping and is deferred.

## The tracking/sibling-suppression key must be re-based off status

This was a correctness trap, not a cosmetic change. `src/client/utils/doc-paths.ts`
decides whether a doc is "tracked" and whether a `checklist.md` row is
suppressed because its `plan.md` sibling exists (`isTracked`,
`hasTrackedSibling`, `hasTrackedPlanSibling`), and all three keyed solely off
`status`/`customStatus`. Removing status without changing this makes
`isTracked()` return `false` for every doc: checklist rows stop being suppressed
(every feature dir renders `plan.md` *and* `checklist.md` as two rows) and any
tracked-vs-other split collapses.

The replacement key does not depend on `status` — it keys off **doc structure**:

- a doc is "tracked" if it is a `plan.md` (the feature-directory primary), or
  carries an `issue:` pointer, or has a `checklist.md` sibling; and
- a `checklist.md` is suppressed when a `plan.md` exists in the same directory —
  a structural test (`basename`/`dir`) that needs no frontmatter at all.

`doc-paths.ts` and its test `doc-paths.test.ts` were updated in the same change.

## Data flow

```
docs/NNN/plan.md (issue: TRACKER-28)
        │ markdown.ts: parse title/description/issue + checklist counts (no status/priority)
        ▼
   DocsViewer: checklist-state groups + jump-to-issue chip from issue:
```

## Key files

> **Type-removal blast radius.** Dropping `DocStatus`/`DocPriority` and
> `customStatus` from `domain-types.ts` broke *every* importer. The full set
> handled in the migration: `markdown.ts`, `doc-paths.ts` (+ `doc-paths.test.ts`),
> `markdown-frontmatter.ts`, `MarkdownSelectionComments.tsx`, `DocsViewer.tsx`
> (+ `DocsViewer.test.tsx`), `markdown.test.ts`, and `domain-types.ts` itself.

Server:
- `src/server/orchestrator/markdown.ts` — deleted `parseStatusFromFrontmatter` +
  the `customStatus` path; stopped parsing `status`/`priority`; parses `issue:`;
  keeps checklist aggregation.
- `src/server/shared/types/domain-types.ts` — removed `DocStatus`, `DocPriority`,
  `DocEntry.status`, `DocEntry.priority`, `DocEntry.customStatus`; added
  `DocEntry.issue`.
- `src/server/shipit-docs/design-docs.md` — frontmatter schema (drop
  status/priority, document `issue:`).

Client:
- `src/client/components/DocsViewer.tsx` (+ `DocsViewer.test.tsx`) — removed
  priority/status UI + sort; checklist-state grouping; jump-to-issue chip.
- `src/client/utils/doc-paths.ts` (+ `doc-paths.test.ts`) — re-based
  `isTracked`/`hasTrackedSibling`/`hasTrackedPlanSibling` off doc structure.
- `src/client/utils/markdown-frontmatter.ts` — stopped surfacing
  `status`/`priority`/`customStatus` in the doc modal.
- `src/client/components/MarkdownSelectionComments.tsx` — dropped the removed-type
  imports.

Docs/config:
- `CLAUDE.md` — rewrote the "Design docs" + frontmatter sections.

## Relationship to existing docs

- **`docs/170-inline-tracker-issues`** (TRACKER-67) — the inline Issues tab that was
  originally part 2 of this doc. It is the surface that closes the §1/§2 gap this
  migration opened; the "issues side" design moved there in full.
- **`docs/156-issue-to-session`** (TRACKER-43) — inbound **push** trigger from the
  tracker. 156 owns push; `docs/170` owns the in-app **pull** picker. Both share
  the `headless-sessions.create({ issueRef })` seeding primitive.
- **`docs/114-tracked-doc-checklist`** (done) — the checklist badge this
  migration promoted to the docs grouping key.
- **`docs/080-unify-features-docs`**, **`docs/138-doc-frontmatter-description`**
  (done) — the frontmatter/doc-discovery system amended here.
