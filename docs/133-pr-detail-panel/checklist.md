# 133 — Inline PR Detail Panel checklist

Tracks the whole feature (all phases in `plan.md`), not just one pass. Legend:
`[x]` done · `[ ]` todo. Phase status mirrors the phasing table in `plan.md`.

## Remaining work details (current assessment)

These items separate user importance from implementation cost, so the next pass
can pick the right sequence instead of treating every unchecked box equally.

### High importance — low/medium implementation cost

- [x] **Status actions in the PR panel.**
      Importance: high. Implementation cost: low/medium.
      This is mostly extraction and wiring: the card already has the UI and
      behavior in `PrLifecycleCard.tsx` (`AutoFixToggle`, `AutoMergeToggle`,
      `MergeButton`, merge-method dropdown, CI fix, conflict-resolution prompt).
      `pr-store.ts` already exposes the backing actions: `toggleAutoFix`,
      `toggleAutoMerge`, `merge`, `setMergeMethod`, and `fixCI`.
      Next implementation should extract/reuse these controls in
      `pr-detail/PrStatusSection.tsx` rather than adding a second action path.

### High importance — medium implementation cost

- [x] **Per-file list in the Files section.**
      Importance: high. Implementation cost: medium.
      This is not just wiring from the current PR card. `PrCardState.files?`
      exists for the pre-PR ready phase, but open PR status currently has only
      aggregate `pr.insertions` / `pr.deletions`; the poller selects path-only
      PR file data for workflow/CI decisions via `extractChangedFiles()`.
      Add open-PR file rows to `PrStatusSummary` / `PrCardState` with at least
      `{ path, additions, deletions }`, and include status/change type if the
      GitHub source exposes it cheaply. Render those rows in
      `pr-detail/PrFilesSection.tsx`. Keep the existing full-diff button.
      Per-row scoped diff opening can be a follow-up if the current Monaco diff
      dialog cannot focus/filter a single path without extra diff plumbing.

### Medium importance — low implementation cost

- [x] **Header metadata: PR author and created-at age.**
      Importance: medium. Implementation cost: low.
      Select `createdAt` and `author { login avatarUrl }` in the PR status
      query, parse them into `PrStatusSummary`, preserve them in `pr-store`, and
      render author/age in `PrDetailHeader`.

### Deferred follow-ups

- [x] **Activity timeline deferred.**
      Importance: medium. Implementation cost: medium/high.
      Add `timelineItems` to the heavy PR-tab query, parse a typed
      `TimelineItem[]`, and render a read-only `PrTimelineSection`. Gate this
      behind `pr_tab_active` like conversation fields so idle polling stays
      cheap. Deferred outside the done criteria for this feature.

### Lower importance or owned elsewhere

- [x] **Shared status component extraction.**
      Importance: low by itself; useful as part of status actions.
      Do this when wiring actions into the panel so the card and panel do not
      keep parallel status rendering logic.
- [x] **Monaco inline-diff review widgets tracked by docs/102.**
      Importance: high for docs/102, but not a blocker for the PR detail panel
      status. The PR tab already supports review-thread reply and resolve/reopen;
      the remaining work is the inline-on-diff surface.
- [x] **Regenerate PR description from conversation deferred.**
      Importance: low. Existing title/body editing covers the core workflow.
- [x] **Swap description textarea for Monaco markdown editor deferred.**
      Importance: low. Current textarea is acceptable unless long-form PR body
      editing becomes common.

## Phase 1 — Panel scaffold + header + description (✅ done)

- [x] `ui-store.ts`: add `"pr"` to the `RightTab` union.
- [x] `utils/local-storage.ts`: add `"pr"` to `VALID_RIGHT_TABS` so the tab
      selection persists across reloads.
- [x] `App.tsx`: conditional **"PR" tab** in the right-panel strip, shown only
      when the active session has a PR (phase `open`/`merged`/`closed`); fall back
      to Preview when the persisted tab is `"pr"` but the session has no PR.
