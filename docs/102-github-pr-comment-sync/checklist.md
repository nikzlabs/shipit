# 102 — GitHub PR Review Comment Sync — Checklist

## Phase 1: write-back via PR conversation panel (shipped)

### Server

- [x] Add `addPullRequestReviewThreadReply` / `resolveReviewThread` / `unresolveReviewThread` GraphQL helpers (`github-auth-review-threads.ts`)
- [x] Wire those helpers onto `GitHubAuthManager`
- [x] Create `services/github-pr-comments.ts` with an auth gate
- [x] Add HTTP routes:
  - [x] `POST /api/sessions/:id/pr/threads/:threadId/reply`
  - [x] `POST /api/sessions/:id/pr/threads/:threadId/resolve`
  - [x] `POST /api/sessions/:id/pr/threads/:threadId/unresolve`
- [x] Extend `StubGitHubAuthManager` with call logs and result-override hooks

### Client

- [x] Add `replyToThread` / `resolveThread` / `unresolveThread` actions to `pr-store.ts` (optimistic + revert)
- [x] Add reply box + Resolve/Reopen controls to `PrConversationSection.tsx`

### Tests

- [x] Unit tests for the GraphQL helpers (`github-auth-review-threads.test.ts`)
- [x] Integration tests for the three routes (`pr-comment-sync.test.ts`):
  - [x] no auth → 401
  - [x] unknown session → 404
  - [x] empty body → 400
  - [x] happy path → forwards trimmed body + thread id
  - [x] GitHub failure → 502

### Wrap-up

- [x] `npm run lint`
- [x] `npm run typecheck`
- [x] `npm run test:dev`
- [x] Update `plan.md` (status, key files, deferred work)

## Follow-up ideas

These are intentionally outside the shipped scope for docs/102. Keep them here
as planning notes unless they grow into their own feature docs.

- [x] Render GitHub-sourced review threads inline on the Monaco diff viewer (`MonacoCommentWidgets` `source: 'local' | 'github'` discriminator)

  This is the core promise of the feature. Review comments currently appear in the PR conversation panel, but not where reviewers and agents reason about changed code lines. Until this exists, comment sync is useful but not truly inline.

- [x] Add a "Send review to GitHub (N)" pill in `PrLifecycleCard.tsx` and batch local line comments into a single `submitPullRequestReview`

  This should follow inline rendering. Posting each line comment immediately is noisy and does not match GitHub's review workflow. A pending-review batch makes ShipIt behave like a real PR review surface instead of a comment proxy.

- [x] Remove the `prCommentSync` opt-in flag

  The flag gated only user-triggered write surfaces (Reply / Resolve / Send review), so it never guarded against background mutation. After the beta cycle the flag was retired; auth is the only remaining gate.

- Add an auto-loop hook on new GitHub-sourced comments (per-session opt-in, similar to `autoFix`)

  This becomes valuable after comments are visible inline: a reviewer comment can prompt the agent to address feedback without the user manually copying context. Keep it opt-in because automatic agent action on teammate comments can be surprising.
