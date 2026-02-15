# Ralph — Development Prompt

You are working on **ShipIt**, a browser-based IDE for vibe coding powered by Claude Code CLI. Your job is to pick up the next unchecked item from the implementation checklist and deliver it end-to-end: working code, tests, and documentation.

## Context Files

Read these before starting — they are your source of truth:

| File | Purpose |
|------|---------|
| `CHECKLIST.md` | Implementation roadmap — find the next unchecked `[ ]` item |
| `ARCHITECTURE.md` | Technical architecture, WebSocket protocol, component roles |
| `DESIGN.md` | Vision, UI layout, backend responsibilities, tech decisions |
| `TESTING.md` | Test strategy, patterns, suite inventory |

## Workflow

### 1. Identify the Next Task

Open `CHECKLIST.md`. Find the first unchecked item (`[ ]`), starting from Phase 7 and working down to Nice to Have. That is your task. If multiple items are unchecked, pick the first one — sequential order matters because later items may depend on earlier ones.

### 2. Research Before Coding

Before writing any code:
- Read the relevant source files to understand how the existing system works. Trace the data flow for similar features that are already implemented.
- Check if any existing code partially addresses the task or provides patterns to follow.
- Identify every file that will need changes (server, client components, hooks, types, tests).

### 3. Implement

Build the feature following the project's established patterns:

- **TypeScript** throughout — no `any` types, use the existing type definitions in `src/server/types.ts`.
- **Server changes** go in `src/server/` — follow the module pattern (e.g., `claude.ts`, `git.ts`, `sessions.ts`).
- **Client changes** go in `src/client/` — React components in `components/`, hooks in `hooks/`.
- **Styling** uses Tailwind CSS classes inline — no separate CSS files, no CSS modules.
- **State management** uses React built-in hooks (useState, useReducer, useContext) — no external state libraries.
- **WebSocket messages**: if the feature requires new message types between client and server, add them to the protocol in `src/server/types.ts` and document in `ARCHITECTURE.md`.

### 4. Test

Write tests alongside the implementation:
- Co-locate test files next to source files (`foo.ts` → `foo.test.ts`).
- Server tests use Vitest directly; client tests use `@testing-library/react` + jsdom.
- Follow existing test patterns — look at neighboring test files for examples.
- Run the full test suite (`npm test`) and ensure all tests pass, including your new ones.
- Run the build (`npm run build`) to verify no type errors.

### 5. Document As You Go

This is critical. As you work through the implementation, you will encounter things that took time to figure out — how a subsystem works, why something is structured a certain way, what the data flow looks like, edge cases you discovered. **Write this knowledge down** so the next developer (or future you) doesn't have to rediscover it.

Documentation belongs in the appropriate file:
- **`ARCHITECTURE.md`** — for new subsystems, components, protocols, data flows, or architectural decisions. Add a new section or extend an existing one.
- **`TESTING.md`** — for new test suites, testing patterns, or gotchas you encountered while testing.
- **`DESIGN.md`** — only if the feature changes the high-level vision, UI layout, or key technical decisions.
- **Inline code comments** — only where the logic isn't self-evident. Don't over-comment.

The bar: if you had to read source code to understand something that wasn't documented, document it. If you made a non-obvious decision, document why.

### 6. Update the Checklist

After the feature is complete and tests pass, mark the item as done in `CHECKLIST.md`:
```
- [x] Your completed item
```

### 7. Report: What's Next

After completing the task, provide a summary covering:

#### Completed Work
- What you built, key implementation decisions, and anything noteworthy.

#### Potential Next Tasks

Go beyond just listing the remaining checklist items. Evaluate the codebase holistically and suggest:

- **From the checklist**: the remaining unchecked items, in priority order, with any dependency notes.
- **Gaps you noticed**: missing error handling, untested edge cases, performance concerns, accessibility issues, security considerations.
- **Feature ideas**: things that would meaningfully improve the UX or developer experience, informed by what you learned while working in the codebase.
- **Tech debt**: patterns that should be refactored, dependencies that should be updated, abstractions that are leaking.
- **Documentation gaps**: areas where documentation is missing, outdated, or could be clearer.

Be specific and actionable. "Improve error handling" is too vague. "Add retry logic to `ClaudeProcess.spawn()` when the CLI binary isn't found — currently throws an unhandled exception that crashes the server" is useful.
