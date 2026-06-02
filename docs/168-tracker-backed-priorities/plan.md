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
issue: SHI-28                            # NEW — pointer to the tracking issue
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

The ~100 existing docs all carry `status:` and (some) `priority:`. The parser
**ignores** these fields after this change — they become inert, not an error.
A follow-up cleanup pass strips them and adds `issue:` pointers where a tracking
issue exists. CLAUDE.md and `src/server/shipit-docs/design-docs.md` must be
updated to describe the new frontmatter (this is agent-facing behavior).

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

## The issues side

### New top-level "Issues" tab

A peer to Docs, not nested inside it. Contains **one sub-tab per configured
tracker** (Linear, GitHub Issues to start). Each sub-tab is a **read-only list
sorted by priority**, showing identifier / title / priority / status /
assignee. Per-row action: **Start session** — seeds a ShipIt session from the
issue, reusing the seeding logic designed in `docs/156-issue-to-session`.

Because the trigger here lives *inside* ShipIt, this is the in-app
complement to `docs/156`, whose trigger lives in the tracker's own UI (Linear
delegate / `/shipit` comment). Both paths converge on the same
session-from-issue seeding code.

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

Server:
- `src/server/orchestrator/markdown.ts` — stop parsing/validating `status` &
  `priority`; parse `issue:`; keep checklist aggregation.
- `src/server/shared/types/domain-types.ts` — drop `DocPriority` /
  `DocEntry.priority` / `DocEntry.status` usage from the doc surface; add
  `DocEntry.issue`. Add issue/tracker domain types.
- `src/server/orchestrator/trackers/**` — new tracker abstraction + adapters.
- `src/server/orchestrator/api-routes-*.ts` — `GET /api/issues` route.
- `src/server/orchestrator/github-auth*.ts` — GitHub Issues listing.
- `src/server/shipit-docs/design-docs.md` — update frontmatter schema (drop
  status/priority, document `issue:`).

Client:
- `src/client/components/DocsViewer.tsx` — remove priority/status UI + sort;
  checklist-state grouping; linked-issue chip + jump-to-issue.
- `src/client/components/IssuesViewer.tsx` — new.
- `src/client/stores/issues-store.ts` — new.
- `src/client/stores/file-store.ts` — `DocEntry` shape change.

Docs/config:
- `CLAUDE.md` — rewrite the "Design docs" + frontmatter sections.

## Relationship to existing docs

- **`docs/156-issue-to-session`** (planned, high) — inbound trigger *from* the
  tracker. This feature is the inline in-app counterpart and shares the
  session-from-issue seeding + auth/app-registration foundation.
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
