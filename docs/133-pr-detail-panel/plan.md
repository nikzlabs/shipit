---
status: in-progress
priority: medium
description: Inline PR detail tab (header, description, status, diff link) as a peer of Preview/Docs/Files, opened by clicking the PR lifecycle card.
---

# 133 — Inline PR Detail Panel

## Implementation status

**Shipped (client-only, no server changes):** the minimum-viable panel.

- `"pr"` added to the `RightTab` union (`ui-store.ts`) and to `VALID_RIGHT_TABS`
  (`utils/local-storage.ts`) so the tab selection persists across reloads.
- Conditional **"PR" tab** in `App.tsx`'s right-panel tab strip — shown only when
  the active session has a PR (phase `open`/`merged`/`closed`). When the persisted
  tab is `"pr"` but the session has no PR, the panel falls back to the Preview view.
- `PrDetailPanel.tsx` + `components/pr-detail/` sub-components:
  `PrDetailHeader` (number, title, branches, diff stats, overflow → "View on GitHub"),
  `PrDescriptionSection` (read-only markdown body), `PrStatusSection` (checks
  breakdown, failed-check list, deployments, conflict warning — reads the same
  `pr-store` slice as the card), `PrFilesSection` ("View full diff" → existing
  Monaco diff dialog).
- `PrLifecycleCard` gains an optional `onOpenDetails` prop; the whole card body is
  clickable when a PR exists, and a `closest("button, a, input, textarea")` guard
  in the click handler means interactive controls never also switch the tab (no
  per-control `stopPropagation` needed).
- Tests: `PrDetailPanel.test.tsx` and new card-click cases in `PrLifecycleCard.test.tsx`.

**Shipped (Phase 4, conversation — issue comments + review-thread write-back):** the
`PrStatusSummary` gained `issueComments` + `reviewThreads`, `PR_STATUS_QUERY`
is now built via `buildPrStatusQuery(includeConversation)` (light vs. heavy
variant), and the parser populates the new fields. The poller's
`pr_tab_active` gate (WS message `pr_tab_active { sessionId, active }` →
`PrStatusPoller.setPrTabActive`) fetches the heavy conversation fields only
while a session's PR tab is the active right-panel tab; activation kicks an
immediate poll. `App.tsx` emits the gate from an effect keyed on tab + session
+ connection (survives reconnects/switches). Issue comments are read + post
(`POST /api/sessions/:id/pr/comments` → `addIssueComment`, optimistic append in
`pr-store.postComment` with revert-on-error). `PrConversationSection` renders
comments + review threads with reply and resolve/reopen write-back when the
`prCommentSync` setting is enabled, backed by the docs/102 thread mutation
routes and optimistic `pr-store` actions.

**Shipped (Phase 2, editable title + description):** the header title and
description section gain inline editing when the PR is open (phase `open`).
A pencil on the description enters a markdown-source textarea (Save/Cancel);
the title gets a click-to-edit pencil → inline input (Enter saves, Esc cancels).
Both call `pr-store.updatePr(sessionId, { title?, body? })`, which optimistically
patches the card's `pr` slice and reverts on error, surfacing the failure in an
inline `Banner`. The write goes through the existing
`PATCH /api/sessions/:id/pr/:number` route (`editPullRequest` →
`updatePullRequest`). Merged/closed PRs show no edit affordances.

**Not yet done:** Phase 6 (activity timeline), the `prCreatedAt`/`prAuthor`/
`timeline` summary fields, and the Monaco-widget surface for inline-on-diff
threads from docs/102. The shipped Status section is read-only; wiring the
card's merge/auto-fix/auto-merge controls into the panel is the remaining part
of Phase 3. The Files section is a single diff link, not a per-file list
(Phase 5).

**Remaining-work assessment (2026-05-23):** the missing Status actions are
mostly extraction and wiring. `PrLifecycleCard.tsx` already owns the relevant UI
and behavior (`AutoFixToggle`, `AutoMergeToggle`, `MergeButton`, merge-method
dropdown, CI fix, conflict-resolution prompt) and `pr-store.ts` already exposes
the backing actions (`toggleAutoFix`, `toggleAutoMerge`, `merge`,
`setMergeMethod`, `fixCI`). The panel work should reuse/extract those pieces
rather than introduce another PR-action path.

