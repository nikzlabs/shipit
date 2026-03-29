# Radix UI Migration Checklist

## Setup
- [x] Install Radix packages + tailwind-merge + clsx
- [x] Create `src/client/utils/cn.ts`

## Phase 1 — DropdownMenu
- [x] Create `src/client/components/ui/dropdown-menu.tsx`
- [x] Migrate `SessionTopBar`
- [x] Migrate `RollbackDropdown`
- [x] Migrate `RewindDropdown`
- [x] Migrate `AgentPicker`
- [x] Migrate `ModelAgentSelector`
- [x] Migrate `PreviewFrame` port selector
- [x] Migrate `RepoSwitcher`
- [x] Migrate `ThemePicker`
- [x] Delete `src/client/components/ui/dropdown.tsx`

## Phase 2 — Dialog
- [x] Create `src/client/components/ui/dialog.tsx`
- [x] Migrate `ui/modal.tsx` consumers to `dialog.tsx`
- [x] Migrate `AllSessionsDialog`
- [x] Migrate `AddRepoDialog`
- [x] Migrate `NewRepoDialog`
- [x] Migrate `Settings`
- [x] Migrate `UsageModal`
- [x] Migrate `FilePreviewModal`
- [x] Migrate `message-tools.tsx` (ToolCallModal)
- [x] Migrate `DiffBlock.tsx` (DiffModal)
- [x] Migrate `App.tsx` DiffPanel modal
- [x] Delete `src/client/components/ui/modal.tsx`

## Phase 3 — Popover
- [x] Create `src/client/components/ui/popover.tsx`
- [x] Migrate `RepoSelector`
- [ ] Migrate `FileAutoComplete` (skipped — uses window-level keydown, not a standard popover)

## Phase 4 — Tooltip
- [x] Create `src/client/components/ui/tooltip.tsx`
- [x] Add `TooltipProvider` to `App.tsx`
- [ ] Migrate `MarkdownTooltip` in `message-markdown.tsx`
- [ ] Migrate key `title` attributes to Radix Tooltip

## Phase 5 — Tabs
- [x] Create `src/client/components/ui/tabs.tsx`
- [x] Migrate `Settings.tsx` tabs

## Phase 6 — Minor primitives
- [ ] Evaluate `@radix-ui/react-toggle` for `PlanModeToggle`
- [ ] Evaluate `@radix-ui/react-select` for native `<select>` elements

## Cleanup
- [x] Delete `src/client/hooks/useClickOutside.ts` (verified no remaining consumers)
- [x] Run full test suite
- [x] Run lint + typecheck
