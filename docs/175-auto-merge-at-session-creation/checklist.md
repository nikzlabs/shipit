# Checklist — auto-merge at session creation

> Blocked on PR #1054 merging first (avoids conflicts in `PrLifecycleCard.tsx`
> and the overflow-gating logic). Do not start the client work until then.

## Decisions to lock before coding
- [ ] Resolve the open question: hide/disable the creation-time toggle when the
      repo has no required checks, vs. arm + show a "no CI gate" warning. Pick one.
- [ ] Confirm whether overlay-time code can cheaply know if the repo has required
      checks (without an extra API round-trip). Determines the above.

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
- [ ] Surface the "no CI gate on this repo" warning if that path is chosen.

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
