---
title: GPT models on the OpenCode harness — requirements
description: Let a GPT model run on OpenCode across the OpenCode subscription, OpenCode Zen, and OpenAI.
---

# GPT models on the OpenCode harness

## Requirement source

The user tried to switch GPT-6 Astra from Codex to OpenCode and could not:
"Looks like I can't change the astra harness to opencode, I thought we
implemented it?" After the OpenCode CLI pin moved to 1.18.30 (PR #2824) they
reported it again, wider: "still the same, can't set any gpt model to use
opencode, even when using the opencode sub", then "well openai models too".

The goal is stated at the level of the picker: a GPT model should be runnable
on OpenCode. Everything below is that experience. How it is built is not a
requirement and belongs in `plan.md`.

## Requirements

1. A GPT model can be selected with the OpenCode harness on the OpenCode
   subscription, on OpenCode Zen, and on OpenAI.
2. GPT-6 Astra can run on OpenCode. This is the case that started the report.
3. Where more than one harness can run the selected model, the harness control
   offers that choice rather than reading as fixed text.
4. Every GPT model on the OpenAI subscription can be selected with OpenCode,
   including ones nobody has run a live turn against. Verification gates what
   we have *checked*, not what we *offer*. This deliberately relaxes
   `docs/295-opencode-chatgpt` req 9 for this set.
5. GPT-6 Astra on the OpenAI subscription is confirmed working on OpenCode by
   a real turn before this ships.
6. Combinations that work today keep working: every model Codex runs now, the
   Claude models on OpenCode Zen, and GPT-5.5 on the ChatGPT subscription.
7. Where a GPT model genuinely cannot run on OpenCode, ShipIt does not offer
   it, and the reason is recorded.
8. ~~On OpenCode, a GPT model reachable by more than one request shape uses the
   same shape Codex uses, rather than the older one.~~ **Dropped 2026-09-18**;
   see the receipt below. The number is kept so earlier citations still resolve.

## Open questions

- (none)

## Resolved questions

- 2026-09-18 — How much live paid verification gates offering a combination?
  The user: "need to make sure that gpt-6 via OpenAI-subscription works via
  opencode. But all gpt models from the sub should be possible to use in
  opencode, even those that won't be checked." So one confirmed case gates the
  change, and breadth is not gated on per-model checks. Carries the constraint
  that req 4 now overrides `docs/295-opencode-chatgpt` req 9 for the OpenAI
  subscription GPT rows; that doc's rule still governs its own scope.
- 2026-09-18 — Should OpenCode switch from Chat Completions to Responses for
  GPT models that offer both? The user: "Switch to Responses". Carries the
  constraint that an already-working path changes shape, so the existing
  OpenAI API-key GPT combinations need re-checking rather than being assumed
  unaffected.
- 2026-09-18 — Build a per-row style preference to deliver req 8, or drop it?
  The user: "req 8: drop it." Two facts led there. Both global levers were
  measured and both changed combinations nobody asked about (see `plan.md`).
  And the requirement was scoped wider than it ever applied: the OpenAI
  subscription route does not use ShipIt's synthetic provider at all, so it was
  already on Responses, leaving req 8 to govern only the API-key and gateway
  routes. Carries the constraint that `resolveStyle` keeps harness-order
  preference, and that GPT models on those routes stay on Chat Completions
  where they offer both.