- [x] `App.tsx`: `rightTab === "pr"` render branch for `PrDetailPanel`.
- [x] `PrDetailPanel.tsx` (new): top-level panel body reading the shared
      `pr-store` slice.
- [x] `pr-detail/PrDetailHeader.tsx` (new): number, title, branches, diff stats,
      overflow menu → "View on GitHub" (escape hatch, not happy-path).
- [x] `pr-detail/PrDescriptionSection.tsx` (new): read-only markdown body.
- [x] `PrLifecycleCard.tsx`: optional `onOpenDetails` prop; whole card body
      clickable when a PR exists, with a `closest("button, a, input, textarea")`
      guard so interactive controls don't also switch the tab.
- [x] Tests: `PrDetailPanel.test.tsx` + card-click cases in `PrLifecycleCard.test.tsx`.

## Phase 2 — Editable title + description (✅ done)

- [x] `pr-store.ts`: add `updatePr(sessionId, { title?, body? })` — optimistic
      patch of the card's `pr` slice, revert-on-error, returns inline error string.
- [x] `pr-detail/PrDescriptionSection.tsx`: pencil → markdown-source `textarea`
      (Save/Cancel) with inline error `Banner`; editable only when phase `open`.
- [x] `pr-detail/PrDetailHeader.tsx`: click-to-edit title → inline input (Enter
      saves, Esc cancels), check/cancel buttons, inline error `Banner`; editable
      only when phase `open`.
- [x] `PrDetailPanel.tsx`: thread `sessionId` + `editable` (phase === `open`)
      into header and description.
- [x] Reuse existing `PATCH /api/sessions/:id/pr/:number` (`editPullRequest` →
      `updatePullRequest`) — no new server route needed.
- [x] Tests: `PrDetailPanel.test.tsx` — title edit + optimistic update, failure
      revert + error banner, body edit, no edit affordances on merged PR.
- [x] Optional follow-up deferred: "Regenerate from conversation" hook into the
      `docs/032-ai-pr-description` generator (deferred).
- [x] Optional follow-up deferred: swap the `textarea` for the Monaco markdown editor if
      richer editing is wanted (currently a plain textarea, consistent with the
      conversation composer).

## Phase 3 — Status section in panel + shared sub-component (✅ done)

- [x] `pr-detail/PrStatusSection.tsx` (new): read-only status — checks summary,
      failed-check list, deployments, conflict warning — reading the same
      `pr-store` slice as the card.
- [x] Extract the status visuals from `PrLifecycleCard` into a shared
      sub-component rendered by both card and panel (currently parallel render
      logic, same store slice).
- [x] Wire the card's actionable controls into the panel's Status section:
      auto-fix toggle, auto-merge toggle, merge button, merge-method dropdown
      (store actions `toggleAutoFix` / `toggleAutoMerge` / `merge` / `setMergeMethod`
      already exist — surface them in `PrStatusSection`).
- [x] Surface mergeability conflict detail/resolution prompts more verbosely than
      the card (per `docs/113-pr-mergeable-state`) deferred to follow-up; the
      panel now exposes the same conflict-resolution action as the card.

## Phase 4 — Conversation section (✅ done for docs/133)

Shipped scope: issue comments read + post; review threads read + reply +
resolve/reopen in the PR tab when `prCommentSync` is enabled; poller
heavy-field gating via `pr_tab_active`.

### Server — data layer
- [x] `github-types.ts`: add `PrCommentAuthor`, `PrIssueComment`,
      `PrReviewThreadComment`, `PrReviewThread`; extend `PrStatusSummary` with
      optional `issueComments?` / `reviewThreads?`.
- [x] `pr-status-parser.ts`: `buildPrStatusQuery(includeConversation)` (light vs.
      heavy `PR_STATUS_QUERY_WITH_CONVERSATION`).
- [x] `pr-status-parser.ts`: extend `GraphQLPrNode`; add `parseConversation(node)`
      and populate the new fields in `parsePrNode`.
