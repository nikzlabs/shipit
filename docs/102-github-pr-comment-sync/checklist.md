# 102 — GitHub PR Review Comment Sync — Checklist

## Phase 1: write-back via PR conversation panel (shipped)

### Server

- [x] Add `prCommentSync` feature-flag setting to `CredentialStore` (default `false`)
- [x] Thread the flag through `GlobalSettings` so it surfaces in the bootstrap payload
- [x] Add `addPullRequestReviewThreadReply` / `resolveReviewThread` / `unresolveReviewThread` GraphQL helpers (`github-auth-review-threads.ts`)
- [x] Wire those helpers onto `GitHubAuthManager`
- [x] Create `services/github-pr-comments.ts` with feature-flag + auth gates
- [x] Add HTTP routes:
  - [x] `POST /api/sessions/:id/pr/threads/:threadId/reply`
  - [x] `POST /api/sessions/:id/pr/threads/:threadId/resolve`
  - [x] `POST /api/sessions/:id/pr/threads/:threadId/unresolve`
- [x] Extend `StubGitHubAuthManager` with call logs and result-override hooks

### Client

- [x] Add `prCommentSync` slice + setter to `settings-store.ts`
- [x] Add `prCommentSync` toggle to Settings → GitHub tab
- [x] Add `replyToThread` / `resolveThread` / `unresolveThread` actions to `pr-store.ts` (optimistic + revert)
- [x] Add reply box + Resolve/Reopen controls to `PrConversationSection.tsx`, gated by the flag
- [x] Pick up `prCommentSync` from the bootstrap payload (`session-data.ts`, `App.tsx`)
- [x] Update `WsGlobalSettings` handler so live-pushed settings include the flag

### Tests

- [x] Unit tests for the GraphQL helpers (`github-auth-review-threads.test.ts`)
- [x] Integration tests for the three routes (`pr-comment-sync.test.ts`):
  - [x] flag-off → 403 with no GitHub call
  - [x] flag-on but no auth → 401
  - [x] unknown session → 404
  - [x] empty body → 400
  - [x] happy path → forwards trimmed body + thread id
  - [x] GitHub failure → 502
  - [x] settings PUT persists the flag and bootstrap surfaces it

### Wrap-up

- [x] `npm run lint`
- [x] `npm run typecheck`
- [x] `npm run test:dev`
- [x] Update `plan.md` (status, key files, deferred work)

## Remaining work, prioritized

### High priority

- [x] Render GitHub-sourced review threads inline on the Monaco diff viewer (`MonacoCommentWidgets` `source: 'local' | 'github'` discriminator)

  This is the core promise of the feature. Review comments currently appear in the PR conversation panel, but not where reviewers and agents reason about changed code lines. Until this exists, comment sync is useful but not truly inline.

- [x] Add a "Send review to GitHub (N)" pill in `PrLifecycleCard.tsx` and batch local line comments into a single `submitPullRequestReview`

  This should follow inline rendering. Posting each line comment immediately is noisy and does not match GitHub's review workflow. A pending-review batch makes ShipIt behave like a real PR review surface instead of a comment proxy.

### Medium priority

- [ ] Add an auto-loop hook on new GitHub-sourced comments (per-session opt-in, similar to `autoFix`)

  This becomes valuable after comments are visible inline: a reviewer comment can prompt the agent to address feedback without the user manually copying context. Keep it opt-in because automatic agent action on teammate comments can be surprising.

### Low priority until the above are stable

- [ ] Promote `prCommentSync` to default-on after a beta cycle

  Default-on makes sense once inline rendering and write-back are trustworthy. Before then, the flag should stay off so a partial workflow is not exposed as the default experience.
