---
issue: planning#544
title: Gemini API as a catalogue vendor
description: Google's Gemini API as a vendor row in the model catalogue — key stored, models priced, wire format named — before any harness speaks it.
---

# 302 — Gemini API as a catalogue vendor: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

Stated by the spawning brief (Nik's session "Check antigravity harness support in
ShipIt", 2026-09-13). Everything the brief left to the implementer is recorded
under Resolved questions with its provenance, so a reader can tell the two apart.

1. ShipIt's model catalogue represents Google's Gemini API as a vendor of its own,
   separate from the gateways (OpenRouter, Vercel AI Gateway) that resell Gemini
   models.

2. A user can store a Gemini API key in ShipIt under that vendor. The key is a
   metered credential: turns on it are billed per token, never against an
   allowance.

3. The vendor row carries current Gemini models. Every model id is one Google's own
   model list names, and every price and context window comes from Google's
   published pricing and model pages — never from memory and never a placeholder.

4. The catalogue states that Gemini's API is a wire format of its own, distinct
   from the three it already knows, so that a harness speaking it can later be
   declared without touching the vendor row. The Gemini models are declared under
   that format only.

5. Until a harness speaks that format, the vendor's models are offered on no
   harness. That state is intended: the key can be stored and the vendor is shown
   in Settings honestly (no harness ticks it, nothing breaks, nothing pretends a
   turn could run).

6. The dogfood instance can carry a Gemini key like every other service credential,
   and the onboarding instance never carries one.

7. This is catalogue work only: no harness adapter, and no client change beyond
   what the catalogue row makes appear on its own.

## Resolved questions

- 2026-09-13 — Which Gemini models does the vendor row carry? The brief delegated
  the pick ("pick the current Gemini models from Google's docs; verify each model
  id against Google's model list"). Chosen: the current flagship pair on Google's
  model list — the latest Flash and the latest Pro. The subset rule is the one
  docs/272-opencode-inference set for OpenCode: the frontier coding set, not the
  whole list.
- 2026-09-13 — Does anything in ShipIt reject or mis-render a service no harness can
  carry? The brief asked for this to be checked and, if so, raised with the user
  rather than answered by the implementer. Checked in `plan.md` § "A service no
  harness carries": nothing rejects it, so no question was raised.
