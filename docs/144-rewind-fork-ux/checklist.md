---
status: in-progress
---

# Rewind & Fork UX Checklist

## Landing 1 — Make It Work

- [x] B1: Render orphan-grouped sessions in `SessionSidebar`, including "Local sessions" and unmatched URL groups.
- [x] B2: Persist durable rewind metadata on messages: `rolled_back`, `notice`, `notice_level`, `fork_child`, and `code_rollback_hash`.
- [x] B3: Copy referenced uploads into forked sessions.
- [x] B4: Guard rewind/fork handlers while a turn is running and clear queued messages during rewind.
- [x] B5: Add `rewind_at_gap` and cut current dropdown actions over to it.
- [x] B6: Auto-switch after fork and persist/broadcast the fork breadcrumb.
- [x] U5: Persist code-only stale-message dimming via `rolled_back` and `code_rollback_hash`.
- [x] B7: Add integration coverage for the Landing 1 rewind/fork branches.

## Landing 2 — Between-Turn Rewind Points

- [x] Build `RewindPoint` for intermediate gaps, gap-after-last, streaming states, and the menu.
- [x] Render `RewindPoint` between role transitions in `MessageList`, plus the gap-after-last control.
- [x] Route all four menu actions through `rewind_at_gap`.
- [x] Add the Fork modal with editable branch slug.
- [x] Add `rewind_preview_request` / `rewind_preview` server contract and count calculation.
- [x] Use `rewind_preview` for menu subtitles and modal counts.
- [x] Add selective confirmation modals.
- [x] Add undo toast and "Recover recent rewind" topbar overflow entry.
- [x] Add `rewind_snapshots` persistence and restore path.
- [ ] Remove legacy per-message rewind/rollback dropdowns and old WS message types.
- [x] U6: Show an empty-chat notice after rewinding to the start.

## Landing 3 — Polish

- [ ] U8: Enrich conversation replay with tool result summaries and attachment manifests.
