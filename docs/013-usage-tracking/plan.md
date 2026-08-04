---
issue: https://linear.app/shipit-ai/issue/SHI-201
description: Per-turn API cost/duration/token tracking; stores the per-turn delta of the CLI's cumulative total_cost_usd.
---

# Usage & Cost Tracking

Tracks per-turn API cost, duration, and token usage from agent `result` events.

## How it works

1. A `result` event carries `total_cost_usd` (+ a `usage` token breakdown). The
   orchestrator's agent-listeners path records it via `UsageManager.record()`.
2. Server broadcasts `usage_update` (session totals) and `turn_usage_update`
   (the single turn) to all attached viewers.
3. Client shows a cost badge in the header (e.g. `$0.42`) for the current session.
4. Clicking the badge opens `UsageModal` with the per-session and all-sessions
   breakdown; the ContextDial rehydrates the per-turn series from `/history`.

## The usage modal

A wide (`max-w-3xl`) two-column dialog — the earlier compact `max-w-md` popup
had room for a stat list and little else. Left/right columns carry the session
and all-sessions summaries (each with cost, turns, and an average per turn),
context occupancy, token totals (input/output plus cache read/write when the
turns carry them), the per-turn breakdown, and the session breakdown ordered by
spend. The trend chart spans both columns so its bars stay wide enough to label.

### The trend chart is weekly, not monthly

Buckets are **calendar weeks keyed on the week's Monday** (`YYYY-MM-DD`, UTC).
A monthly bucket only produced a handful of meaningful bars and blurred a spike
into a 30-day average; weeks make a burst of spend visible in the same week it
happened.

- **Bucketing** (`getStats()`): `date(created_at, 'weekday 0', '-6 days')` snaps
  a timestamp to that week's Monday — advance to the coming Sunday, step back
  six days.
- **Gaps are zero-filled** (`fillWeekGaps`) between the first and last active
  week, so an idle week renders as an empty column instead of collapsing the
  axis and putting two non-adjacent weeks side by side.
- **Bounded by the data, not the clock.** The series stops at the last active
  week rather than extending to "now", which keeps `getStats()` free of a
  wall-clock dependency (and its tests deterministic).
- **The window is measured, not fixed.** `WeeklyUsageChart` renders the most
  recent `floor(chartWidth / 44px)` weeks, clamped to 6–20, so the bigger dialog
  shows more history and each bar keeps room for its `$12.34` label. It falls
  back to 12 weeks until measured and wherever `ResizeObserver` is unavailable
  (jsdom), so tests see a stable 12-week window.

## Cost is cumulative at the source — we store the per-turn delta

**Load-bearing semantic.** Each turn is a fresh `claude -p … --resume <sessionId>`
process (`agents/claude/process.ts`), and the CLI's `total_cost_usd` is the
**running total of the entire resumed conversation**, not that turn's cost. A
zero-token no-op turn re-reports the same running total; the total climbs each
turn within one resume chain and **resets** to a small value when the chain
breaks (e.g. an idle container is destroyed and re-cloned, starting a fresh CLI
conversation).

Recording those snapshots verbatim into `cost_usd` and then `SUM(cost_usd)`-ing
them over-counted the session bill **~N×** for N resume chains (a real session
showed `$356.60` for ~`$60` of actual spend). `UsageManager.record()` therefore
converts the cumulative into a per-turn delta before storing:

- `cost_usd` ← `max(0, current − previousCumulativeForThisSession)`. A reset
  (`current < previous`) collapses to treating `current` as a fresh baseline.
- `cumulative_cost_usd` ← the raw snapshot, so the **next** turn can diff against
  it across an orchestrator restart (the baseline is read back from the DB, not
  held in memory).
- The delta baseline is keyed per **ShipIt session** and excludes **sub-agent**
  rows (`sub_agent_id IS NOT NULL`): a one-shot consult (docs/144) already
  reports a per-run cost, is stored verbatim with a null cumulative, and must not
  perturb the primary chain's baseline.
- `record()` returns the computed delta so the live `turn_usage_update` emit
  shows the same figure the DB will rehydrate, not the cumulative snapshot.

Historical rows written before the `cumulative_cost_usd` migration are **not**
backfilled — their `cost_usd` keeps the old cumulative snapshot, so pre-migration
sessions retain their (over-counted) totals; only turns recorded afterward are
exact.

## Storage

- **SQLite** `usage_turns` table (`shared/database.ts`): one row per turn —
  `cost_usd` (the per-turn delta), `cumulative_cost_usd` (raw running total, NULL
  for sub-agent/legacy rows), `duration_ms`, `input/output/cache tokens`,
  `model`, `context_tokens`, `sub_agent_id`.
- `getSessionUsage()` / `getStats()` aggregate with `SUM(cost_usd)`, now correct
  because the column holds deltas.

## Key files

- `src/server/orchestrator/usage.ts` — `UsageManager`: `record` (cumulative→delta),
  `getSessionUsage`, `getPerTurnUsage`, `getStats` (weekly buckets), `delete`;
  plus the `fillWeekGaps` helper.
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — records cost on the
  `result` event; reflects the returned delta onto the live emit.
- `src/server/session/agents/claude/adapter.ts` — maps `total_cost_usd` →
  `event.cost.totalUsd`.
- `src/server/shared/database.ts` — `usage_turns` schema + `cumulative_cost_usd`
  migration.
- `src/client/components/UsageModal.tsx` — usage display modal.
- `src/server/orchestrator/usage.test.ts` — delta/reset/baseline regression suite.
