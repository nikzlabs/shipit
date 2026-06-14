# Checklist — Quick Session Optimistic Start

- [ ] Add `variant?: "success" | "error" | "info"` to `ToastData`; drive icon/accent from it (default `success`) — `Toast.tsx`, `ui-store.ts`
- [ ] Add `startQuickSessionInBackground()` to `session-actions.ts` — owns POST, fast-hit threshold, success/failure toast
- [ ] `QuickCaptureOverlay.handleSend`: validate, capture payload, close immediately, delegate to background helper (drop the blocking spinner branch)
- [ ] Failure toast *Retry* re-opens overlay with the typed text restored (reset `armAutoMerge` to off)
- [ ] Confirm `/repo/*/new` path still navigates into the new session (`handleQuickSessionCreated` unchanged)
- [ ] Tune fast-hit suppression threshold against a warm vs cold start
- [ ] Tests: background-create success/failure toast, retry restores text, no toast on fast hit
- [ ] Decide phase-2 pending sidebar row (optional)
- [ ] Update `docs/205-*/plan.md` with final decisions; verify in browser
