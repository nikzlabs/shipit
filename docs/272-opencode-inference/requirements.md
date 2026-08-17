---
title: OpenCode inference (Zen / Go) as a catalogue service
description: Requirements for supporting OpenCode's own hosted inference — their subscription and their API key — as a service in ShipIt's model catalogue.
---

# OpenCode inference — requirements

The ask, verbatim: *"we need to support OpenCode inference. They provide their
own subscription or the API key, and we need to investigate."*

This folder is that investigation. The numbered requirements are the
human-owned statements (reqs 4–5 were added from the 2026-08-17 review
answers — see Resolved questions); anything still author-supplied is under
**Open questions**.

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

## Open questions

- **Go quota indicator — investigated, decision pending.** The caps are
  vendor-confirmed ($12/5h, $30/week, $60/month, dollar-denominated), but the
  2026-08-17 live investigation found **no per-key usage/quota API**: not in
  the CLI binary, not at probed console endpoints, not in the vendor docs
  (fact sheet §8). What does exist: per-request `cost` in every response body,
  a 429 `UsageLimitError`-family shape on exceeded limits (observed for the
  free tier), console-UI usage reporting behind console-session auth, and a
  console "Use balance" option that makes Go **silently fall back to Zen PAYG
  credits** when caps are hit. Options: (a) ship the `sub` mode with a
  `QuotaIntegrationId` whose reader reports nothing until a source exists —
  the GLM precedent (planning#339) — and rely on generic 429 refusal-memory
  benching; (b) additionally accumulate the per-response `cost` field into a
  local cap estimate (new mechanism, ShipIt-maintained window arithmetic).
  Recommend (a) for launch. Note for the decision: with "Use balance" enabled
  the cap boundary produces no error at all, so ShipIt cannot detect that a
  subscription turn became a metered one — worth a settings-surface warning
  when the Go row is authored.

## Resolved questions

- **2026-08-17 (Nik, doc review)** — *Which product is "the subscription", and
  what breadth?* Answer: "We need to support all ways the user['s] OpenCode
  account could use OpenCode CLI without ShipIt." → req 4 added; req 2/3
  reworded to name Go and Zen. Free models are covered as ordinary $0 rows
  under the key mode (an account holder's key runs them); the credential-less
  anonymous free tier is not an *account* way and stays out of scope.
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
