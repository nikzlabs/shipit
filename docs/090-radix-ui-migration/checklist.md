# Radix UI Migration Checklist

## Setup
- [ ] Install Radix packages + tailwind-merge + clsx
- [ ] Create `src/client/utils/cn.ts`

## Phase 1 — DropdownMenu
- [ ] Create `src/client/components/ui/dropdown-menu.tsx`
- [ ] Migrate `SessionTopBar`
- [ ] Migrate `RollbackDropdown`
- [ ] Migrate `RewindDropdown`
- [ ] Migrate `AgentPicker`
- [ ] Migrate `ModelAgentSelector`
- [ ] Migrate `PreviewFrame` port selector
- [ ] Migrate `RepoSwitcher`
- [ ] Migrate `ThemePicker`
- [ ] Delete `src/client/components/ui/dropdown.tsx`

## Phase 2 — Dialog
- [ ] Create `src/client/components/ui/dialog.tsx`
- [ ] Migrate `ui/modal.tsx` consumers to `dialog.tsx`
- [ ] Migrate `AllSessionsDialog`
- [ ] Migrate `AddRepoDialog`
- [ ] Migrate `NewRepoDialog`
- [ ] Migrate `Settings`
- [ ] Migrate `UsageModal`
- [ ] Migrate `FilePreviewModal`
- [ ] Delete `src/client/components/ui/modal.tsx`

## Phase 3 — Popover
- [ ] Create `src/client/components/ui/popover.tsx`
- [ ] Migrate `RepoSelector`
- [ ] Migrate `FileAutoComplete`

## Phase 4 — Tooltip
- [ ] Create `src/client/components/ui/tooltip.tsx`
- [ ] Add `TooltipProvider` to `App.tsx`
- [ ] Migrate `MarkdownTooltip` in `message-markdown.tsx`
- [ ] Migrate key `title` attributes to Radix Tooltip

## Phase 5 — Tabs
- [ ] Create `src/client/components/ui/tabs.tsx`
- [ ] Migrate `Settings.tsx` tabs

## Phase 6 — Minor primitives
- [ ] Evaluate `@radix-ui/react-toggle` for `PlanModeToggle`
- [ ] Evaluate `@radix-ui/react-select` for native `<select>` elements

## Cleanup
- [ ] Delete `src/client/hooks/useClickOutside.ts` (verify no remaining consumers)
- [ ] Run full test suite
- [ ] Run lint + typecheck
