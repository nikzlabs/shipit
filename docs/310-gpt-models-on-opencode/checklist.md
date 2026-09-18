# GPT models on the OpenCode harness

## Design

- [x] Record the user's goal and scope as numbered requirements.
- [x] Ask the two open questions and record dated receipts.
- [x] Measure whether OpenCode can drive Responses through ShipIt's
      custom-provider shape, rather than assuming it from the docs.

## Implementation

- [x] Map `openai-responses` to the Responses-capable provider package.
- [x] Allow `openai-responses` on OpenCode's string credential target.
- [x] Unpin the OpenAI subscription rows OpenCode's filter accepts (req 4).
- [x] Keep the two rows OpenCode refuses pinned to Codex (req 7).
- [x] Guard the pins against OpenCode's filter, asserting the invariant rather
      than a list of model ids; proved red in both directions.
- [x] Prove every change is additive, by diffing `resolveStyle` and
      `retirementSuccessor` across every harness × service × model against
      `main`.
- [x] Full suite, lint, typecheck.

## Parked

- [ ] Req 8 — prefer Responses for GPT models on OpenCode. Both global levers
      were built, measured and reverted for collateral; see `plan.md`. Needs a
      per-row preference, and a decision on whether that is worth building.

## Verification

- [ ] Confirm GPT-6 Astra on the OpenAI subscription runs a real turn on
      OpenCode (req 5). Needs a rebuilt session-worker image and a connected
      ChatGPT account. **No subscription model is verified live yet.**
- [ ] Check whether the account shaper's hardcoded 400k/272k/128k limits are
      wrong for newly offered rows. Spark's native row declares 128k/100k/32k,
      so an oversized request is plausible.
- [ ] Check whether a custom Responses provider model with no `limit` disables
      proactive compaction, and whether that predates this change.
- [ ] Decide whether `catalogueEntriesForHarness` should consult carriers, so
      the grok harness stops being reported models it cannot carry.
