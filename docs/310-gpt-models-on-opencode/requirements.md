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
4. A combination is offered only after it is verified to work, so the picker
   never offers a pairing that then fails when a turn starts. This restates
   `docs/295-opencode-chatgpt` req 9 for the wider set.
5. Combinations that work today keep working and keep their current behavior:
   every model Codex runs now, the Claude models on OpenCode Zen, and GPT-5.5
   on the ChatGPT subscription.
6. Where a model is offered on a harness that cannot reach it, ShipIt says so
   with a reason rather than silently omitting it.

## Open questions

- Verifying a combination end-to-end means running a real turn against a paid
  route, which spends the user's own ChatGPT / OpenCode Go quota. Is that
  authorized, and for how many combinations?
- On the OpenAI API-key route, several GPT models can be reached by two
  different request shapes. OpenCode uses the lower-fidelity one today and
  works. Should it switch to the same shape Codex uses, which is what OpenAI
  recommends for reasoning models but changes an already-working path?

## Resolved questions

- (none yet)
