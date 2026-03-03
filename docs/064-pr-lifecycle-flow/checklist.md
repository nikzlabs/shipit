# PR Lifecycle Flow — Checklist

## Phase 1: Inline Card + CI Status Infrastructure

### Server
- [x] Add `PrStatusSummary` type to `github-types.ts`
- [x] Add `pr_lifecycle_update` message type to `ws-server-messages.ts`
- [x] Create `PrStatusPoller` class (`pr-status-poller.ts`) — GraphQL query, per-repo polling, SSE broadcast
- [x] Add `POST /api/sessions/:id/pr/quick` endpoint — push, generate description, create PR
- [x] Add `quickCreatePr()` service function with conversation-aware description generation
- [x] Emit `pr_lifecycle_update` after agent turn with diff stats (`send-message.ts`)
- [x] Wire `PrStatusPoller` into `buildApp()` / `index.ts` — instantiate, start/stop with sessions
- [x] Add `pr_status` SSE event, send snapshot on SSE connect
- [x] Remove per-session HTTP polling endpoint usage (keep endpoint for backward compat)

### Client
- [x] Create `PrLifecycleCard` component — renders all phases (ready, creating, open, merged, error)
- [x] Render `PrLifecycleCard` in `MessageList` for `pr_lifecycle_update` messages
- [x] Rewrite `pr-store` — SSE-driven state, `quickCreate()` action, per-session status map
- [x] Handle `pr_status` SSE event in `useServerEvents`
- [x] Handle `pr_lifecycle_update` in `useMessageHandler`
- [x] Remove PR status polling from `useConnectionSync`
- [x] Add PR status icons to sidebar session cards
- [x] Remove `PrStatusBar` component and its rendering in `App.tsx`

### Tests
- [x] `PrLifecycleCard.test.tsx` — all phases, button callbacks, CI status variants
- [x] `pr-status-poller.test.ts` — GraphQL parsing, session matching, change detection, start/stop
- [x] `pr-lifecycle.test.ts` — integration tests for quick-create endpoint, poller SSE broadcast

## Phase 2: CI Failure Details + Server-Driven Auto-Fix

### Server
- [ ] Extend GraphQL query with `oid` on commit node and `databaseId`, `title`, `detailsUrl` on CheckRun
- [ ] Add `CIFailureLog` type to `github-types.ts`
- [ ] Add `getCheckRunAnnotations()` and `getJobLogs()` to `github-auth.ts`
- [ ] Add `fetchCIFailureLogs()` service function
- [ ] Add `POST /api/sessions/:id/pr/fix-ci` endpoint — fetch logs, construct prompt, send/enqueue
- [ ] Add `POST /api/sessions/:id/pr/auto-fix` endpoint — toggle state, trigger if CI failed
- [ ] Add `AutoFixState` map to `PrStatusPoller` — manage enabled, attempts, lastHeadSha
- [ ] Add auto-fix loop in poller tick handler — detect failure, fetch logs, enqueue fix prompt
- [ ] Add `sendSystemMessage()` to `SessionRunnerInterface` — server-initiated prompts without WS context
- [ ] Extend `PrStatusSummary` SSE shape with `failedChecks` and `autoFix`

### Client
- [ ] Add per-check failure list to `PrLifecycleCard` (truncate to 5 with "and N more...")
- [ ] Add auto-fix toggle to card
- [ ] Add "Fix CI Issues" button (visible when auto-fix off or exhausted)
- [ ] Add auto-fix running state (`⟳ Auto-fixing (attempt N/3)...`)
- [ ] Add auto-fix exhausted state
- [ ] Add `fixCI()` and `toggleAutoFix()` to `pr-store`

### Tests
- [ ] `PrLifecycleCard.test.tsx` — failure list, auto-fix toggle, running/exhausted states
- [ ] `pr-ci-fix.test.ts` — integration tests for fix-ci, auto-fix toggle, agent-busy queueing, exhaustion

## Phase 3: Merge + Auto-Merge + Post-Merge Archive

### Server
- [ ] Add `disableAutoMerge()` GraphQL mutation to `github-auth.ts`
- [ ] Add `PrAutomationState` type (wraps autoFix + autoMerge) to `github-types.ts`
- [ ] Add `POST /api/sessions/:id/pr/auto-merge` endpoint — enable/disable GitHub native auto-merge
- [ ] Add `POST /api/sessions/:id/pr/merge-method` endpoint — persist merge method preference
- [ ] Extend `POST /api/sessions/:id/pr/merge` with optional `method` field
- [ ] Add `PrAutoMergeError` type with `settingsUrl` for clear error messages
- [ ] Detect merged PRs in poller (missing from OPEN results) → trigger session archive
- [ ] Extend `PrStatusSummary` SSE shape with `autoMerge`

### Client
- [ ] Add merge split button with method dropdown to `PrLifecycleCard`
- [ ] Add auto-merge toggle to card
- [ ] Add "Will merge when CI passes" state
- [ ] Add auto-merge error messages with repo settings links
- [ ] Add merged card state (`✓ PR #42 merged into main`)
- [ ] Add `merge()`, `toggleAutoMerge()`, `setMergeMethod()` to `pr-store`

### Tests
- [ ] `PrLifecycleCard.test.tsx` — merge button, dropdown, auto-merge toggle, error states, merged state
- [ ] Integration tests — auto-merge enable/disable, error cases, merge-method update, post-merge archive
