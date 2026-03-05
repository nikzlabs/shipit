## Phase 1: Foundation — CSS Tokens

- [ ] Create `src/client/themes/light.css` with `:root { ... }` block — all `--color-*` tokens
- [ ] Create `src/client/themes/dark.css` with `.dark { ... }` block overriding tokens
- [ ] Import both theme files from `src/client/index.css`
- [ ] Add `--color-scrollbar-*` tokens and refactor scrollbar CSS to use them
- [ ] Add `--font-size-code: 13px` token to theme files
- [ ] Add shared motion tokens to `index.css`: `--duration-fast: 150ms`, `--duration-normal: 200ms`, `--duration-slow: 1s`, `--ease-default: ease`, `--ease-out: ease-out`, `--ease-in: ease-in`
- [ ] Verify UI is visually unchanged (tokens defined but not consumed yet)

## Phase 2: Install Dependencies

- [ ] `npm install @phosphor-icons/react class-variance-authority`
- [ ] Run `npm run build` and verify bundle size is acceptable

## Phase 3: Migrate Core Layout (App.tsx)

- [ ] Replace `bg-white dark:bg-gray-950` → `bg-[var(--color-bg-primary)]` and all surface color pairs
- [ ] Replace `text-gray-900 dark:text-gray-100` → `text-[var(--color-text-primary)]` and all text color pairs
- [ ] Replace `border-gray-200 dark:border-gray-800` → `border-[var(--color-border-primary)]` and all border pairs
- [ ] Replace inline SVG sun/moon icons with Phosphor `<Sun>` / `<Moon>`
- [ ] Replace hardcoded blue button classes with `--color-accent` tokens
- [ ] Update tab active states to use `--color-border-focus` token

## Phase 4: Migrate PR Lifecycle Card

- [ ] Replace `⑂` (U+2442) with Phosphor `<GitPullRequest>` / `<GitMerge>`
- [ ] Replace `✓` (U+2713) with `<Check>` or `<CheckCircle>`
- [ ] Replace `✗` (U+2717) with `<X>` or `<XCircle>`
- [ ] Replace `◐` (U+25D0) with `<CircleNotch>` + `animate-spin`
- [ ] Replace `▾` (U+25BE) with `<CaretDown>`
- [ ] Replace `←` (U+2190) with `<ArrowLeft>`
- [ ] Replace `⚠` (U+26A0) with `<Warning>`
- [ ] Replace custom SVG spinner with `<CircleNotch>` + `animate-spin`
- [ ] Migrate `text-purple-400`, `text-emerald-400`, `text-red-400`, `text-amber-400` to design tokens

## Phase 5: Migrate Status & Connection Components

- [ ] `ConnectionBanner.tsx` — replace status colors with `--color-success/error/warning` tokens
- [ ] `Toast.tsx` — replace status background/text colors with `--color-*-subtle` tokens
- [ ] `StatusBar.tsx` — migrate context meter to `--color-context-ok/mid/high/full` tokens
- [ ] `StreamingIndicator.tsx` — migrate to `--color-info` token
- [ ] Ensure all status dots, banners, and badges follow design language patterns

## Phase 6: Extract UI Primitives

- [ ] Create `src/client/components/ui/button.tsx` — CVA variants: primary, secondary, destructive, ghost + sizes sm, md, lg
- [ ] Create `src/client/components/ui/badge.tsx` — CVA variants: default, success, error, warning, info
- [ ] Create `src/client/components/ui/status-dot.tsx` — status prop: success, error, warning, info
- [ ] Create `src/client/components/ui/banner.tsx` — CVA variants: error, warning, info, success
- [ ] Create `src/client/components/ui/panel.tsx` — token-based surface with border
- [ ] Create `src/client/components/ui/card.tsx` — token-based elevated surface with shadow
- [ ] Create `src/client/components/ui/modal.tsx` — dialog overlay with backdrop
- [ ] Refactor App.tsx and Phases 3–5 components to use primitives where applicable

## Phase 7: Migrate File Tree & Preview

- [ ] `FileTree.tsx` — replace `text-yellow-500` folder with Phosphor `<Folder>` / `<FolderOpen>` + `--color-folder`
- [ ] `FileTree.tsx` — replace file type indicators with Phosphor icons (`<FileCode>`, `<FileText>`, etc.)
- [ ] `PreviewFrame.tsx` — migrate error/warning state colors to tokens
- [ ] `PreviewFrame.tsx` — migrate auto-fix orange indicator to `--color-autofix` token
- [ ] `PreviewFrame.tsx` — replace any inline SVGs with Phosphor equivalents

## Phase 8: Migrate Remaining Components

- [ ] `MessageList.tsx` — replace all hardcoded color pairs with tokens
- [ ] `Settings.tsx` — replace all hardcoded color pairs with tokens
- [ ] `SessionSidebar.tsx` — replace all hardcoded color pairs with tokens
- [ ] `AddRepoDialog.tsx` — replace all hardcoded color pairs with tokens
- [ ] `NewRepoDialog.tsx` — replace all hardcoded color pairs with tokens
- [ ] `OnboardingWizard.tsx` — replace all hardcoded color pairs with tokens
- [ ] `ToolResult.tsx` — replace all hardcoded color pairs with tokens
- [ ] Sweep all other `src/client/components/*.tsx` for remaining raw color classes
- [ ] Replace any remaining inline SVGs with Phosphor icons
- [ ] Replace inline button/badge/banner patterns with UI primitive components

## Phase 9: Update useTheme for Multi-Theme Support

- [ ] Change theme type from `"light" | "dark"` to extensible union in `useTheme.ts`
- [ ] Update toggle logic: remove all theme classes, add the new one
- [ ] Keep `"dark"` as default class for backwards compatibility
- [ ] Light theme = no class (`:root` defaults), dark = `.dark` class
- [ ] Document how to add a new theme (add CSS class block + register name)

## Phase 10: Clean Up Legacy Patterns

- [ ] Remove unused `dark:` prefixed classes now handled by tokens
- [ ] Audit codebase: no raw Tailwind color classes outside `index.css` token definitions
- [ ] Update component tests that assert on specific color class names
- [ ] Remove light-mode syntax highlighting CSS import if replaced by token-aware version

## Phase 11: Testing & Verification

- [ ] Visual verification: toggle light/dark, confirm all surfaces/text/borders/status colors
- [ ] `npm run typecheck` — no regressions
- [ ] `npm run lint` — no regressions
- [ ] `npm run test:dev` — all tests pass, snapshots updated
- [ ] `npm run build` — verify bundle size delta from dependencies is reasonable
- [ ] Verify syntax highlighting in both themes
- [ ] Test all status indicators (connection, CI, deploy, context meter)
