# 156 — Session card consolidation: checklist

- [x] Delete `SessionTopBar.tsx` and `SessionTopBar.test.tsx`.
- [x] `PrLifecycleCard` always renders for an active session (renders an empty left side + right cluster when no PR card exists).
- [x] `PrLifecycleCard` outer container becomes the chat-panel's top chrome (single 40px row with `border-b`, no `mx-4`, no `rounded-t-xl`/`border-b-0` tab-into-input styling).
- [x] Right cluster: dedicated `[🔍 Search]` icon + `[⋯ Overflow]`.
- [x] Top-bar overflow houses Auto-fix, Auto-merge (when session has a remote), Recover-rewind (when available), Download chat.
- [x] `ReadyPhase` no longer renders the Auto-merge toggle.
- [x] `OpenPhase` no longer renders the Auto-merge / Auto-fix toggles in a phase-specific overflow.
- [x] `MessageInput` drops `hasPrCard`; always `rounded-xl`.
- [x] `App.tsx` removes `SessionTopBar`, removes the `hasPrCard` selector, and mounts `PrLifecycleCard` at the top of the chat panel (no longer pinned above `MessageInput`).
- [x] Sidebar row gets a hover-revealed `[⋯]` overflow trigger (always visible on the active row and on touch devices via `(pointer: coarse)`).
- [x] Inline archive / restore buttons on the row are removed.
- [x] Menu items: non-archived row → Rename, Archive. Archived row → Restore.
- [x] Inline rename in the row (Enter to submit, Escape to cancel, blur to submit, double-resolution guard).
- [x] `PrStatusSection` in the PR detail panel keeps its toggles (separate contextual surface).
- [x] Tests updated:
  - [x] `PrLifecycleCard.test.tsx` — replaced "renders nothing when no card" with "renders right cluster"; gated overflow toggles on `canAutoMerge` rather than CI state.
  - [x] `SessionSidebar.test.tsx` — replaced direct-archive test with overflow flow; added hover/active/touch visibility tests; added Rename/Archive vs Restore menu shape tests; added inline-rename submit/cancel tests.
  - [x] `MessageInput.test.tsx` — no longer carries `hasPrCard` cases (prop is gone).
  - [x] `pr-ci-fix.test.ts` — added regression for "Auto-fix enabled pre-PR persists and triggers on the first failure".
- [ ] Browser smoke check the new top-bar layout end-to-end (sidebar overflow, inline rename, top-bar search + overflow, MessageInput rounded-xl in all states). The agent cannot start the dogfood dev service (it is `preview: manual`); the user should run the `dev` service from the preview panel and confirm.

## Follow-ups (out of scope of this plan)

- PR title editing inside ShipIt (PR detail panel "Edit title" affordance).
- Right-click context menu on sidebar rows (redundant with the always-discoverable `[⋯]`, but worth doing for power users).
- Undo toast on archive (orthogonal to placement — applies regardless of where the action lives).
