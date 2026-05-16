---
status: planned
priority: medium
---

# 133 — Inline PR Detail Panel

## Summary

Clicking a `PrLifecycleCard` opens an **inline PR detail panel** rendered entirely inside ShipIt — title, description (markdown), full check breakdown, deploy statuses, review comments, activity timeline, and file list. The card in chat stays as a compact, live status marker; the panel is the drill-in surface that subsumes everything a user would otherwise leave for github.com.

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

A right-hand **side panel** that slides over (or pushes, depending on viewport width) the chat column when opened. Similar in spirit to the existing diff panel — it's a "drill-in" mode, not a modal.

- **Trigger** — clicking anywhere on the `PrLifecycleCard` body (except interactive controls like the auto-fix toggle or merge button).
- **Dismissal** — `Esc`, clicking outside the panel, or a close affordance in the panel header. The card in chat keeps its current state; closing the panel doesn't change PR state.
- **Persistence** — the panel is per-session ephemeral UI state (`ui-store.ts`). It does not survive a page reload — reloading restores chat with the panel closed.
- **Multi-PR** — only one PR detail panel open at a time. Clicking a different PR card swaps the panel contents.

### Layout

```
┌────────────────────────────────────────────────────────────────────┐
│  ← #42  Add PR lifecycle flow                          [⋯]  [×]   │
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
| Header (number, title, branches, age, diff stats) | PR poller (extend with `title`, `createdAt`) | Title: yes (calls `updatePullRequest` GraphQL) |
| Description | New `body` field on poller GraphQL query | Yes — pencil → Monaco markdown editor → `updatePullRequest` |
| Status (checks, deploys, merge state) | Existing card data, restyled for the panel | Same controls as card (auto-fix, auto-merge, merge button) |
| Conversation (review threads + issue comments) | `reviewThreads` from [`docs/102`](../102-github-pr-comment-sync/plan.md) GraphQL + `comments` (issue-level) | Reply, resolve — same mutations as 102 |
| Files | Reuse server diff API + existing Monaco diff viewer | "View diff" opens existing diff panel; not a re-implementation |
| Activity timeline | New: GraphQL `timelineItems` (commits, reviews, labels, status changes) | Read-only |

The "Status" section is the same data the card renders, restyled to fit the wider panel. The card and panel **read from the same store slice** (`pr-store.ts:PrCardState`) — the panel is a richer view of the same model, not a parallel state.

### Card ↔ panel relationship

The card stays as today: compact, live, in chat. It gains one change — the whole card body becomes clickable, with a subtle hover affordance ("Open PR details ↗" or just a chevron in the corner). The interactive controls (auto-fix toggle, merge dropdown, etc.) call `e.stopPropagation()` so clicking them doesn't also open the panel.

Inside the panel, the card's existing controls (auto-fix, auto-merge, merge button, merge method dropdown) are present in the Status section. Toggling either surface updates the shared store; the other surface re-renders automatically.

### Data layer

Extend `PrStatusSummary` in `src/server/shared/types/github-types.ts`:

```ts
interface PrStatusSummary {
  // existing fields
  prTitle: string;
  // new
  prBody: string;             // markdown source
  prCreatedAt: string;        // ISO timestamp
  prAuthor: { login: string; avatarUrl: string };
  reviewThreads: ReviewThread[];     // from docs/102
  issueComments: IssueComment[];     // PR-level (not line) comments
  timeline: TimelineItem[];          // unified activity feed
}
```

`pr-status-poller.ts` gains the corresponding GraphQL selections. The poller already runs on a tick — adding these fields costs one GraphQL round-trip's worth of extra payload per tick per session with an open PR. For sessions whose panel is closed, the poller can skip the heavier `reviewThreads`/`timeline` selections (gate on `panelOpenForSession[sessionId]` reported back over WS). This keeps idle-session polling cheap.

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

- **New component:** `src/client/components/PrDetailPanel.tsx` — top-level panel, composes sub-sections.
- **Sub-components** (siblings under `components/pr-detail/`):
  - `PrDetailHeader.tsx`
  - `PrDescriptionSection.tsx` (markdown view + edit mode using existing Monaco markdown setup from `MarkdownSectionComments.tsx`)
  - `PrStatusSection.tsx` (extracts the status visuals from `PrLifecycleCard` into a shared sub-component both card and panel render)
  - `PrConversationSection.tsx` (reuses widgets from [`docs/102`](../102-github-pr-comment-sync/plan.md) for review threads; adds an issue-comment composer)
  - `PrFilesSection.tsx` (file rows that delegate to existing diff viewer)
  - `PrTimelineSection.tsx`
- **Store changes:** extend `pr-store.ts:PrCardState` with the new fields; add `ui-store.ts:openPrDetailPanel(sessionId)` / `closePrDetailPanel()`.
- **Card change:** wrap `PrLifecycleCard`'s body in a clickable container that dispatches `openPrDetailPanel`. Existing interactive controls call `stopPropagation`.

### Phasing

| Phase | Scope | Depends on |
|---|---|---|
| **1. Panel scaffold + header + description** | Panel surface, open/close UX, render title + markdown body (read-only), poller fetches `prBody`, "View on GitHub" overflow link. Card becomes clickable. | — |
| **2. Editable description + title** | Pencil → Monaco markdown edit → `updatePullRequest`. Title click-to-edit. Optimistic update with revert-on-error. | Phase 1 |
| **3. Status section in panel + extract shared sub-component** | Move status visuals into a sub-component used by both card and panel. Card UX unchanged; panel gets full status detail. | Phase 1 |
| **4. Conversation section** | Issue comments + review threads. Heavy overlap with [`docs/102`](../102-github-pr-comment-sync/plan.md) — co-sequence so the GraphQL query and widget work happen once. | [`docs/102`](../102-github-pr-comment-sync/plan.md) Phase 1 |
| **5. Files section** | List from existing diff API; "View diff" opens the existing Monaco diff panel — no diff re-implementation. | Phase 1 |
| **6. Activity timeline** | Timeline GraphQL query; new `PrTimelineSection`. Read-only. | Phase 1 |

Phases 1-3 are the minimum viable panel. Phase 4 is the largest single win (subsumes the link-out to GitHub for review). Phases 5-6 fill in the long tail.

## Relationship to other docs

- [`docs/064-pr-lifecycle-flow`](../064-pr-lifecycle-flow/plan.md) — built the card. This doc takes the card from "compact status" to "compact status + drill-in destination."
- [`docs/102-github-pr-comment-sync`](../102-github-pr-comment-sync/plan.md) — review-thread sync. The panel's Conversation section is where these threads naturally render at the PR level (in addition to the inline-on-diff rendering 102 already plans). Co-sequence phase 4 here with 102's phase 1.
- [`docs/113-pr-mergeable-state`](../113-pr-mergeable-state/plan.md) — mergeability conflicts. The panel's Status section is the right place to surface conflict details and resolution prompts more verbosely than the card can.
- [`docs/032-ai-pr-description`](../032-ai-pr-description/plan.md) — AI-generated descriptions. The panel's edit flow should plug into the same generator (button: "Regenerate from conversation").

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/pr-status-poller.ts` | Add `body`, `createdAt`, `author`, `timeline`, `issueComments` (and `reviewThreads` per 102) to GraphQL query. Gate heavy selections on `panelOpenForSession`. |
| `src/server/shared/types/github-types.ts` | Extend `PrStatusSummary` with `prBody`, `prCreatedAt`, `prAuthor`, `timeline`, `issueComments`. |
| `src/server/orchestrator/services/github.ts` | Add `updatePullRequest`, `addIssueComment` service functions. |
| `src/server/orchestrator/api-routes-github.ts` | Add `PATCH /api/sessions/:id/pr` and `POST /api/sessions/:id/pr/comments` routes. |
| `src/server/orchestrator/ws-handlers/misc-handlers.ts` (or new) | New WS message `pr_detail_panel_state { sessionId, open }` so server knows whether to fetch heavy fields. |
| `src/client/components/PrLifecycleCard.tsx` | Wrap body in clickable container; add hover affordance; `stopPropagation` on interactive controls. Extract status visuals into shared sub-component. |
| `src/client/components/PrDetailPanel.tsx` (new) | Top-level panel component. |
| `src/client/components/pr-detail/*.tsx` (new) | Section sub-components. |
| `src/client/stores/pr-store.ts` | Extend `PrCardState` with new fields; selector helpers. |
| `src/client/stores/ui-store.ts` | `prDetailPanelSessionId: string \| null`; `openPrDetailPanel` / `closePrDetailPanel` actions. |
| `src/client/hooks/useApi.ts` | Hooks for `PATCH /api/sessions/:id/pr` and the new comments endpoint. |

