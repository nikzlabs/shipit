# Checklist — auto-merge at session creation

> Blocked on PR #1054 merging first (avoids conflicts in `PrLifecycleCard.tsx`
> and the overflow-gating logic). Do not start the client work until then.

## Decisions (locked)
- [x] Toggle is **always present**, no CI-presence gating (decision #2). The
      per-session explicit opt-in is the gate; experimental/no-CI repos are a
      first-class use case. Inform, never block.
- [x] Transparency shows in **both** surfaces, but they say different things
      (decision #2): the overlay shows an **unconditional** arm-time note (the
      per-PR `checks.state === "none"` signal isn't knowable pre-PR, so no repo
      lookup); the card shows a **conditional** line only when armed and
      `checks.state === "none"`. Both-surfaces because a quick session may never
      be opened.
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
- [ ] Render the **unconditional** arm-time note inline in the overlay
      ("merges automatically once mergeable; if no CI checks, merges
      immediately"). No repo lookup — see decision #2. Inform, don't block.
- [ ] Render the **conditional** durable line on the PR card, shown only when
      armed and `checks.state === "none"`; coordinate with #1054's inline-toggle
      placement.

## Mobile / responsive
- [ ] Overlay checkbox + arm-time note look deliberate at mobile width — label,
      checkbox, and note wrap cleanly and stay tappable.
- [ ] PR-card no-checks line verified on mobile breakpoints (#1054 reworks the
      card's responsive layout; the inline toggle was previously `md:hidden`).
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
