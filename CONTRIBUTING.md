# Contributing to ShipIt

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

**Prerequisites:**

- Node.js 20+
- npm
- git
- Docker (ShipIt runs inside containers)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed globally (`npm install -g @anthropic-ai/claude-code`)

**Getting started:**

```bash
git clone https://github.com/nicolasalt/shipit.git
cd shipit
npm install
```

## Development Workflow

```bash
# Start the dev server
npm run dev

# Run tests affected by your changes (fast, preferred during development)
npm run test:dev

# Run a single test file
npx vitest run src/server/git-core.test.ts

# Lint and type-check
npm run lint
npm run typecheck
```

Always run `npm run lint` and `npm run typecheck` before submitting a PR and fix any errors.

## Submitting Changes

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Run the quality checks:
   ```bash
   npm run typecheck
   npm run lint
   npm run test:dev
   ```
5. Commit with a clear, descriptive message
6. Open a pull request

## Code Conventions

- **ESM throughout** — use `.js` extensions in relative imports (e.g., `import { foo } from "./bar.js"`)
- **Type imports** — `import type { X } from "./path.js"` for type-only imports
- **Node built-ins** — use `node:` prefix (e.g., `import fs from "node:fs"`)
- **Naming** — classes: PascalCase, functions: camelCase, events/WS message types: snake_case, constants: UPPER_SNAKE_CASE
- **React** — functional components only, hooks for all state and effects
- **Styling** — Tailwind CSS v4 utility classes, dark-mode-only color scheme
- **Icons** — use `@phosphor-icons/react`, never hardcode `<svg>` elements
- **Tests** — co-located with source files (`foo.ts` → `foo.test.ts`)

## Project Structure

```
src/
  server/
    orchestrator/    Main process — routes, services, managers
    session/         Session container worker — Claude CLI, terminal, preview
    shared/          Shared code — types, git, utilities
  client/            React 19 SPA — components, hooks, Zustand stores
```

## Where to Start

- Check [open issues](https://github.com/nicolasalt/shipit/issues) for tasks labeled `good first issue`
- Read the feature docs in `docs/NNN-feature-name/plan.md` before modifying a feature
- Look at existing tests near the code you're changing to understand the expected patterns

## Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Browser and OS version
- Relevant console output or screenshots
