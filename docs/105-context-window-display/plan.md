---
status: done
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
- When the dial is yellow/red, the popover shows a hint: *"Type `/compact` in the composer to summarize history and free up context."* No button — `/compact` is a slash command the user types in chat (per CLAUDE.md §5: user-driven tasks happen in chat, not via quick-action buttons).

### Cost computation

Already in `usage.ts`. Just expose per-turn deltas. Use existing model pricing constants.

### When the user changes models mid-session

The dial re-targets the new model's window immediately. Historic usage is computed at the rate of the model that produced each turn (already tracked).

## Server pieces

- `usage.ts`: `getPerTurnUsage(sessionId): TurnUsage[]` — canonical per-turn store, sourced from the `usage_turns` table.
- `usage.ts`: `getSessionTokenTotals` returns cumulative input *and* output. The `usage_update` WS message includes both.
- New WS server message `turn_usage_update` emitted at end of each turn, so multiple viewers update live.
- `GET /api/sessions/:id/history` returns `{ turnUsage, sessionUsage, cumulativeInputTokens, cumulativeOutputTokens }` so the dial rehydrates from the canonical store on session attach (not from per-message embedded `turnUsage`, which used to live on `MessageGroup` but was an inconsistent secondary source — see "Cost-display unification" below).

## Client pieces

- New store slice in `session-store.ts`: `turnUsage: Record<sessionId, TurnUsage[]>`.
- New component: `src/client/components/ContextDial.tsx` (the compact + popover combo).
- Mount in `MessageInput.tsx` between the model picker and send button.

### Compaction is user-typed, not button-driven

Claude Code already accepts `/compact` as a chat input. The composer routes slash-prefixed messages straight to the agent. This feature does **not** add a button or WS message to invoke compaction — that would be a shell-shaped affordance (CLAUDE.md §5). Instead:

1. User types `/compact` in the composer.
2. The composer (existing path) sends it to the agent like any other message.
3. CLI replaces in-context history with a summary, emits a normal turn.
4. The dial detects the drop in token usage on the next `turn_usage_update` and shows a small "context compacted" pill above the next message group.

The dial's job is purely to **inform**: it surfaces enough state for the user to decide whether to run `/compact`, and the chat composer is where they act on that decision.

## Tests

`integration_tests/context-usage.test.ts`:

1. Two completed turns → `turn_usage_update` emitted for each → store contains 2 entries.
2. Aggregation matches `UsageManager.getCumulativeUsage`.
3. Reload session → usage persisted in chat history.
4. After a turn whose input tokens drop sharply (a `/compact` user message), the dial reflects the lower value and the "context compacted" pill renders above the next group.

Component test for `ContextDial.tsx`: dial color transitions at 70/90% thresholds.

## Key files

| File | Change |
|---|---|
| `src/shared/types/agent-types.ts` | Add `usage?: TurnUsage` to `MessageGroup` |
| `src/shared/agent-registry.ts` | Add `MODEL_CONTEXT_WINDOWS` constant |
| `src/server/orchestrator/usage.ts` | Per-turn breakdown API |
| `src/server/orchestrator/ws-handlers/post-turn.ts` | Attach usage; emit `turn_usage_update` |
| `src/shared/types/ws-server-messages.ts` | `turn_usage_update` |
| `src/client/components/ContextDial.tsx` | New component |
| `src/client/components/MessageInput.tsx` | Mount the dial |
| `src/client/stores/session-store.ts` | `turnUsage` slice |

## Cost-display unification

The original design used two cost surfaces in parallel:

1. A **session-cost pill** in the composer toolbar driven from `currentSessionUsage.totalCostUsd` (= `UsageManager.getSessionUsage()` → `usage_update` WS message). Authoritative.
2. The dial popover's **"Total cost" row**, computed by summing `costUsd` across whatever `turnUsage` entries the client had observed in this WS connection. Often **less** than the pill because it didn't see turns from before the connection or from outside chat-history.

This shipped a visible $1.31 vs $5.41-style discrepancy. The fix collapses the two into a single surface on the dial:

- The dial's trigger button shows the running session cost next to the K-token reading (`[icon] [K-tokens] [$cost]`).
- The popover's "Total cost" row reads from `currentSessionUsage` (authoritative) and is wired to open the existing `UsageModal`.
- The standalone cost pill, the `showSessionCost` setting, and its localStorage key were removed.
- `turnUsage` rehydration moved from "attach to the last message group of each turn in chat history" to "fetch from `/api/sessions/:id/history` (sourced from `usage_turns`)". `PersistedMessage.turnUsage` and `WsChatHistoryMessage.turnUsage` are gone; the `messages.turn_usage` SQLite column stays (read-only) for back-compat.

