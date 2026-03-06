# CLAUDE.md

ShipIt is a browser-based IDE for vibe coding — chat with Claude, it writes code, you see results live. Powered by Claude Code CLI and your Claude subscription.

## Runtime

ShipIt always runs inside Docker containers — there is no local/bare-metal mode. The orchestrator runs in a container and spawns session worker containers.

## Setup

```bash
npm install
```

## Commands

- **`npm run test:dev`** — **preferred for development.** Runs only tests affected by your uncommitted changes + a small set of smoke tests. Much faster than the full suite. Use this while iterating.
- `npm run test:dev -- --list` — dry run: shows which test files would run without executing them.
- `npm run test:smoke` — run only the smoke tests (core connectivity, HTTP bootstrap, git, one client component).
- `npm test` — run **all** tests (full suite). Use sparingly during development — the CI runs this automatically on every PR. Only run locally if you suspect wide-reaching breakage.
- `npx vitest run src/server/git-core.test.ts` — run a single test file.
- `npm run lint` — ESLint on `src/`
- `npm run typecheck` — TypeScript type checking (`tsc --noEmit`)
- `npm run dev` — start dev server (tsx)
- `npm run build` — build client with Vite

## Project structure

```
src/
  server/
    session/         Code that runs inside a session context
      claude.ts      ClaudeProcess — spawns CLI, parses NDJSON, emits events
      terminal.ts    TerminalProcess — interactive PTY
      preview-manager.ts  PreviewManager — spawns/manages preview server
      preview-config.ts   Preview config parsing (shipit.yaml)
      file-watcher.ts     FileWatcher — recursive fs.watch, debounced change events
      port-scanner.ts     Port detection for dev server previews
      install-runner.ts   Runs install commands (npm install, etc.)
      vite-error-plugin.ts  Injects error-capture script into preview HTML
      session-worker.ts   Fastify server that runs inside each container
      agents/        Agent process adapters
        agent-process.ts, agent-registry.ts, claude-adapter.ts, codex-adapter.ts

    orchestrator/    Code that runs in the main process
      index.ts       Entry point — buildApp(), DI setup, WS switch dispatcher
      api-routes.ts  HTTP REST API routes (registered via registerApiRoutes())
      validation.ts  Input validation, error formatting
      repo-git.ts    RepoGit — clone, fetch, worktree lifecycle, branch deletion
      git-utils.ts   generateBranchPrefix(), parseGitHubRemote()
      git-config.ts  Global git config helpers
      sessions.ts    SessionManager — persists session metadata to JSON
      session-runner.ts   SessionRunner + SessionRunnerRegistry
      container-session-runner.ts  ContainerSessionRunner (proxy)
      session-container.ts  SessionContainerManager — Docker orchestration
      preview-proxy.ts     Reverse proxy for container previews
      auth.ts        AuthManager — Claude CLI OAuth
      github-auth.ts GitHubAuthManager — GitHub token + API
      credential-store.ts  CredentialStore — unified credentials
      deployment-manager.ts  DeploymentManager — target registry, build, deploy dispatch
      deployment-store.ts    DeploymentStore — credentials and deploy history
      deploy-targets/        DeployTarget implementations (Vercel, Cloudflare)
      features.ts    FeatureManager — scans docs/ for feature status
      session-namer.ts  AI-powered session naming
      chat-history.ts  ChatHistoryManager — per-session message persistence
      threads.ts     ThreadManager — conversation threads and checkpoints
      usage.ts       UsageManager — per-session cost tracking
      templates.ts   Project scaffolding templates
      markdown.ts    findMarkdownFiles() — docs discovery
      ws-handlers/   WebSocket-only message handlers (streaming, per-connection state)
        types.ts     HandlerContext interface shared by all handlers
        send-message.ts  send_message, answer_question, home_send_with_repo
        session-handlers.ts, terminal-handlers.ts, misc-handlers.ts,
        deploy-handlers.ts, thread-handlers.ts
      services/      Business logic layer — pure functions consumed by routes and WS handlers
        session.ts, git.ts, github.ts, deploy.ts, settings.ts, threads.ts,
        templates.ts, files.ts, misc.ts, types.ts
      integration_tests/  Integration tests — one file per feature area
        test-helpers.ts   Shared stubs (TestClient, FakeClaudeProcess, etc.)

    shared/          Code used by both session and orchestrator
      types/         All type definitions
        index.ts, ws-client-messages.ts, ws-server-messages.ts, domain-types.ts,
        claude-types.ts, agent-types.ts, attachment-types.ts, deployment-types.ts,
        github-types.ts, terminal-types.ts, thread-types.ts, usage-types.ts
      types.ts       Barrel re-export of types/
      git.ts         GitManager — init, autoCommit, log, push, pull, diff, rollback
      file-tree.ts   scanFileTree() — workspace directory listing

  client/          React 19 frontend (Vite + Tailwind CSS v4)
    App.tsx        Main orchestrator — state, layout, WebSocket dispatch
    components/    UI components (MessageList, FileTree, PreviewFrame, etc.)
    hooks/         Custom hooks (useWebSocket, useSearch, useResizablePanel, etc.)
    index.css      Tailwind imports + custom animations
    test-setup.ts  Imports @testing-library/jest-dom/vitest
```

