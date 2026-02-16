# Design Doc 001: Usage & Cost Tracking Dashboard

## Status: Proposed

## Problem

ShipIt users have zero visibility into how much they are spending on Claude API calls. The `ClaudeResultEvent` already carries `total_cost_usd` and `duration_ms` in every result event, but both fields are completely ignored by the server and client. Users operating in a pay-per-use environment need cost awareness to avoid surprise bills and to optimize their prompting strategies.

## Goals

1. Track per-turn cost and duration from every Claude result event.
2. Aggregate usage at the session level and across all sessions.
3. Display usage data in a persistent, always-accessible UI element.
4. Persist usage data to disk so it survives server restarts.

## Non-Goals

- Token-level breakdown (input vs. output tokens) — Claude CLI does not expose this.
- Budget limits or spending caps — can be layered on later.
- Historical trends or charts — v1 is a simple summary view.

## Design

### Data Model

```typescript
// src/server/types.ts — new types

interface UsageTurn {
  sessionId: string;
  costUsd: number;
  durationMs: number;
  timestamp: string;
}

interface SessionUsage {
  sessionId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  turnCount: number;
}

interface UsageStats {
  sessions: SessionUsage[];
  totalCostUsd: number;
  totalTurns: number;
}
```

### Server Changes

#### New: `UsageManager` class (`src/server/usage.ts`)

- Persists usage data to `/workspace/.shipit-usage.json`.
- `record(sessionId, costUsd, durationMs)` — appends a turn record, updates session aggregate.
- `getStats(): UsageStats` — returns aggregated usage across all sessions.
- `getSessionUsage(sessionId): SessionUsage | undefined` — returns usage for one session.
- `delete(sessionId)` — removes usage data when a session is deleted.

#### `index.ts` changes

1. In the `claude.on("event")` handler, when `event.type === "result"`:
   ```typescript
   if (event.total_cost_usd !== undefined) {
     usageManager.record(
       event.session_id,
       event.total_cost_usd,
       event.duration_ms ?? 0
     );
   }
   ```

2. Include cost/duration in the `claude_event` relay (already relayed — no change needed).

3. After recording, broadcast the updated session usage to the client:
   ```typescript
   send({
     type: "usage_update",
     sessionId: event.session_id,
     ...usageManager.getSessionUsage(event.session_id),
   });
   ```

#### New WebSocket messages

| Direction | Type | Payload |
|-----------|------|---------|
| Client → Server | `get_usage_stats` | (none) |
| Server → Client | `usage_stats` | `UsageStats` object |
| Server → Client | `usage_update` | `SessionUsage` for the current session (sent after each turn) |

### Client Changes

#### State additions in `App.tsx`

```typescript
const [currentSessionUsage, setCurrentSessionUsage] = useState<SessionUsage | null>(null);
```

#### Message handler additions

- On `usage_update`: update `currentSessionUsage` state.
- On `usage_stats`: populate full usage view (when the user opens a usage panel/modal).

#### UI: Cost indicator in header

A small cost badge in the header, next to the connection status pill:

```
[ShipIt] [session dropdown]              [$0.42] [preview :5173] [open]
```

- Shows the current session's cumulative cost.
- Formatted as `$X.XX` (or `$X.XXX` for sub-cent amounts).
- Clicking opens a modal/dropdown with full usage breakdown.

#### UI: Usage detail modal (triggered by clicking cost badge)

```
┌──────────────────────────────────────┐
│  Usage Summary                    ✕  │
│                                      │
│  This session                        │
│  Cost:     $0.42                     │
│  Turns:    7                         │
│  Duration: 3m 12s                    │
│                                      │
│  All sessions                        │
│  Cost:     $2.18                     │
│  Turns:    34                        │
│                                      │
│  Recent sessions                     │
│  ┌────────────────────────┬───────┐  │
│  │ Build landing page     │ $0.83 │  │
│  │ Fix API routes         │ $0.42 │  │
│  │ Add auth               │ $0.93 │  │
│  └────────────────────────┴───────┘  │
└──────────────────────────────────────┘
```

### Dependency Injection

`UsageManager` is added to `AppDeps`:

```typescript
export interface AppDeps {
  // ... existing fields
  usageManager?: UsageManager;
}
```

Tests inject a `UsageManager` pointed at a temp directory.

### File Layout

| File | Change |
|------|--------|
| `src/server/usage.ts` | New — `UsageManager` class |
| `src/server/usage.test.ts` | New — unit tests |
| `src/server/types.ts` | Add message types |
| `src/server/index.ts` | Wire up `UsageManager`, record on result, handle `get_usage_stats` |
| `src/server/integration.test.ts` | Add happy-path + error-path tests for `get_usage_stats` |
| `src/client/App.tsx` | Add state, message handler, cost badge |
| `src/client/components/UsageModal.tsx` | New — usage detail modal |
| `src/client/components/UsageModal.test.tsx` | New — component tests |

### Quality Checklist

- [x] Input validation: `get_usage_stats` has no user-supplied parameters. Cost values come from Claude CLI (trusted source).
- [ ] Component tests: `UsageModal.test.tsx` — render with zero usage, render with multiple sessions, click to close.
- [ ] Integration tests: send a message, verify `usage_update` is received with cost data.
- [ ] Edge cases: handle `total_cost_usd` being `undefined` (older CLI versions), handle `0` cost gracefully.
