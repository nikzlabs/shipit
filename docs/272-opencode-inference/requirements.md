---
title: OpenCode inference (Zen / Go) as a catalogue service
description: Requirements for supporting OpenCode's own hosted inference — their subscription and their API key — as a service in ShipIt's model catalogue.
---

# OpenCode inference — requirements

The ask, verbatim: *"we need to support OpenCode inference. They provide their
own subscription or the API key, and we need to investigate."*

This folder is the investigation that ask commissioned. The numbered
requirements below are the human-owned statements; everything the investigation
had to supply itself — which of OpenCode's two paid products maps to
"subscription", which auth modes launch, whether other harnesses route to it —
is under **Open questions** and stays there until a human answers.

Companion fact sheet and design assessment: [plan.md](./plan.md).

## Requirements

1. ShipIt supports OpenCode's own inference service as a **service in the model
   catalogue**: its models appear in the picker and a turn can run on them,
   under the same catalogue mechanisms (docs/252) as every other service.
2. A user who has **OpenCode's subscription** can use it as the credential for
   that service.
3. A user who has an **OpenCode API key** can use it as the credential for that
   service.

Standing platform context, not a new requirement: ShipIt is subscription-first —
connected subscriptions rank above metered keys (CLAUDE.md preamble). Whatever
launches must not invert that.

## Open questions

- **Which product is "the subscription"?** OpenCode sells two paid things plus
  a free tier (fact sheet §1): **OpenCode Zen** — pay-as-you-go credits over
  ~60 models including frontier closed models (`key`-shaped), and **OpenCode
  Go** — a $10/month subscription with dollar-denominated usage caps over ~17
  open-weight coding models (`sub`-shaped, like GLM's coding plan). Reading:
  req 2 = Go, req 3 = Zen PAYG. Confirm. And is the **free tier** (a handful of
  free models Zen serves with no credential at all) in scope? Offering models
  with *no* credential has no precedent in the catalogue — recommend out of
  scope at launch.
- **Launch auth scope.** Both products authenticate with the same pasted API
  key from the OpenCode console (one `OPENCODE_API_KEY`). The CLI additionally
  has an OAuth device-code login ("OpenCode Console account") with refresh
  tokens. Recommend launch = pasted key only for both modes (matches the
  docs/268 OpenCode-harness launch scope, and Go-via-key is exactly the GLM
  sub-via-string shape); the OAuth login is follow-up work with its own
  `LoginIntegrationId`. Confirm.
- **Cross-harness routing in scope?** Zen speaks all three of ShipIt's API
  styles (wire-verified CLI-side, fact sheet §3), so Claude Code and Codex
  could in principle route to it — but no live pair has been verified (this
  container cannot reach opencode.ai, and no real key exists yet). Recommend:
  declare per-model styles only after a live pair-verification sweep (docs/252
  question-5 discipline), launch OpenCode-harness-first. Confirm scope.
- **Go quota indicator.** docs/252 requires a `sub` mode to name a
  `QuotaIntegrationId`. Go has real caps ($12/5h, $30/wk, $60/mo — third-party
  corroborated), but no usage/quota API was found in this investigation.
  Options: ship with a quota integration that reports nothing until a source is
  found (the GLM precedent, planning#339), or block the `sub` mode on finding
  one. Recommend the former.
- **Maintained model subset** (docs/252 req 6). The Zen list is ~60 current
  models spanning Claude, GPT, Gemini, GLM, DeepSeek, Kimi, Qwen, Grok and
  more, with heavy churn (26 of 86 snapshot entries already deprecated). Which
  subset does ShipIt maintain? Recommend: the frontier coding set that
  overlaps ShipIt's existing model families, decided at row-authoring time
  against live models.dev.

## Resolved questions

(none yet)
