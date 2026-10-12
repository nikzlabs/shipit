# Tier-aware model pricing — checklist

- [x] Requirements, with the three open questions answered (2026-10-12)
- [x] Design (`plan.md`)
- [ ] `ModelPrice.longPrompt`, `parsePrice` support, and tier rates for Haiku 5.5, Gemini 3.1 Pro and the xAI Grok rows (vendor pages re-read); `npm run catalogue:export`
- [ ] Per-request usage on the turn-end event for each harness that reports it
- [ ] `costFromRates` prices per request, with the `contextTokens` estimate as fallback
- [ ] `usage_turns.at_api_rates_usd`: written at turn end, backfilled by migration, summed by the `usage.ts` read paths
- [ ] Supported models dialog shows the long-prompt price
- [ ] Wiki (`settings-and-accounts.md`, `chat.md`) and the docs/252-custom-models Haiku 5.5 note updated
