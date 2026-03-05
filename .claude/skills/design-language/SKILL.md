---
description: "ShipIt design language: color tokens, typography, spacing, elevation, iconography, motion, and multi-theme architecture. Load when working on UI components, styling, theming, or adding new visual elements."
user-invocable: true
---

# Design Language

ShipIt's visual design is defined through semantic design tokens — CSS custom properties that map intent to color values. Themes are sets of token overrides applied via a class on the root element. All UI code references tokens, never raw color values.

## Multi-Theme Architecture

Themes are CSS custom property sets applied via a class on `<html>`. The active theme class is managed by `useTheme()` in `src/client/hooks/useTheme.ts` and persisted to `localStorage` key `shipit-theme`.

```css
/* src/client/index.css — token definitions */
:root {
  /* Defaults = light theme */
  --color-bg-primary: theme(colors.white);
  --color-bg-secondary: theme(colors.gray.50);
  ...
}
.dark {
  --color-bg-primary: theme(colors.gray.950);
  --color-bg-secondary: theme(colors.gray.900);
  ...
}
```

To add a new theme (e.g., `.solarized`): define a new class block in `index.css` that overrides the same custom properties. Update `useTheme()` to cycle through available themes. No component changes needed.

## Color Tokens

All component styles must use these tokens. Never use raw Tailwind color classes like `bg-gray-950` or `text-blue-500` — use `bg-[var(--color-bg-primary)]` or the equivalent Tailwind v4 theme reference.

### Surface & Background

| Token | Semantic Purpose | Light | Dark |
|-------|-----------------|-------|------|
| `--color-bg-primary` | Page/app background | `white` | `gray-950` |
| `--color-bg-secondary` | Sidebar, secondary panels | `gray-50` | `gray-900` |
| `--color-bg-tertiary` | Cards, inputs, code blocks | `gray-100` | `gray-800` |
| `--color-bg-elevated` | Dropdowns, modals, popovers | `white` | `gray-800` |
| `--color-bg-overlay` | Backdrop behind modals | `black/50` | `black/60` |
| `--color-bg-hover` | Hover state for interactive surfaces | `gray-100` | `gray-800` |
| `--color-bg-active` | Active/pressed state | `gray-200` | `gray-700` |

### Text

| Token | Semantic Purpose | Light | Dark |
|-------|-----------------|-------|------|
| `--color-text-primary` | Body text, headings | `gray-900` | `gray-100` |
| `--color-text-secondary` | Descriptions, timestamps | `gray-600` | `gray-400` |
| `--color-text-tertiary` | Placeholders, disabled | `gray-400` | `gray-500` |
| `--color-text-inverse` | Text on filled backgrounds | `white` | `white` |
| `--color-text-link` | Clickable text links | `blue-600` | `blue-400` |

### Border & Divider

| Token | Semantic Purpose | Light | Dark |
|-------|-----------------|-------|------|
| `--color-border-primary` | Panel borders, dividers | `gray-200` | `gray-800` |
| `--color-border-secondary` | Input borders | `gray-300` | `gray-700` |
| `--color-border-focus` | Focused input ring | `blue-500` | `blue-500` |

### Accent (Primary Action)

| Token | Semantic Purpose | Light | Dark |
|-------|-----------------|-------|------|
| `--color-accent` | Primary buttons, active tabs | `blue-600` | `blue-600` |
| `--color-accent-hover` | Primary button hover | `blue-700` | `blue-500` |
| `--color-accent-text` | Text on accent backgrounds | `white` | `white` |
| `--color-accent-subtle` | Tinted backgrounds, badges | `blue-50` | `blue-900/30` |

### Status / Semantic

| Token | Semantic Purpose | Light | Dark |
|-------|-----------------|-------|------|
| `--color-success` | Connected, passed, deployed | `green-600` | `green-500` |
| `--color-success-subtle` | Success background | `green-50` | `green-900/30` |
| `--color-error` | Failed, disconnected, destructive | `red-600` | `red-500` |
| `--color-error-subtle` | Error background | `red-50` | `red-900/30` |
| `--color-warning` | In-progress, caution | `amber-600` | `amber-400` |
| `--color-warning-subtle` | Warning background | `amber-50` | `amber-900/30` |
| `--color-info` | Informational, typing | `blue-500` | `blue-400` |
| `--color-info-subtle` | Info background | `blue-50` | `blue-900/30` |

### Domain-Specific

| Token | Semantic Purpose | Light | Dark |
|-------|-----------------|-------|------|
| `--color-pr` | PR open/merged indicator | `purple-600` | `purple-400` |
| `--color-folder` | Folder icon in file tree | `yellow-600` | `yellow-500` |
| `--color-autofix` | Auto-fix toggle/indicator | `orange-600` | `orange-500` |
| `--color-context-ok` | Context meter 0–60% | `green-500` | `green-500` |
| `--color-context-mid` | Context meter 60–80% | `yellow-500` | `yellow-500` |
| `--color-context-high` | Context meter 80–90% | `orange-500` | `orange-500` |
| `--color-context-full` | Context meter 90%+ | `red-500` | `red-500` |

## Scrollbar

| Token | Light | Dark |
|-------|-------|------|
| `--color-scrollbar-thumb` | `gray-400/40` | `gray-600/50` |
| `--color-scrollbar-thumb-hover` | `gray-500/60` | `gray-500/70` |

## Typography

System font stack — no custom web fonts.

