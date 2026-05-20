# 133 — Phase 4 (Conversation section) checklist

Scope for this pass (decided 2026-05-20):

- **Issue comments** — read + post PR-level (issue) comments in the panel.
- **Review threads** — render **read-only** (author, body, resolved/outdated state).
  Reply/resolve write-back is deferred (full docs/102 work).
- **Poller heavy-field gating** — fetch conversation fields only when the PR tab
  is the active right-panel tab for a session (`pr_tab_active`).

## Server — data layer

- [x] `github-types.ts`: add `PrCommentAuthor`, `PrIssueComment`,
      `PrReviewThreadComment`, `PrReviewThread` types; extend `PrStatusSummary`
      with optional `issueComments?` and `reviewThreads?`.
- [x] `pr-status-parser.ts`: parameterize the query via
      `buildPrStatusQuery(includeConversation)`; keep `PR_STATUS_QUERY` (light)
      and add `PR_STATUS_QUERY_WITH_CONVERSATION` (heavy).
- [x] `pr-status-parser.ts`: extend `GraphQLPrNode` with optional `comments` /
      `reviewThreads`; add `parseConversation(node)` and populate the new summary
      fields in `parsePrNode`.
- [x] `pr-status-parser.ts`: extend `prStatusEqual` (`conversationEqual`) to
      detect comment/thread changes; treats defined/undefined mismatch as changed.

## Server — gating

- [x] `pr-status-poller.ts`: track `prTabActiveSessions: Set<string>`; add
      `setPrTabActive(sessionId, active)` that flips the flag and kicks an
      immediate poll for that repo when turned on.
- [x] `pr-status-poller.ts`: in `pollRepo`, pick the heavy query only when a
      tracked session on the repo has the tab active; carry the previous
      conversation forward on light polls so a focus change doesn't wipe it.
- [x] `pr-status-poller.ts`: clear the flag in `untrackSession`.

## Server — WS message + write route

- [x] `ws-client-messages.ts`: add `WsPrTabActive` to the union.
- [x] `ws-handlers/misc-handlers.ts`: add `handlePrTabActive(ctx, msg)` →
      `ctx.prStatusPoller.setPrTabActive(...)`.
- [x] `index.ts`: dispatch `pr_tab_active` (single per-session WS dispatcher).
- [x] `services/github.ts`: add `addIssueComment` (wrapper over
      `commentOnPullRequest`, resolving the current-branch PR).
- [x] `api-routes-github.ts`: add `POST /api/sessions/:id/pr/comments`
      (body `{ body }`) → `addIssueComment`. (No explicit post-poll trigger —
      the client appends optimistically and the active-tab poll reconciles.)

## Client

- [x] `pr-store.ts`: extend `PrCardState` with `issueComments` / `reviewThreads`;
      populate them in `applyPrStatusUpdates` (preserving on light polls); add a
      `postComment(sessionId, body)` action (optimistic + revert-on-error).
- [x] `App.tsx`: emit `pr_tab_active` from an effect keyed on rightTab + session
      + connection status (survives session switches and reconnects).
- [x] `components/pr-detail/PrConversationSection.tsx` (new): issue comments +
      read-only review threads + composer + inline error banner.
- [x] `PrDetailPanel.tsx`: render `PrConversationSection` between Status and Files.

## Tests

- [x] Parser/poller tests live in `pr-status-poller.test.ts` (alongside existing
      parser tests, not a new file): conversation parsing, `prStatusEqual` change
      detection, light-query omission, and the `pr_tab_active` query gate.
- [x] Route tests added to `integration_tests/http-mutations.test.ts` (not a new
      `pr-detail-panel.test.ts`): `POST /pr/comments` 400 (empty body) / 401
      (unauth) / 200 success calling `addPullRequestComment`. Stub gained
      `addPullRequestComment` + `lastIssueComment` capture.
- [x] `PrConversationSection.test.tsx`: renders comments/threads, loading/empty
      states, composer posts + clears, error banner; `pr-store.test.ts` covers
      `postComment` optimistic + revert.
- [x] `npm run lint` + `npm run typecheck` clean; `npm run test:dev` green (247).

## Docs

- [x] Update `plan.md`: Phase 4 marked partial (read-only threads + issue comments
      shipped, gating implemented); write-back deferred to docs/102.
