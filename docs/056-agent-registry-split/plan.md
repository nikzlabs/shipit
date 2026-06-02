
# 056 — AgentRegistry Placement

## Problem

`AgentRegistry` serves two purposes:

1. **Detection** (orchestrator concern) — scans the system for installed agent CLIs (Claude, Codex), checks auth status, reports capabilities. Called at startup from `index.ts` and refreshed when users authenticate.
2. **Process creation** (session concern) — referenced by `session-worker.ts` when creating agent processes. The session worker uses `AgentRegistry.get(agentId)` to look up the agent definition and spawn the right adapter.

The class straddles both layers.

## Scope

This doc covers AgentRegistry placement. For the broader directory restructure, see [053-server-code-separation](../053-server-code-separation/plan.md).

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

Option A, implemented. The canonical implementation lives in `src/server/shared/agent-registry.ts`. `src/server/session/agents/agent-registry.ts` is a thin re-export shim for backwards compatibility. `orchestrator/index.ts` imports directly from `../shared/agent-registry.js`.

This placement means the orchestrator → session import direction is avoided: both sides import from `shared/`, which is the neutral layer.

## Conflict with 051 (Session Containerization)

**No conflict.** 051's remaining phases (Phase 4 pre-warming, Phase 5 cross-platform validation, post-launch hardening) are entirely about Docker container lifecycle, standby sessions, and security hardening. None of them touch `AgentRegistry` or its placement. The `session-worker.ts` already spawns agents via the adapters in `session/agents/` independently of where `AgentRegistry` lives in the orchestrator layer.
