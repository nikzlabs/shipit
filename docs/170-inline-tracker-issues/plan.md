---
title: Inline tracker Issues tab
description: A top-level, read-only, priority-sorted Issues tab inside ShipIt with one sub-tab per tracker (Linear, GitHub) and a start-session action per row — the inline "what's next" surface that replaces what docs left behind when priority moved to the tracker.
issue: https://linear.app/shipit-ai/issue/SHI-67/inline-tracker-issues-tab-linear-github-with-start-session
---

# Inline tracker Issues tab

Tracks **SHI-67 — "Inline tracker Issues tab (Linear + GitHub) with start-session."**

## Why this is a separate doc

This was originally the second half of `docs/168-tracker-backed-priorities`
(SHI-28). SHI-28 split a design doc's two jobs — *spec* vs *work item* — by
moving `priority`/`status` out of doc frontmatter and into the issue tracker.
That decoupling **shipped**. The inline surface that was supposed to ship
*alongside* it — this Issues tab — **did not**.

So ShipIt is currently in the exact state `docs/168` warned against: priority
has left the docs, and there is **no inline "what should I work on next?"
surface**. Per CLAUDE.md §1/§2 that's a live product-principle gap — the user
must open Linear or GitHub in another tab to decide what to work on next. This
doc owns closing that gap; `docs/168` is trimmed to own only the (completed)
decoupling migration.

Splitting at the doc *and* issue level keeps the tracker honest: SHI-28 is a
finished migration and stays Done; SHI-67 is the unbuilt surface and tracks
this work. Reopening a Done issue to hang new work off it would re-conflate the
two jobs SHI-28 just separated.

## Goal

A top-level **Issues** tab, peer to Docs, with **one sub-tab per configured
tracker** (Linear, GitHub Issues to start). Each sub-tab is a **read-only list
sorted by priority**, showing identifier / title / priority / status /
assignee. Per-row action: **Start session** — seeds a ShipIt session from the
issue without leaving the app.

## Non-goals

- **Editing issues from inside ShipIt (v1).** Read + start a session. Setting
  priority, changing status, or commenting on an issue from ShipIt is a
  deliberate follow-up, not v1.
- **A triage/query UI.** No board view, no JQL / Linear-view / GitHub-query
  builder, no custom-field editing, no "create issue" flow. The list surfaces
  the *already-prioritized* queue so the user can act; triage still happens in
  the tracker. This is the discipline that keeps us from chasing per-tracker
  filter UIs we'll always be behind on.
- **A background poller (v1).** Fetch on tab open + a manual refresh button.
  Webhooks/polling are a deferred follow-up if staleness bites.
- **Mutating issue status from ShipIt** (e.g. moving an issue to "In Progress"
  when a session starts). Out of scope; overlaps `docs/156`.

## Reconciling with docs/156's rejected "Issue picker"

**This must be called out, because `docs/156` explicitly rejects exactly this
surface.** 156's non-goals say "Not pulling lists of assigned issues into a
ShipIt sidebar. Push from tracker, don't pull," and its *Rejected alternatives*
lists "Issue picker in ShipIt (list issues, click to start)" — declined because
"the user's job in the tracker is to triage and pick what to work on next; doing
that *also* in ShipIt with worse filtering would be a strict loss." This doc
builds a pull-based picker, so it **overturns** that decision. The overturn is
legitimate only because the *premise changed*:

- **156's premise:** docs still carry `priority`, so ShipIt already has an
  internal "what's next" surface (the prioritized docs list). A picker would be
  a redundant second triage surface with worse filtering — a strict loss.
- **SHI-28 changed that premise:** priority *left* the docs. ShipIt now has
  **no** internal "what's next" surface at all. Per CLAUDE.md §1/§2, leaving
  that hole forces the user into another tab to decide what to work on — the
  exact failure 156 itself invokes §1/§2 to avoid. So an inline surface is now
  *required*, not redundant.

To stay faithful to 156's *valid* concern (don't lose to the tracker's own
filtering, don't chase per-tracker query UIs), this picker is deliberately
narrow and is **not** a triage tool — read-only, priority-sorted, no query UI
(see Non-goals).

**Settled:** the user confirmed the picker supersedes 156's rejection. `docs/156`
has already been amended to cross-reference this surface (its non-goals, its
rejected-alternative entry, and its "Push, not pull" section); the cross-references
point at the design that has now moved here from `docs/168`.