The per-file list is not just wiring. `PrCardState.files?: PrFileStat[]` exists
for the pre-PR **ready** phase, but open PR status currently carries only
aggregate insertions/deletions in `pr` plus path-only GraphQL data used by
`extractChangedFiles()` for workflow/CI decisions. `PrStatusSummary` does not
yet expose per-file `{ path, status, insertions, deletions }` rows for open PRs,
and `PrFilesSection` only opens the full diff. A useful first pass should add
per-file summary data to the poller result and render it in the panel; scoped
per-row diff opening can follow if the existing diff dialog cannot cheaply focus
or filter to one path.

## Summary

Clicking a `PrLifecycleCard` brings forward an **inline PR detail tab** in the right-hand panel, rendered entirely inside ShipIt — title, description (markdown), full check breakdown, deploy statuses, review comments, activity timeline, and file list. The card in chat stays as a compact, live status marker; the PR tab is the drill-in surface that subsumes everything a user would otherwise leave for github.com.

> **Surface decision:** the detail view is a **tab in the existing tabbed right panel**, a peer of Preview/Docs/Files/etc., rather than a separate slide-over panel. See [Design → Surface](#surface) for the rationale. "Panel" throughout this doc refers to the contents of that tab.

This is the destination view that the product principles in `CLAUDE.md` point at:

- **§1 / §2** — PR data lives inline; the "View on GitHub" link moves into an overflow menu.
- **§4** — comments, reviews, and PR body are exactly the "we don't render it inline yet" items called out as backlog, not link-out justification.

The panel also becomes the natural home for future PR-adjacent features (review comments per [`docs/102-github-pr-comment-sync`](../102-github-pr-comment-sync/plan.md), conversation threads, requested reviewers, labels) so they don't accrete onto the already-dense card.

## Motivation

`PrLifecycleCard` (built in [`docs/064-pr-lifecycle-flow`](../064-pr-lifecycle-flow/plan.md)) is excellent at "what is the live status of this PR?" — checks, deploys, merge readiness. But it deliberately stays compact: the PR title is fetched but not rendered, the body is never fetched, and there's nowhere to hang review comments or a conversation timeline.

Today the user's mental model is:

> Card shows me status. For anything richer, I open GitHub.

Every "open GitHub" is a §1/§2 failure — once the user is on github.com, the next reply, re-request, or follow-up commit happens there too, and ShipIt loses the loop.

The destination is:

> Card shows me status. Clicking it gives me the full PR, inline.

A separate small change (covered in the conversation that produced this doc — "Option A": title in card header, body collapsed) is a useful stopgap, but the long-term home for PR depth is a dedicated panel, not a card that keeps growing sections.

## Design

### Surface

A new **"PR" tab in the existing right-hand panel** — a peer of the current Preview / Services / Docs / Files / Terminal / History tabs, not a separate floating surface.

The right column in `App.tsx` (`rightPanel`) is already a tabbed container whose active tab is the `RightTab` union in `ui-store.ts`, persisted to localStorage. The PR detail view slots in as one more tab rather than introducing a fifth kind of surface (the app already has: chat, the tabbed right panel, the diff modal, and the file-preview modal). This was chosen over the originally-sketched slide-over side panel because:

- **It reuses the existing pattern.** Add `"pr"` to the `RightTab` union plus one tab button — the same shape as every other tab. A slide-over would be net-new UI machinery for the same job.
- **It honors §1/§2 better.** A persistent, peer-level tab reads as "the PR is a real, first-class view inside ShipIt." A transient overlay reads as "a popover you dismiss."
- **Persistence is free.** The tab survives reloads and session switches via the existing `saveRightTab` mechanism — no new ephemeral state to manage.
- **No chat compression.** The tab lives in the space already allocated to the right panel; nothing has to push or cover the chat column.

Behavior:

- **Tab visibility** — the "PR" tab is shown only when the active session has a PR (open or recently merged), mirroring how the `Services` tab is conditional on `composeServices.length > 0`. When there's no PR, the tab is absent and the panel falls back to the previously selected tab.
- **Trigger** — clicking anywhere on the `PrLifecycleCard` body (except interactive controls like the auto-fix toggle or merge button) calls `handleTabChange("pr")` to bring the tab forward. The user can also click the tab directly. (`handleTabChange` is the existing tab-strip entry point — it wraps `setRightTab` and is also where per-tab data fetches and the `pr_tab_active` WS emit fire, so routing the card click through it keeps activation behavior identical regardless of entry point.)
- **Dismissal** — there's nothing to "dismiss": the user simply selects another tab, exactly as with Preview/Docs/etc. `Esc` is not overloaded. The card in chat keeps its current state regardless of which tab is active.
- **Persistence** — selecting the PR tab persists like any other `rightTab` choice (localStorage), so a reload restores it. The heavy-field polling gate (below) keys off "is the PR tab the active tab for this session," not a bespoke open/closed flag.
- **Multi-PR** — same 1:1 model as `docs/064`: one PR per session, so the tab always reflects that session's single PR. Switching sessions repaints the tab from the new session's `PrCardState`.
- **Mobile** — no special handling needed. On mobile (`AppLayout.tsx`), the bottom `MobileTabBar` toggles between the chat panel and the *entire* `rightPanel` — including its in-panel tab strip. The PR tab therefore appears in that strip for free; the bottom bar doesn't need a third button. (This is a concrete advantage over a slide-over, which would have required bespoke mobile layout work.)

### Layout

The PR tab's content sits below the shared right-panel tab strip (the same strip that holds Preview / Docs / Files / …); there is no in-panel close button — switching tabs is the dismissal.

```
│ Preview │ Docs │ Files │ Terminal │ History │ ▸PR◂ │   ← shared tab strip
┌────────────────────────────────────────────────────────────────────┐
│  #42  Add PR lifecycle flow                                 [⋯]   │
│  main ← shipit/abc123 · opened 2h ago · +42 -12                    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ## Description                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ This PR introduces inline PR lifecycle cards…               │ │
│  │ (markdown-rendered, supports task lists, code blocks,       │ │
│  │  cross-PR links, mentions)                                   │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ## Status                                                         │
│  ✓ 5/5 checks   ✓ preview deployed   ◉ ready to merge             │
│   ▸ lint              passed  2m                                   │
│   ▸ test              passed  4m                                   │
│   ▸ typecheck         passed  1m                                   │
│   ▸ build (preview)   passed  3m                                   │
│   ▸ deploy (preview)  success URL                                  │
│                                                                    │
│  ## Conversation                                                   │
│   @alice  Looks good, one nit on the naming…           2h ago     │
│   @claude (you)  Renamed in 7c3a1bd, please re-review  1h ago     │
│   @alice  ✓ approved                                   30m ago    │
│   [Reply…]                                                         │
│                                                                    │
│  ## Files (3)                                                      │
│   src/server/api-routes.ts     M  +18 -4   [View diff]            │
│   src/client/App.tsx           M  +20 -6   [View diff]            │
│   src/client/hooks/usePR.ts    A  +4  -0   [View diff]            │
│                                                                    │
│  ## Activity                                                       │
│   ● PR opened by @claude                              2h ago      │
│   ● 5 checks queued                                   2h ago      │
│   ● Preview deployed to https://…                     1h 58m      │
│   ● @alice requested changes                          1h 30m      │
│   ● Fixup commit 7c3a1bd pushed                       1h ago      │
│   ● @alice approved                                   30m ago     │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Sections, and what each one owns

| Section | Source | Editable in ShipIt? |
|---|---|---|
| Header (number, title, branches, age, diff stats) | `prTitle` already on the summary; extend `PR_STATUS_QUERY` with `createdAt` for age | Title: yes (calls `updatePullRequest` GraphQL) |
| Description | `prBody` — already selected by `PR_STATUS_QUERY` and parsed into the summary | Yes — pencil → Monaco markdown editor → `updatePullRequest` |
| Status (checks, deploys, merge state) | Existing card data, restyled for the panel | Same controls as card (auto-fix, auto-merge, merge button) |
| Conversation (review threads + issue comments) | `reviewThreads` from [`docs/102`](../102-github-pr-comment-sync/plan.md) GraphQL + `comments` (issue-level) | Reply, resolve — same mutations as 102 |
| Files | Reuse server diff API + existing Monaco diff viewer | "View diff" opens existing diff panel; not a re-implementation |
| Activity timeline | New: GraphQL `timelineItems` (commits, reviews, labels, status changes) | Read-only |

The "Status" section is the same data the card renders, restyled to fit the wider panel. The card and panel **read from the same store slice** (`pr-store.ts:PrCardState`) — the panel is a richer view of the same model, not a parallel state.

### Card ↔ panel relationship

The card stays as today: compact, live, in chat. It gains one change — the whole card body becomes clickable, with a subtle hover affordance ("Open PR details ↗" or just a chevron in the corner). Clicking it calls `handleTabChange("pr")` to bring the PR tab forward. The interactive controls (auto-fix toggle, merge dropdown, etc.) call `e.stopPropagation()` so clicking them doesn't also switch the tab.

Inside the PR tab, the card's existing controls (auto-fix, auto-merge, merge button, merge method dropdown) are present in the Status section. Toggling either surface updates the shared store; the other surface re-renders automatically.

### Data layer

Extend `PrStatusSummary` in `src/server/shared/types/github-types.ts`:

```ts
interface PrStatusSummary {
  // already present (declared, and populated by the poller)
  prTitle: string;
  prBody: string;             // markdown source — already on the type
  // new
  prCreatedAt: string;        // ISO timestamp
  prAuthor: { login: string; avatarUrl: string };
  reviewThreads: ReviewThread[];     // from docs/102
  issueComments: IssueComment[];     // PR-level (not line) comments
  timeline: TimelineItem[];          // unified activity feed
}
```

`PR_STATUS_QUERY` (in `pr-status-parser.ts`) gains the corresponding GraphQL selections, and the parser populates the new summary fields. The poller already runs on a tick — adding these fields costs one GraphQL round-trip's worth of extra payload per tick per session with an open PR. For sessions where the PR tab is **not** the active right-panel tab, the poller can skip the heavier `reviewThreads`/`timeline` selections (gate on `prTabActiveForSession[sessionId]`, reported back over WS via the `pr_tab_active` message that `handleTabChange` emits whenever the active tab enters/leaves `"pr"`). This keeps idle-session polling cheap.

### Mutations (write paths)

All write paths go through the existing `services/github.ts` layer. New service functions:

- `updatePullRequest(prNumber, { title?, body? })` — for title/body edits.
- `addIssueComment(prNumber, body)` — for the Conversation section's PR-level reply.
- Resolve/reply on review threads — already covered by [`docs/102`](../102-github-pr-comment-sync/plan.md).

New HTTP routes (see `add-endpoint` skill):

- `PATCH /api/sessions/:id/pr` — body `{ title?, body? }` → `updatePullRequest`.
- `POST /api/sessions/:id/pr/comments` — body `{ body }` → `addIssueComment`.

Errors surface inline in the panel (toast-style banner inside the section that failed), not as global toasts — the user is "inside the PR" mentally and shouldn't have to scan elsewhere.

### Client architecture

- **New component:** `src/client/components/PrDetailPanel.tsx` — top-level panel body rendered as the `rightTab === "pr"` branch in `App.tsx`'s `rightPanel`, composes sub-sections.
- **Sub-components** (siblings under `components/pr-detail/`):
  - `PrDetailHeader.tsx`
  - `PrDescriptionSection.tsx` (markdown view + edit mode using existing Monaco markdown setup from `MarkdownSectionComments.tsx`)
  - `PrStatusSection.tsx` (extracts the status visuals from `PrLifecycleCard` into a shared sub-component both card and panel render)
  - `PrConversationSection.tsx` (reuses widgets from [`docs/102`](../102-github-pr-comment-sync/plan.md) for review threads; adds an issue-comment composer)
  - `PrFilesSection.tsx` (file rows that delegate to existing diff viewer)
  - `PrTimelineSection.tsx`
- **Store changes:** extend `pr-store.ts:PrCardState` with the new fields; add `"pr"` to the `RightTab` union in `ui-store.ts`. No bespoke open/close actions — `App.tsx`'s existing `handleTabChange` (which wraps `setRightTab`) is the entry point.
- **Tab strip change:** add a conditional "PR" tab button in `App.tsx`'s `rightPanel` (shown only when the session has a PR) and a `rightTab === "pr"` render branch for `PrDetailPanel`.
- **Card change:** wrap `PrLifecycleCard`'s body in a clickable container that calls `handleTabChange("pr")`. Existing interactive controls call `stopPropagation`.

### Phasing

| Phase | Scope | Depends on | Status |
|---|---|---|---|
| **1. Panel scaffold + header + description** | "PR" tab wired into `rightPanel` (conditional on a PR existing), tab-selection UX, render title + markdown body read-only (`prTitle`/`prBody` are already on the summary — Phase 1 just renders them), "View on GitHub" overflow link. Card becomes clickable (selects the PR tab). | — | ✅ done |
| **2. Editable description + title** | Pencil → markdown-source edit → `updatePullRequest`. Title click-to-edit. Optimistic update with revert-on-error. | Phase 1 | ✅ done (textarea editor, not Monaco — kept consistent with the existing comment composer) |
| **3. Status section in panel + extract shared sub-component** | Move status visuals into a sub-component used by both card and panel. Card UX unchanged; panel gets full status detail. | Phase 1 | 🟡 partial — read-only status section shipped (reads shared store slice); shared sub-component extraction + actionable controls in panel still todo |
| **4. Conversation section** | Issue comments + review threads. Heavy overlap with [`docs/102`](../102-github-pr-comment-sync/plan.md) — co-sequence so the GraphQL query and widget work happen once. | [`docs/102`](../102-github-pr-comment-sync/plan.md) Phase 1 | 🟡 partial — issue comments (read + post) + review-thread reply/resolve write-back shipped in the PR tab, gated by `pr_tab_active`; Monaco inline-diff widgets still live with docs/102 |
| **5. Files section** | List from existing diff API; "View diff" opens the existing Monaco diff panel — no diff re-implementation. | Phase 1 | 🟡 partial — single "View full diff" link shipped; per-file list still todo |
| **6. Activity timeline** | Timeline GraphQL query; new `PrTimelineSection`. Read-only. | Phase 1 | ⬜ todo |

Phases 1-3 are the minimum viable panel. Phase 4 is the largest single win (subsumes the link-out to GitHub for review). Phases 5-6 fill in the long tail.

## Relationship to other docs

- [`docs/064-pr-lifecycle-flow`](../064-pr-lifecycle-flow/plan.md) — built the card. This doc takes the card from "compact status" to "compact status + drill-in destination."
- [`docs/102-github-pr-comment-sync`](../102-github-pr-comment-sync/plan.md) — review-thread sync. The panel's Conversation section is where these threads naturally render at the PR level (in addition to the inline-on-diff rendering 102 already plans). Co-sequence phase 4 here with 102's phase 1.
- [`docs/113-pr-mergeable-state`](../113-pr-mergeable-state/plan.md) — mergeability conflicts. The panel's Status section is the right place to surface conflict details and resolution prompts more verbosely than the card can.
- [`docs/032-ai-pr-description`](../032-ai-pr-description/plan.md) — AI-generated descriptions. The panel's edit flow should plug into the same generator (button: "Regenerate from conversation").

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/pr-status-parser.ts` | `PR_STATUS_QUERY` lives here (not the poller) and already selects `title`/`body`. Add `createdAt`, `author`, `timeline`, `issueComments` (and `reviewThreads` per 102) selections + parse them into the summary. |
| `src/server/orchestrator/pr-status-poller.ts` | Gate the heavy selections (`reviewThreads`/`timeline`) on `prTabActiveForSession`; run the poll/broadcast loop. |
| `src/server/shared/types/github-types.ts` | Extend `PrStatusSummary` with `prCreatedAt`, `prAuthor`, `timeline`, `issueComments` (and `reviewThreads` per 102). `prTitle`/`prBody` already exist on the type. |
| `src/server/orchestrator/services/github.ts` | Add `updatePullRequest`, `addIssueComment` service functions. |
| `src/server/orchestrator/api-routes-github.ts` | Add `PATCH /api/sessions/:id/pr` and `POST /api/sessions/:id/pr/comments` routes. |
| `src/server/orchestrator/ws-handlers/misc-handlers.ts` (or new) | New WS message `pr_tab_active { sessionId, active }` (emitted by `handleTabChange` when the active tab enters/leaves `"pr"`) so server knows whether to fetch heavy fields. |
| `src/client/App.tsx` | Add conditional "PR" tab button to `rightPanel`'s tab strip and a `rightTab === "pr"` render branch for `PrDetailPanel`. Extend `handleTabChange`'s typed parameter union (currently `"preview" \| "docs" \| "files" \| "terminal" \| "history" \| "services"`) with `"pr"`, and add the `pr_tab_active` WS emit there (it's the single choke point for tab activation + per-tab data fetches). |
| `src/client/components/PrLifecycleCard.tsx` | Wrap body in clickable container that calls `handleTabChange("pr")` (threaded down from `App.tsx`); add hover affordance; `stopPropagation` on interactive controls. Extract status visuals into shared sub-component. |
| `src/client/components/PrDetailPanel.tsx` (new) | Top-level panel component rendered inside the PR tab. |
| `src/client/components/pr-detail/*.tsx` (new) | Section sub-components. |
| `src/client/stores/pr-store.ts` | Extend `PrCardState` with new fields; selector helpers. |
| `src/client/stores/ui-store.ts` | Add `"pr"` to the `RightTab` union. Activation routes through `App.tsx`'s `handleTabChange`, which calls `setRightTab` — no new store action needed. |
| `src/client/hooks/useApi.ts` | Hooks for `PATCH /api/sessions/:id/pr` and the new comments endpoint. |

## Tests

Per the `testing-and-quality` skill checklist:

- **Server:** `integration_tests/pr-detail-panel.test.ts`
  - Poller fetches body/timeline/issueComments only when the PR tab is the active right-panel tab for the session.
  - `PATCH /api/sessions/:id/pr` calls `updatePullRequest` with the right payload; round-trips title/body change to the next poll tick.
  - `POST /api/sessions/:id/pr/comments` calls `addIssueComment`; 401 if `GitHubAuthManager` not authenticated.
- **Client:** `PrDetailPanel.test.tsx`, `PrLifecycleCard.test.tsx`
  - Clicking the card selects the PR tab (`rightTab === "pr"`); clicking the auto-fix toggle does **not** switch the tab (stopPropagation).
  - The "PR" tab is only present when the session has a PR; absent otherwise.
  - Selecting another tab leaves the card state untouched.
  - Edit description → save → optimistic update; on server error, reverts and shows inline banner.
- **Smoke:** add the panel to a single existing render-the-app smoke test to catch obvious regressions.

## Out of scope

- **Cross-repo / cross-session PR browsing.** The panel only ever shows the PR for the active session.
- **PR creation flow.** Stays in the card per `docs/064`.
- **Re-implementing the diff viewer.** The Files section delegates to the existing Monaco diff panel.
- **Labels, milestones, projects, assignees.** Deferrable to a follow-up; the panel layout leaves room.
- **Multiple PRs per session.** Same 1:1 model as `docs/064`.
- **Offline editing.** Edits require an authenticated GitHub session; no queueing.
