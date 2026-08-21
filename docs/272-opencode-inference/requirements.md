---
title: OpenCode inference (Zen / Go) as a catalogue service
description: Requirements for supporting OpenCode's own hosted inference — their subscription and their API key — as a service in ShipIt's model catalogue.
---

# OpenCode inference — requirements

The ask, verbatim: *"we need to support OpenCode inference. They provide their
own subscription or the API key, and we need to investigate."*

This folder is that investigation. The numbered requirements are the
human-owned statements (reqs 4–6 were added from the 2026-08-17 review
answers — see Resolved questions). All open questions are resolved; the
investigation is complete and implementation can start.

Companion fact sheet and design assessment: [plan.md](./plan.md).

## Requirements

1. ShipIt supports OpenCode's own inference service as a **service in the model
   catalogue**: its models appear in the picker and a turn can run on them,
   under the same catalogue mechanisms (docs/252) as every other service.
2. A user who has **OpenCode's subscription** (OpenCode Go, the $10/month
   plan) can use it as the credential for that service.
3. A user who has an **OpenCode API key** (OpenCode Zen pay-as-you-go) can use
   it as the credential for that service.
4. **Every way a user's OpenCode account can be used with the OpenCode CLI
   outside ShipIt is supported.** Both products ride one pasted API key, and
   the launch delivers exactly that (the "simplest thing" answer below); the
   account's other entry point — the console OAuth device login — is follow-up
   work under this requirement, not out of scope.
5. **Cross-harness routing is in scope**: OpenCode-inference models are also
   offered on the other harnesses (Claude Code, Codex) — for each pair only
   after live verification shows it works (see plan.md §7).

Standing platform context, not a new requirement: ShipIt is subscription-first —
connected subscriptions rank above metered keys (CLAUDE.md preamble). Whatever
launches must not invert that.

6. The Go mode launches **without a usage-quota indicator**: ShipIt reacts to
   the service's own limit errors (429 benching, as for any subscription) and
   displays no remaining-quota figure until a per-key usage source exists.
   The Go settings surface warns that the console's "Use balance" option
   makes cap exhaustion silently continue on metered Zen credits, invisibly
   to ShipIt.
7. **The user supplies their OpenCode key once and chooses nothing.** ShipIt
   takes whatever key they give it and works out for itself whether the
   account carries the Go subscription; it does not ask which product the key
   is for, and it does not ask for the same key twice. A billing-mode choice
   is only justified where the two ways of paying authenticate differently —
   Anthropic's subscription and API key do; OpenCode's do not, since one key
   and one flow serve both products.

## Open questions

(none)

## Resolved questions

- **2026-08-17 (Nik, PR review)** — *Should the user pick a billing mode for
  OpenCode?* Answer: "If for the user it is the same key, then why do they need
  to choose when they edit ShipIt? So ShipIt should use whatever the key the
  user provides, and if they have a subscription, ShipIt has to detect it. We
  have different flow for Anthropic, for example, because the way to
  authenticate with the subscription and the API key are different. But where
  we have a single way, we don't need to distinguish that." → req 7 added. The
  same answer scoped the work: "this is probably a separate change. Let's do it
  after the current PR is merged" — so the first PR ships the two-mode shape,
  with the same key set in both slots, and req 7 is the follow-up's brief.

- **2026-08-17 (Nik, doc review)** — *Go quota indicator.* The investigation
  found no per-key usage/quota API (fact sheet §8); of the two stated options
  — (a) ship the `sub` mode with a `QuotaIntegrationId` whose reader reports
  nothing until a source exists (the GLM precedent, planning#339) plus
  generic 429 refusal-memory benching, or (b) additionally accumulate the
  per-response `cost` field into a local cap estimate — the answer to
  "Recommend (a) for launch" was: "let's do that." → req 6 added; the
  "Use balance" settings warning is part of it.
- **2026-08-17 (Nik, doc review)** — *Which product is "the subscription", and
  what breadth?* Answer: "We need to support all ways the user['s] OpenCode
  account could use OpenCode CLI without ShipIt." → req 4 added; req 2/3
  reworded to name Go and Zen. Free models are *offerable* as ordinary $0
  rows under the key mode — a pasted key is still required; the
  credential-less anonymous free tier is not an *account* way and stays out
  of scope.
- **2026-08-17 (Nik, doc review)** — *Launch auth scope.* Answer: "agree,
  let's do the simplest thing" → launch = pasted API key only, for both modes.
  The console OAuth login remains follow-up under req 4.
- **2026-08-17 (Nik, doc review)** — *Cross-harness routing in scope?* Answer:
  "yes, and live verification needed" → req 5 added. The 2026-08-17 live pass
  verified the per-route auth-header matrix and live endpoints (plan.md §7–§8);
  the remaining per-pair turns need a real key.
- **2026-08-17 (Nik, doc review)** — *Maintained model subset.* Answer:
  "agree" → the frontier coding set that overlaps ShipIt's existing model
  families, decided at row-authoring time against live models.dev.
