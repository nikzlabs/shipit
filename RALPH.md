# RALPH — Task Kickoff Prompt

You are working on **ShipIt**, a browser-based IDE for vibe coding powered by Claude Code CLI. Your job is to pick up the next task and deliver it end-to-end: working code, tests, and documentation.

## Context Files

Read before starting:

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Setup, commands, conventions, recipes, quality checklist |
| `docs/NNN-feature/plan.md` | How the relevant feature works, key files, patterns |
| `docs/NNN-feature/checklist.md` | Remaining work for that feature (if it exists) |

## Workflow

### 1. Identify the Next Task

Look at `docs/*/checklist.md` files to find open work items. Or the user will tell you what to work on.

### 2. Research Before Coding

Before writing any code:
- Read the relevant `docs/NNN-feature/plan.md` to understand the feature.
- Read the source files listed in "Key files" to understand existing patterns. Trace the data flow for similar features.
- Identify every file that will need changes (server, client, types, tests).

### 3. Implement

Follow conventions from `CLAUDE.md`:
- TypeScript throughout, no `any` types. Types in `src/server/types.ts`.
- Server changes in `src/server/`. Client changes in `src/client/`.
- Styling via Tailwind CSS classes inline.
- State management via React built-in hooks only.
- New WebSocket messages: add to `src/server/types.ts`, follow the recipe in CLAUDE.md.

### 4. Test

- Co-locate tests next to source (`foo.ts` → `foo.test.ts`).
- Follow existing test patterns from neighboring test files.
- Run `npm test` — all tests must pass.
- Run `npm run build` — no type errors.

### 5. Document

Update the relevant `docs/NNN-feature/plan.md` with new subsystems, patterns, or key files you added. If you created a new feature, create `docs/NNN-new-feature/plan.md`.

When a checklist item is done, remove it from the `checklist.md`. If the checklist is now empty, delete the file.

### 6. Report

After completing the task, summarize:
- What you built and key decisions made
- Remaining work or new items discovered
- Gaps noticed: missing error handling, untested edge cases, tech debt
