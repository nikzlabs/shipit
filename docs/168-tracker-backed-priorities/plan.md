---
status: planned
priority: high
description: Move priority (and work-status) out of design-doc frontmatter and into issue trackers. Docs become reference material with an issue: pointer; a new inline Issues tab renders Linear and GitHub issues in tracker sub-tabs, sorted by priority, with start-session per row.
---

# Tracker-backed priorities

Tracks Linear issue **SHI-28 — "Decouple priorities from documents."**

## Goal

Priority — and, by extension, work-status — should live where work is actually
coordinated: the issue tracker. Today a design doc does two jobs at once. It is
the **spec** (what we're building and why) *and* the **work item** (its
`status` and `priority` frontmatter decide where it sorts and whether it's
"active"). SHI-28 separates those jobs:

- **Docs become reference material.** What the thing is, why, how. They no
  longer carry `priority` or `status`. They keep an optional pointer to the
  issue that tracks the work.
- **Issues become the prioritized work queue.** Priority and status live in
  Linear (internal planning) and GitHub Issues (external bug reports), and
  ShipIt renders them inline so "what should I work on next?" never sends the
  user to another tab.

## Why this matters

The `priority` frontmatter field couples the spec to its scheduling. A doc can
be a finished, approved design (`status: done`) while the *work* is still
mid-flight, or vice-versa — conflating them forces one field to lie. The
trackers already model priority, status, assignee, and cross-PR threading
correctly; duplicating a thinner version of that in markdown frontmatter means
two sources of truth that drift.

Removing priority from docs has a direct consequence dictated by **CLAUDE.md
§1/§2**: the moment priority leaves the docs, the "what's urgent?" question has
no home inside ShipIt. If the answer is "go look in Linear," the work cycle
starts in another tab — which §1 calls a product failure. So this feature is
necessarily *two* changes that ship together:

1. Strip priority/status from docs (the decoupling).
2. Render issues + priority inline in a new Issues tab (the surface that
   replaces what the docs used to provide).

You cannot do (1) without (2) without violating the product principles.

## Non-goals

- **Editing issues from inside ShipIt (v1).** The Issues tab is read + start a
  session. Setting priority, changing status, or commenting on an issue from
  ShipIt is a deliberate follow-up, not v1.
- **A 1:1 doc↔issue mapping.** One issue can spawn several PRs and reference
  several docs; one doc can be referenced by several issues. The `issue:`
  pointer is a convenience link, not a foreign-key constraint.
- **Replacing the checklist UI.** The sibling `checklist.md` progress badge
  (`docs/114`) stays — it remains the only *in-doc* progress signal and now
  also drives doc grouping.
- **Mutating issue status from ShipIt** (e.g. moving an issue to "In Progress"
  when a session starts). Out of scope here; overlaps `docs/156`.

## Design decisions

These were settled in the design conversation that produced this doc:

| Decision | Choice | Rationale |
|---|---|---|
| Priority on docs | **Removed** | The whole point of SHI-28. |
| Status on docs | **Removed too** (not just priority) | Status conflates design-maturity with work-state; the tracker owns work-state. |
| Checklist UI | **Kept** | Local, deterministic, network-free progress signal; now also the grouping key for the docs list. |
| Doc↔issue link | **`issue:` frontmatter pointer** | Lets ShipIt resolve the linked issue, show a status/priority chip on the doc, and cross-navigate (jump-to-issue, start-session) without a 1:1 constraint. |
| Docs list grouping (no status) | **By checklist state** — Active (incomplete or no checklist) vs Done (100%), Done collapsed | Checklist is local and needs no tracker round-trip to group; the issue pointer is for navigation/chips, not grouping. |
| Issues view scope (v1) | **Read + start session** | Smaller, faster; write-back is a follow-up. |
| Tracker layout | **A top-level "Issues" tab with one sub-tab per tracker** (Linear, GitHub) | Mirrors SHI-28's split between internal planning and external bugs, and lets new trackers register and appear as sub-tabs with no UI rework. |
| Repo → tracker mapping | **Hybrid**: GitHub repo defaults to the repo's own git remote (shipit.yaml override optional); Linear workspace/team binding in ShipIt settings | Each binding lives at its natural scope. GitHub's "which repo" is already a fact of the checkout, so it needs no config by default; a Linear workspace is deployment-wide, not a per-repo fact. |
| Issue refresh | **Fetch on open + manual refresh button** (no background poller in v1) | Zero background load; the list is as fresh as the last open/click. Webhooks/polling are a possible follow-up. |
| Linear `issue:` pointer | **Full URL / fully-qualified always** | Unambiguous across any number of Linear workspaces a deployment might wire up; no single-workspace assumption to break later. |

