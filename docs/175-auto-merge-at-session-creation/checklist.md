# Checklist — auto-merge at session creation

> Blocked on PR #1054 merging first (avoids conflicts in `PrLifecycleCard.tsx`
> and the overflow-gating logic). Do not start the client work until then.

## Decisions (locked)
- [x] Toggle is **always present**, no CI-presence gating (decision #2). The
      per-session explicit opt-in is the gate; experimental/no-CI repos are a
      first-class use case. Inform via a card line, never block.

## Server
- [ ] Add optional `armAutoMerge` (boolean) to `CreateHeadlessSessionOptions`
      (`headless-sessions.ts`).
- [ ] Accept + validate the flag on `POST /api/sessions/headless`
      (`api-routes-session.ts`).
- [ ] After claim/graduate, seed the per-session armed auto-merge state via the
      existing toggle/arm path — no new merge logic.
- [ ] Verify the PR-creation handoff: when the first turn opens a PR, the poller
      picks up the already-armed state and merges on green (existing behavior).

## Client
- [ ] Add the auto-merge checkbox to `QuickCaptureOverlay.tsx`, default off.
- [ ] Explicitly **do not** persist to `localStorage` (per decision #1). Add a
      code comment citing this doc so nobody "fixes" it later.
- [ ] Thread `armAutoMerge` through `createHeadlessSession()`
      (`session-actions.ts`).
- [ ] When armed on a repo with no required checks, surface the "will merge as
      soon as the PR is open and mergeable — no CI gate" transparency line on the
      session/PR card (decision #2). Inform, don't block.

## Tests
- [ ] Server: creating a headless session with `armAutoMerge: true` arms the
      session's auto-merge state; omitting it leaves auto-merge off.
- [ ] Server: the flag is not persisted — a reload/restart does not re-arm.
- [ ] Client: overlay checkbox defaults off and does not read/write
      `localStorage`.
- [ ] Integration: armed-at-creation session merges on green via the existing
      poller path.

## Docs
- [ ] Update this checklist as items land; mark all `[x]` when done.
- [ ] If behavior visible to the in-container agent changes, update
      `src/server/shipit-docs/` (likely none for this feature).
