# Checklist — Quick Session Optimistic Start

## Phase 1 (shipped)

- [x] Add `variant?: "success" | "error"` to `ToastData`; drive icon/color from it (default `success`) — `Toast.tsx`, `ui-store.ts`
- [x] Add `startQuickSessionInBackground()` to `session-actions.ts` — fire-and-forget POST, error toast on failure, `onCreated` callback
- [x] `QuickCaptureOverlay.handleSend`: validate, capture payload, close immediately, delegate to the helper (blocking spinner + `submitting` state removed)
- [x] `/repo/*/new` path still navigates into the new session (`handleQuickSessionCreated` unchanged; driven via `onCreated`)
- [x] Remove the concurrent quick-session cap (set, env knob, 429) — `services/headless-sessions.ts`
- [x] Tests: overlay closes immediately + delegates with right params; helper success/failure (toast); cap test removed

## Deferred (not built — creation is reliable in practice)

- [ ] Success "Session started · View" toast with fast-hit (~800ms) suppression
- [ ] Failure toast *Retry* that re-opens the overlay with the typed text restored
- [ ] Optimistic "starting…" sidebar row for cold-start feedback