## Architecture

Three-layer system: browser (React SPA) → orchestrator (Fastify) → session workers (Docker containers). Architecture knowledge is packaged as skills in `.claude/skills/` for progressive disclosure — each skill auto-loads when the task context matches.

### Available skills

| Skill | Covers |
|-------|--------|
| `server-architecture` | buildApp(), HTTP routes, services, WS handlers, DI, state scopes |
| `client-architecture` | Zustand stores, hooks, components, data flow |
| `session-lifecycle` | Session types, creation paths, warm pool, activation, switching |
| `session-containers` | Docker containers, runners, idle cleanup, reconnection |
| `session-processes` | Claude CLI, preview manager, file watcher, terminal, agents |
| `git-architecture` | GitManager, RepoGit, worktrees, credentials, auto-commit |
| `deployment-architecture` | Deploy targets, framework detection, deploy flow |
| `add-endpoint` | How to add HTTP endpoints, WS messages, deploy targets, activity labels |
| `testing-and-quality` | Test patterns, integration tests, quality checklist |
| `docs-navigator` | Feature docs index — find the right `docs/NNN-*` for a task |

## Code conventions

- **ESM throughout** — `"type": "module"` in package.json. Use `.js` extensions in relative imports (e.g., `import { foo } from "./bar.js"`).
- **Type imports** — use `import type { X } from "./path.js"` for type-only imports.
- **Node built-ins** — use `node:` prefix (e.g., `import fs from "node:fs"`).
- **Naming** — classes: PascalCase, functions: camelCase, events/WS message types: snake_case, constants: UPPER_SNAKE_CASE.
- **React** — functional components only, hooks for all state/effects. React 19 JSX transform (no `import React` needed).
- **Icons** — use `@phosphor-icons/react` for all icons. Never hardcode `<svg>` elements. Use the `ICON_SIZE` constants from `src/client/design-tokens.ts` (XS=12, SM=16, MD=20, LG=32, XL=48) for icon sizes. See the `design-language` skill for full icon and styling guidance.
- **Styling** — Tailwind CSS v4 utility classes. Dark-mode-only color scheme (gray-950 backgrounds).
- **Strict TypeScript** — `strict: true` in tsconfig. Target ES2022, module ESNext with bundler resolution.

## Docs structure

```
docs/
  NNN-feature-name/
    plan.md        — How the feature works, key files, patterns
    checklist.md   — Remaining work items or tracking notes
```

Feature docs describe individual features and may include planned-but-not-implemented designs.

Features are numbered by creation order. When implementing or modifying a feature, read its `plan.md` first. When a feature has remaining work, check its `checklist.md`. When adding a new feature, create `docs/NNN-new-feature/plan.md`.

Every `plan.md` must have YAML frontmatter with a `status` field. Valid values: `planned`, `in-progress`, `done`, `paused`. The feature tracking system (`src/server/orchestrator/features.ts`) reads this frontmatter to display feature status in the UI. Example:

```yaml
---
status: in-progress
---
```

When creating a new feature doc, set `status: planned`. Update to `in-progress` when work begins and `done` when complete. Set `paused` for features that have a design but are not currently planned for implementation. A `checklist.md` can exist alongside any status — it tracks remaining work items regardless of whether the feature is actively in progress. When a feature is done, set `status: done` and mark all checklist items as complete (`[x]`).
