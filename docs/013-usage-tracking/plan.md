---
status: done
---
# Usage & Cost Tracking

Tracks per-turn API costs and duration from Claude CLI `result` events.

## How it works

1. When `result` event carries `total_cost_usd`, `UsageManager.recordTurn()` saves cost/duration/timestamp
2. Server broadcasts `usage_update` with session totals to all clients
3. Client shows cost badge in header (e.g. `$0.42`) for current session
4. Clicking badge opens `UsageModal` with per-session and all-sessions breakdown

## Storage

- **Location**: `/workspace/.shipit-usage.json`
- **Format**: JSON with per-session arrays of `{ costUsd, durationMs, timestamp }`
- Handles `total_cost_usd` being `undefined` (older CLI) and `0` gracefully
- Corruption recovery: resets to empty on invalid JSON

## Key files

- `src/server/usage.ts` — `UsageManager` class: recordTurn, getSessionUsage, getAllUsage, deleteSession
- `src/server/index.ts` — Records cost on `result` event, handles `get_usage_stats`
- `src/server/types.ts` — `WsGetUsageStats`, `WsUsageStats`, `WsUsageUpdate` messages
- `src/client/components/UsageModal.tsx` — Usage display modal
- `src/client/App.tsx` — Cost badge, usage state
