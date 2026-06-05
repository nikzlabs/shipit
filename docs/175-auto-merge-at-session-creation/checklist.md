# Checklist — auto-merge at session creation

> Blocked on PR #1054 merging first (avoids conflicts in `PrLifecycleCard.tsx`
> and the overflow-gating logic). Do not start the client work until then.

## Decisions (locked)
- [x] Toggle is **always present**, no CI-presence gating (decision #2). The
      per-session explicit opt-in is the gate; experimental/no-CI repos are a
      first-class use case. Inform, never block.
- [x] The "no CI gate" transparency line shows in **both** the overlay (at arm
      time) and the PR card (durable reminder) — not card-only, because a quick
      session may never be opened.
- [x] Mobile is a first-class target for both surfaces, verified explicitly.

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
- [ ] Overlay-time required-checks lookup: query whether the selected repo gates
      on required checks (server route + client hook, cached per repo);
      re-evaluate when the repo dropdown changes.
- [ ] Render the "no CI gate" transparency line inline in the overlay when the
      selected repo has no required checks (decision #2). Inform, don't block.
- [ ] Render the durable "no CI gate" line on the PR card when armed without
      required checks; coordinate with #1054's inline-toggle placement.

## Mobile / responsive
- [ ] Overlay checkbox + no-CI line look deliberate at mobile width — label,
      checkbox, and warning wrap cleanly and stay tappable.
- [ ] PR-card no-CI line verified on mobile breakpoints (#1054 reworks the card's
      responsive layout; the inline toggle was previously `md:hidden`).
- [ ] Screenshot both surfaces on a narrow viewport during implementation.

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
