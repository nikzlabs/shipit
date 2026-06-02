---
description: Route every agent turn (WS user-typed, system-dispatched, rebase conflict resolution) through one shared event listener so tool calls and message-group boundaries render identically regardless of who started the turn.
---

# 152 — Unify Agent Turn Flows

## Summary

Three code paths started agent turns (`runAgentWithMessage`, `runDispatchedTurn`, `runRebaseResolutionTurn`). Only one of them — the WS user-typed path — handled assistant events correctly: it accumulated message groups into `runner.chatMessageGroups` via `wireAgentListeners`, split them at tool-result boundaries, and persisted each group as its own chat-history row with `toolUse` and `toolResults` populated. The other two paths reimplemented the listener inline and reimplemented it wrong: they concatenated assistant text across events with no separator, dropped every `tool_use` block, and persisted the entire turn as a single assistant row with the tool call missing.

This collapses the three turn drivers down to one shared listener (`wireAgentListeners`) and one shared per-turn state reset (`resetRunnerTurnState`). The per-flow differences (auto-commit / auto-push / PR card / queue drain vs. nothing) stay where they belong — in each driver's `done` handler — but the listener that produces chat history is now identical across callers.

## Motivation

The visible bug: a rebase conflict-resolution turn appeared in chat history as

```json
{
  "role": "assistant",
  "text": "I'll examine the conflict in `MarkdownSelectionComments.tsx` and resolve it.Conflict resolved..."
}
```

— two distinct utterances concatenated with no separator, with no record of the file edit the agent made between them. The tool call never made it into the persisted history. Same bug class (milder, because text joined with `\n\n` rather than `""`) applied to every system-dispatched turn — Fix CI, child-session spawn, the `/agent/dispatch` HTTP route.

A previous fix in `wireAgentListeners` shipped message-group accumulation correctly. But because the rebase driver and `runDispatchedTurn` lived in their own files and wired their own listeners, that fix never reached them. Three listener implementations, only one correct.

The shape we wanted: each entry point posts a user message, then the rest happens the same way as if the user had typed it. The architecture forces system-initiated turns to look exactly like user-initiated turns from the listener's perspective.

This satisfies CLAUDE.md's "Key patterns / Message group boundaries" contract — that `chatMessageGroups` is the single source of truth for assistant chat history, persisted via `buildTurnMessages` at agent_result.

## Design

### Three flows, one listener

The change is structural, not algorithmic. `wireAgentListeners` already had the right logic. What was missing: a way for non-WS callers to invoke it. The function took `FullCtx = ConnectionCtx & RunnerCtx & AppCtx`, which only the WS handlers could satisfy.

The refactor lifts the function out of the WS-context world by introducing **`AgentListenerDeps`** — an app-level dependency bundle covering only the managers + broadcasters the listener actually uses:

```ts
export interface AgentListenerDeps {
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  usageManager: UsageManager;
  authManager: AuthManager;
  sseBroadcast: (event: string, data: unknown) => void;
  broadcastLog: (source: WsLogEntry["source"], text: string) => void;
  getSelectedModel: () => string | undefined;
  recordCodexRateLimits?: (...) => void;
  getSubscriptionLimitsSnapshot?: () => SubscriptionLimitsMap;
}
```

The new `wireAgentListeners` signature takes deps + a registry-resolved runner + per-turn opts:

```ts
wireAgentListeners(
  agent: AgentProcess,
  runner: SessionRunnerInterface | null,
  deps: AgentListenerDeps,
  opts: WireListenersOpts,
): void
```

The runner is passed in directly (rather than resolved from a ctx inside the function) because non-WS callers — `runDispatchedTurn` and `runRebaseResolutionTurn` — already have a runner reference and don't have a ctx to resolve from.

### Per-turn state reset → shared helper

All three flows used to inline the same reset block (`accumulatedText = ""`, `turnSummary = ""`, etc.) — except the system / rebase versions skipped `chatMessageGroups = []`, which now matters because they go through the same listener that writes to `chatMessageGroups`. A stale group from a previous turn would bleed into the new one's chat history.

`resetRunnerTurnState(runner, { reviewFilePath? })` consolidates the reset. All three drivers call it at turn start.

### Per-flow post-turn behavior stays in the driver

Three callers, three post-turn behaviors:

