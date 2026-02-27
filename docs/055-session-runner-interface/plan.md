---
status: paused
---

# 055 — SessionRunner Interface Boundary

## Problem

`SessionRunnerInterface` lives in the orchestrator (`session-runner.ts`) but references session-layer types: `AgentProcess`, `AgentRunParams`, `AgentEvent` (from `agents/agent-process.ts`), `TerminalProcess` (from `terminal.ts`), and `WsServerMessage` (from `types/`).

Two implementations exist:
- **`SessionRunner`** — in-process, used in test/dev mode. Directly creates session-layer objects (agents, terminals, file watchers).
- **`ContainerSessionRunner`** — proxy to a Docker container. Communicates via HTTP/SSE, never instantiates session-layer objects directly.

The interface must know the *shape* of session-layer objects (for `SessionRunner`), but the proxy implementation only needs serializable messages.

## Scope

This doc covers the SessionRunnerInterface type boundary. For the broader directory restructure, see [053-server-code-separation](../053-server-code-separation/plan.md).

## Current State

The 053 refactoring keeps `SessionRunnerInterface` in `orchestrator/session-runner.ts`. It imports types from `session/agents/agent-process.ts` and `session/terminal.ts`. This creates a one-directional dependency: orchestrator → session (types only). This is acceptable — the orchestrator needs to know the shape of what it's managing.

## Possible Directions

### Option A: Extract interface types to shared

Move the types that `SessionRunnerInterface` depends on (`AgentProcess`, `AgentRunParams`, `AgentEvent`) to `shared/types/`. This removes the orchestrator → session import for types.

**Tradeoff**: Bloats `shared/types/` with types that only exist to satisfy one interface boundary.

### Option B: Define abstract interface types in orchestrator

The orchestrator defines its own `RunnerAgent`, `RunnerTerminal` interfaces that describe what the orchestrator needs. Session-layer classes implement these interfaces. The orchestrator never imports from `session/` directly.

**Tradeoff**: Adds indirection. Two parallel type hierarchies.

### Option C: Keep as-is

The current orchestrator → session type imports are fine. They're type-only imports (erased at runtime), the dependency direction is consistent (orchestrator depends on session types, not vice versa), and TypeScript enforces that session code can't import from orchestrator.

## Decision

Keep as-is (Option C). Type-only imports from orchestrator → session are acceptable. The important invariant is that session code never imports orchestrator code, and the directory structure enforces that. Revisit if the interface boundary becomes a build-time concern (e.g., separate packages).
