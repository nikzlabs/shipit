---
status: planned
---

# 105 — Context Window Usage Display

## Summary

Show users how much of Claude's context window the current session is using, with a per-turn cost meter and a hover breakdown (system prompt, tool definitions, chat history, attachments, output). Inspired by Conductor v0.33.0 ("context dial") and v0.36.5 ("tokens and cost below responses").

## Motivation

Today, ShipIt's `UsageManager` tracks per-session cost (`usage.ts`) but the only client-visible surface is the session list footer (if at all). Users hit context-limit errors with no warning, and have no way to make informed decisions about when to start a fresh session, fork the conversation ([095](../095-runner-ctx-simplification/plan.md) referenced patterns), or run `/compact`.

Conductor's design — a small dial near the composer that fills as the context grows, expandable to a full breakdown — is the right primitive. It pays for itself the first time a user avoids a "Prompt is too long" error.

## Design

### Data we already have

Each `agent_result` event from `ClaudeProcess` carries usage info: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. `UsageManager.recordUsage` (`usage.ts`) accumulates per-session totals. Per-turn deltas are not currently kept, but they're trivially derivable.

### What we add

1. **Per-turn usage**: Extend the post-turn flow (`post-turn.ts`) to attach `{ inputTokens, outputTokens, cacheRead, cacheCreate, costUsd }` to each `MessageGroup`. Persisted in chat history.
2. **Running context size**: Sum of input + output across the turn that produced the largest input — that's effectively the "current context size" since Claude re-reads the full chat each turn. Plus we can ask the SDK for `messageCount` and approximate.
3. **Budget**: Per-model max. Default 200_000 for Sonnet 4.6, 1_000_000 for Opus 4.6 in 1M mode. Read from a small `MODEL_CONTEXT_WINDOWS` constant in `src/shared/agent-registry.ts`.

### UI

A compact "context dial" component near the composer footer in `MessageInput.tsx`:

```
[●●●●●●○○○○]  127K / 200K  ·  $1.42
```

- Dial fills from green → yellow (>70%) → red (>90%).
- Click expands a popover showing per-turn breakdown:
  - Cumulative graph (sparkline) of input tokens per turn.
  - Top 3 contributors (longest tool results, biggest attachments) with file paths.
  - Cost split: input $X, output $Y, cache savings $Z.
- "Run /compact" shortcut button at the bottom of the popover (sends a `compact` request to the agent).

### Cost computation

Already in `usage.ts`. Just expose per-turn deltas. Use existing model pricing constants.

### When the user changes models mid-session

The dial re-targets the new model's window immediately. Historic usage is computed at the rate of the model that produced each turn (already tracked).

## Server pieces

- Extend `MessageGroup` with `usage?: { inputTokens, outputTokens, cacheRead, cacheCreate, costUsd, model }`.
- `usage.ts`: add `getPerTurnUsage(sessionId): TurnUsage[]`.
- `chat-history.ts`: include usage in stored groups.
- New WS server message `turn_usage_update` emitted at end of each turn, so multiple viewers update live.

## Client pieces

- New store slice in `session-store.ts`: `turnUsage: Record<sessionId, TurnUsage[]>`.
- New component: `src/client/components/ContextDial.tsx` (the compact + popover combo).
- Mount in `MessageInput.tsx` between the model picker and send button.
- Add a "Compact context" action to the agent that triggers a server-side compact (Claude Code CLI supports `/compact`). New WS client message `compact_context { sessionId }`.

### Compact flow

1. User clicks "Compact context" in dial popover.
2. Client sends `compact_context` WS message.
3. Handler in `ws-handlers/misc-handlers.ts` calls `agent.sendInput("/compact\n")` (Claude Code CLI behavior).
4. CLI replaces in-context history with a summary, emits a normal turn. UI shows a "context compacted" pill above the next message group.

## Tests

`integration_tests/context-usage.test.ts`:

1. Two completed turns → `turn_usage_update` emitted for each → store contains 2 entries.
2. Aggregation matches `UsageManager.getCumulativeUsage`.
3. Reload session → usage persisted in chat history.
4. `compact_context` message → agent receives `/compact` input.

Component test for `ContextDial.tsx`: dial color transitions at 70/90% thresholds.

## Key files

| File | Change |
|---|---|
| `src/shared/types/agent-types.ts` | Add `usage?: TurnUsage` to `MessageGroup` |
| `src/shared/agent-registry.ts` | Add `MODEL_CONTEXT_WINDOWS` constant |
| `src/server/orchestrator/usage.ts` | Per-turn breakdown API |
| `src/server/orchestrator/ws-handlers/post-turn.ts` | Attach usage; emit `turn_usage_update` |
| `src/server/orchestrator/ws-handlers/misc-handlers.ts` | Handle `compact_context` message |
| `src/shared/types/ws-server-messages.ts` | `turn_usage_update` |
| `src/shared/types/ws-client-messages.ts` | `compact_context` |
| `src/client/components/ContextDial.tsx` | New component |
| `src/client/components/MessageInput.tsx` | Mount the dial |
| `src/client/stores/session-store.ts` | `turnUsage` slice |

## Future extensions

- **Auto-compact** — a setting to compact automatically at 90% with a confirmation toast.
- **Per-attachment size warning** — flag pasted text > N tokens at composer time.
- **Cost budgets** — per-session or per-day budget cap with a soft block.
