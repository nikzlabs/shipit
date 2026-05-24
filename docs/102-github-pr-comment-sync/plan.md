---
status: in-progress
priority: high
description: Bidirectionally sync GitHub PR review comments with ShipIt's inline diff viewer so teammates' comments appear in-app and replies write back to GitHub.
---

# 102 — GitHub PR Review Comment Sync

## Status snapshot

- **Read side** — shipped with docs/133 Phase 4 (poller fetches `reviewThreads`, `PrConversationSection` renders them).
- **Phase 1 write-back (this doc)** — reply, resolve, and unresolve via GraphQL. Gated by a `prCommentSync` setting (off by default). The mutation controls live in `PrConversationSection`.
- **Inline render follow-up** — GitHub review threads now render as read-only Monaco diff widgets by mapping `PrReviewThread` data into `LineCommentLike` entries with `source: "github"`. Replies and resolve/reopen still live in `PrConversationSection`.
- **Deferred** — "Send review to GitHub (N)" batched pending review flow, the agent auto-loop on new comment.

## Summary

Bidirectionally sync GitHub PR review comments with ShipIt's existing inline diff comments. PR comments authored on github.com appear in the in-app diff viewer with author, avatar, and resolved state; replies and resolutions made in ShipIt write back to GitHub via the GraphQL API. Closes the biggest gap between ShipIt and dedicated review tools (Conductor, GitHub PR pages, Graphite).

## Motivation

ShipIt already has substantial inline-comment infrastructure (`docs/017-…`, `MonacoCommentWidgets.ts`, `MarkdownSectionComments.tsx`) — comments on a diff line feed back to Claude as context. But these comments are local to the session: a teammate reviewing on github.com cannot reach Claude through them, and a comment Claude leaves is invisible outside ShipIt.

Conductor sealed this gap in v0.29.0 ("GitHub Comment Sync") and v0.44.0 ("resolve GitHub review comments from Conductor"). Without it, ShipIt is a great solo tool but loses to GitHub's PR page the moment a reviewer enters the loop.

## Design

### Data flow

1. **Pull** — when a session has an open PR (`pr-status-poller.ts` already tracks this), the poller's GraphQL query gains a `reviewThreads` selection: `comments { nodes { id, body, author, path, line, originalLine, diffSide } }, isResolved`.
2. **Render** — incoming threads materialize as Monaco comment widgets keyed by GitHub `databaseId` (distinct from the local `commentId` namespace). Author avatar and "from GitHub" badge in the widget header. Resolved threads collapse into a single chevron strip the way GitHub renders them.
3. **Reply / resolve in ShipIt** — the existing comment composer gains a "post to GitHub" toggle (default on when the session has a PR). Submitting calls `POST /api/sessions/:id/pr/comments` → `services/github.ts:postReviewComment()` → GraphQL `addPullRequestReviewThreadReply` or `resolveReviewThread`.
4. **Push** — a comment authored locally with the toggle on creates a **pending review** the first time, then `submitPullRequestReview` on the next "Send to GitHub" click. This avoids spamming GitHub with one notification per line comment.
5. **Conflict resolution** — comments are append-only on both sides. Resolution state is last-writer-wins: a local resolve writes to GitHub immediately; a GitHub resolve flips local state on the next poll tick.

### Server pieces

- New service: `src/server/orchestrator/services/github-pr-comments.ts` — `fetchReviewThreads(prNumber)`, `postReviewComment(...)`, `resolveThread(threadId)`. Uses the existing `GitHubAuthManager` token.
- Extend `pr-status-poller.ts`: add `reviewThreads` to its GraphQL query; emit a `pr_comments_update` SSE message when threads change.
- New WS server message: `pr_comments_update { sessionId, prNumber, threads: ReviewThread[] }`.
- New HTTP routes: `POST /api/sessions/:id/pr/comments`, `POST /api/sessions/:id/pr/comments/:threadId/resolve`, `POST /api/sessions/:id/pr/comments/:threadId/reply`.

### Client pieces

- Extend `MonacoCommentWidgets.ts` to accept a `source: 'local' | 'github'` discriminator and render author info.
- New store slice in `git-store.ts`: `prComments: Record<sessionId, ReviewThread[]>`.
- "Send review to GitHub" pill button at the top of the diff panel — counts pending local comments and lets the user batch-post.

### Mapping line numbers