## The doc side

### Frontmatter after this change

```yaml
---
title: Tracker-backed priorities        # unchanged (optional; defaults to filename)
description: One-line summary.           # unchanged (docs/138)
# NEW — pointer to the tracking issue. Linear MUST be a full URL (see below);
# GitHub may use owner/repo#N or a full URL.
issue: https://linear.app/shipit-ai/issue/SHI-28/decouple-priorities-from-documents
---
```

- **Removed:** `status`, `priority`.
- **`issue:`** accepts a tracker-qualified pointer.
  - **Linear: always a full URL** (e.g.
    `https://linear.app/shipit-ai/issue/SHI-28/...`). Bare `SHI-28` is *not*
    accepted — the full URL keeps the pointer unambiguous if a deployment ever
    wires up more than one Linear workspace.
  - **GitHub:** `owner/repo#123` or a full issue URL.
  - The tracker is inferred from the shape; an explicit `tracker:` is
    unnecessary.
- ShipIt resolves the pointer against the configured trackers and renders the
  linked issue's **priority + status as a chip** on the doc card, plus
  **jump-to-issue** and **start-session** affordances.
- A doc with **no** `issue:` is pure reference — no chip, always shown.

### Migration of existing docs

The ~100 existing docs all carry `status:` and (some) `priority:`. "Inert" must
be specified precisely, because `status` today is load-bearing across both
layers and a half-migrated repo would render wrong:

- **Server:** `parseStatusFromFrontmatter` and the entire `customStatus`
  concept (`markdown.ts`, `domain-types.ts`) are **deleted**, not left dangling.
  Every `status`/`priority` reader is removed in the same change as the parser,
  so no caller is left expecting a value the parser no longer produces.
- **Field stripping vs parser change — ordering.** The parser/type change and
  the field-stripping cleanup pass must land **together** (one PR), or the
  stripping must come **first**. The forbidden order is "parser stops reading
  status while docs still carry it AND code still keys off it" — that's the
  half-migrated state where the docs list mis-buckets every doc at once.
- A doc that still physically contains a `status:`/`priority:` line after the
  change is harmless: the new parser simply doesn't read those keys. The cleanup
  pass removes the dead lines and adds `issue:` pointers where a tracking issue
  exists.

CLAUDE.md and `src/server/shipit-docs/design-docs.md` must be updated to
describe the new frontmatter (this is agent-facing behavior).

### Docs list (DocsViewer) after this change

- **No** priority badge, **no** priority sort, **no** status buckets.
- Grouped by **checklist state**:
  - **Active** — checklist incomplete, *or* no checklist at all.
  - **Done** — checklist 100% complete; rendered in a collapsed group like
    today's Archived section.
- Each card may show the resolved linked-issue chip (identifier + priority +
  status) when an `issue:` pointer is present and resolves.
- Known edge case: a finished reference doc with no checklist stays in
  **Active** forever (nothing marks it complete). Acceptable for v1; a possible
  refinement is to fold docs whose linked issue is *closed* into Done, but that
  reintroduces a tracker dependency into grouping and is deferred.

