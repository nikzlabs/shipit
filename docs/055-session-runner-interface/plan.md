
# 055 — SessionRunner Interface Boundary

## Problem

`SessionRunnerInterface` lives in the orchestrator (`session-runner.ts`) but originally referenced session-layer types directly: `AgentProcess`, `AgentRunParams`, `AgentEvent` (from `agents/agent-process.ts`), `TerminalProcess` (from `terminal.ts`), and `WsServerMessage` (from `types/`).

## Resolution

The 053 server code separation moved the shared interface types (`AgentProcess`, `AgentId`, `TerminalProcess`, etc.) into `shared/types/`. The orchestrator now imports these from `shared/types.js` — no cross-layer imports remain.

An ESLint `no-restricted-imports` rule enforces the boundary: orchestrator and session cannot import from each other, even type-only imports. Integration tests are excluded since they deliberately cross the boundary to test session-worker IPC.