## Context occupancy includes cache tokens

The dial originally read the "current context size" straight off `TurnUsage.inputTokens`. That was wrong under prompt caching (the default for Claude Code): the CLI reports `input_tokens` as **only the uncached** portion of the prompt, so a turn that actually occupies ~70K of the window can report `inputTokens: 4` while the rest shows up as `cache_read_input_tokens` / `cache_creation_input_tokens`. The dial displayed "Context: 4 / 200K".

Fix: a shared `turnContextTokens(turn)` helper in `usage-types.ts` returns `inputTokens + cacheRead + cacheCreate` — the real context-window occupancy. Every "context size" surface now goes through it:

- `ContextDial` — the dial reading, fill %, level color, sparkline scaling, `wasCompacted()` detection, and the "Largest turns" rows (now sorted by, and labelled with, context occupancy).
- `useMessageHandler` — the `turn_usage_update` handler sets the UI store's `contextTokens` from `turnContextTokens(turn)` (drives the status-bar meter and usage modal).
- `session-data.ts` — rehydration on session attach uses `turnContextTokens()` for the last turn.

`inputTokens` alone is still used where it's genuinely wanted (the popover's "Input tokens" total, the usage modal's "Token totals" → Input row).

## Multi-call turns: use the last iteration, not the sum

The naive `inputTokens + cacheRead + cacheCreate` sum was correct for single-call turns, but wrong by an N× factor for **multi-call (tool-use) turns**. The Claude CLI's top-level `result.usage.cache_read_input_tokens` is the SUM across every API round-trip in the turn, so a turn with 10 tool calls reports ~10× the actual context — surfaced in the wild as "Context: 573.4K / 200K" for a single tool-heavy turn.

The CLI exposes the per-iteration breakdown in `result.usage.iterations[]` (added to `ClaudeResultEvent` in `claude-types.ts`). The LAST iteration's `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` is the true context-window occupancy at turn end.

Plumbed end-to-end:

- `claude-adapter.ts` extracts `contextTokens` from the last entry of `usage.iterations` and emits it on `AgentResultEvent.contextTokens`.
- `agent-listeners.ts` passes `contextTokens` into `UsageManager.record()` and the `turn_usage_update` payload.
- New `context_tokens` column on `usage_turns` (migration 12) so the value is persisted and rehydrated by `/api/sessions/:id/history`.
- `turnContextTokens()` prefers the explicit `turn.contextTokens` when present and falls back to the cache-sum for legacy rows. All call sites (`ContextDial`, `useMessageHandler`, `session-data`) inherit the fix transparently.
- `tokens.cacheRead` / `tokens.cacheWrite` on `AgentResultEvent` keep their existing meaning (turn-wide sums) and continue to drive cost/billing rollups — only the dial's "current context size" reading switched to the last-iteration value.

## Authoritative context window from `result.modelUsage.contextWindow`

The original implementation derived the context window from a static `MODEL_CONTEXT_WINDOWS` map keyed by substring. That's brittle: Claude Opus 4.7 ships with a 1M window, but the map's `"opus": 200_000` entry beat any future-model substring and pinned the dial at 200K. The Claude CLI already reports the real window in `result.modelUsage.<model>.contextWindow` — that's now the source of truth.

- `ClaudeResultEvent.modelUsage` and `ClaudeModelUsage` types added to `claude-types.ts`.
- `claude-adapter.ts` extracts the largest `contextWindow` reported across models in the turn (handles mid-turn model switches by keeping the more permissive value).
- `agent-listeners.ts` re-emits `model_info` with the authoritative `contextWindowTokens` from the result event, overriding whatever the static map produced on `agent_init`.
- The static map is still used (a) for the first frame before `result` arrives, and (b) for adapters that can't surface the field. `"claude-opus-4-7": 1_000_000` was added so even the first-frame fallback is correct.

## Future extensions

- **Auto-compact** — a setting that, on reaching 90%, has the agent itself proactively run a compaction during its next turn (agent-driven, not a UI button).
- **Per-attachment size warning** — flag pasted text > N tokens at composer time.
- **Cost budgets** — per-session or per-day budget cap with a soft block.