### The tracking/sibling-suppression key must be re-based off status

This is a correctness trap, not a cosmetic change. `src/client/utils/doc-paths.ts`
decides three things — whether a doc is "tracked," and whether a `checklist.md`
row is suppressed because its `plan.md` sibling exists (`isTracked`,
`hasTrackedSibling`, `hasTrackedPlanSibling`) — and **all three key solely off
`status`/`customStatus`**. If status is removed without changing this, `isTracked()`
returns `false` for every doc: checklist rows stop being suppressed (every
feature dir renders `plan.md` *and* `checklist.md` as two rows) and any
tracked-vs-other split collapses.

The replacement key must not depend on `status`. Re-base "tracked"/sibling
suppression on **doc structure** instead:

- a doc is "tracked" if it is a `plan.md` (the feature-directory primary), or
  carries an `issue:` pointer, or has a `checklist.md` sibling; and
- a `checklist.md` is suppressed when a `plan.md` exists in the same directory
  — a structural test (`basename`/`dir`) that needs no frontmatter at all.

`doc-paths.ts` and its test `doc-paths.test.ts` must be updated in the same
change; this is **not** optional cleanup.

## The issues side

### New top-level "Issues" tab

A peer to Docs, not nested inside it. Contains **one sub-tab per configured
tracker** (Linear, GitHub Issues to start). Each sub-tab is a **read-only list
sorted by priority**, showing identifier / title / priority / status /
assignee. Per-row action: **Start session** — seeds a ShipIt session from the
issue.

**What's actually reused vs new.** `docs/156`'s session-from-issue path is a
webhook handler (`IssueTrackerProvider.handleTrigger()`) that builds an
`IssueRef` from the inbound payload and calls
`headless-sessions.create({ issueRef })`. Only the **downstream**
`headless-sessions.create()` (branch derivation + initial prompt from an
`IssueRef`) is shared. There is **no** in-app, user-initiated "start from a
fetched issue object" entry point today — this feature must add one: a new
caller that turns a fetched issue (from the list) into an `IssueRef` and invokes
`headless-sessions.create()`. So this is new work that *reuses* 156's seeding
primitive, not a free ride on an existing trigger.

Because the trigger here lives *inside* ShipIt (a list-row click) rather than in
the tracker's own UI (Linear delegate / `/shipit` comment), this is the in-app
**pull** counterpart to `docs/156`'s **push** trigger — see the explicit
reconciliation below, since 156 declined a pull-based picker.

### Reconciling with docs/156's rejected "Issue picker"

**This must be called out, because `docs/156` explicitly rejects exactly this
surface.** 156's non-goals say "Not pulling lists of assigned issues into a
ShipIt sidebar. Push from tracker, don't pull," and its *Rejected alternatives*
lists "Issue picker in ShipIt (list issues, click to start)" — declined because
"the user's job in the tracker is to triage and pick what to work on next; doing
that *also* in ShipIt with worse filtering would be a strict loss." This doc
builds a pull-based picker, so it **overturns** that decision rather than
complementing it. The overturn is legitimate only because the *premise changed*:

- **156's premise:** docs still carry `priority`, so ShipIt already has an
  internal "what's next" surface (the prioritized docs list). A picker would be
  a redundant second triage surface with worse filtering — a strict loss.
- **SHI-28 changes that premise:** priority *leaves* the docs. After this change
  ShipIt has **no** internal "what's next" surface at all. Per CLAUDE.md §1/§2,
  leaving that hole would force the user into another tab to decide what to work
  on — the exact failure 156 itself invokes §1/§2 to avoid. So an inline surface
  is now *required*, not redundant.

To stay faithful to 156's *valid* concern (don't lose to the tracker's own
filtering, don't chase per-tracker query UIs), this picker is deliberately
narrow and is **not** a triage tool:

- read-only, **sorted by priority**, no board view, no JQL/Linear-view/GitHub-
  query filter UI, no custom-field editing, no "create issue" flow;
