# 260 — Composer toolbar layout: checklist

- [x] `requirements.md` — 16 numbered requirements, provenance, receipts, no open questions
- [x] `plan.md` — the design, citing requirements
- [x] Extract `useModelPickerState` / `useHarnessPickerState` in `ModelPicker.tsx`
- [x] Extract `useReasoningPickerState` in `ReasoningSelector.tsx`
- [x] Extract `isGuardedModelOk` from `PermissionModeSelector.tsx`
- [x] `ComposerSettingsMenu.tsx` — anchor + drill-down panels (mode / harness / model / reasoning)
- [x] `ContextDial` — `compact` prop (ring only)
- [x] `MessageInput.tsx` — container-width branch, clipping group, pinned action buttons
- [x] Remove `compactTrigger` from `HarnessSelector` and `ReasoningSelector`
- [x] Tests: narrow-row structure, pinned action buttons, menu drill-down, mid-turn locking
- [x] `npm run lint:dev` and `npm run typecheck` clean; full client suite green (3356 tests post-rebase)
- [x] Verified in the browser at 320–900px: no overflow at any width, branch flips at exactly 700
- [x] Rebased onto `main`: merged the new `seedFromHistory` / `boundSession` / `displayedHarness`
      harness resolution into the extracted hooks, and threaded `seedFromHistory` into the narrow
      row so Quick Capture cannot describe a session it will never send to
- [ ] Cross-backend review (Codex) against every numbered requirement — first run was cancelled
      mid-flight by the rebase; relaunch once the rebase has landed
