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

## Phase 2: deferred

- [ ] Render GitHub-sourced review threads inline on the Monaco diff viewer (`MonacoCommentWidgets` `source: 'local' | 'github'` discriminator)
- [ ] "Send review to GitHub (N)" pill in `PrLifecycleCard.tsx` — batch local line comments into a single `submitPullRequestReview`
- [ ] Auto-loop hook on new GitHub-sourced comment (per-session opt-in, similar to `autoFix`)
- [ ] Promote `prCommentSync` to default-on after a beta cycle
