
# 069 — Design System: Tokens, Themes & Iconography

Migrate ShipIt's UI from hardcoded Tailwind color classes to semantic design tokens (CSS custom properties), replace inline SVGs and Unicode icons with Phosphor Icons, and establish multi-theme support.

## Motivation

1. **Multi-theme support** — Current `dark:` prefix approach requires every component to declare both light and dark colors. Adding a third theme means touching every file. With tokens, a new theme is one CSS class block.
2. **Consistency** — Components use slightly different grays, blues, and status colors. Tokens enforce a single source of truth.
3. **Iconography** — Icons are a mix of inline SVGs (theme toggle), Unicode characters (PR lifecycle `⑂✓✗`), and bare text. A single icon library gives visual consistency and better accessibility.

## Reference

Design language skill: `.claude/skills/design-language/SKILL.md` — defines all tokens, icon mappings, and component patterns. All refactoring work must conform to that spec.

## Refactoring Plan

### Phase 1: Foundation — CSS Tokens

**Goal:** Define all design tokens without changing any components. Both old classes and new tokens work simultaneously.

**Files:**
- `src/client/themes/light.css` (new)
- `src/client/themes/dark.css` (new)
- `src/client/index.css`

**Work:**
1. Create `src/client/themes/light.css` with `:root { ... }` block — all `--color-*` tokens set to light-theme values
2. Create `src/client/themes/dark.css` with `.dark { ... }` block overriding the same tokens with dark-theme values
3. Import both theme files from `index.css`
4. Add `--color-scrollbar-*` tokens and update scrollbar CSS to use them
5. Add `--font-size-code: 13px` token
6. Add shared motion tokens in `index.css`: `--duration-fast: 150ms`, `--duration-normal: 200ms`, `--duration-slow: 1s`, `--ease-default: ease`, `--ease-out: ease-out`, `--ease-in: ease-in`
7. Verify existing UI is unchanged (tokens defined but not yet consumed)

### Phase 2: Install Dependencies

**Goal:** Add `@phosphor-icons/react` and `class-variance-authority` dependencies.

**Files:**
- `package.json`

**Work:**
1. `npm install @phosphor-icons/react class-variance-authority`
2. Verify bundle — both are tree-shakeable

### Phase 3: Migrate Core Layout (App.tsx)

**Goal:** Replace hardcoded color classes in `App.tsx` with token references. This is the highest-impact single file.

**Files:**
- `src/client/App.tsx`

**Work:**
1. Replace `bg-white dark:bg-gray-950` → `bg-[var(--color-bg-primary)]` (and similar for all surfaces)
2. Replace `text-gray-900 dark:text-gray-100` → `text-[var(--color-text-primary)]`
3. Replace `border-gray-200 dark:border-gray-800` → `border-[var(--color-border-primary)]`
4. Replace inline SVG sun/moon icons with Phosphor `<Sun>` / `<Moon>`
5. Replace hardcoded blue button classes with accent tokens
6. Update tab active states (`border-blue-500` → `border-[var(--color-border-focus)]`)

### Phase 4: Migrate PR Lifecycle Card

**Goal:** Replace all Unicode icon characters and hardcoded colors in PrLifecycleCard.

**Files:**
- `src/client/components/PrLifecycleCard.tsx`

**Work:**
1. Replace `⑂` (Unicode) with `<GitPullRequest>` / `<GitMerge>` from Phosphor
2. Replace `✓` with `<Check>` or `<CheckCircle>`
3. Replace `✗` with `<X>` or `<XCircle>`
4. Replace `◐` (half circle pending) with `<CircleNotch>` + `animate-spin`
5. Replace `▾` with `<CaretDown>`
6. Replace `←` with `<ArrowLeft>`
7. Replace `⚠` with `<Warning>`
8. Replace custom SVG spinner with `<CircleNotch>` + `animate-spin`
9. Migrate all `text-purple-400`, `text-emerald-400`, `text-red-400`, `text-amber-400` to tokens

### Phase 5: Migrate Status & Connection Components

**Goal:** Standardize status indicators across components.

**Files:**
- `src/client/components/ConnectionBanner.tsx`
- `src/client/components/Toast.tsx`
- `src/client/components/StatusBar.tsx`
- `src/client/components/StreamingIndicator.tsx`

**Work:**
1. Replace status color classes with `--color-success`, `--color-error`, `--color-warning`, `--color-info` tokens
2. Replace status background classes with `--color-*-subtle` tokens
3. Migrate context meter colors in StatusBar to `--color-context-*` tokens
4. Ensure all status dots, banners, and badges follow the patterns defined in the design language skill

### Phase 6: Extract UI Primitives

**Goal:** Create shared primitive components with CVA so remaining migration phases can consume them instead of duplicating class strings.

