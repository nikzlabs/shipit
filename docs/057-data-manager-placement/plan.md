---
status: done
---

# 057 — Data Manager Placement (ChatHistory, Threads, Usage)

## Problem

`ChatHistoryManager`, `ThreadManager`, and `UsageManager` are app-wide singletons that organize data per-session. They're created once by the orchestrator at startup and accessed from WS handlers and services.

Today all callers are orchestrator code. The session worker (`session-worker.ts`) does not import any of them. But in a fully containerized architecture, the session container might need to persist chat history or record usage locally.

## Scope

This doc covers the placement of these three data managers. For the broader directory restructure, see [053-server-code-separation](../053-server-code-separation/plan.md).

## Current State

The 053 refactoring places all three in `orchestrator/`. This is correct for today's call-site analysis: every caller is in `ws-handlers/*.ts`, `services/*.ts`, `api-routes.ts`, or `index.ts`. No callers exist in `session/`.

## Callers

**ChatHistoryManager**:
- `ws-handlers/send-message.ts` — `append()` after agent turn
- `ws-handlers/thread-handlers.ts` — `load()` for thread fork/switch, `append()` for replayed messages
- `services/session.ts` — `load()` for session chat history API
- `services/threads.ts` — `load()` for thread checkpoint

**ThreadManager**:
- `ws-handlers/send-message.ts` — `getActiveThread()`, `consumeConversationReplay()`
- `ws-handlers/thread-handlers.ts` — `listThreads()`, `forkThread()`, `switchThread()`, `getCheckpoint()`, `restore()`, `setConversationReplay()`
- `services/threads.ts` — `createCheckpoint()`, `getActiveThread()`, `listThreads()`
- `services/session.ts` — `init()` during session fork
- `index.ts` — `init()` on session creation

**UsageManager**:
- `ws-handlers/send-message.ts` — `record()` after turn, `getSessionUsage()`, `getSessionTokenTotals()` for stats
- `services/misc.ts` — `getStats()`, `clear()` during full reset

## Future Consideration

If session containers need local data persistence (e.g., to survive container restarts without round-tripping to the orchestrator), these managers would move to `shared/` and be instantiated in both layers. But that's a design change, not a file-move — it requires deciding on data ownership and sync strategy.

## Decision

Place in `orchestrator/`. All callers are orchestrator code and no session-layer code imports these managers. Promote to `shared/` only when a concrete containerization requirement demands it.