## Tests

Per the `testing-and-quality` skill checklist:

- **Server:** `integration_tests/pr-detail-panel.test.ts`
  - Poller fetches body/timeline/issueComments only when panel is open for the session.
  - `PATCH /api/sessions/:id/pr` calls `updatePullRequest` with the right payload; round-trips title/body change to the next poll tick.
  - `POST /api/sessions/:id/pr/comments` calls `addIssueComment`; 401 if `GitHubAuthManager` not authenticated.
- **Client:** `PrDetailPanel.test.tsx`, `PrLifecycleCard.test.tsx`
  - Clicking the card opens the panel; clicking the auto-fix toggle does **not** open the panel (stopPropagation).
  - `Esc` closes the panel.
  - Edit description → save → optimistic update; on server error, reverts and shows inline banner.
- **Smoke:** add the panel to a single existing render-the-app smoke test to catch obvious regressions.

## Out of scope

- **Cross-repo / cross-session PR browsing.** The panel only ever shows the PR for the active session.
- **PR creation flow.** Stays in the card per `docs/064`.
- **Re-implementing the diff viewer.** The Files section delegates to the existing Monaco diff panel.
- **Labels, milestones, projects, assignees.** Deferrable to a follow-up; the panel layout leaves room.
- **Multiple PRs per session.** Same 1:1 model as `docs/064`.
- **Offline editing.** Edits require an authenticated GitHub session; no queueing.