- it surfaces the *already-prioritized* list so the user can act
  (start a session) without leaving — it does not try to replace triage, which
  still happens in the tracker.

**Settled:** the user confirmed this doc supersedes 156's decision. `docs/156`'s
non-goals, its rejected-alternative entry, and its "Push, not pull" section have
been amended to cross-reference this doc; 156 now owns the push trigger and this
doc owns the pull surface.

### Tracker abstraction (extensibility)

Modeled on the existing `agents/` registry so adding a tracker later is "write
an adapter + register it," with sub-tabs generated from the registry:

```
src/server/orchestrator/trackers/
  tracker.ts        Tracker interface: listIssues(), getIssue(), id/label
  registry.ts       configured-tracker registry (drives the sub-tabs)
  linear/           Linear adapter — user OAuth + GraphQL
  github/           GitHub Issues adapter — reuses GitHubAuthManager
  index.ts          barrel
```

- **Issues are repo/workspace-scoped, not session-scoped.** The list endpoint
  is global-ish (per configured tracker + repo mapping), not
  `/api/sessions/:id/...`. Likely `GET /api/issues?tracker=linear` with the
  per-repo tracker mapping resolving which Linear team / GitHub repo to query.
- **Auth + app registration** reuse `docs/156`'s per-deployment app
  registration and the user's own OAuth token (no server-held credential).
  Linear via GraphQL; GitHub via `GitHubAuthManager`.
- **Repo → tracker mapping (hybrid):**
  - **GitHub** defaults to the **repo's own git remote** — the session already
    knows its `owner/repo`, so no config is needed in the common case. An
    optional `shipit.yaml` key can override it (e.g. issues live in a different
    repo than the code).
  - **Linear** workspace/team binding lives in **ShipIt settings**, since a
    Linear workspace is deployment-wide, not a per-repo fact.
- **Refresh model:** issues are **fetched when the Issues tab opens**, with a
  **manual refresh button** — no background poller in v1. Keeps background load
  at zero; webhooks or polling are a possible follow-up if staleness bites.

### Client

- `src/client/components/IssuesViewer.tsx` — the tab + sub-tab switcher + list.
- `src/client/stores/issues-store.ts` — issue lists per tracker, fed over the
  global SSE/HTTP channel like the docs list.
- DocsViewer changes: remove priority/status rendering + sort, add
  checklist-state grouping, add the linked-issue chip + jump-to-issue.

## Data flow

```
Linear / GitHub  ──(user OAuth)──▶  Tracker adapter  ──▶  GET /api/issues
                                                              │
                                          issues-store ◀──────┘ (HTTP + SSE refresh)
                                                              │
                                                      IssuesViewer (sub-tabs, priority sort)
                                                              │
                                              "Start session" ──▶ session-from-issue (docs/156 seeding)

docs/NNN/plan.md (issue: SHI-28)
        │ markdown.ts: parse title/description/issue + checklist counts (no status/priority)
        ▼
   DocsViewer: checklist-state groups + resolved linked-issue chip
```

## Key files

> **Type-removal blast radius.** Dropping `DocStatus`/`DocPriority` and
> `customStatus` from `domain-types.ts` breaks *every* importer. The full set
> (audit before declaring the migration done): `markdown.ts`,
> `doc-paths.ts` (+ `doc-paths.test.ts`), `markdown-frontmatter.ts`,
> `MarkdownSelectionComments.tsx`, `DocsViewer.tsx` (+ `DocsViewer.test.tsx`),
> `markdown.test.ts`, and `domain-types.ts` itself. CLAUDE.md and `docs/080`
> also reference the fields (prose only). Each must be handled in the same
> change, or the client won't compile.

Server:
- `src/server/orchestrator/markdown.ts` — delete `parseStatusFromFrontmatter` +
  the `customStatus` path; stop parsing `status`/`priority`; parse `issue:`;
  keep checklist aggregation.
