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
- [ ] `harnessId` is a **required** field on the role (req 9) — no derivation, no implementer
      preference; refused at save when that harness is not installed, cannot carry the model, or
      has no credential (`harnessesForSelection` answers all three)
- [ ] `resolveRoleByName(name, implementer, deps)` — built-in `reviewer` via `selectReviewer`;
      user roles run on the harness the role names, checked only for a usable route, frozen
      target with `source: "role"` and the name
- [ ] The role's effort is validated against **its own** harness at save — the docs/261 phase-3
      latent bug (level validated on one harness, run on another) has no analogue here; add a
      test that pins the property rather than assuming it
- [ ] Unknown role name refused, listing the known roles (built-in + user), with the `--model`
      hint
- [ ] Settings payload carries the roles, each resolved (server sends the resolution)

## Phase 2 — Settings (the only way a role is created, req 5)

- [ ] Role CRUD through the settings API, validating params through `resolveReviewerPinPatch`;
      the optional prompt (req 11) is an ordinary string
- [ ] Name rules: kebab-case token, length bound, uniqueness — enforced server-side
- [ ] Roles surface: the built-in `reviewer` row (auto/pinned, its two-slot resolution) plus the
      user roles (name, optional prompt, the three shared controls, the harness, rename, delete,
      New role row)
- [ ] The harness is **shown on every user role** and is filled from the single valid option
      where a model has one; it becomes a real picker where a model is carried by more than one.
      Required in the data, not necessarily a required interaction

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
- [ ] The prefill carries the **harness that actually ran**, read from the consult card's `runOn`
      (docs/261 phase 4), rather than guessing one for req 9's required field

The pool question is settled (requirements req 12): a user role's params are pinned — deliberately
not in this table; see plan.md § "The pool question, settled" for the assessment that led there.
