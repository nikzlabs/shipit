# GPT models on the OpenCode harness

## Design

- [x] Record the user's goal and scope as numbered requirements.
- [x] Ask the two open questions and record dated receipts.
- [x] Measure whether OpenCode can drive Responses through ShipIt's
      custom-provider shape, rather than assuming it from the docs.

## Implementation

- [x] Map `openai-responses` to the Responses-capable provider package.
- [x] Allow `openai-responses` on OpenCode's string credential target.
- [x] Prefer Responses over Chat Completions for OpenCode (req 8).
- [x] Unpin the OpenAI subscription rows OpenCode's filter accepts (req 4).
- [x] Keep the two rows OpenCode refuses pinned to Codex (req 7).
- [x] Guard the pins against OpenCode's filter, asserting the invariant rather
      than a list of model ids; proved red in both directions.
- [x] Update the assertions that encoded the old restriction.
- [x] Full suite, lint, typecheck.

## Verification

- [ ] Confirm GPT-6 Astra on the OpenAI subscription runs a real turn on
      OpenCode (req 5). Needs a rebuilt session-worker image and a connected
      ChatGPT account.
- [ ] Re-check an existing OpenAI API-key GPT combination, which moved from
      Chat Completions to Responses (req 6, and the receipt on question 2).
- [ ] Independent review against the numbered requirements.