- `src/server/shared/types/domain-types.ts` — remove `DocStatus`,
  `DocPriority`, `DocEntry.status`, `DocEntry.priority`, `DocEntry.customStatus`;
  add `DocEntry.issue`. Add issue/tracker domain types.
- `src/server/orchestrator/trackers/**` — new tracker abstraction + adapters.
- `src/server/orchestrator/api-routes-*.ts` — `GET /api/issues` route.
- `src/server/orchestrator/services/headless-sessions.ts` — reuse
  `create({ issueRef })`; this feature adds the in-app caller that builds an
  `IssueRef` from a fetched issue (the entry point 156 doesn't provide).
- `src/server/orchestrator/github-auth*.ts` — GitHub Issues listing.
- `src/server/shipit-docs/design-docs.md` — update frontmatter schema (drop
  status/priority, document `issue:`).

Client:
- `src/client/components/DocsViewer.tsx` (+ `DocsViewer.test.tsx`) — remove
  priority/status UI + sort; checklist-state grouping; linked-issue chip +
  jump-to-issue.
- `src/client/utils/doc-paths.ts` (+ `doc-paths.test.ts`) — re-base
  `isTracked`/`hasTrackedSibling`/`hasTrackedPlanSibling` off doc structure
  instead of `status`/`customStatus` (see "tracking/sibling-suppression key"
  above).
- `src/client/utils/markdown-frontmatter.ts` — stop surfacing
  `status`/`priority`/`customStatus` in the doc modal (it imports the removed
  types and renders the status badge).
- `src/client/components/MarkdownSelectionComments.tsx` — imports the removed
  types; update accordingly.
- `src/client/components/IssuesViewer.tsx` — new.
- `src/client/stores/issues-store.ts` — new.
- `src/client/stores/file-store.ts` — `DocEntry` shape change.

Docs/config:
- `CLAUDE.md` — rewrite the "Design docs" + frontmatter sections.

## Relationship to existing docs

- **`docs/156-issue-to-session`** (planned, high) — inbound **push** trigger
  *from* the tracker. This feature adds an inline **pull** picker that 156
  explicitly rejected; see "Reconciling with docs/156's rejected 'Issue picker'"
  above for why the changed premise (priority leaving docs) reopens that
  decision. Shares 156's `headless-sessions.create()` seeding primitive and its
  auth/app-registration foundation. **Settled:** 156 has been amended to
  cross-reference this doc — it owns the push trigger; this doc owns the pull
  surface.
- **`docs/164-user-bug-filing`** (planned) — outbound: user files a GitHub
  issue against upstream ShipIt. Complementary; same GitHub auth model.
- **`docs/114-tracked-doc-checklist`** (done) — the checklist badge this
  feature promotes to the docs grouping key.
- **`docs/080-unify-features-docs`**, **`docs/138-doc-frontmatter-description`**
  (done) — the current frontmatter/doc-discovery system being amended.

## Resolved (was open)

1. **Repo → tracker mapping** — *hybrid.* GitHub repo is deduced from the
   session's own git remote with an optional `shipit.yaml` override; Linear
   workspace/team binding lives in ShipIt settings.
2. **Issue refresh cadence** — *fetch on tab open + manual refresh button*; no
   background poller in v1. Webhooks/polling are a deferred follow-up.
3. **Linear `issue:` pointer format** — *always a full Linear URL*; bare IDs are
   not accepted, so the pointer stays unambiguous across workspaces.

## Open questions

1. **`status: done` for *this* doc** — once shipped, doc priority/status no
   longer exists, so this very doc's `status`/`priority` frontmatter becomes
   inert under its own feature. Handle in the migration cleanup pass.
2. **Webhook follow-up trigger** — decide later whether "fetch on open" staleness
   is acceptable long-term or whether the per-deployment app should register
   webhooks for push updates.
