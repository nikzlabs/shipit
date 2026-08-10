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
- [x] Cross-backend review (Codex) against every numbered requirement — run 589d4b6f
- [x] Applied from the review: `aria-disabled` on inert menu rows; removed the unused
      `lockedHarnessReason` re-export and the unused `rows` field; corrected requirement 15
      (figures live in the ring's popover, not the menu) and the action-cluster floor in
      `plan.md` (the recording mic has auto width, so ≈218 px not ≈190 px)
- [ ] **Blocked on a human decision** — the review found requirements 1 and 3 conflict between
      700 and ~808 px, and that requirement 14 describes the device where the code reads the
      viewport. Both are in `## Open questions`.
