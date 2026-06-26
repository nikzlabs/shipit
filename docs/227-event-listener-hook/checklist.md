# Checklist — Shared browser event-listener hook (SHI-214)

## This PR — prototype the primitive (no migration)

- [x] Verify the real call sites (file:line, target, events, handler stability)
- [x] Decide single-event vs multi-event API; ship both
      (`useEventListener` + `useEventListeners`)
- [x] Implement `src/client/hooks/useEventListener.ts` with correct cleanup
      (shared listener ref + latest-callback ref)
- [x] Co-located `useEventListener.test.ts` proving:
      add-on-mount, remove-with-the-SAME-ref (+ listener stops firing),
      handler-swap-without-rebind, target/type-change rebind, null no-op,
      multi-target bind/teardown
- [x] Decide the SSE `es.addEventListener` table is out of scope (documented)
- [x] `npx vitest run` on the new test — green
- [x] `npm run typecheck` + `eslint` on the new files — clean
- [x] Create Linear issue (SHI-214) and link it in `plan.md` frontmatter
- [x] PR with `Refs SHI-212` + `Closes SHI-214`
- [x] Second-opinion review (Codex) + fixes: honor `once`/`passive`/`signal` on add
      (not just `capture`); multi-form key tracks all three booleans; correct the
      `null`-target/ref guidance; expand the call-site audit (now non-exhaustive +
      out-of-scope classes); note non-listener (timer) cleanup in the
      `useConnectionSync` migration

## Migration — priority call sites (done)

- [x] Add typed overloads to `useEventListener` (Window/Document/HTMLElement) so
      keyboard/message handlers infer their event type — no per-site casts
- [x] Batch 1 (single-event): `useServerEvents.ts` visibilitychange,
      `useNotification.ts`, `useKeyboardShortcuts.ts` (both keydown),
      `useQuickCaptureHotkey.ts`, `usePreviewErrors.ts`
- [x] Batch 2 (multi-event / gated): `useConnectionSync.ts`, `useWebSocket.ts`
      (foreground listeners), `voice/use-voice-input.ts` (PTT keydown/keyup;
      blur/visibility)
- [x] Preserve non-listener cleanup where the old effect also cleared a timer
      (`useConnectionSync`, `useWebSocket` — kept on the same cadence)
- [x] Drop the now-unneeded per-site `no-restricted-imports` /
      `no-restricted-syntax` listener `useEffect` disables
- [x] Tests green for every migrated module (`useEventListener`, `useNotification`,
      `useConnectionSync`, `usePreviewErrors`, `useQuickCaptureHotkey`,
      `useWebSocket`, `use-voice-input`) + typecheck + lint clean

## Follow-up (later PRs)

- [ ] Component-level sites still on the raw pattern (`KeyboardShortcutsOverlay`,
      `FileAutoComplete`, `SkillAutoComplete`, `QuickCaptureOverlay`,
      `MobileRecordingOverlay`, `ui/dialog.tsx`, `PreviewFrame`, `ChatQuoteReply`,
      `MarkdownSelectionComments`, …) — separate reviewable sweeps
