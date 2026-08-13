---
issue: planning#363
title: Named reviewer configurations — implementation checklist
description: Per-phase build steps for docs/264.
---

# 264 — Named reviewer configurations: checklist

The design is [`plan.md`](./plan.md); the contract is [`requirements.md`](./requirements.md).

## Phase 1 — Storage + resolution

- [ ] Named reviewer store in the credential store, list-shaped: `getNamedReviewers`,
      `setNamedReviewer(name, pin | null)`, `renameNamedReviewer`
- [ ] `resolveReviewerByName(name, implementer, deps)` — look up, routable check, harness
      derived preferring a non-implementer harness, frozen target with `source: "named"` and the
      name
- [ ] Unknown name refused, listing the known names, with the `--model` hint
- [ ] Settings payload carries the named list, each resolved (server sends the resolution)

## Phase 2 — CLI

- [ ] `--reviewer NAME` parsed by the shim, sent as `{ role: "reviewer", reviewer: NAME }`
- [ ] `--reviewer` exclusive with `--model` / `--effort` in both shim and server
- [ ] `resolveSubAgentSpawnTarget` resolves the named path through `resolveReviewerByName`

## Phase 3 — Chat-native creation

- [ ] Settings CRUD for the named list, validating through `resolveReviewerPinPatch`
- [ ] Name rules: kebab-case token, length bound, uniqueness — enforced server-side
- [ ] Reviewer tab's Named reviewers section: name field, the three shared controls, rename,
      delete, New reviewer row

## Phase 4 — Recurrence conversion

- [ ] Agent-facing guidance: after a repeated `--model NAME --effort LEVEL` combination, offer to
      save it as a named reviewer (propose-actions pattern), cross-checked against consult
      `runOn`
- [ ] The offer's payload is the exact command / settings write that creates the configuration

The unify fold (requirements open question 1) is deliberately not in this table; see plan.md
§ "The unify option, assessed" for what it would cost.
