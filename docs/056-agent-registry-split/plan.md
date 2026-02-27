---
status: paused
---

# 056 — AgentRegistry Placement

## Problem

`AgentRegistry` serves two purposes:

1. **Detection** (orchestrator concern) — scans the system for installed agent CLIs (Claude, Codex), checks auth status, reports capabilities. Called at startup from `index.ts` and refreshed when users authenticate.
2. **Process creation** (session concern) — referenced by `session-worker.ts` when creating agent processes. The session worker uses `AgentRegistry.get(agentId)` to look up the agent definition and spawn the right adapter.

The class straddles both layers.

## Scope

This doc covers AgentRegistry placement. For the broader directory restructure, see [053-server-code-separation](../053-server-code-separation/plan.md).

## Current State

The 053 refactoring moves the entire `agents/` directory to `session/agents/`. The orchestrator imports `AgentRegistry` from `session/agents/agent-registry.ts` for the detection step at startup. This means the orchestrator imports a class from the session layer — the reverse of the usual dependency direction.

## Possible Directions

### Option A: Keep in session (current plan)

`AgentRegistry` lives in `session/agents/` alongside the adapters it manages. The orchestrator imports it for detection. The dependency direction is orchestrator → session, which is consistent with how `SessionRunnerInterface` already imports session types.

**Tradeoff**: Conceptually, "what agents are installed?" is an orchestrator question, not a session question.

### Option B: Split into two parts

- `shared/types/agent-types.ts` — already has the `AgentId`, `AgentInfo`, `AgentCapabilities` types
- `orchestrator/agent-detection.ts` — the detection/auth-refresh logic (reads filesystem, checks CLI versions)
- `session/agents/agent-registry.ts` — the process creation logic (maps `AgentId` → adapter factory)

**Tradeoff**: More files, but each has a single concern and lives in the right layer.

### Option C: Move entirely to orchestrator

The registry is a lookup table. The session worker could receive agent config via its initialization params instead of importing the registry.

**Tradeoff**: Requires changing the session worker's init protocol.

## Decision

Option A for now. The orchestrator → session direction for type/class imports is already established. If agent detection grows complex (e.g., remote agent discovery), revisit with Option B.
