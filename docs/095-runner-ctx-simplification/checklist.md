# 095 — Runner Context Simplification — Checklist

- [x] Add a shared `resolveRunner(ctx, sessionId)` helper in `ws-handlers/resolve-runner.ts`.
- [x] Refactor `ws-handlers/send-message.ts` — replace every `ctx.setX(...)` with `runner.X = …`; capture `runner` once at handler entry.
- [x] Refactor `ws-handlers/claude-execution.ts` — finish the partial migration; remove all remaining `ctx.setX(...)` from `runClaudeWithMessage`.
- [x] Refactor `ws-handlers/agent-listeners.ts` — uses captured runner; nothing further to remove.
- [x] Audit `ws-handlers/misc-handlers.ts`, `terminal-handlers.ts` — switched to `resolveRunner` + direct mutation.
- [x] Remove deprecated setter fields from `RunnerCtx` in `ws-handlers/types.ts`.
- [x] Remove setter implementations and `withRunner`/`reportDetachedAccess` scaffolding from `index.ts`.
- [x] `postTurnCommit` no longer reads `ctx.getTurnSummary()` — `turnSummary` is a required arg.
- [x] All affected tests still pass (461 integration tests + unit tests).
- [x] Lint, typecheck.
- [x] Mark `status: done`.
