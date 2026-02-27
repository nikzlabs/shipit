---
status: paused
---

# 054 — HandlerContext Refactor

## Problem

`HandlerContext` (in `ws-handlers/types.ts`) is a ~40-method interface that mixes three distinct concerns:

1. **Per-connection state** — `getActiveAppSessionId()`, `setActiveSessionDir()`, `getPerConnectionAgentId()`, etc.
2. **Per-session runner delegation** — `isRunning()`, `getQueueSnapshot()`, `emitMessage()`, `attachToRunner()`, etc.
3. **App-wide manager references** — `sessionManager`, `chatHistoryManager`, `threadManager`, `usageManager`, `deploymentManager`, `githubAuthManager`, etc.

This makes it the biggest coupling surface between orchestrator and session layers. Any new feature that touches WebSocket handling must navigate this god object.

## Scope

This doc covers HandlerContext only. For the broader directory restructure, see [053-server-code-separation](../053-server-code-separation/plan.md).

## Current State

HandlerContext is an orchestrator concept — it exists per WebSocket connection in the main process. The 053 refactoring moves it to `orchestrator/ws-handlers/types.ts` without changing its structure. This is intentional: splitting HandlerContext is a separate, larger change that can happen independently.

## Possible Directions

### Option A: Split into typed sub-contexts

Break the monolith into focused interfaces passed to handlers:

```typescript
interface ConnectionCtx {
  getActiveAppSessionId(): string | null;
  setActiveSessionDir(dir: string): void;
  getPerConnectionAgentId(): AgentId | null;
  sendMessage(msg: WsServerMessage): void;
  // ...per-connection state
}

interface RunnerCtx {
  isRunning(): boolean;
  emitMessage(msg: WsServerMessage): void;
  getQueueSnapshot(): QueuedMessage[];
  // ...runner delegation
}

interface AppCtx {
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  // ...app-wide singletons
}
```

Handlers declare which sub-contexts they need, making dependencies explicit.

### Option B: Keep as-is

HandlerContext works. It's verbose but not broken. The 053 directory split already prevents the worst outcome (session code accidentally importing it). Further decomposition can wait until HandlerContext grows painful.

## Decision

Deferred. The 053 refactoring does not change HandlerContext — it stays in `orchestrator/ws-handlers/types.ts`. Revisit if the interface grows beyond ~50 methods or if new handler categories emerge.
