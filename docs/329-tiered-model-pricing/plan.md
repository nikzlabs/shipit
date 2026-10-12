---
issue: planning#690
title: Tier-aware model pricing — design
description: A long-prompt rate on the catalogue price, per-request pricing where harnesses report it, and a stored at-API-rates cost per turn.
---

# Tier-aware model pricing — design

Implements [requirements.md](requirements.md).

## Where catalogue rates are used today

`ModelPrice` (`src/server/shared/catalogue/types.ts`) is one flat rate per model.
`costFromRates` (`src/server/orchestrator/turn-attribution.ts`) multiplies it by a
turn's token totals, in four places:

| Use | Where | When |
|---|---|---|
| Spend of an API-key turn that ShipIt prices itself (the harness is not on its native service, or reports no cost) | `resolveTurnCost` | turn end; stored in `usage_turns.cost_usd` |
| "At API rates" for a subscription turn, live | `agent-listeners.ts` (`perTurnUsage.atApiRatesUsd`) | turn end; not stored |
| "At API rates" per usage group and per week | `usage.ts` `foldSplitRows` | every read, from the stored rate columns × summed tokens |
| "At API rates" per turn in a session's list | `usage.ts` `applyAttribution` | every read, same |

Only the first is stored as money. The other three recompute from
`rate_*` × token totals, which cannot express a per-request tier: two turns with the
same totals can owe different amounts. That is the one structural change below.

When the harness reports its own cost on its native service (Claude Code on an
Anthropic API key), `resolveTurnCost` keeps that figure. The CLI knows its vendor's
tiers, so nothing changes there.

## Design

### 1. The catalogue carries one long-prompt tier (req 3)

```ts
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Every rate for a request whose prompt is above `aboveTokens`. */
  longPrompt?: { aboveTokens: number; input: number; output: number; cacheRead: number; cacheWrite: number };
}
```

- Full rates, not a multiplier: Gemini 3.1 Pro's tier is 2× input but 1.5× output.
- One tier, not a list: every published case today has exactly one step. A list
  is a later, compatible widening if a vendor publishes two.
- The prompt is the request's input + cache read + cache write tokens, and the
  whole request, output included, takes the higher rates. That is the usual shape
  of a long-context price, but confirm it on each vendor page when entering the
  rates (and record the date in the existing provenance comment); a vendor that
  differs needs this definition widened before its row gets a tier.
- Rows: Haiku 5.5 (above 100K, every rate 5×), Gemini 3.1 Pro (above 200K), the
  xAI Grok rows (above 200K, every rate 2×). The comments that now say "excludes
  the tier" are replaced by the data. A gateway row (OpenCode Zen, Vercel) keeps
  the gateway's own published price and gets a tier only if the gateway publishes
  one.

**Published list (docs/318-remote-model-list).** `price` is spread whole into
`models.json`, so `longPrompt` publishes without export changes. An install
older than this change reads the list with a `parsePrice` that keeps only the four
flat fields, so it keeps working with the lower tier — no compatibility shim.
The new `parsePrice` accepts `longPrompt` when present and treats a malformed one
as a bad price, the same as a malformed flat rate.

### 2. Per-request usage reaches the orchestrator (req 4)

`AgentResultEvent` (`src/server/shared/types/agent-types.ts`) gains an optional
`requests` list: one entry per model call, each with its input, cache read and
cache write tokens, and its output tokens where the harness reports them final.
The turn-wide `tokens` stay the billing totals. Every harness already reports
per-request usage; no adapter forwards it today (see "Per-harness sources").

`costFromRates(price, { tokens, requests?, contextTokens? })` (`PricedUsage`) then:

- no `longPrompt` → today's formula on the totals (unchanged for every other model);
- otherwise each listed request is priced at the tier its own prompt (input +
  cache read + cache write) selects — exact, req 4;
- whatever the totals hold beyond the listed requests, per field and floored at
  zero (output a harness does not report per request, requests it does not list,
  or the whole turn when there is no list), is priced with the estimate req 4
  allows: the tier the turn's `contextTokens` (the last request's prompt size)
  selects. The context grows through a turn, so the last request is normally its
  largest. With no `contextTokens` either, the lower tier is used, as today.

One rule covers every harness, including a partial list, so no harness needs a
special case in the pricing. The list is used at turn end and is not stored.
`resolveTurnCost` takes the same `PricedUsage`, so a metered turn ShipIt prices
itself gets the tiers too.

