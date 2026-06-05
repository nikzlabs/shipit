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
- [x] Add optional `armAutoMerge` (boolean) to `CreateHeadlessSessionOptions`
      (`headless-sessions.ts`).
- [x] Accept + validate the flag on `POST /api/sessions/headless`
      (`api-routes-session.ts`).
- [x] After claim/graduate, seed the per-session armed auto-merge state via the
      existing toggle/arm path — no new merge logic. Calls
      `toggleAutoMerge(githubAuth, prStatusPoller, sessionId, true)`; with no PR
      yet it falls through to `prStatusPoller.setAutoMergeEnabled` (the same
      pre-PR arm path the overflow toggle uses).
- [x] Verify the PR-creation handoff: when the first turn opens a PR, the poller
      picks up the already-armed state and merges on green (existing behavior).
      The handoff is `activatePendingAutoMergeForPr` (docs/156/169) — unchanged;
      this feature only seeds the state it reads.

## Client
- [x] Add the auto-merge checkbox to `QuickCaptureOverlay.tsx`, default off.
- [x] Explicitly **do not** persist to `localStorage` (per decision #1). Added a
      code comment citing this doc; checkbox state is plain `useState`, reset to
      off on every overlay open.
- [x] Thread `armAutoMerge` through `createHeadlessSession()`
      (`session-actions.ts`).
- [x] Render the **unconditional** arm-time note inline in the overlay
      ("Merges automatically once the PR is mergeable. If it has no CI checks, it
      merges immediately — without review."). No repo lookup.
- [x] Render the **conditional** durable line on the PR card, shown only when
      armed and `checks.state === "none"`; placed in OpenPhase alongside the
      existing auto-merge rows, after #1054's inline-toggle.

## Mobile / responsive
- [x] Overlay checkbox + arm-time note look deliberate at mobile width — laid out
      as a `flex flex-col` footer block; the label/checkbox/note use
      `items-start` + `min-w-0` so the note wraps under the label and the
      `size-4` checkbox stays tappable.
- [x] PR-card no-checks line uses `flex items-start` + `wrap-break-word` with a
      `shrink-0` icon so it wraps cleanly within OpenPhase's responsive column.
- [ ] Screenshot both surfaces on a narrow viewport during implementation. NOT
      done — no dev server / authed repo state was available in this environment
      to drive the overlay and an open-PR card live. Verified the responsive
      classes by code review instead.

## Tests
- [x] Server: creating a headless session with `armAutoMerge: true` arms the
      session's auto-merge state; omitting it leaves auto-merge off.
      (`headless-sessions.test.ts` + integration `quick-capture-headless.test.ts`)
- [x] Server: the flag is not persisted — asserted the session row / DB JSON
      contains no auto-merge state (unit + integration).
- [x] Client: overlay checkbox defaults off, only sends `armAutoMerge:true` when
      checked, touches no auto-merge `localStorage` key, and resets on reopen.
- [~] Integration: armed-at-creation session arms via the existing poller path
      (asserted `app.prStatusPoller.getAutoMergeState().enabled === true`). The
      full "merges on green" leg (simulating PR open + CI success → REST merge)
      is exercised by docs/077 auto-merge tests; not re-driven end-to-end here.

## Docs
- [x] Update this checklist as items land; mark all `[x]` when done.
- [x] No in-container agent-facing behavior changed — `src/server/shipit-docs/`
      needs no update (auto-merge is an orchestrator/UI concern).
