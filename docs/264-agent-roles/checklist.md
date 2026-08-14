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
- [ ] `harnessId` is a **required** field on the role (req 6) — no derivation, no implementer
      preference; refused at save when that harness is not installed, cannot carry the model, or
      has no credential (`harnessesForSelection` answers all three)
- [ ] The role's reasoning level is validated against **its own** harness at save, so a level can
      never be carried onto a harness that does not declare it — with a test that pins the
      property rather than assuming it
- [ ] `resolveRoleByName(name, deps)` — the role's own tuple, checked only for a usable route,
      frozen target with `source: "role"` and the name
- [ ] Unknown role name refused, listing the roles that exist, with the `--model` hint (req 12)
- [ ] Settings payload carries the roles, each resolved (server sends the resolution)
- [ ] The reviewer's resolution, per open question 1 — either a `{ kind: "auto" }` params
      discriminator delegating to `selectReviewer`, or a seeded ordinary role. **Decide before
      starting this phase**, since it decides the shape of the store

## Phase 2 — Settings (the only way a role is created, req 5)

- [ ] Role CRUD through the settings API, validating params through `resolveReviewerPinPatch`;
      the optional prompt (req 8) is an ordinary string
- [ ] Name rules: token shape, length bound, uniqueness — enforced server-side
- [ ] Roles surface: the reviewer's row, then the user's roles (name, optional prompt, the shared
      service / model / reasoning controls, the harness, rename, delete, New role row)
- [ ] The harness is **shown on every role** and filled from the single valid option where a model
      has one; it becomes a real picker where a model is carried by more than one

## Phase 3 — Starting a role

- [ ] `--role NAME` on `shipit agent run`: the shim passes the name through, the server resolves
- [ ] `--role NAME` on `shipit session create` (req 10) — replaces inheritance rather than
      layering over it; no `--role` keeps today's inheritance exactly
- [ ] `--role NAME` refused together with a model or a reasoning level, in shim and server (req 9)
- [ ] The roles read (req 11) — names plus a one-line description, scoped to roles and NOT the
      service/model catalogue
- [ ] Agent-facing guidance: map the user's intent onto a role ("review the PR" → the reviewer),
      pass an explicitly named role through unchanged, and supply no param

## Phase 4 — Injected documentation (req 14)

- [ ] The fully-specified run leaves the injected pages and the harness system prompts; what
      replaces it is "name a role, and ask the user to create one in Settings if it is missing"
- [ ] The server still accepts a fully-specified call from a caller that holds all five values —
      this phase changes what the agent is told, not what the server permits
- [ ] A guard that fails if an injected page starts telling an agent to assemble a run out of
      parameters it cannot enumerate
