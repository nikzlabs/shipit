---
issue: https://linear.app/shipit-ai/issue/SHI-139
description: Quick-capture fires a new session optimistically — overlay closes immediately, a subtle toast reports ready/failed instead of a blocking spinner.
---

# Quick Session — Optimistic Start

## Problem

Creating a quick session (the Ctrl-K **QuickCaptureOverlay**) currently shows a
modal **"Starting session"** spinner and blocks until the create request
resolves. The user wanted to fire off a new session and keep working in their
current one — not babysit a boot.

The spinner is mostly **vestigial**:

- `handleSend` awaits `createHeadlessSession()` and renders a blocking spinner
  while `submitting === true` (`QuickCaptureOverlay.tsx:120-148`, spinner at
  `:208-212`). The overlay is a `role="dialog"` modal, so the whole app is
  blocked behind the backdrop for the duration.
- But the server **dispatches the first prompt to the agent before the HTTP
  response returns** (`services/headless-sessions.ts:242-245`), then graduates
  the session and replies. The agent is already working while the user watches
  the spinner.
- Quick capture is **designed as background creation**: it does **not** switch
  the user to the new session unless they were on the `/repo/*/new` route
  (`App.tsx:785-792` — `handleQuickSessionCreated`). A true background session
  doesn't match the active session id and the user stays put.
- The wait is **bimodal**: a warm-pool hit is ~500ms (spinner is a flicker); a
  cold clone is ~10-30s (spinner is a real, full-app modal block). The change is
  almost entirely a **cold-path** win.

The only things the client actually needs from the create response are the
session row (also broadcast over SSE `session_list`) and the navigate decision
(only relevant on the `/new` route). Neither requires a blocking modal.

## Design

Make the **background** quick-capture path fire-and-forget:

1. **Close the overlay immediately on submit** — after local validation passes,
   don't await the create. The user is back in their current session instantly.
2. **Report the result with a toast**, not a modal:
   - **Success →** subtle toast **"Session started · View"**, where *View*
     navigates to the new session. `Toast` already supports
     `action: { label, onClick }` (`Toast.tsx:53-65`) — exactly this shape.
   - **Failure →** toast **"Couldn't start session · Retry"** where *Retry*
     re-opens the overlay **with the typed text preserved**, so nothing is lost.
3. **Suppress the success toast on a fast (warm) hit.** If the create resolves
   within a short threshold (~800ms), skip the toast — the session just quietly
   appears in the sidebar via the existing `session_list` SSE broadcast. A toast
   that fires 400ms after the overlay closes reads as a double-flash.
4. **Leave the `/repo/*/new` route path unchanged.** There the user is
   explicitly entering the new session, so progress belongs on the session
   screen, not behind a modal. `handleQuickSessionCreated` already distinguishes
   the two by comparing the created id to the active session id.

This matches the product principle that **chat is the input surface and the
agent is the actor** (CLAUDE.md §5): the user describes the session and returns
to work; they don't operate the boot.

### Why move the create off the component

Today the awaited create lives inside the overlay component, which unmounts when
`open` becomes false (`QuickCaptureOverlay.tsx:116`). For fire-and-forget we
want the request + toast to **outlive the overlay's mount**. Extract a
`startQuickSessionInBackground(params)` helper into
`stores/actions/session-actions.ts` (alongside `createHeadlessSession`) that owns
the POST, the timing threshold, and the success/failure toast. The overlay
captures its payload (repo, prompt, agent, model, files, armAutoMerge) at submit
time, calls the helper, and closes — no stale-closure or unmount races.

## Toast system — already exists (one small gap)

ShipIt has a working toast system; we build on it, not a new one.

- **`Toast.tsx`** — bottom-right, auto-dismiss (default 8s), optional action
  button + manual dismiss. Rendered from `useUiStore.toast`.
- **`ui-store.ts:158,261`** — `toast: ToastData | null` + `setToast`.
- `ToastData = { message; action?: { label; onClick }; duration? }`
  (`Toast.tsx:7-11`).
- Widely used already: PR card actions, settings failures, rewind
  (`PrLifecycleCard.tsx`, `Settings.tsx`, `rewind-complete.ts`, etc.).

**Gap:** `Toast` hardcodes a green success `CheckCircleIcon` (`Toast.tsx:51`).
There is no error/neutral variant. The failure toast ("Couldn't start session")
should not show a success checkmark, so this needs a small extension:

- Add an optional `variant?: "success" | "error" | "info"` to `ToastData` and
  pick the icon/accent color from it (keep `"success"` the default so existing
  call sites are unchanged).

## Key files

| Area | File | Notes |
|------|------|-------|
| Overlay / submit | `client/components/QuickCaptureOverlay.tsx` | `handleSend` (`:120-148`), spinner (`:208-212`), `close()` (`:90-101`). Close optimistically; capture payload + typed text. |
| Background create + toast | `client/stores/actions/session-actions.ts` | `createHeadlessSession` (`:97-157`). Add `startQuickSessionInBackground()` owning POST + timing + toast. |
| Navigate-on-`/new` | `client/App.tsx:785-792` | `handleQuickSessionCreated` — keep as-is for the `/new` path. |
| Toast component | `client/components/Toast.tsx` | Add `variant` for the error toast. |
| Toast store | `client/stores/ui-store.ts:158,261` | `ToastData` type extension. |
| Server (no change expected) | `services/headless-sessions.ts:124-289` | Already dispatches prompt before responding; returns session. |

## Edge cases

- **Validation stays inline, pre-close.** `handleSend` already rejects "no repo"
  before submitting (`:121-124`) and the input is disabled while a repo is still
  cloning (`disabled`, `:118`). Only close optimistically once local validation
  passes — a missing-repo error still shows in the overlay.
- **Retry must restore the prompt.** On failure the toast's *Retry* re-opens the
  overlay; stash the failed payload's text so `MessageInput` re-seeds it.
  (Decision: do we also restore files / model / armAutoMerge, or just text?
  `armAutoMerge` deliberately never persists — docs/175 decision #1 — so it
  should reset to off on retry, not carry over.)
- **No double-submit.** The overlay closes on submit, so there's no second-send
  window to guard.
- **Auto-merge reset.** `armAutoMerge` resets on every open (`:85-88`); the
  background helper must read it from the captured payload, not the (unmounted)
  component state.

## Open questions

1. **Fast-hit threshold** — 800ms is a starting guess. Tune so a warm hit shows
   no toast and a cold start always does.
2. **Pending sidebar row (optional, phase 2)** — for a cold start, the user gets
   ~10-30s of silence between overlay-close and the session appearing. Worth
   inserting an optimistic "starting…" row in the sidebar on submit for "your
   click registered" feedback? Adds state-reconciliation complexity (replace the
   placeholder when `session_list` arrives, drop it on failure). Defer unless the
   silence feels bad in testing.
3. **Error copy** — "Couldn't start session" vs surfacing the server error
   message. Lean generic + Retry; log the detail.

## Visual reference

The two toast states (success "View" / failure "Retry") reuse the existing
`Toast` layout; no new layout to prototype. If the error variant's color
treatment needs sign-off, add a `mockup.html` here before implementing.
