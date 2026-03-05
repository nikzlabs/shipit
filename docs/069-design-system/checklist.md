## Phase 1: Foundation — CSS Tokens

- [x] Create `src/client/themes/light.css` with `:root { ... }` block — all `--color-*` tokens
- [x] Create `src/client/themes/dark.css` with `.dark { ... }` block overriding tokens
- [x] Import both theme files from `src/client/index.css`
- [x] Add `--color-scrollbar-*` tokens and refactor scrollbar CSS to use them
- [x] Add `--font-size-code: 13px` token to theme files
- [x] Add shared motion tokens to `index.css`: `--duration-fast: 150ms`, `--duration-normal: 200ms`, `--duration-slow: 1s`, `--ease-default: ease`, `--ease-out: ease-out`, `--ease-in: ease-in`
- [x] Verify UI is visually unchanged (tokens defined but not consumed yet)

## Phase 2: Install Dependencies

- [x] `npm install @phosphor-icons/react class-variance-authority`
- [x] Run `npm run build` and verify bundle size is acceptable

## Phase 3: Migrate Core Layout (App.tsx)

- [x] Replace `bg-white dark:bg-gray-950` → `bg-(--color-bg-primary)` and all surface color pairs
- [x] Replace `text-gray-900 dark:text-gray-100` → `text-(--color-text-primary)` and all text color pairs
- [x] Replace `border-gray-200 dark:border-gray-800` → `border-(--color-border-primary)` and all border pairs
- [x] Replace inline SVG sun/moon icons with Phosphor `<Sun>` / `<Moon>`
- [x] Replace hardcoded blue button classes with `--color-accent` tokens
- [x] Update tab active states to use `--color-border-focus` token
- [x] Replace remaining `text-gray-500` in Suspense fallbacks with `text-(--color-text-secondary)`

## Phase 4: Migrate PR Lifecycle Card

- [x] Replace `⑂` (U+2442) with Phosphor `<GitPullRequest>` / `<GitMerge>`
- [x] Replace `✓` (U+2713) with `<Check>` or `<CheckCircle>`
- [x] Replace `✗` (U+2717) with `<X>` or `<XCircle>`
- [x] Replace `◐` (U+25D0) with `<CircleNotch>` + `animate-spin`
- [x] Replace `▾` (U+25BE) with `<CaretDown>`
- [x] Replace `←` (U+2190) with `<ArrowLeft>`
- [x] Replace `⚠` (U+26A0) with `<Warning>`
- [x] Replace custom SVG spinner with `<CircleNotch>` + `animate-spin`
- [x] Migrate `text-purple-400`, `text-emerald-400`, `text-red-400`, `text-amber-400` to design tokens

## Phase 5: Migrate Status & Connection Components

- [x] `ConnectionBanner.tsx` — replace status colors with `--color-success/error/warning` tokens
- [x] `Toast.tsx` — replace status background/text colors with `--color-*-subtle` tokens
- [x] `StatusBar.tsx` — migrate context meter to `--color-context-ok/mid/high/full` tokens
- [x] `StreamingIndicator.tsx` — migrate to `--color-info` token
- [x] Ensure all status dots, banners, and badges follow design language patterns

## Phase 6: Extract UI Primitives