GitHub reports comments against `originalLine` on the diff (i.e. the snapshot of the file at the SHA of the comment). Local comments target the working copy. We match by `(path, side, line)` against the diff currently rendered in the Monaco editor using the existing diff-vs-base-branch query — if the file has drifted since the comment was posted, we render the comment as "outdated" with a chevron, matching GitHub's behavior.

## Auth and feature flags

- Requires `githubAuthManager.authenticated`. Otherwise the toggle is hidden and pull is skipped.
- Gate the whole feature behind a `prCommentSync` setting in `CredentialStore`, default off in initial release. Promote to default-on after the integration test suite is green and one beta cycle.

## Tests

`integration_tests/pr-comment-sync.test.ts`:

1. Poller picks up a new GitHub thread → `pr_comments_update` emitted → store populated.
2. Local reply with toggle on → service stub records GraphQL mutation with correct thread id.
3. Local resolve → GraphQL `resolveReviewThread` called.
4. GitHub-side resolve appears in the next poll → local widget collapses.
5. Outdated comment (file changed since SHA) renders with `outdated: true`.

## Key files

Shipped in Phase 1 (write-back via the PR conversation panel):

| File | Change |
|---|---|
| `src/server/orchestrator/github-auth-review-threads.ts` | **New** — GraphQL helpers: `addReviewThreadReply`, `resolveReviewThread`, `unresolveReviewThread`. |
| `src/server/orchestrator/github-auth.ts` | Methods on `GitHubAuthManager` that delegate to the helpers above. |
| `src/server/orchestrator/services/github-pr-comments.ts` | **New** — service wrapping the mutations behind the feature flag + auth checks. Throws `ServiceError(403, …)` when `prCommentSync` is off. |
| `src/server/orchestrator/api-routes-github.ts` | New routes: `POST /api/sessions/:id/pr/threads/:threadId/reply`, `…/resolve`, `…/unresolve`. |
| `src/server/orchestrator/credential-store.ts` | New `prCommentSync` flag (default `false`) with `getPrCommentSync` / `setPrCommentSync`. |
| `src/server/orchestrator/services/{settings,types}.ts` | Carry the flag through `GlobalSettings` so bootstrap surfaces it to the client. |
| `src/server/shared/types/ws-server-messages.ts` | Add `prCommentSync` to `WsGlobalSettings`. |
| `src/client/stores/pr-store.ts` | Actions `replyToThread`, `resolveThread`, `unresolveThread` — optimistic + revert, reconciled by the next poll. |
| `src/client/stores/settings-store.ts` | `prCommentSync` state slice. |
| `src/client/components/pr-detail/PrConversationSection.tsx` | Reply box + Resolve/Reopen control on every review thread. Hidden when the flag is off. |
| `src/client/components/Settings.tsx` | New `PrCommentSyncSettings` toggle in the GitHub tab. |
| `src/client/utils/session-data.ts`, `src/client/App.tsx` | Pick up `prCommentSync` from the bootstrap payload. |
| `src/server/orchestrator/integration_tests/test-helpers.ts` | `StubGitHubAuthManager` gains `addReviewThreadReply` / `resolveReviewThread` / `unresolveReviewThread` plus call-log + result-override hooks. |

Deferred to a Phase 2 of this feature:

| File | Change |
|---|---|
| `src/client/components/MonacoCommentWidgets.ts` | **Shipped follow-up** — Render GitHub-sourced threads inline on the diff viewer with `source: 'local' \| 'github'`; GitHub cards are read-only and show author/reply/resolved/outdated metadata. |
| `src/client/components/DiffPanel.tsx` | **Shipped follow-up** — Merge `card.reviewThreads` from `pr-store` with local diff comments so the Monaco diff shows teammate review comments on matching file/line anchors. |
| `src/client/components/PrLifecycleCard.tsx` | "Pending review (N)" pill. |
| `src/server/orchestrator/services/github-pr-comments.ts` | `submitPullRequestReview` to batch-post local line comments as a single pending review. |

## Future extensions

- **Reactions** — GitHub thumbs/eyes mirrored in the widget.
- **Suggested changes** — render GitHub's `suggestion` blocks as one-click apply buttons.
- **Auto-loop on new comment** — when a reviewer leaves a comment, ShipIt can prompt Claude to address it automatically (gated by a per-session setting, similar to `autoFix`).
- **MonacoCommentWidgets integration** — render GitHub-sourced review threads inline on the diff viewer (the read side currently lives only in the PR detail panel).
- **Pending-review batching** — accumulate local line comments and post them as a single GraphQL `submitPullRequestReview` rather than one notification per reply.
