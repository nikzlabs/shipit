---
issue: planning#362
title: Per-review reviewer choice — implementation checklist
description: Per-part build steps for docs/263.
---

# 263 — Per-review reviewer choice: checklist

The design is [`plan.md`](./plan.md); the contract is [`requirements.md`](./requirements.md).

## Parsing — the role carries the user's named values

- [x] `--role reviewer` may combine with `--model` and `--effort` (passed through verbatim);
      it may not combine with `--agent`/`--service`/`--billing-mode`, which ShipIt resolves —
      enforced at the shim (`spawnTargetPayload`) for the message and at the HTTP edge
      (`parseSubAgentSpawnTarget`) for the guarantee
- [x] `SubAgentSpawnTarget`'s role variant gains `modelName?` / `reasoningEffort?`; the wire key
      stays `modelId` (the `--model` flag's body key), the typed name is `modelName` because it
      is a human name to resolve, not a catalogue id
- [x] The explicit path unchanged — all five required, an omission refused

## Resolution

- [x] `resolveReviewerByName(modelName, implementer, deps)` in `reviewer-model.ts` — match
      (exact id → exact label → substring, via new catalogue `modelsNamed`), disambiguate by
      `canonicalModelKey` (unknown/ambiguous refusals listing candidates), enumerate offerings
      by key, `firstRoutable` in catalogue order preferring a harness that is not the
      implementer's, build a frozen `ReviewerTarget` with `source: "named"` and no slot
- [x] The effort override is validated against the final harness and applied in one place
      (`applyEffortOverride`, sharing the explicit path's `assertValidEffort`); unnamed effort
      falls back to the reviewer's own (a pin's or the ShipIt-authored default)
- [x] A bare role still resolves through `selectReviewer`, unchanged; the named path bypasses
      the slots (the human chose, lifting the distance guarantee like a pin) and arrives
      already routed for the card's `runOn`

## Type changes

- [x] `ReviewerSource` gains `"named"`; `ReviewerSlotSource` (`"pinned" | "auto"`) kept narrow
      for the Settings wire shape
- [x] `ReviewerTarget.slot` optional — a named reviewer belongs to no slot
- [x] `buildTarget`'s core extracted to `freezeTarget`, shared by the slot and named paths

## Prompts and docs — every place that stated the combination rule

- [x] `shipit-docs/agent.md` — the three shapes, the override rule, the usage block
- [x] `shipit-docs/spec-discipline.md` — the role carries `--model`/`--effort` only for values
      the user named
- [x] `orchestrator/agents/claude/system-prompt.md` and `codex/system-prompt.md` — the review
      path reworded
- [x] `client/utils/compose-review-body.ts` — the generated message names the pass-through rule
- [x] `CLAUDE.md` review rule — name the role; a user-named model/effort rides it
- [x] Shim help (`shipit.ts` usage block, `ROLE_HINT`)

## Tests

- [x] `sub-agent-target.test.ts` — parse accepts role+model/effort and refuses the trio;
      resolve: named model → routed target, effort override + validation, each refusal
- [x] `reviewer-model.test.ts` — `resolveReviewerByName` matching/disambiguation, gateway
      collapse, route fall-through, frozen `source: "named"` target
- [x] `catalogue.test.ts` — `modelsNamed` tiers and dedupe
- [x] `shipit.test.ts` — the shim forwards role+model+effort and still refuses role+`--agent`
- [x] `compose-review-body.test.ts` — the generated message names the overrides but binds no
      value; `review-command-callers.test.ts` stays green
