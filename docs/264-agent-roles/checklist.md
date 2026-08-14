---
issue: planning#363
title: Agent roles — implementation checklist
description: Per-phase build steps for docs/264.
---

# 264 — Agent roles: checklist

The design is [`plan.md`](./plan.md); the contract is [`requirements.md`](./requirements.md).

## Phase 1 — Storage + resolution

- [ ] Role record in the credential store, keyed by name: `getRoles` (name order), `setRole(name,
      role | null)`. No reorder, no rename primitive — a rename is a validated write plus a delete
- [ ] Params are a discriminator — `{ kind: "pinned", … }` or `{ kind: "auto" }` — so the shipped
      reviewer is a role with automatic params rather than a second kind of object (reqs 2, 7)
- [ ] `{ kind: "auto" }` is **rejected for every name but `reviewer`**, so the state cannot be set
      on a role that has no machinery behind it
- [ ] **A validator that takes `harnessId` as an input** (reqs 6, 7): the triple exists, the named
      harness is installed, can carry the model and is credentialed, and the level is one *that
      harness* declares. It must NOT be `resolveReviewerPinPatch`, which derives a harness
      (`harnessesForSelection(patch, …)[0]`) and would reproduce the very defect the required
      harness removes — pin it with a fabricated dual-harness fixture whose effort sets differ
- [ ] `resolveRoleByName` — `auto` delegates to `selectReviewer` unchanged; `pinned` runs on the
      harness the role names, checked only for a usable route; both freeze with the role's name
- [ ] A role whose model, service, harness or credential is gone reports that it cannot run and is
      **never re-pointed** through a retirement successor (req 7, and open question 1)
- [ ] Unknown role name refused, listing the roles that exist (req 13)
- [ ] Settings payload carries the roles, each resolved (server sends the resolution)

## Phase 2 — Settings (the only way a role is created, req 5)

- [ ] Role CRUD through the settings API, validated by the harness-explicit validator above
- [ ] The description (req 9) and the optional standing instructions (req 8) are separate fields —
      the description is not derived from the instructions, since a role need not have any
- [ ] Roles surface: the reviewer's row first, then the user's roles (name, description, standing
      instructions, the shared service / model / reasoning controls, the harness, delete, New role)
- [ ] The reviewer's row **embeds the existing two-slot editor** for its automatic params; it is
      not a single ordinary control set, because `selectReviewer` ranks two candidates
- [ ] The reviewer cannot be renamed or deleted, and its name is reserved (req 2)
- [ ] The harness is shown on every pinned role and filled from the single valid option where a
      model has one; it becomes a real picker where a model is carried by more than one
- [ ] **Unresolved-role view**: a role whose stored model, service or harness no longer exists
      renders its raw tuple as text, names the invalid field, and stays editable and deletable —
      it must not vanish or be silently rewritten to the first available option

## Phase 3 — Starting a role

- [ ] `--role NAME` on `shipit agent run`: the shim passes the name through, the server resolves
- [ ] `--role NAME` on `shipit session create` (req 11) — resolves **once at creation**, seeds the
      session row with the complete harness/selection/effort tuple, and then routes like any other
      session. The one-shot frozen route must NOT be carried into a child, or failover breaks days
      later under quota exhaustion
- [ ] `--role NAME` refused together with **any** what-to-run-on parameter (req 10): all five
      explicit flags on the one-shot path — matching what the server already enforces, not a
      narrowing to `--model`/`--effort` — and `--agent`/`--model` on the child-session path
- [ ] The prompt join (req 8): labelled sections, the combined prompt validated against the
      destination's limit (200k one-shot, 50k child), and a byte-for-byte passthrough when the
      role carries no standing instructions
- [ ] The roles read (req 12) — name plus description, scoped to roles
- [ ] Agent-facing guidance: map the user's intent onto a role ("review the PR" → the reviewer),
      pass an explicitly named role through unchanged, and supply no param
- [ ] Attribution for a role-started child session, not only for the one-shot consult (req 14)

## Phase 4 — Documentation split (req 15)

- [ ] The five-parameter shape leaves the injected pages and the harness system prompts
- [ ] The repository override stays documented for whoever writes repository policy, and the
      guidance keeps docs/261 phase 5's line: pass a complete target through unchanged, never
      assemble one
- [ ] `review-command-callers.test.ts` moves with it — today it asserts a complete five-flag
      invocation appears in `shipit-docs/agent.md`, which req 15 removes; it must assert the shape
      is documented in the human-facing reference instead, not simply be deleted
- [ ] A guard that fails if an injected page starts telling an agent to assemble a run out of
      parameters it cannot enumerate
