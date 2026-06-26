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

## Follow-up PRs — migrate call sites (NOT this PR)

- [ ] Batch 1 (single-event): `useServerEvents.ts` visibilitychange,
      `useNotification.ts`, `useKeyboardShortcuts.ts` (both keydown effects)
- [ ] Batch 2 (multi-event / gated): `useConnectionSync.ts`,
      `voice/use-voice-input.ts` (PTT keydown/keyup; blur/visibility)
- [ ] After each migration, drop the now-unneeded per-site
      `no-restricted-imports` / `no-restricted-syntax` `useEffect` disable
- [ ] Confirm no behavior change (mobile foreground SSE reconnect, PTT,
      notifications) after migration