## Pull vs push

This is the **pull** counterpart to `docs/156`'s **push** trigger. Push: "I'm
already in Linear, delegate this issue to ShipIt" (the trigger lives in the
tracker). Pull: "priority left the docs, so ShipIt must show what's next inline"
(the trigger is a list-row click *inside* ShipIt). They are complementary, not
in tension, and share one downstream primitive.

## Tracker abstraction (extensibility)

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
  **manual refresh button** — no background poller in v1.

## Start session — what's reused vs new

`docs/156`'s session-from-issue path is a webhook handler
(`IssueTrackerProvider.handleTrigger()`) that builds an `IssueRef` from the
inbound payload and calls `headless-sessions.create({ issueRef })`. Only the
**downstream** `headless-sessions.create()` (branch derivation + initial prompt
from an `IssueRef`) is shared.

There is **no** in-app, user-initiated "start from a fetched issue object" entry
point today — this feature must add one: a new caller that turns a fetched issue
(from the list) into an `IssueRef` and invokes `headless-sessions.create()`. So
this reuses 156's seeding primitive; it is not a free ride on an existing
trigger.

**Dependency:** the only hard prerequisite is that `headless-sessions.create()`
accepts an `IssueRef` and derives branch + initial prompt from it. The GitHub
sub-tab can use ShipIt's existing user GitHub auth, so it works before 156's
GitHub push path exists; only the **Linear** sub-tab needs 156's Linear app
registration / OAuth.

## Client

- `src/client/components/IssuesViewer.tsx` (new) — the tab + sub-tab switcher +
  list. **(Superseded layout: docs/173)** the original stacked "card per row"
  list became a responsive table (Issue / Title / Priority / Status / Assignee /
  action) with a filter bar; below the `md` breakpoint it collapses back to
  stacked cards. See `docs/173-issue-tracker-filters`.
- `src/client/stores/issues-store.ts` (new) — issue lists per tracker, fed over
  the global SSE/HTTP channel like the docs list. **(docs/173)** also holds the
  client-side `filters` state (query + priority/status/assignee facets).

## Data flow

```
Linear / GitHub  ──(user OAuth)──▶  Tracker adapter  ──▶  GET /api/issues
                                                              │
                                          issues-store ◀──────┘ (HTTP + manual refresh)
                                                              │
                                                      IssuesViewer (sub-tabs, priority sort)
                                                              │
                                              "Start session" ──▶ setPrefillText(issue prompt)
                                                                  (seeds chat input; user sends)
```

### Start session seeds the input — it does not auto-send

"Start session" mirrors the docs "Start Session" flow (`handleDocStartSession`):
instead of POSTing to `/api/sessions/headless` and auto-dispatching the first
turn, it switches to a fresh session (when the current one already has messages)
and **prefills the chat input** with the issue's context (`identifier`, `title`,
`description`, link — the same text `seedFromIssueRef` would have sent). The user
can then edit/augment the prompt before sending. The prefill + fresh-session
handling lives in `App.tsx#handleIssueStartSession` (where
`handleNewSessionForRepo` and `setPrefillText` are available); `IssuesPanel` only
resolves the repo for the `canStart` gate and delegates the click upward.

The server-side `seedFromIssueRef()` / `createHeadlessSession({ issueRef })`
seeding primitive is retained for the **push** trigger (docs/156) — only the
in-app **pull** path stopped calling it.

## Key files

Server:
- `src/server/orchestrator/trackers/**` (new) — tracker abstraction + Linear /
  GitHub adapters + registry.