- **WS user-typed (`runAgentWithMessage`)**: auto-commit, auto-push, PR lifecycle card, queue drain, token sync-back.
- **System-dispatched (`runDispatchedTurn`)**: same — auto-commit, auto-push, PR card, queue drain, token sync-back.
- **Rebase conflict resolution (`runRebaseResolutionTurn`)**: **none.** The rebase machinery itself runs `git add -A && git rebase --continue` after the agent finishes, and force-push happens after the entire flow completes. Auto-committing inside the conflict-resolution turn would create a commit on top of a working tree that's mid-rebase — `git rebase --continue` would then fail or produce corrupt history.

The carve-out is non-negotiable. Each driver keeps its own `agent.on("done", ...)` handler for the flow-specific post-turn work. Only the listener (event/error/auth_required) is shared.

### Import-cycle structure

`agent-listeners.ts` imports `SessionRunnerInterface` from `session-runner.ts` (type only). Once `session-runner.ts` needs `wireAgentListeners` at runtime (so `runDispatchedTurn` can call it), the cycle becomes a runtime cycle that breaks module init.

Solution: **extract `runDispatchedTurn` to its own file** (`orchestrator/dispatched-turn.ts`). The new file imports `wireAgentListeners` at runtime and the session-runner types as type-only imports. `session-runner.ts` re-exports `runDispatchedTurn` for backward compat with `container-session-runner.ts` and `SessionRunner._runDispatchedTurn`. The cycle is broken because each module's runtime imports flow in one direction:

```
dispatched-turn.ts (runtime: wireAgentListeners, resetRunnerTurnState)
        ↑ runtime: runDispatchedTurn
session-runner.ts ← (type only) ws-handlers/agent-listeners.ts
```

### `SystemTurnDeps` shape change

Before: ad-hoc `sseBroadcast`, `persistMessage`, `replaceInProgress`, `finalizeInProgress`, `clearInProgress` callbacks — each a thin wrapper over a manager method.

After: a single **`listenerDeps: AgentListenerDeps`** bundle that the listener consumes directly. `runDispatchedTurn` accesses `deps.listenerDeps.chatHistoryManager.append(...)` for the user message and `deps.listenerDeps.sseBroadcast(...)` for `session_agent_started` / `session_agent_finished` events; everything else is the listener's job. The factory in `runner-registry-factory.ts` constructs the listener deps once per session (so `broadcastLog` and `getSelectedModel` get session-scoped closures) and stuffs them into `SystemTurnDeps`.

`SystemTurnHost` (the minimal interface `runDispatchedTurn` used to take) was deleted. The function now takes `SessionRunnerInterface` directly — both `SessionRunner` and `ContainerSessionRunner` already satisfy it, and the listener needs fields (`chatMessageGroups`, `steeredMessages`, `accumulatedToolUse`, `wasInterrupted`, `activeReviewFilePath`, `guardedUnavailable`) that weren't in the minimal host.

## Touchpoints

**New files:**
- `src/server/orchestrator/dispatched-turn.ts` — the relocated `runDispatchedTurn`, now using `wireAgentListeners`.
- `docs/152-unify-agent-turn-flows/plan.md` — this doc.

**Modified — server:**
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — new `AgentListenerDeps` interface; `wireAgentListeners` signature now `(agent, runner, deps, opts)`; all `ctx.X` references replaced with `deps.X`; `FullCtx` type alias removed; runner-null fallback in `emitToViewers` logs and drops instead of falling back to `ctx.send`.
- `src/server/orchestrator/session-runner.ts` — `SystemTurnDeps` reshape (single `listenerDeps` field replacing five ad-hoc callbacks); `SystemTurnHost` interface deleted; `resetRunnerTurnState(runner, opts?)` helper exported; old inline `runDispatchedTurn` removed; new `runDispatchedTurn` re-exported from `./dispatched-turn.js`.
- `src/server/orchestrator/services/rebase-driver.ts` — `runRebaseResolutionTurn` rewritten to use `wireAgentListeners`. Drops its custom event listener entirely; keeps only the `done` handler for resolve and the `error` handler for reject. `RebaseDriverDeps` gains `usageManager` + `authManager` for the shared listener.
- `src/server/orchestrator/runner-registry-factory.ts` — `RunnerRegistryDeps` gains `usageManager`, `authManager`, optional `recordCodexRateLimits`, optional `getSubscriptionLimitsSnapshot`. The factory builds the per-session `listenerDeps` (session-scoped `broadcastLog` + `getSelectedModel`) and threads it into `SystemTurnDeps`.
- `src/server/orchestrator/index.ts` — passes `usageManager` + `authManager` into `createRunnerRegistry`.
- `src/server/orchestrator/api-routes-git.ts` — passes `usageManager` + `authManager` into `runRebaseFlow`.
- `src/server/orchestrator/ws-handlers/agent-execution.ts` — `runAgentWithMessage` builds an `AgentListenerDeps` inline from `ctx` and calls `wireAgentListeners(agent, runner, deps, opts)`. The inline per-turn state reset (~11 lines) is replaced by a single `resetRunnerTurnState(runner, { reviewFilePath })` call.
- `src/server/orchestrator/ws-handlers/send-message.ts` — same shape change for the `handleAnswerQuestion` call to `wireAgentListeners`.

