---
issue: planning#362
title: Per-review reviewer choice — design
description: --role reviewer accepts --model and --effort overrides; ShipIt resolves the rest.
---

# 263 — Per-review reviewer choice: design

Implements [`requirements.md`](./requirements.md). Requirement numbers below refer to it.

## What this is

Today a review request names who reviews in exactly two ways (docs/261 reqs 6, 7):
`--role reviewer` resolves the two configured slots, and the explicit call names all five
parameters and refuses an omission. There is no middle path, so a user who wants THIS review
on a specific model — "review this with GPT-5.6 at high effort" — either edits Settings or
loses the choice: the agent inside the container cannot discover valid ids, and the prompts
forbid it from guessing.

This feature lets the role carry the fields the user named. `--role reviewer` gains two
optional overrides, **model** and **effort** (reqs 1, 2); the agent passes them through
verbatim; ShipIt resolves the rest. **Harness, service and billing-mode naming are deferred**
(requirements.md's resolved questions): naming a harness falls back to the role, and naming a
model always derives who pays (req 3).

The courier invariant is unchanged from docs/261 req 2's repo-override: ShipIt cannot detect
whether the agent invented a value, and the prompt rule is the convention. What is new is that
the **user** has a per-review outlet, so the agent no longer has to choose between relaying
nothing and guessing.

## The target shape

`SubAgentSpawnTarget`'s role variant gains `modelName?` and `reasoningEffort?`:

```ts
| { kind: "role"; role: SubAgentRole; modelName?: string; reasoningEffort?: string }
```

The wire key for the model stays `modelId` (the `--model` flag's body key); the **typed**
name is `modelName` because in the role path it is a human name to resolve, not a catalogue
id. The explicit variant is unchanged (all five required).

## Parsing — the same rule in both halves

`--role reviewer` may combine with `--model` and `--effort`; it may **not** combine with
`--agent`, `--service` or `--billing-mode`, which ShipIt resolves. Both the shim
(`shipit-agent.ts:spawnTargetPayload`) and the HTTP edge
(`sub-agent-target.ts:parseSubAgentSpawnTarget`) enforce this — the shim for the message, the
server for the guarantee (docs/261). Overrides are defined for the reviewer role only; there is
one role today.

## Resolution — `resolveSubAgentSpawnTarget`, role branch

1. **Base target.** No `modelName` → `selectReviewer`, unchanged. `modelName` →
   `resolveReviewerByName`.
2. **Effort override.** If `reasoningEffort` was named, validate it against the final
   harness's declared levels — the explicit path's own rule — and apply it; otherwise keep
   the base target's effort (a pin's level or `REVIEWER_DEFAULT_EFFORT`). One validation
   site, after the harness is known.

### `resolveReviewerByName(modelName, implementer, deps)` — new, in `reviewer-model.ts`

Names a model, resolves a routed, frozen `ReviewerTarget`:

1. **Match** (new catalogue helper `modelsNamed`): exact id, then exact label, then
   case-insensitive substring over id and label. Collect the matched `ModelDef`s.
2. **Disambiguate** by `canonicalModelKey`. Zero matches → refuse `unknown_model`. Matches
   spanning more than one key → refuse `ambiguous_model`, listing the candidate labels. One
   key → the model.
3. **Enumerate offerings**: every catalogue `(service, mode, model)` row whose
   `canonicalModelKey` is the matched key — this collapses vendor and gateway spellings of
   one model, which `modesOfferingModel` by id would miss for an alias id.
4. **Route**: `firstRoutable` over those rows in catalogue order — the same helper the slot
   resolution uses, preferring a harness that is not the implementer's. None routable →
   refuse `no_route`.
5. **Build** a frozen target (the extracted `buildTarget` core) with `source: "named"`, no
   `slot`, effort = `defaultEffortFor(harness)`.

The harness preference is a preference, not a filter (docs/261): a model only the
implementer's own harness can run still resolves — the human named it, which lifts the
distance guarantee just as a pin does (req 5, Scope).

## Refusals

| Case | Message |
|---|---|
| `--role` + `--agent` / `--service` / `--billing-mode` | Those are resolved by ShipIt; name a model and/or a reasoning level, or drop the role. |
| A blank `--model` / `--effort` on the role | A blank override is a NAMED value that cannot run, not an absence — absence means "ShipIt resolves it" (added after cross-backend review). |
| Model name matches nothing | "No model matches X" + the catalogue's available labels — the refusal is also the discovery mechanism. |
| Model name spans several models | "X matches more than one model: … Name one exactly." |
| No offering with a working route | "No service on this install can run X right now." |
| Effort invalid for the resolved harness | The explicit path's own message, naming the valid levels. |

## Type changes

- `ReviewerSource` gains `"named"`.
- `ReviewerTarget.slot` becomes optional — the configured slots have one; a user-named
  reviewer belongs to no slot. `source` stays required.
- `buildTarget`'s core is extracted so the slot path and the named path build the same frozen
  target (freeze, copies, `serviceRouting`/`credentialSecret` shaping).
- `ResolvedSpawnTarget.reviewer` stays absent for the named path — `sub-agent-target.ts` sets
  it only from `selectReviewer`.

## Wiring

`runSubAgent` (`sub-agent.ts`) needs no structural change: resolution returns the same
`ResolvedSpawnTarget` (harness, selection, effort, route), and the harness gates, the cap
spend, the route reuse and the `runOn` card all read it. The named path arrives **already
routed** (`route` set), so the `resolvedTarget.route ?? selectRouteForSelection` fallback is
skipped exactly as for the bare role. The worker's `/agent/spawn` already requires a concrete
model; resolution guarantees one. Add a `reviewer-by-name` log line beside the slot one.

The `runOn` card needs no change: it copies service, mode, model and effort from the captured
target (req 4), and the named path provides them — which is req 3's "reports the choice".

## Prompts and docs — every place that states the combination rule

- `src/server/shipit-docs/agent.md` — the combination rule becomes "pass through
  `--model`/`--effort` only for values the user named; name nothing else"; the "Do not choose
  the reviewer" section gains the override.
- `src/server/shipit-docs/spec-discipline.md:70` — "`--role reviewer` takes no `--agent`, no
  `--model` and no reasoning level" is now false; reword.
- `orchestrator/agents/claude/system-prompt.md` and `agents/codex/system-prompt.md` — the
  review path ("Supply no `--agent`, no model, no reasoning level") rewords to "pass through a
  model or reasoning level the user named; supply nothing yourself."
- `client/utils/compose-review-body.ts` — the generated message's "Name the ROLE and nothing
  else: no --agent, no --model, no reasoning level" rewords the same way.
- `CLAUDE.md`'s review rule — still names the role; notes that a user-named model/effort is
  passed through.
- The shim's help text (`shipit.ts` usage block, `ROLE_HINT`).

## Tests

- `sub-agent-target.test.ts` — parse: role+model, role+effort, role+both accepted;
  role+agent/service/billing-mode refused; the explicit path unchanged. Resolve: a named
  model → routed target; effort override validated and applied; each refusal; harness
  preference.
- `reviewer-model.test.ts` — `resolveReviewerByName`: matching by id/label/substring,
  canonical-key disambiguation, route fall-through, frozen target, `source: "named"`, slot
  absent.
- `catalogue.test.ts` — `modelsNamed`.
- `review-command-callers.test.ts` — the command-shape guard stays green; extend to assert no
  generated call pairs `--role` with `--agent`.
- `compose-review-body.test.ts` — the reworded message.
