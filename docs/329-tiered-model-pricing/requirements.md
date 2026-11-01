---
issue: planning#690
title: Tier-aware model pricing
description: Price a turn at the long-prompt rate when a model's price depends on prompt length.
---

# Tier-aware model pricing

Some vendors charge more per token once a request's prompt passes a size limit.
The catalogue keeps one flat rate per model (`ModelPrice`), so ShipIt prices
those models at their lowest tier even when a prompt is in the higher one.

1. Where ShipIt works out a turn's cost from catalogue rates, a model whose price
   depends on prompt length is charged at the rate for that prompt length, not
   always at its lowest tier.
2. Requirement 1 holds for both uses of catalogue rates: the spend of API-key
   turns that ShipIt prices itself, and the "at API rates" comparison for
   subscription turns.
3. The long-prompt prices vendors publish today are used: Claude Haiku 5.5 (every
   rate 5× above 100K prompt tokens), Gemini 3.1 Pro (higher rates above 200K),
   and the xAI Grok rows (doubled above 200K).
4. Each API request in a turn is priced at the tier for its own prompt size. Where
   a harness does not report each request's usage, ShipIt uses an estimate.
5. Turns recorded before this change keep their recorded cost; only new turns use
   the tiers.
6. For a model with a long-prompt price, the Supported models dialog shows it next
   to the standard price, for example "$0.10 / $0.50, 5× above 100K".

## Open questions

## Resolved questions

- 2026-10-12 — How exact must the cost be, given that vendors pick the tier per
  API request but ShipIt stores one token total per turn? Answer: exact per
  request; a harness that does not report each request's usage uses an estimate
  (req 4). Rejected: an estimate from the turn's largest prompt that never
  under-counts, and a turn-level estimate that can err both ways.
- 2026-10-12 — Correct the costs already recorded for past turns? Answer: no, new
  turns only (req 5).
- 2026-10-12 — Show the long-prompt price in the Supported models dialog? Answer:
  yes, next to the standard price (req 6).
