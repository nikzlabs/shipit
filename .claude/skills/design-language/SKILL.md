---
description: "ShipIt design language: color tokens, typography, iconography, motion, and multi-theme architecture. Load when working on UI components, styling, theming, or adding new visual elements."
user-invocable: true
---

# Design Language

ShipIt uses semantic design tokens (CSS custom properties) for all colors. Themes are token overrides applied via a class on `<html>`. All UI code references tokens — never raw Tailwind color classes.

Concrete color values live exclusively in `src/client/index.css`. This skill defines token **names** and **semantic purpose**. Theme state is managed by `useTheme()` in `src/client/hooks/useTheme.ts` (persisted to `localStorage` key `shipit-theme`).

To add a new theme: define a new class block in `index.css` overriding the same custom properties, then register it in `useTheme()`. No component changes needed.

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

## Typography

System font stack, no custom web fonts. Body: `text-sm`, headings: `text-lg font-semibold`, code: `font-mono text-[13px]`, small: `text-xs`.

## Iconography — Phosphor Icons

Library: [`@phosphor-icons/react`](https://phosphoricons.com). All icons use Phosphor — no inline SVGs or Unicode characters.

**Sizes:** 16px inline with text, 20px in buttons/nav, 32px empty states, 48px hero.

**Weights:** `"regular"` (default), `"bold"` for emphasis, `"fill"` for toggle-on states, `"duotone"` sparingly for illustrations.

**Color:** Icons inherit `currentColor`. Set via parent's text color token:

```tsx
<span className="text-[var(--color-text-secondary)]">
  <GitBranch size={16} />
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

Color transitions: `150ms ease` (`transition-colors`). Enter: `200ms ease-out`. Exit: `150ms ease-in`. Spinners: `1s linear infinite`. Avoid animating layout properties (`width`, `height`) unless explicitly resizing.

## Component Patterns

```
Primary button:    bg-[var(--color-accent)] text-[var(--color-accent-text)] hover:bg-[var(--color-accent-hover)]
Secondary button:  bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]
Destructive button: bg-[var(--color-error)] text-[var(--color-accent-text)] hover:opacity-90
Ghost button:      bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]

Status dot:    w-2 h-2 rounded-full bg-[var(--color-success|error|warning)]
Status banner: bg-[var(--color-error-subtle)] border border-[var(--color-error)] text-[var(--color-error)]
Badge:         px-2 py-0.5 rounded-full text-xs bg-[var(--color-accent-subtle)] text-[var(--color-accent)]

Panel:  bg-[var(--color-bg-secondary)] border border-[var(--color-border-primary)] rounded-lg
Card:   bg-[var(--color-bg-tertiary)] rounded-lg p-3 shadow-sm
Modal:  bg-[var(--color-bg-elevated)] rounded-xl shadow-lg p-6
```