| Role | CSS | Tailwind Class |
|------|-----|----------------|
| Body | `font-family: system-ui, sans-serif; font-size: 14px;` | `text-sm` (default) |
| Heading | Same stack, `font-weight: 600` | `text-lg font-semibold` |
| Code | `font-family: ui-monospace, monospace; font-size: 13px;` | `font-mono text-[13px]` |
| Small | Same stack, `font-size: 12px` | `text-xs` |

## Spacing

Use Tailwind's default spacing scale (4px base). Key reference:

| Name | Value | Common Use |
|------|-------|------------|
| `1` | 4px | Inline gaps, icon-to-text |
| `1.5` | 6px | Tight padding (badges) |
| `2` | 8px | Default inner padding |
| `3` | 12px | Card padding, list gaps |
| `4` | 16px | Section spacing |
| `6` | 24px | Panel padding |
| `8` | 32px | Page margins |

## Border Radius

| Token / Class | Value | Use |
|---------------|-------|-----|
| `rounded` | 4px | Inputs, small elements |
| `rounded-md` | 6px | Buttons, badges |
| `rounded-lg` | 8px | Cards, panels, modals |
| `rounded-xl` | 12px | Dialogs, large containers |
| `rounded-full` | 9999px | Pills, avatars, status dots |

## Elevation (Shadows)

Three levels. Shadows use opacity-based black for both themes.

| Level | Class | Use |
|-------|-------|-----|
| Low | `shadow-sm` | Cards, panels |
| Medium | `shadow-md` | Dropdowns, popovers |
| High | `shadow-lg` | Modals, dialogs |

Dark mode surfaces rely on background color differentiation rather than shadows.

## Iconography — Phosphor Icons

Library: [`@phosphor-icons/react`](https://phosphoricons.com). All icons use Phosphor; no inline SVGs or Unicode characters for UI icons.

### Sizes

| Context | Size | Prop |
|---------|------|------|
| Inline with text | 16px | `size={16}` |
| Buttons / nav | 20px | `size={20}` |
| Empty states | 32px | `size={32}` |
| Hero / illustrations | 48px | `size={48}` |

### Weights

Use `"regular"` (default) for all UI icons. Use `"bold"` for emphasis (active nav items, status). Use `"fill"` for toggle-on states (bookmarked, starred). Use `"duotone"` sparingly for illustrative/empty-state icons.

### Color

Icons inherit `currentColor`. Set color via the parent's text color token:

```tsx
<span className="text-[var(--color-text-secondary)]">
  <GitBranch size={16} />
</span>
```

### Key Icon Mappings

| Concept | Phosphor Icon | Notes |
|---------|---------------|-------|
| PR open | `GitPullRequest` | Color: `--color-pr` |
| PR merged | `GitMerge` | Color: `--color-pr` |
| PR closed | `GitPullRequest` | Color: `--color-text-tertiary` |
| Branch | `GitBranch` | |
| Commit | `GitCommit` | |
| Diff | `GitDiff` | |
| Success / check | `Check` or `CheckCircle` | Color: `--color-success` |
| Error / fail | `X` or `XCircle` | Color: `--color-error` |
| Warning | `Warning` | Color: `--color-warning` |
| Pending / loading | `CircleNotch` | With `animate-spin` |
| Folder | `Folder` / `FolderOpen` | Color: `--color-folder` |
| File | `File` / `FileCode` / `FileText` | |
| Terminal | `Terminal` | |
| Settings / gear | `Gear` | |
| Deploy / rocket | `Rocket` | |
| Sun (light mode) | `Sun` | |
| Moon (dark mode) | `Moon` | |
| Search | `MagnifyingGlass` | |
| Copy | `Copy` | |
| Trash / delete | `Trash` | Color: `--color-error` for destructive |
| External link | `ArrowSquareOut` | |
| Chevron down | `CaretDown` | |
| Arrow left | `ArrowLeft` | |

## Motion

| Purpose | Duration | Easing |
|---------|----------|--------|
| Color transitions | `150ms` | `ease` (Tailwind `transition-colors`) |
| Layout shifts | `200ms` | `ease-out` |
| Enter animations | `200ms` | `ease-out` |
| Exit animations | `150ms` | `ease-in` |
| Loading spinners | `1s` | `linear` (infinite) |
| Typing dots | `1.4s` | `ease-in-out` (infinite, staggered) |

Use Tailwind's `transition-colors` for interactive state changes. Avoid transitions on layout properties (`width`, `height`) unless explicitly animating a resize.

## Patterns

### Buttons

```
Primary:    bg-[var(--color-accent)] text-[var(--color-accent-text)] hover:bg-[var(--color-accent-hover)]
Secondary:  bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]
Destructive: bg-[var(--color-error)] text-[var(--color-accent-text)] hover:opacity-90
Ghost:      bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]
```

### Status Indicators

```
Dot:    w-2 h-2 rounded-full bg-[var(--color-success|error|warning)]
Banner: bg-[var(--color-error-subtle)] border border-[var(--color-error)] text-[var(--color-error)]
Badge:  px-2 py-0.5 rounded-full text-xs bg-[var(--color-accent-subtle)] text-[var(--color-accent)]
```

### Panels & Cards

```
Panel:  bg-[var(--color-bg-secondary)] border border-[var(--color-border-primary)] rounded-lg
Card:   bg-[var(--color-bg-tertiary)] rounded-lg p-3 shadow-sm
Modal:  bg-[var(--color-bg-elevated)] rounded-xl shadow-lg p-6
```