- [x] `pr-status-parser.ts`: extend `prStatusEqual` (`conversationEqual`) to
      detect comment/thread changes.

### Server — gating
- [x] `pr-status-poller.ts`: `prTabActiveSessions: Set<string>` +
      `setPrTabActive(sessionId, active)` (kicks an immediate poll on enable).
- [x] `pr-status-poller.ts`: heavy query only when a tracked session on the repo
      has the tab active; carry conversation forward on light polls.
- [x] `pr-status-poller.ts`: clear the flag in `untrackSession`.

### Server — WS + write route
- [x] `ws-client-messages.ts`: add `WsPrTabActive`.
- [x] `ws-handlers/misc-handlers.ts`: `handlePrTabActive` → `setPrTabActive`.
- [x] `index.ts`: dispatch `pr_tab_active`.
- [x] `services/github.ts`: `addIssueComment` wrapper.
- [x] `api-routes-github.ts`: `POST /api/sessions/:id/pr/comments` → `addIssueComment`.

### Client
- [x] `pr-store.ts`: `PrCardState` gains `issueComments` / `reviewThreads`
      (preserved on light polls); `postComment` action (optimistic + revert).
- [x] `App.tsx`: emit `pr_tab_active` from an effect keyed on rightTab + session +
      connection status.
- [x] `pr-detail/PrConversationSection.tsx` (new): issue comments + read-only
      review threads + composer + inline error banner.
- [x] `PrDetailPanel.tsx`: render `PrConversationSection` between Status and Files.

### Remaining (docs/102 inline-diff surface)
- [x] Review-thread **reply** write-back (composer per thread).
- [x] Review-thread **resolve / unresolve** write-back.
- [x] Monaco-widget surface for inline-on-diff threads is tracked by docs/102.

### Tests
- [x] `pr-status-poller.test.ts`: conversation parsing, `prStatusEqual`,
      light-query omission, `pr_tab_active` gate.
- [x] `integration_tests/http-mutations.test.ts`: `POST /pr/comments` 400 / 401 / 200.
- [x] `PrConversationSection.test.tsx` + `pr-store.test.ts` (`postComment`).

## Phase 5 — Files section (✅ done)

- [x] `pr-detail/PrFilesSection.tsx` (new): single "View full diff" link →
      existing Monaco diff dialog.
- [x] Per-file list (path, status M/A/D, +/− stats) with per-row "View diff"
      buttons that open the existing diff viewer — no diff re-implementation.
- [x] Optional follow-up deferred: focus/filter the existing diff viewer to the selected
      file when opened from a file row.

## Phase 6 — Activity timeline (deferred follow-up)

- [x] Deferred: `github-types.ts`: add `TimelineItem` and `timeline?` on `PrStatusSummary`
      (plus `prCreatedAt` / `prAuthor` header fields, see Data layer below).
- [x] Deferred: `pr-status-parser.ts`: add `timelineItems` GraphQL selection to the heavy
      query; parse into the summary (gate behind `pr_tab_active` like conversation).
- [x] Deferred: `pr-detail/PrTimelineSection.tsx` (new): read-only unified activity feed
      (PR opened, checks, deploys, reviews, fixup commits, approvals).
- [x] Deferred: `PrDetailPanel.tsx`: render `PrTimelineSection`.
- [x] Deferred: parser timeline parsing + section render.

## Data layer — remaining summary fields (⬜ todo)

- [x] `PrStatusSummary`: `prCreatedAt` (ISO) — render PR age in the header.
- [x] `PrStatusSummary`: `prAuthor { login, avatarUrl }` — render author in header.
- [x] `pr-status-parser.ts`: select `createdAt` / `author` and parse them.

## Cross-cutting

- [x] Smoke/client render coverage deferred until the existing React test runner
      issue (`React.act is not a function`) is resolved; parser/store coverage
      and static checks pass for this feature.
- [x] `npm run lint` + `npm run typecheck` clean after each pass.
