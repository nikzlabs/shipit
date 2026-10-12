# Tier-aware model pricing — checklist

- [x] Requirements, with the three open questions answered (2026-10-12)
- [x] Design (`plan.md`), reviewed
- [ ] `ModelPrice.longPrompt`, `parsePrice` support, and tier rates for Haiku 5.5, Gemini 3.1 Pro and the xAI Grok rows (vendor pages re-read); `npm run catalogue:export`
- [x] `requests` on `AgentResultEvent`, filled once per request of the turn by each adapter, with a sum-within-totals test per adapter
- [x] OpenCode reasoning tokens counted as output, not as prompt size
- [x] `costFromRates` prices per request, with the `contextTokens` estimate for the remainder
- [x] The list reaches consults and background work (`SubAgentRunResult`, `NonTurnTelemetry`; one-entry lists for direct calls and session naming)
- [x] `usage_turns.at_api_rates_usd`: computed in `UsageManager.record`, backfilled by migration, summed by the `usage.ts` read paths without the rate `GROUP BY`
- [x] Supported models dialog shows the long-prompt price
- [x] Wiki (`settings-and-accounts.md`, `chat.md`) and the docs/252-custom-models Haiku 5.5 note updated