- `src/server/orchestrator/api-routes-*.ts` — `GET /api/issues` route.
- `src/server/orchestrator/services/headless-sessions.ts` — the in-app caller
  that builds an `IssueRef` from a fetched issue and calls `create({ issueRef })`
  (the entry point 156 doesn't provide). `create()` itself must accept
  `issueRef` — shared prerequisite with 156.
- `src/server/orchestrator/github-auth*.ts` — GitHub Issues listing.
- `src/server/shared/types/domain-types.ts` — issue/tracker domain types,
  `IssueRef`.

Client:
- `src/client/components/IssuesViewer.tsx` (new).
- `src/client/stores/issues-store.ts` (new).

## Relationship to existing docs

- **`docs/168-tracker-backed-priorities`** (SHI-28, **Done**) — shipped the
  doc-frontmatter decoupling that removed ShipIt's only inline "what's next"
  surface. This doc builds the replacement. 168 is now the migration reference
  only; its "issues side" moved here.
- **`docs/156-issue-to-session`** (SHI-43, planned) — the inbound **push**
  trigger from the tracker. Shares this doc's downstream
  `headless-sessions.create({ issueRef })` seeding primitive and its
  auth/app-registration foundation. 156 owns push; this doc owns pull.
- **`docs/164-user-bug-filing`** (planned) — outbound: user files a GitHub
  issue against upstream ShipIt. Same GitHub auth model.

## Resolved (inherited from SHI-28's design conversation)

1. **Repo → tracker mapping** — *hybrid.* GitHub from the session's own git
   remote with an optional `shipit.yaml` override; Linear workspace/team binding
   in ShipIt settings.
2. **Issue refresh cadence** — *fetch on tab open + manual refresh button*; no
   background poller in v1.
3. **Linear `issue:` pointer format** — *always a full Linear URL*; bare IDs are
   not accepted, so the pointer stays unambiguous across workspaces.

## Implementation status (v1 — Linear only, SHI-67)

Shipped the **Linear** path; the **GitHub** sub-tab/adapter is deliberately
deferred (the user tracks everything in Linear) — now tracked on its own as
**SHI-80** (so SHI-28's "both trackers simultaneously" mandate isn't lost when
SHI-28 closed under its migration framing). The tracker abstraction is built so a
GitHub adapter slots in by registering one more `Tracker`.

- **Auth (v1):** simplest read-only path — a Linear **API token** stored in
  `CredentialStore` (mirrors the GitHub-token pattern), plus a workspace/team
  binding, configured in **Settings → Trackers**. The full per-deployment
  Linear OAuth app registration / webhook machinery from `docs/156` is *not*
  built here — that's for the push trigger, not this read surface.
- **Empty state:** when no token/team is bound the Issues tab renders a
  "Connect Linear" empty state (no error) that deep-links to settings.

Actual key files (server):
- `src/server/orchestrator/trackers/{tracker.ts,registry.ts,index.ts}` +
  `trackers/linear/adapter.ts` (GraphQL list, priority mapping/sort).
- `src/server/orchestrator/services/issues.ts` — list trackers/issues + Linear
  connect/team/disconnect.
- `src/server/orchestrator/api-routes-issues.ts` — `GET /api/trackers`,
  `GET /api/issues?tracker=`, `POST /api/trackers/linear/{token,team,disconnect}`,
  `GET /api/trackers/linear/teams`.
- `src/server/orchestrator/services/headless-sessions.ts` — `seedFromIssueRef()`
  (branch + title + first prompt) and `createHeadlessSession({ issueRef })`.
- `src/server/orchestrator/credential-store.ts` — Linear token + team binding.

Actual key files (client):
- `src/client/components/IssuesViewer.tsx` (presentational) +
  `IssuesPanel.tsx` (store-connected wrapper that resolves the repo for the
  `canStart` gate and delegates Start session upward) + `SettingsTrackers.tsx`
  (Linear connect/bind).
- `src/client/App.tsx` — `handleIssueStartSession` seeds the chat input from the
  issue (prefill, not auto-send), reusing `handleNewSessionForRepo` +
  `setPrefillText`.
- `src/client/stores/issues-store.ts` — per-tracker lists, fetch-on-open +
  manual refresh. (The earlier `startSession()` action that POSTed to
  `/api/sessions/headless` was removed when Start session moved to prefill.)

### Gotcha: Zustand selectors must return stable references

`IssuesPanel` selects the active tracker's list as
`s.issuesByTracker[s.activeTracker] ?? EMPTY_ISSUES` using a module-level
`EMPTY_ISSUES` constant. The earlier `?? []` form returned a **fresh array on
every render**, which makes Zustand v5's `useSyncExternalStore` see a changed
snapshot each render and loop into React error #185 ("Maximum update depth
exceeded"). It triggered exactly on tab open, before the first fetch populates
`issuesByTracker`. Any `?? []`/`?? {}` fallback inside a selector here must use a
shared stable constant. Regression: `IssuesPanel.test.tsx`.

## Open questions

1. **Webhook follow-up trigger** — decide later whether "fetch on open"
   staleness is acceptable long-term, or whether the per-deployment app should
   register webhooks for push updates.