- [x] Create `src/client/components/ui/button.tsx` — CVA variants: primary, secondary, destructive, ghost + sizes sm, md, lg
- [x] Create `src/client/components/ui/badge.tsx` — CVA variants: default, success, error, warning, info
- [x] Create `src/client/components/ui/status-dot.tsx` — status prop: success, error, warning, info
- [x] Create `src/client/components/ui/banner.tsx` — CVA variants: error, warning, info, success
- [x] Create `src/client/components/ui/panel.tsx` — token-based surface with border
- [x] Create `src/client/components/ui/card.tsx` — token-based elevated surface with shadow
- [x] Create `src/client/components/ui/modal.tsx` — dialog overlay with backdrop
- [x] Adopt `<Button>` in App.tsx (2 of 12 — tab buttons and custom pill buttons kept as-is)
- [x] Adopt `<Button>` in PrLifecycleCard.tsx (5 of 8 — split merge buttons kept as-is)
- [x] Adopt `<Button>` in DeployModal.tsx (9 of 12 — target/env selectors kept as-is)
- [x] Adopt `<Button>` in Settings.tsx (7 of 13 — sidebar tabs and stateful buttons kept as-is)
- [x] Adopt `<Button>` in remaining components (~65 buttons across 25+ files)
- [x] Adopt `<Badge>` in FeaturesPanel, AllSessionsDialog, AddRepoDialog, RepoSelector, Settings, AskUserQuestion
- [x] Adopt `<Banner>` in ConnectionBanner.tsx (success flash + connecting/disconnected banners)
- [x] Adopt `<Modal>` in DeployModal, UsageModal, AllSessionsDialog, AddRepoDialog, Settings
- [ ] Adopt `<Panel>` / `<Card>` for surface containers across components (deferred — most container patterns are inside Modal which already provides the elevated surface)

## Phase 7: Migrate File Tree & Preview

- [x] `FileTree.tsx` — replace `text-yellow-500` folder with Phosphor `<Folder>` / `<FolderOpen>` + `--color-folder`
- [x] `FileTree.tsx` — replace file type indicators with Phosphor icons (`<FileCode>`, `<FileText>`, etc.)
- [x] `PreviewFrame.tsx` — migrate error/warning state colors to tokens
- [x] `PreviewFrame.tsx` — migrate auto-fix orange indicator to `--color-autofix` token
- [x] `PreviewFrame.tsx` — replace any inline SVGs with Phosphor equivalents

## Phase 8: Migrate Remaining Components

- [x] `MessageList.tsx` — replace all hardcoded color pairs with tokens
- [x] `Settings.tsx` — replace all hardcoded color pairs with tokens
- [x] `SessionSidebar.tsx` — replace all hardcoded color pairs with tokens
- [x] `AddRepoDialog.tsx` — replace all hardcoded color pairs with tokens
- [x] `NewRepoDialog.tsx` — replace all hardcoded color pairs with tokens
- [x] `OnboardingWizard.tsx` — replace all hardcoded color pairs with tokens
- [x] `ToolResult.tsx` — replace all hardcoded color pairs with tokens
- [x] Sweep all other `src/client/components/*.tsx` for remaining raw color classes
- [x] Replace any remaining inline SVGs with Phosphor icons
- [x] Replace inline button/badge/banner patterns with UI primitive components

## Phase 9: Update useTheme for Multi-Theme Support

- [x] Change theme type from `"light" | "dark"` to extensible union in `useTheme.ts`
- [x] Update toggle logic: remove all theme classes, add the new one
- [x] Keep `"dark"` as default class for backwards compatibility
- [x] Light theme = no class (`:root` defaults), dark = `.dark` class
- [x] Document how to add a new theme (add CSS class block + register name)

## Phase 10: Clean Up Legacy Patterns

- [x] Remove unused `dark:` prefixed classes now handled by tokens
- [x] Audit codebase: no raw Tailwind color classes outside `index.css` token definitions
- [x] Update component tests that assert on specific color class names
- [x] Remove light-mode syntax highlighting CSS import (replaced by token-based rules)

## Phase 11: Syntax Highlighting Tokens

- [x] Define `--color-syntax-*` tokens in `light.css` and `dark.css` for all highlight.js categories (keyword, string, comment, title, attr, literal, built-in, section, bullet, addition, deletion, etc.)
- [x] Replace hardcoded hex values in `.dark .hljs-*` rules in `index.css` with `var(--color-syntax-*)` tokens
- [x] Add light-mode `.hljs-*` rules using the same tokens (removed `github.css` import)
- [x] Removed `highlight.js/styles/github.css` import in favor of token-based syntax highlighting

## Phase 12: Testing & Verification

- [x] `npm run typecheck` — no regressions
- [x] `npm run lint` — no regressions
- [x] `npm run test:dev` — all 634 tests pass
- [x] `npm run build` — build succeeds
- [ ] Visual verification: toggle light/dark, confirm all surfaces/text/borders/status colors
