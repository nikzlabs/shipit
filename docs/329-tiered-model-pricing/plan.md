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

The turn-end event gains an optional list of the turn's requests, each with its
own input, output, cache read and cache write tokens. An adapter fills it only
where its harness reports per-request usage; see "Per-harness sources" below.

`costFromRates(price, tokens, requests?)` then:

- no `longPrompt` → today's formula on the totals (unchanged for every other model);
- `longPrompt` and `requests` → sums each request at the tier its own prompt size
  selects (exact, req 4);
- `longPrompt` and no `requests` → the estimate req 4 allows: the turn's
  `contextTokens` (the last request's prompt size, already reported by every
  harness that reports usage) picks one tier for the whole turn. The context
  grows through a turn, so the last request is normally the largest; this can
  over-count a turn that crossed the limit part-way. With no `contextTokens`
  either, the lower tier is used, as today.

The per-request list is used for pricing at turn end and is not stored.

### 3. A subscription turn stores its at-API-rates cost (req 2, req 5)

New nullable column `usage_turns.at_api_rates_usd`, written at turn end for every
subscription turn from the same `costFromRates` call that feeds the live figure.
The read paths in `usage.ts` sum the column instead of recomputing from `rate_*`.

A migration backfills the column for existing subscription rows from their stored
flat rates and token totals — exactly the figure those rows show today — so past
turns keep their recorded cost (req 5) and the read paths have one source. The
`rate_*` columns stay: they still split usage groups when a price changes.

### 4. The Supported models dialog shows the tier (req 6)

`SupportedModelsDialog.tsx` keeps the "$in / $out" cell and adds the tier under it
in the tertiary text colour:

- every rate the same multiple of the flat rate → "5× above 100K";
- otherwise the higher input / output rates → "$4 / $18 above 200K".

The Usage dialog needs no change: it shows sums, which become correct.

## Per-harness sources

_To be filled from the adapter survey (claude, codex, opencode, grok, antigravity)._

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
- `src/server/session/agents/*/adapter.ts` — per-request usage on the turn-end event
- `src/client/components/Settings/SupportedModelsDialog.tsx` — the tier in the price cell
