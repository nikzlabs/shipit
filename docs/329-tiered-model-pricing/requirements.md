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

## Open questions

- How exact must the cost be? Vendors pick the tier per API request, and one turn
  makes many requests, but ShipIt stores one token total per turn. Claude Code
  reports each request's usage (`usage.iterations`); the other harnesses are not
  checked yet. Options: exact per request, an estimate from the turn's largest
  prompt that can over-count but never under-count, or an estimate that can err
  both ways.
- Should costs already recorded for past turns be corrected, or only new turns use
  the tiers?
- Should the Supported models dialog show the long-prompt price next to the flat
  price it shows now?

## Resolved questions
