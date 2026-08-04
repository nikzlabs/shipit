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
- [x] Second-opinion review (Codex) on the migration PR + fix: made the
      `useEventListeners` rebind key **identity-aware** (WeakMap-backed stable id
      for `target` + `signal`) so a different same-tag element / fresh signal
      rebinds — removing the documented footgun rather than relying on the caveat.
      Added target-identity and signal-identity rebind tests.

## Component-level sweep (done)

- [x] Migrated 11 component sites onto the hook: `FileAutoComplete`,
      `SkillAutoComplete`, `KeyboardShortcutsOverlay`,
      `MarkdownSelectionComments/CommentInput`, `QuickCaptureOverlay`,
      `MobileRecordingOverlay`, `KeybindingCapture` (capture phase), `PresentPane`
      (gated), `ChatQuoteReply` (document), `PreviewFrame` (message),
      `MessageInput` (document `load`, capture phase)
- [x] Dropped each site's listener `useEffect` eslint-disable, plus the now-stale
      `no-restricted-imports -- useEffect` directives left when `useEffect` was
      removed from the import
- [x] Verified no behavioral change: typecheck + `eslint --report-unused-disable-directives`
      clean; co-located component tests green (83)

### Deliberately NOT migrated (out of scope — documented in plan.md)

- [ ] `LogView` — listener target is `containerRef.current?.parentElement`, read
      *inside* the effect (element-ref, not safe as a render-time `null` target)
- [ ] `useMessageScroll` — element-ref `scroll` listener + a `ResizeObserver` in
      the same effect (mixed concern, element ref)
- [ ] `ui/dialog.tsx` — module-level install-once-never-removed global `popstate`
      listener, not a React effect
- [ ] `PreviewServicesDrawer` — drag-gesture listeners added inside a pointer
      handler, removed on gesture end (not a mount/unmount effect)
- [ ] `stores/mcp-store.ts` — `message` listener inside a Promise/OAuth-popup flow,
      not a React hook
- [ ] `MarkdownSelectionComments/useMarkdownSelection` — the effect couples the
      listener with a `setSnapshot(null)` derived-state reset on the gate branch;
      not a pure listener effect, so left as-is
- [ ] `useMediaQuery` — `MediaQueryList` subscription, its own correct hook
