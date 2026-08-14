---
issue: planning#363
title: Agent roles — implementation checklist
description: Per-phase build steps for docs/264.
---

# 264 — Agent roles: checklist

The design is [`plan.md`](./plan.md); the contract is [`requirements.md`](./requirements.md).

## Phase 1 — Storage + resolution

- [ ] Role store in the credential store, list-shaped: `getRoles`, `setRole(name, role | null)`,
      `renameRole`
- [ ] `resolveRoleByName(name, implementer, deps)` — built-in `reviewer` via `selectReviewer`;
      user roles via the routable-pin path, harness derived preferring a non-implementer harness,
      frozen target with `source: "role"` and the name
- [ ] Unknown role name refused, listing the known roles (built-in + user), with the `--model`
      hint
- [ ] Settings payload carries the roles, each resolved (server sends the resolution)
- [ ] Optional `harnessId` on the role, if open question 1 is taken — absent means derived;
      present is refused at save when that harness cannot run the model

## Phase 2 — Settings (the only way a role is created, req 5)

- [ ] Role CRUD through the settings API, validating params through `resolveReviewerPinPatch`;
      the optional prompt (req 11) is an ordinary string
- [ ] Name rules: kebab-case token, length bound, uniqueness — enforced server-side
- [ ] Roles surface: the built-in `reviewer` row (auto/pinned, its two-slot resolution) plus the
      user roles (name, optional prompt, the three shared controls, rename, delete, New role row)
- [ ] The harness control renders only where a model is offered by more than one harness
      (docs/261 req 14) — never on today's catalogue

## Phase 3 — CLI + inventory

- [ ] `--role NAME` accepts user roles: the shim validates the built-in set locally and passes
      anything else through for the server to resolve
- [ ] `--role NAME` exclusive with `--model` / `--effort` in both shim and server
- [ ] `resolveSubAgentSpawnTarget` resolves the role path through `resolveRoleByName`
- [ ] The roles read (req 14) — names plus a one-line description, scoped to roles and NOT the
      service/model catalogue
- [ ] Agent-facing guidance: map the user's intent onto a role ("review the PR" → `reviewer`),
      pass an explicitly named role through unchanged, and supply no param

## Phase 4 — Recurrence conversion

- [ ] Agent-facing guidance: after a repeated `--role reviewer --model NAME --effort LEVEL`
      combination, offer to save it as a role (propose-actions pattern), cross-checked against
      consult `runOn`
- [ ] The offer's payload opens the Roles settings surface prefilled — it does not write the role

The pool question is settled (requirements req 12): a user role's params are pinned — deliberately
not in this table; see plan.md § "The pool question, settled" for the assessment that led there.
