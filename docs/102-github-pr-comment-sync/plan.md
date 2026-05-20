---
status: planned
priority: high
description: Bidirectionally sync GitHub PR review comments with ShipIt's inline diff viewer so teammates' comments appear in-app and replies write back to GitHub.
---

# 102 — GitHub PR Review Comment Sync

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

| File | Change |
|---|---|
| `src/server/orchestrator/services/github-pr-comments.ts` | New — wraps GraphQL review-thread mutations |
| `src/server/orchestrator/pr-status-poller.ts` | Extend query, emit `pr_comments_update` |
| `src/server/orchestrator/api-routes-github.ts` | New PR-comment routes |
| `src/shared/types/ws-server-messages.ts` | Add `pr_comments_update` message |
| `src/client/components/diff/MonacoCommentWidgets.ts` | Render GitHub-sourced threads, resolved state |
| `src/client/stores/git-store.ts` | `prComments` slice + actions |
| `src/client/components/PrLifecycleCard.tsx` | "Pending review (3)" pill in `open` phase |

## Future extensions

- **Reactions** — GitHub thumbs/eyes mirrored in the widget.
- **Suggested changes** — render GitHub's `suggestion` blocks as one-click apply buttons.
- **Auto-loop on new comment** — when a reviewer leaves a comment, ShipIt can prompt Claude to address it automatically (gated by a per-session setting, similar to `autoFix`).
