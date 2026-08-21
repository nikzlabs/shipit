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
- [x] Human decisions taken on both review findings: clipping is the universal rule (requirements
      1, 3 and 8 rewritten), and requirement 14 now names the viewport, with `pointer: coarse`
      filed as planning#350
- [x] Mock of the wide row at 700–808 px, presented — today's overflow, the clipping fix, and
      guarded-as-an-icon side by side
- [x] Requirements 17 and 18 taken from the mock: "Guarded mode" → "Guarded", and the model
      control drops the service pill
- [x] Wide row: clipping group around the four labelled controls, both ends pinned (the mic is
      on the LEFT in that row, so the middle is what gives way)
- [x] Tests for the wide-row clipping and the shortened mode label; the four ModelPicker tests
      that observed the group through the removed pill now observe the menu's checkmark
- [x] Re-verified against the real component: nothing past the composer's edge at 700 / 760 /
      808 / 900 px in the guarded + ambiguous state, nor at 520 px on the compact row
- [x] `lint:dev`, `typecheck`, full client suite (3358) green
- [x] Req 19 — quick capture on desktop keeps the permission mode in the row, and the settings
      menu drops its Mode row (`modeInRow` in `MessageInput.tsx` / `ComposerSettingsMenu.tsx`)
- [x] Tests for req 19: mode in the row on desktop and absent from the menu, folded on a mobile
      viewport, chat composer unchanged at the same width
