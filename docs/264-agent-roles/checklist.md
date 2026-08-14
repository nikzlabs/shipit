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

## Phase 2 — CLI

- [ ] `--role NAME` accepts user roles: the shim validates the built-in set locally and passes
      anything else through for the server to resolve
- [ ] `--role NAME` exclusive with `--model` / `--effort` in both shim and server
- [ ] `resolveSubAgentSpawnTarget` resolves the role path through `resolveRoleByName`

## Phase 3 — Chat-native creation

- [ ] Settings CRUD for roles, validating params through `resolveReviewerPinPatch`; the optional
      prompt field (req 11) is an ordinary string
- [ ] Name rules: kebab-case token, length bound, uniqueness — enforced server-side
- [ ] Roles settings surface: the built-in `reviewer` row (auto/pinned, its two-slot resolution)
      plus the user roles (name, optional prompt, the three shared controls, rename, delete, New
      role row)

## Phase 4 — Recurrence conversion

- [ ] Agent-facing guidance: after a repeated `--role reviewer --model NAME --effort LEVEL`
      combination, offer to save it as a role (propose-actions pattern), cross-checked against
      consult `runOn`
- [ ] The offer's payload is the exact command / settings write that creates the role

The pool question is settled (requirements req 12): a user role's params are pinned — deliberately
not in this table; see plan.md § "The pool question, settled" for the assessment that led there.
