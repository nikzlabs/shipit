---
description: "ShipIt design language: color tokens, typography, iconography, motion, and multi-theme architecture. Load when working on UI components, styling, theming, or adding new visual elements."
user-invocable: true
---

# Design Language

ShipIt uses semantic design tokens (CSS custom properties) for all colors. Themes are token overrides applied via a class on `<html>`. All UI code references tokens — never raw Tailwind color classes.

Concrete color values live in per-theme CSS files under `src/client/themes/`. Each file defines one theme's token values. `src/client/index.css` imports them and contains shared rules (animations, scrollbars, syntax highlighting). Theme state is managed by `useTheme()` in `src/client/hooks/useTheme.ts` (persisted to `localStorage` key `shipit-theme`).

```
src/client/themes/
  light.css       ← :root { --color-bg-primary: ...; }
  dark.css        ← .dark { --color-bg-primary: ...; }
```

To add a new theme: create a new CSS file in `themes/`, import it in `index.css`, register the name in `useTheme()`. No component changes needed.

## Color Tokens

Never use raw Tailwind color classes like `bg-gray-950` or `text-blue-500` in components — use `bg-[var(--color-bg-primary)]`.

| Token | Purpose |
|-------|---------|
| `--color-bg-primary` | Page/app background |
| `--color-bg-secondary` | Sidebar, secondary panels |
| `--color-bg-tertiary` | Cards, inputs, code blocks |
| `--color-bg-elevated` | Dropdowns, modals, popovers |
| `--color-bg-overlay` | Backdrop behind modals |
| `--color-bg-hover` | Hover state for interactive surfaces |
| `--color-bg-active` | Active/pressed state |
| `--color-text-primary` | Body text, headings |
| `--color-text-secondary` | Descriptions, timestamps |
| `--color-text-tertiary` | Placeholders, disabled |
| `--color-text-inverse` | Text on filled backgrounds |
| `--color-text-link` | Clickable text links |
| `--color-border-primary` | Panel borders, dividers |
| `--color-border-secondary` | Input borders |
| `--color-border-focus` | Focused input ring |
| `--color-accent` | Primary buttons, active tabs |
| `--color-accent-hover` | Primary button hover |
| `--color-accent-text` | Text on accent backgrounds |
| `--color-accent-subtle` | Tinted backgrounds, badges |
| `--color-success` | Connected, passed, deployed |
| `--color-success-subtle` | Success background |
| `--color-error` | Failed, disconnected, destructive |
| `--color-error-subtle` | Error background |
| `--color-warning` | In-progress, caution |
| `--color-warning-subtle` | Warning background |
| `--color-info` | Informational, typing |
| `--color-info-subtle` | Info background |
| `--color-pr` | PR open/merged indicator |
| `--color-folder` | Folder icon in file tree |
| `--color-autofix` | Auto-fix toggle/indicator |
| `--color-context-ok` | Context meter 0–60% |
| `--color-context-mid` | Context meter 60–80% |
| `--color-context-high` | Context meter 80–90% |
| `--color-context-full` | Context meter 90%+ |
| `--color-scrollbar-thumb` | Scrollbar thumb |
| `--color-scrollbar-thumb-hover` | Scrollbar thumb on hover |
| `--font-size-code` | Monospace / code block font size |
| `--duration-fast` | Color transitions, exits |
| `--duration-normal` | Enter animations, layout shifts |
| `--duration-slow` | Loading spinners |
| `--ease-default` | Default easing |
| `--ease-out` | Enter animations |
| `--ease-in` | Exit animations |

## Typography

System font stack, no custom web fonts. Body: `text-sm`, headings: `text-lg font-semibold`, code: `font-mono text-[var(--font-size-code)]`, small: `text-xs`.

## Iconography — Phosphor Icons

Library: [`@phosphor-icons/react`](https://phosphoricons.com). All icons use Phosphor — no inline SVGs or Unicode characters.

**Sizes:** Use `ICON_SIZE` constants from `src/client/design-tokens.ts` — `SM` (16px) inline with text, `MD` (20px) buttons/nav, `LG` (32px) empty states, `XL` (48px) hero.

**Weights:** `"regular"` (default), `"bold"` for emphasis, `"fill"` for toggle-on states, `"duotone"` sparingly for illustrations.

**Color:** Icons inherit `currentColor`. Set via parent's text color token:

```tsx
import { ICON_SIZE } from "../design-tokens.js";

<span className="text-[var(--color-text-secondary)]">
  <GitBranch size={ICON_SIZE.SM} />
</span>
```

**Key mappings** (non-obvious or domain-specific):

| Concept | Icon | Color Token |
|---------|------|-------------|
| PR open | `GitPullRequest` | `--color-pr` |
| PR merged | `GitMerge` | `--color-pr` |
| PR closed | `GitPullRequest` | `--color-text-tertiary` |
| Success | `CheckCircle` | `--color-success` |
| Error | `XCircle` | `--color-error` |
| Warning | `Warning` | `--color-warning` |
| Pending | `CircleNotch` | With `animate-spin` |
| Folder | `Folder` / `FolderOpen` | `--color-folder` |
| Deploy | `Rocket` | |
| Trash | `Trash` | `--color-error` (destructive) |
| External link | `ArrowSquareOut` | |

## Motion

Motion tokens are defined in `index.css` (shared, not per-theme). Use `transition-[color] duration-[var(--duration-fast)]` instead of Tailwind's `transition-colors` to reference the token. Avoid animating layout properties (`width`, `height`) unless explicitly resizing.

## UI Primitives

Shared components in `src/client/components/ui/` using [CVA](https://cva.style) (class-variance-authority) for variant-based styling. Never duplicate token class strings across components — use these primitives instead.

| Component | File | Variants |
|-----------|------|----------|
| `Button` | `button.tsx` | `variant`: primary, secondary, destructive, ghost. `size`: sm, md, lg |
| `Badge` | `badge.tsx` | `variant`: default, success, error, warning, info |
| `StatusDot` | `status-dot.tsx` | `status`: success, error, warning, info |
| `Banner` | `banner.tsx` | `variant`: error, warning, info, success |
| `Panel` | `panel.tsx` | Base surface with border |
| `Card` | `card.tsx` | Elevated surface with shadow |
| `Modal` | `modal.tsx` | Dialog overlay with backdrop |

Example usage:

```tsx
import { Button } from "./ui/button.js";

<Button variant="destructive" size="sm">Delete</Button>
```

### Adding a new primitive

1. Create `src/client/components/ui/<name>.tsx`
2. Define variants with `cva()` — use only design tokens for colors, motion tokens for transitions
3. Accept `className` prop and merge it with CVA output (so consumers can add layout classes like margins)
4. Forward `ref` and spread remaining props onto the root element
5. Export the component and its variant props type
6. Add it to the table above in this skill
