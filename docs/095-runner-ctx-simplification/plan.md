---
status: done
---
# 095 — Runner Context Simplification

## Summary

Remove the per-connection runner-state setters and getters from `RunnerCtx`. Replace them with direct mutation of a runner reference resolved from the registry. The bug class fixed in feature 094-merge-conflicts (cont'd) — silent state-mutation failures after WebSocket disconnect — was made possible by the existence of `ctx.setIsClaudeRunning`, `ctx.setTurnSummary`, etc. Deleting them makes the bug class structurally impossible.

## Motivation

The current `RunnerCtx` interface exposes ~15 setters/getters that delegate to a per-connection `attachedRunner`:

```ts
setIsClaudeRunning: (v: boolean) => void;
setTurnSummary: (s: string) => void;
setAccumulatedText: (s: string) => void;
// ... etc
```

Each implementation is `(v) => { if (attachedRunner) runner.X = v; }`. When the WebSocket disconnects, `attachedRunner` becomes `null` and every setter silently no-ops. Any code in an async closure (`agent.on("done", ...)`, recursive turn drains, post-turn commits) that tried to update runner state would have its update vanish. We've now seen at least four production bugs of exactly this shape:

1. `runner.running` stranded as `true` after WS disconnect mid-turn.
2. Queue-drained turns starting with stale accumulated state.
3. Post-turn commit messages defaulting to `"Agent turn"` because `ctx.getTurnSummary()` returned `""`.
4. Post-turn events (`git_committed`, PR cards) lost to all viewers because `ctx.send()` no-ops on closed sockets.

The previous fix (resilient setters that fall back to `runnerRegistry.get(sessionId)`) addresses the immediate failure mode but leaves the foot-gun in place. A future contributor writing `ctx.setX(...)` inside an async closure won't know they need to think about WS lifetime — and the next bug only appears when the registry lookup also fails (e.g., session archived mid-turn).

The right long-term fix is to remove the setters entirely. If the only way to mutate runner state is `runner.X = ...`, then:
- The author has to obtain a runner reference explicitly (forces them to think about lifetime).
- The natural pattern — capture `runner` once at function entry — is also the correct pattern.
- Reading the code, you can grep for `runner.running = …` and find every state mutation in one shot.

## Design

### Target shape of `RunnerCtx`

```ts
export interface RunnerCtx {
  // Agent factory (delegates to runner.createAgent if available)
  agentFactory: (agentId: AgentId) => AgentProcess;

  // Per-connection identifiers — these don't depend on runner state
  getActiveAgentId: () => AgentId;
  setActiveAgentId: (id: AgentId) => void;
  getSelectedModel: () => string | undefined;
  setSelectedModel: (m: string | undefined) => void;

  // Runner lookup — the ONLY supported way to access runner state
  /** Get the runner attached to this connection (if any). Prefer registry lookup. */
  getRunner: () => SessionRunnerInterface | null;
  /** Get the app-level runner registry. THE preferred resolver. */
  getRunnerRegistry: () => SessionRunnerRegistry;
  /** Attach this connection to a runner (detaches previous). */
  attachToRunner: (runner: SessionRunnerInterface) => void;
  /** Detach this connection from its current runner. */
  detachFromRunner: () => void;
}
```

Everything else — `setIsClaudeRunning`, `setTurnSummary`, `setAccumulatedText`, `setAccumulatedToolUse`, `setChatMessageGroups`, `setNeedsNewMessageGroup`, `setWasInterrupted`, `setAgent`, `setTerminal`, `clearMessageQueue`, and their getters — is removed.

### Caller pattern

Every handler that previously used `ctx.setX(...)` is rewritten to capture the runner once at entry:

```ts
export async function handleSendMessage(ctx: FullCtx, msg: WsSendMessage) {
  const sessionId = ctx.getActiveAppSessionId();
  if (!sessionId) { ctx.send({ type: "error", message: "No active session" }); return; }
  const runner = ctx.getRunnerRegistry().get(sessionId) ?? ctx.getRunner();
  if (!runner) { ctx.send({ type: "error", message: "Session not found" }); return; }

  // From here on, every state mutation is `runner.X = ...`.
  runner.running = true;
  runner.turnSummary = "";
  // ...
}
```

For long-running async closures, the runner reference is captured at the OUTER function scope, not re-fetched inside the closure:

```ts
runClaudeWithMessage(ctx, opts) {
  const runner = /* registry-resolved at top */;

  currentAgent.on("done", () => {
    // Use the captured `runner` directly — no ctx access.
    if (runner) runner.running = false;
  });
}
```

### Migration steps

1. **Add a runner-resolution helper**. Either a free function `resolveRunner(ctx, sessionId)` or just inline the pattern. Use it consistently.

2. **Refactor `send-message.ts`**. Replace every `ctx.setX(...)` with `runner.X = ...`. Replace every `ctx.getX()` with `runner.X` (or local variable). Replace `ctx.setIsClaudeRunning(true)` with `runner.running = true`. The handler's outer scope captures `runner` once.

3. **Refactor `claude-execution.ts`** (`runClaudeWithMessage`). Already partially done — the outer captures `runner` via registry. Replace remaining `ctx.setX(...)` calls.

4. **Refactor `agent-listeners.ts`**. The captured `runner` from `wireAgentListeners` is already the right pattern; remove any remaining `ctx.setX(...)` inside the listeners.

5. **Refactor remaining handlers** (`misc-handlers.ts`, `terminal-handlers.ts`, `rollback-handlers.ts`, `service-handlers.ts`, `rewind-handlers.ts`). Most don't use the setters but a few read `ctx.getMessageQueue()` etc.

6. **Remove the deprecated setters from `RunnerCtx` (types.ts) and from the ctx-construction site in `index.ts`**. Compilation errors at this step pinpoint any remaining call sites.

7. **Drop the `withRunner` / `reportDetachedAccess` scaffolding from `index.ts`**. Once the setters are gone, that scaffolding has no purpose.

8. **Update tests**. Test code that called `ctx.setX(...)` (none in production handlers; some in tests) gets the same treatment.

### Backwards compatibility / risk

- All public WS message types stay identical. This is a pure server-internal refactor.
- The migration is mechanical. Each step compiles independently, so it can be split across multiple commits.
- The resilient `withRunner` setters added in the prior round are the safety net during the transition: if any caller is missed, behavior remains correct (fallback through registry) and tests fail loudly under VITEST.

## Key files

| File | Role |
|---|---|
| `src/server/orchestrator/ws-handlers/types.ts` | `RunnerCtx` definition — fields removed |
| `src/server/orchestrator/index.ts` | Ctx construction — setter implementations removed |
| `src/server/orchestrator/ws-handlers/send-message.ts` | Largest consumer — full rewrite |
| `src/server/orchestrator/ws-handlers/claude-execution.ts` | Long-running turn — capture runner at entry |
| `src/server/orchestrator/ws-handlers/agent-listeners.ts` | Captures runner already; remove residual ctx access |
| `src/server/orchestrator/ws-handlers/misc-handlers.ts` | Minor consumer |

## Patterns reinforced

- **Capture runner at entry.** Long-running functions get `const runner = …` at the top.
- **Registry-first resolution.** `ctx.getRunnerRegistry().get(capturedSessionId) ?? ctx.getRunner()`. The `?? ctx.getRunner()` only matters during the warm-pool/standby window; production hits the registry lookup.
- **Mutate the runner directly.** `runner.running = false`, `runner.emitMessage(...)`, etc.
- **Never re-fetch in async closures.** No `ctx.getRunner()` inside `agent.on(...)` / `setTimeout` / recursive calls — always use the captured reference.

## Out of scope

- Reorganizing `ChatMessageGroup` shape or `accumulatedToolUse` — separate concern.
- Splitting `RunnerCtx` further (e.g., `MessageQueueCtx`) — only if it falls out naturally.
- Replacing `ctx.send()` with `runner.emitMessage()` everywhere — already covered by the agent-listeners pattern; do it opportunistically as files are touched.
