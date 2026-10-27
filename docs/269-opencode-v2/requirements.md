---
issue: planning#411
title: OpenCode 2 harness — requirements
description: OpenCode 2 (npm `@opencode/cli`) as its own ShipIt harness, beside an untouched OpenCode 1 harness.
---

# OpenCode 2 harness — requirements

Requirements for integrating OpenCode 2 into ShipIt. [plan.md](./plan.md)
holds the fact sheet and the design; this doc holds what the feature must do.

Sources: the user's 2026-08-16 decision (recorded in plan.md, "Settled
direction") and the user's 2026-10-27 instructions in the session that checked
whether the OpenCode 2 API is stable enough to integrate.

## Requirements

1. **Own harness.** OpenCode 2 is available in ShipIt as its own harness,
   wherever a harness can be selected — session creation, model picking, roles.
2. **OpenCode 1 stays intact.** Adding OpenCode 2 does not replace, remove or
   change the existing OpenCode 1 harness.
3. **Both at the same time.** OpenCode 1 and OpenCode 2 are both available on
   one ShipIt install at the same time. The two integrations may be fully
   separate.
4. **Same sign-in routes as OpenCode 1.** At launch, OpenCode 2 offers the
   sign-in routes OpenCode 1 offers: API keys and the ChatGPT subscription.
5. **OpenCode 2 first for a shared model.** When ShipIt picks a harness for a
   model by itself — reviewer selection, child sessions, routing — and both
   OpenCode harnesses offer that model, it picks OpenCode 2. OpenCode 1 stays
   available when someone selects it.

## Open questions

None.

## Resolved questions

- **2026-08-16 — Does OpenCode 2 replace OpenCode 1, or run beside it?** The
  user: run the OpenCode 1 and OpenCode 2 integrations at the same time, fully
  separate if needed (reqs 1, 3).
- **2026-10-27 — The 2026-08-16 decision assumed a separate binary and a
  separate data root, which upstream no longer ships. Keep both, or replace
  OpenCode 1?** The user: "let's keep opencode1 intact" (req 2).
- **2026-10-27 — Which sign-in routes must OpenCode 2 offer at launch: the
  same as OpenCode 1, API keys only, or also GitHub Copilot?** The user: the
  same as OpenCode 1 (req 4). Constraint: v1's ChatGPT token delivery does
  not work on v2, so req 4 needs a new delivery path (plan.md, "ChatGPT token
  delivery").
- **2026-10-27 — When both OpenCode harnesses offer a model and ShipIt picks
  a harness by itself, which one wins: OpenCode 1, OpenCode 2, or the
  existing tie-break?** The user: OpenCode 2 first (req 5).