**Files:**
- `src/client/components/ui/button.tsx` (new)
- `src/client/components/ui/badge.tsx` (new)
- `src/client/components/ui/status-dot.tsx` (new)
- `src/client/components/ui/banner.tsx` (new)
- `src/client/components/ui/panel.tsx` (new)
- `src/client/components/ui/card.tsx` (new)
- `src/client/components/ui/modal.tsx` (new)

**Work:**
1. Create `Button` with CVA variants: primary, secondary, destructive, ghost + sizes sm, md, lg
2. Create `Badge` with CVA variants: default, success, error, warning, info
3. Create `StatusDot` with status prop: success, error, warning, info
4. Create `Banner` with CVA variants: error, warning, info, success
5. Create `Panel`, `Card`, `Modal` as thin wrappers with token-based styling
6. Refactor App.tsx and Phases 3–5 components to use the new primitives where applicable
7. All primitives use design tokens — no raw Tailwind color classes

### Phase 7: Migrate File Tree & Preview

**Files:**
- `src/client/components/FileTree.tsx`
- `src/client/components/PreviewFrame.tsx`

**Work:**
1. FileTree: Replace `text-yellow-500` folder icon with Phosphor `<Folder>` / `<FolderOpen>` + `--color-folder` token
2. FileTree: Replace any file type indicators with appropriate Phosphor icons (`<FileCode>`, `<FileText>`, etc.)
3. PreviewFrame: Migrate error/warning states to tokens
4. PreviewFrame: Migrate auto-fix orange indicator to `--color-autofix` token
5. PreviewFrame: Replace any inline SVGs with Phosphor equivalents

### Phase 8: Migrate Remaining Components

**Goal:** Sweep through all remaining components, using UI primitives where applicable.

**Files:**
- `src/client/components/MessageList.tsx`
- `src/client/components/Settings.tsx`
- `src/client/components/SessionSidebar.tsx`
- `src/client/components/AddRepoDialog.tsx`
- `src/client/components/NewRepoDialog.tsx`
- `src/client/components/OnboardingWizard.tsx`
- `src/client/components/ToolResult.tsx`
- All other components in `src/client/components/`

**Work:**
1. Replace all `bg-*` / `dark:bg-*` pairs with token equivalents
2. Replace all `text-*` / `dark:text-*` pairs with token equivalents
3. Replace all `border-*` / `dark:border-*` pairs with token equivalents
4. Replace any remaining inline SVGs with Phosphor icons
5. Replace inline button/badge/banner patterns with UI primitive components

### Phase 9: Update useTheme for Multi-Theme Support

**Goal:** Extend the theme system beyond light/dark.

**Files:**
- `src/client/hooks/useTheme.ts`

**Work:**
1. Change theme state from `"light" | "dark"` to a union of theme names (e.g., `"light" | "dark" | string`)
2. On theme change: remove all theme classes from `documentElement`, add the new one
3. Keep `"dark"` as the default class name for backwards compatibility
4. Light theme = no class (`:root` defaults), dark theme = `.dark` class
5. Future themes add their own class (e.g., `.solarized`, `.high-contrast`)

### Phase 10: Clean Up Legacy Patterns

**Goal:** Remove all dead code from the migration.

**Work:**
1. Remove light-mode GitHub syntax highlighting CSS import if replaced by token-aware version
2. Remove any `dark:` prefixed classes that are no longer needed (they're now handled by tokens)
3. Audit for any remaining raw color classes — there should be none outside of `index.css` token definitions
4. Update any component tests that assert on specific color classes

### Phase 11: Testing & Verification

**Work:**
1. Visual verification: toggle light/dark mode, confirm all surfaces, text, borders, and status colors are correct
2. Run `npm run typecheck` — no regressions
3. Run `npm run lint` — no regressions
4. Run `npm run test:dev` — update any snapshot tests or class-name assertions
5. Run `npm run build` — verify bundle size delta from Phosphor (should be minimal with tree-shaking)
6. Verify syntax highlighting still works in both themes
7. Test all status indicators (connection, CI, deploy, context meter)

## Migration Strategy

- **Incremental** — Each phase is independently shippable. Tokens and old classes coexist during migration.
- **No visual changes** — Every phase should produce pixel-identical output. This is a refactor, not a redesign.
- **Test after each phase** — Run `npm run test:dev` after each phase to catch regressions early.
- **Component-by-component** — Phases 3–5 can be done in any order. Phase 6 (UI primitives) should come before Phase 7–8 so those phases can consume the primitives.

## Risk & Mitigation

| Risk | Mitigation |
|------|------------|
| `var()` fallback in older browsers | Tailwind v4 already requires modern browsers; CSS custom properties have the same support baseline |
| Phosphor bundle size | Tree-shakeable; only imported icons are bundled. Monitor with `npm run build` |
| Missing Phosphor icon for a concept | Phosphor has 6000+ icons; fallback to a generic icon and file an issue |
| Visual regression in one theme | Test both themes after each phase; use screenshots for comparison |
