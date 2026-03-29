---
status: done
---

# Radix UI Migration

Replace all hand-rolled interactive UI primitives with [Radix UI](https://www.radix-ui.com/) components, wrapped in project-styled `ui/` primitives following shadcn conventions.

## Motivation

Every interactive primitive (dropdowns, modals, tooltips, tabs) is hand-rolled with `useState` + `useClickOutside` + absolute positioning. This works but:

- **Accessibility gaps** — no roving focus, no arrow-key navigation in menus, no focus trapping in modals, tooltips are mouse-only.
- **Boilerplate** — each dropdown re-implements ~15 lines of open/close/click-outside/escape plumbing.
- **Inconsistency** — 9 dropdowns with slight behavioral differences (some have keyboard nav, most don't).

Radix primitives are unstyled, accessible, and composable. We wrap them in thin `ui/` components styled with Tailwind + our design tokens, same as existing `ui/button.tsx` and `ui/badge.tsx`.

## Approach

### Dependencies to install

```
@radix-ui/react-dropdown-menu
@radix-ui/react-dialog
@radix-ui/react-popover
@radix-ui/react-tooltip
@radix-ui/react-tabs
@radix-ui/react-select
@radix-ui/react-toggle
@radix-ui/react-accordion
```

Also install `tailwind-merge` and `clsx` for the `cn()` utility (standard shadcn pattern used by all wrappers):

```ts
// src/client/utils/cn.ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
```

### Wrapper convention

Each Radix primitive gets a thin wrapper in `src/client/components/ui/` that:
1. Re-exports Radix compound components with project styling baked in.
2. Uses `cn()` for className merging so consumers can override.
3. Sets `forwardRef` and `displayName` on every sub-component.
4. Does NOT add business logic — wrappers are purely presentational.

Example for dropdown-menu:
```tsx
// src/client/components/ui/dropdown-menu.tsx
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";

const DropdownMenuContent = forwardRef(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      className={cn(
        "z-50 min-w-32 overflow-hidden rounded-lg border border-(--color-border-secondary)",
        "bg-(--color-bg-elevated) py-1 shadow-xl",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
```

## Migration inventory

### Phase 1 — DropdownMenu (9 components)

Replace the hand-rolled `ui/dropdown.tsx` and all 9 dropdown patterns.

| Component | Trigger | Radix primitive | Notes |
|-----------|---------|-----------------|-------|
| `SessionTopBar` | Icon button (dots) | DropdownMenu | Simplest — 3 flat items with icons |
| `RollbackDropdown` | Icon button | DropdownMenu | 3 items + 1 separator, `onOpenChange` callback |
| `RewindDropdown` | Icon button | DropdownMenu | 3 items, `onOpenChange` callback |
| `AgentPicker` | Caret button | DropdownMenu | Status dots, disabled items, check marks |
| `ModelAgentSelector` | Caret button | DropdownMenu | Grouped with labels, disabled items, check marks |
| `PreviewFrame` | Caret button | DropdownMenu | Status dots per item, dynamic port list |
| `RepoSwitcher` | Controlled (no trigger) | DropdownMenu (controlled) | Fully controlled `open`, no trigger |
| `ThemePicker` | Icon button | DropdownMenu | Grid layout in content, keyboard nav |
| `RepoSelector` | Input field | Popover + custom list | Combobox pattern — search input triggers popover |

#### Sub-components to create

**`src/client/components/ui/dropdown-menu.tsx`** — wraps `@radix-ui/react-dropdown-menu`:
- `DropdownMenu` (Root)
- `DropdownMenuTrigger`
- `DropdownMenuContent` — styled panel with portal, animation
- `DropdownMenuItem` — styled row with hover/focus states
- `DropdownMenuCheckboxItem` — item with check indicator
- `DropdownMenuRadioGroup` / `DropdownMenuRadioItem`
- `DropdownMenuLabel` — section header
- `DropdownMenuSeparator` — divider line
- `DropdownMenuGroup` — logical grouping

### Phase 2 — Dialog (7 components)

Replace `ui/modal.tsx` and all modal usages.

| Component | Notes |
|-----------|-------|
| `ui/modal.tsx` | Base primitive — becomes `ui/dialog.tsx` wrapping Radix Dialog |
| `AllSessionsDialog` | Large modal with search + filters |
| `AddRepoDialog` | Modal with search + clone progress |
| `NewRepoDialog` | Modal with form + template selector |
| `Settings` | Multi-tab modal (combine with Radix Tabs) |
| `UsageModal` | Read-only statistics modal |
| `FilePreviewModal` | Modal with Monaco editor |

#### Sub-components to create

**`src/client/components/ui/dialog.tsx`** — wraps `@radix-ui/react-dialog`:
- `Dialog` (Root)
- `DialogTrigger`
- `DialogPortal`
- `DialogOverlay` — backdrop with fade animation
- `DialogContent` — centered panel with focus trap, Escape close
- `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription`
- `DialogClose` — close button

**Key improvements over current `modal.tsx`:**
- Focus trapping (Radix built-in)
- Body scroll lock
- Proper `aria-labelledby` / `aria-describedby`
- Animation on open/close (not just mount/unmount)

### Phase 3 — Popover (2 components)

For non-menu floating content.

| Component | Notes |
|-----------|-------|
| `RepoSelector` | Search input + floating results list (combobox) |
| `FileAutoComplete` | @ mention popup |

#### Sub-components to create

**`src/client/components/ui/popover.tsx`** — wraps `@radix-ui/react-popover`:
- `Popover` (Root)
- `PopoverTrigger`
- `PopoverContent` — styled floating panel
- `PopoverAnchor` — for positioned anchoring without trigger

### Phase 4 — Tooltip

Replace native `title` attributes and custom `MarkdownTooltip`.

| Component | Current | Notes |
|-----------|---------|-------|
| Various buttons | `title="..."` attr | Migrate to Radix Tooltip for consistent styling |
| `message-markdown.tsx` | Custom `MarkdownTooltip` | Replace with Radix Tooltip + rich content |

#### Sub-components to create

**`src/client/components/ui/tooltip.tsx`** — wraps `@radix-ui/react-tooltip`:
- `TooltipProvider` — global delay config (add to `App.tsx`)
- `Tooltip` (Root)
- `TooltipTrigger`
- `TooltipContent` — styled arrow tooltip

### Phase 5 — Tabs

Replace custom tab implementation in Settings.

| Component | Notes |
|-----------|-------|
| `Settings.tsx` | 8 tabs managed via Zustand — migrate to Radix Tabs with controlled value |

#### Sub-components to create

**`src/client/components/ui/tabs.tsx`** — wraps `@radix-ui/react-tabs`:
- `Tabs` (Root)
- `TabsList`
- `TabsTrigger`
- `TabsContent`

### Phase 6 — Minor primitives (low priority)

| Primitive | Component | Notes |
|-----------|-----------|-------|
| Toggle | `PlanModeToggle` | `@radix-ui/react-toggle` — minimal gain |
| Accordion | `DiffPanel` file tree | `@radix-ui/react-accordion` — optional |
| Select | Native `<select>` elements | `@radix-ui/react-select` — nice-to-have |

## Migration pattern per component

Each migration follows this pattern:

1. **Replace imports** — swap `useState`/`useRef`/`useClickOutside` for Radix wrapper imports.
2. **Replace JSX** — swap hand-rolled `<div ref={ref}>` / `<button onClick={toggle}>` / `{open && <div className="absolute ...">}` for Radix compound components.
3. **Remove boilerplate** — delete `useState(false)`, `useRef`, `useClickOutside`, `handleClose`.
4. **Preserve behavior** — keep `onOpenChange` callbacks, disabled states, custom item content.
5. **Run tests** — existing tests should pass with minimal updates (role queries may change).

Example — `SessionTopBar` before:
```tsx
const [menuOpen, setMenuOpen] = useState(false);
const menuRef = useRef<HTMLDivElement>(null);
useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);
// ... <div ref={menuRef} className="relative">
//       <button onClick={() => setMenuOpen(!menuOpen)}>
//       {menuOpen && <div className="absolute ...">}
```

After:
```tsx
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <button ...>
      <DotsThreeVerticalIcon />
    </button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuItem onClick={startEditing}>
      <PencilSimpleIcon /> Rename
    </DropdownMenuItem>
    ...
  </DropdownMenuContent>
</DropdownMenu>
```

Deleted: `useState`, `useRef`, `useCallback`, `useClickOutside` import. Gained: keyboard navigation, focus management, Escape handling — all from Radix.

## Files to delete after migration

- `src/client/components/ui/dropdown.tsx` — replaced by `dropdown-menu.tsx`
- `src/client/components/ui/modal.tsx` — replaced by `dialog.tsx`
- `src/client/hooks/useClickOutside.ts` — no longer needed once all consumers migrated (verify with grep first)

## Key files

| File | Role |
|------|------|
| `src/client/components/ui/dropdown-menu.tsx` | New — Radix DropdownMenu wrapper |
| `src/client/components/ui/dialog.tsx` | New — Radix Dialog wrapper |
| `src/client/components/ui/popover.tsx` | New — Radix Popover wrapper |
| `src/client/components/ui/tooltip.tsx` | New — Radix Tooltip wrapper |
| `src/client/components/ui/tabs.tsx` | New — Radix Tabs wrapper |
| `src/client/utils/cn.ts` | New — `cn()` class merge utility |

## Risks

- **React 19 compatibility** — Radix v2 supports React 19. Verify all installed primitives are v2+.
- **Test updates** — Radix uses Portal for content, which may require `screen.findBy*` instead of `screen.getBy*` in tests. Radix also changes some ARIA roles.
- **Animation** — Radix uses `data-[state=open]` / `data-[state=closed]` attributes for animation. Need to add `animate-in` / `animate-out` keyframes to `index.css` or use Tailwind's built-in animation utilities.
- **Bundle size** — Each Radix primitive is a separate package (~2-5KB gzipped). Total addition is ~20-30KB for all 8 packages. Acceptable for the accessibility and DX gains.