**Modified — tests:**
- `src/server/orchestrator/services/rebase-driver.test.ts` — new bug-class regression test `conflicts — preserves tool calls and splits assistant messages at tool-result boundary`. `makeStubHistory` extended with `replaceInProgress` / `finalizeInProgress` / `clearInProgress` (the shared listener now persists via these instead of `append`-only). New `makeStubUsageManager` + `makeStubAuthManager` stubs. All 7 `runRebaseFlow({...})` call sites threaded with the new managers.
- `src/server/orchestrator/integration_tests/agent-dispatch-route.test.ts` — new end-to-end regression test `dispatch persists tool calls and splits assistant text at tool-result boundary` exercising the HTTP dispatch route with the canonical bug sequence.
- `src/server/orchestrator/session-runner.test.ts` — the one `setSystemTurnDeps({...})` call updated to provide `listenerDeps` instead of the old `sseBroadcast` / `persistMessage` fields.

## Non-goals / explicit decisions

- **No removal of per-flow post-turn handlers.** WS, dispatched, and rebase each keep their own `agent.on("done", ...)` for flow-specific work. The shared piece is the listener (event/error/auth_required), not the entire driver.
- **No auto-commit inside the rebase conflict-resolution turn.** This is the one place where the unification has a carve-out — explained above. Removing the carve-out would break rebase.
- **No wiring of `recordCodexRateLimits` / `getSubscriptionLimitsSnapshot` into the system-turn listener.** These are constructed later in `index.ts` (after `createRunnerRegistry`), and threading them through would require a forward-ref dance. Both are optional on `AgentListenerDeps`; system-turn listeners just skip those nice-to-have signals. WS user-typed turns are unaffected — they still wire them.

## Risks & open questions

- **`SystemTurnDeps` shape change is a breaking refactor** for anyone wiring it manually (one test in `session-runner.test.ts`). Caught by TypeScript at compile time, so the diff is mechanical to apply.
- **Import cycle between `session-runner.ts` and `ws-handlers/agent-listeners.ts`.** Resolved by extracting `runDispatchedTurn` to `dispatched-turn.ts`. Type-only imports flow both ways without cycle; only the runtime import (`wireAgentListeners` → `dispatched-turn.ts`) leaves session-runner.ts.
- **Indentation inconsistency in `rebase-driver.test.ts`** — the `replace_all` of `      sseBroadcast: () => {},` matched both 6-space and 8-space-indented occurrences (substring match), leaving three blocks with mixed indent. Functionally harmless; can be fixed by a follow-up format pass.

## Success criteria

- Chat history rows produced by a rebase conflict-resolution turn match the shape produced by a user-typed turn: one assistant row per message group, `toolUse` and `toolResults` populated on rows that contained tool calls, no concatenation across tool-result boundaries.
- Same for system-dispatched turns (Fix CI, child-session, `/agent/dispatch` HTTP route).
- `runner.chatMessageGroups` is the only place message-group state lives. No more parallel `accumulatedText`-only flows persisting chat history.
- `wireAgentListeners` is the only event listener implementation. No more inline `agent.on("event", ...)` blocks in `runDispatchedTurn` or `runRebaseResolutionTurn`.
- Both regression tests (one per affected flow) catch the bug class if the listener is ever bypassed again.
