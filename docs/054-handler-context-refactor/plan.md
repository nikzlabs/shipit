---
status: done
---

# 054 — HandlerContext Refactor

## Problem

`HandlerContext` (in `ws-handlers/types.ts`) was a ~40-method interface that mixed three distinct concerns:

1. **Per-connection state** — `getActiveAppSessionId()`, `setActiveSessionDir()`, etc.
2. **Per-session runner delegation** — `getRunner()`, `getAgent()`, `setIsClaudeRunning()`, etc.
3. **App-wide manager references** — `sessionManager`, `chatHistoryManager`, `threadManager`, etc.

This made it the biggest coupling surface between orchestrator and session layers. Any new feature that touched WebSocket handling had to navigate this god object.

## Scope

This doc covers HandlerContext only. For the broader directory restructure, see [053-server-code-separation](../053-server-code-separation/plan.md).

## Solution

Split the monolith into three focused sub-interfaces:

### `ConnectionCtx`
Per-connection state and communication, scoped to a single WebSocket connection's lifecycle:
- Communication: `send`, `broadcastLog`, `sseBroadcast`
- Session accessors: `getActiveDir`, `getActiveGitManager`, `getActiveAppSessionId`, `getActiveSessionDir`, `activateSession`
- Per-connection helpers: `checkGitIdentity`, `readSystemPrompt`, `scheduleAutoPush`, `clearLogBuffer`

### `RunnerCtx`
Per-session runner delegation — agent/claude state accessors that delegate to the attached `SessionRunner`:
- Agent management: `agentFactory`, `getAgent`, `setAgent`, `getActiveAgentId`, `setActiveAgentId`
- Running state: `getIsClaudeRunning`, `setIsClaudeRunning`, `getWasInterrupted`, `setWasInterrupted`
- Turn accumulation: `getTurnSummary`, `getAccumulatedText`, `getAccumulatedToolUse`, `getChatMessageGroups`, `getNeedsNewMessageGroup`
- Message queue: `getMessageQueue`, `clearMessageQueue`
- Terminal: `getTerminal`, `setTerminal`
- Runner lifecycle: `getRunner`, `getRunnerRegistry`, `attachToRunner`, `detachFromRunner`

### `AppCtx`
App-wide manager references, factories, and config — shared singletons that live for the lifetime of the server process:
- All manager references (`sessionManager`, `chatHistoryManager`, `threadManager`, etc.)
- Repo management: `repoStore`, `warmSessionForRepo`
- Factories: `createSessionDir`, `generateText`, `getSharedRepoDir`
- Config: `workspaceDir`, `sessionsRoot`, `defaultAgentId`

### `HandlerContext`
Composed as `ConnectionCtx & RunnerCtx & AppCtx` — a type alias, so existing code using `HandlerContext` continues to work unchanged.

## Handler Dependencies

Each handler file now declares only the sub-contexts it needs:

| Handler file | Sub-contexts used |
|---|---|
| `terminal-handlers.ts` | `ConnectionCtx & RunnerCtx` (or `RunnerCtx` alone) |
| `misc-handlers.ts` | `ConnectionCtx & RunnerCtx` |
| `deploy-handlers.ts` | `ConnectionCtx & AppCtx` (or `AppCtx` alone) |
| `thread-handlers.ts` | `ConnectionCtx & AppCtx` |
| `send-message.ts` | `HandlerContext` (uses all three) |

## Key Files

- `src/server/orchestrator/ws-handlers/types.ts` — sub-interface definitions and `HandlerContext` type alias