The list is only as good as the adapter's bookkeeping, so each adapter lists every
request of **this** turn exactly once: Claude dedupes by `message.id`, Codex skips
the resume replay `codex-rate-limits.ts` already baselines away and any snapshot
whose total did not grow (Codex 0.159.2 resends its usage on every rate-limit
update, even under the next turn's id), Antigravity takes
a step's usage once although it repeats across ACTIVE/DONE updates. The flooring
above keeps a slip from producing a negative remainder; a test per adapter checks
that its list sums to no more than its totals.

**OpenCode reasoning tokens.** Its fields are disjoint (docs/268-opencode-harness
plan), and `OpencodeTurnAccumulator` adds `input`/`output` but drops `reasoning`
from output while counting it into `contextTokens`. So ShipIt's own pricing of an
OpenCode turn never bills reasoning today. Reasoning becomes output — in each
request entry and in the totals — and leaves the prompt size, or exact per-request
pricing would disagree with the totals the remainder is taken from. This also
corrects OpenCode turns on flat-priced models.

### 3. Every subscription row stores its at-API-rates cost (req 2, req 5)

New nullable column `usage_turns.at_api_rates_usd`. `UsageManager.record` computes
it for every subscription row with `atApiRatesFor(attribution, usage)` from the
attribution's rates and the usage it is given — tokens, `requests`,
`contextTokens` — so the three writers (turns in `agent-listeners.ts`, consults
in `services/sub-agent.ts`, background work in `services/non-turn-work.ts`)
cannot diverge, and the live figure in `agent-listeners.ts` comes from the same
function with the same inputs.

A migration (`AT_API_RATES_MIGRATION`) backfills the column for existing
subscription rows from their stored flat rates and token totals — exactly the figure those rows show today — so past
turns keep their recorded cost (req 5). The read paths in `usage.ts` then sum the
column, and the rate columns leave the usage `SELECT`/`GROUP BY`: `foldSplitRows`
already keys groups by service, billing mode and scope only, so splitting by rate
existed only to recompute the cost. The `rate_*` columns stay in the table as the
turn's price record.

### 4. The Supported models dialog shows the tier (req 6)

`SupportedModelsDialog.tsx` keeps the "$in / $out" cell and adds the tier under it
in the tertiary text colour:

- every rate the same multiple of the flat rate → "5× above 100K";
- otherwise the higher input / output rates → "$4 / $18 above 200K".

The Usage dialog needs no change: it shows sums, which become correct.

## Per-harness sources

Surveyed 2026-10-12. Each adapter today sums these into `tokens` and keeps only the
last request's prompt size as `contextTokens`.

| Harness | Per-request source | What it gives |
|---|---|---|
| Claude Code | `assistant` events' `message.usage`, several per call: dedupe by `message.id` | Input, cache read, cache write exact. Output is the start-of-call value (1), not final — probe 2026-10-12, CLI 2.1.284: two calls' prompt fields summed exactly to `result.usage`, output did not. Sub-agent calls are not listed. `result.usage.iterations` is NOT a per-request list: it describes the last call only. |
| Codex | `thread/tokenUsage/updated` → `tokenUsage.last`, one per response | Full breakdown; `inputTokens` includes both cache portions (`disjointCodexTokens` splits them). ShipIt types `last` as `{ totalTokens }` only today. |
| OpenCode | each `step_finish` `part.tokens` | Input, output, reasoning, cache read, cache write, disjoint (reasoning: see above). |
| Grok | top-level `assistant` events' `message.usage` | Input, output, cache read, cache write; the fixture's per-call usages sum exactly to `result.usage`. |
| Antigravity | `step_update.usage` on `agent_response` steps | Input, output (thinking included), cache read; no cache write. |

So Claude turns price the prompt side exactly and the output with the estimate;
the other four price every listed request exactly.

Consults and harness background work run the same adapters, so
`runAgentToCompletion` (`shared/sub-agent-run.ts`) keeps the list on
`SubAgentRunResult` and both pass it on. A direct provider call
(`runNonTurnDirect`) is one request, so it passes its usage as a one-entry list
(`oneRequest` in `services/non-turn-work.ts`). Session naming parses each CLI's
totals itself and makes one tool-less request, so it does the same. `NonTurnTelemetry` gains the optional list and `contextTokens`: a harness run
on Claude lists no output per call, so its output is priced at the tier the
last prompt selects, as for a turn.

## Docs to update with the code

- `src/server/shipit-docs/wiki/settings-and-accounts.md` (Usage dialog, "at API
  rates") and `wiki/chat.md`: at-API-rates figures price long prompts at the
  vendor's long-prompt rate.
- `docs/252-custom-models/plan.md`: the Haiku 5.5 note's "stores the lower tier"
  line points here.

## Key files

- `src/server/shared/catalogue/types.ts`, `services.ts`, `model-list.ts` — the tier and its rates
- `src/server/orchestrator/turn-attribution.ts` — `costFromRates`
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — turn-end pricing
- `src/server/orchestrator/usage.ts`, `src/server/shared/database.ts` — the stored column and migration
- `src/server/orchestrator/services/sub-agent.ts`, `services/non-turn-work.ts`, `src/server/shared/sub-agent-run.ts` — the list for consults and background work
- `src/server/session/agents/*/adapter.ts`, `src/server/shared/opencode-stream.ts` — per-request usage on the turn-end event; OpenCode reasoning as output
- `src/client/components/Settings/SupportedModelsDialog.tsx` — the tier in the price cell (`formatLongPrompt`)
- `src/server/shared/antigravity-stream.ts`, `src/server/session/agents/codex/codex-rate-limits.ts` — the per-step and per-response lists
