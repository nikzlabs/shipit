---
issue: planning#363
title: Agent roles — implementation checklist
description: Per-phase build steps for docs/264.
---

# 264 — Agent roles: checklist

The design is [`plan.md`](./plan.md); the contract is [`requirements.md`](./requirements.md).

Reqs 9, 13 and 14 are marked provisional in `requirements.md` (open question 3). The steps below
implement them; if any is struck, the matching steps go with it.

## Phase 1 — Storage + resolution

- [ ] Role record in the credential store, keyed by name: `getRoles` (sorted by name at read time,
      no stored rank), `setRole(name, role | null)`. No reorder, no rename primitive
- [ ] Params are a discriminator — `{ kind: "pinned", … }` or `{ kind: "auto" }` — so the shipped
      reviewer is a role with automatic params rather than a second kind of object (reqs 2, 7)
- [ ] `{ kind: "auto" }` is **rejected for every name but `reviewer`**
- [ ] **The reviewer is synthesized in `getRoles()`**, from its two existing `getReviewerPin`
      values plus editable metadata under a reserved key — no seed record, no migration, and it is
      present on a completely empty store (req 2). Reserved key enforces no-rename/no-delete
- [ ] **A validator that takes `harnessId` as an input** (reqs 6, 7): the triple exists and the
      named harness is installed and can carry the model, and the level is one *that harness*
      declares. It must NOT be `resolveReviewerPinPatch`, which derives a harness
      (`harnessesForSelection(patch, …)[0]`) and would reproduce the defect the required harness
      removes — pin it with a fabricated dual-harness fixture whose effort sets differ
- [ ] Save checks **compatibility only**, never live route availability — a role must remain
      saveable while a subscription is exhausted or a provider is down
- [ ] `resolveRoleByName` — `auto` delegates to `selectReviewer` unchanged; `pinned` runs on the
      harness the role names, checked only for a usable route; both freeze with the role's name
- [ ] **Stranded and quota-exhausted report differently**: a gone model/service/harness needs a
      Settings edit and is never re-pointed through a retirement successor (req 7, open question
      1); a spent subscription says when to retry and keeps the exact tuple
- [ ] Unknown role name refused, listing the roles that exist (req 13)
- [ ] Settings payload carries the roles, each resolved (server sends the resolution)

## Phase 2 — Settings (the only way a role is created, req 5)

- [ ] Role CRUD through the **existing settings mutation surface**, validated by the
      harness-explicit validator above — not a new set of routes
- [ ] The description (req 9) and the optional standing instructions (req 8) are separate fields;
      standing instructions have a **stored maximum**
- [ ] **A Reviewer section, not a row**: its description and standing instructions above the two
      existing slot cards, unchanged. No rename, no delete, no single model control
- [ ] A separate list of pinned roles: name, description, standing instructions, the shared
      service / model / reasoning controls, the harness, rename, delete, New role
- [ ] Rename flow for pinned roles only, with its uniqueness and failure tests; the reviewer is
      explicitly excluded
- [ ] The harness is shown on every pinned role and filled from the single valid option where a
      model has one; it becomes a real picker where a model is carried by more than one
- [ ] **Unresolved-role view**: a role whose stored model, service or harness no longer exists
      renders its raw tuple as text, names the invalid field, and stays editable and deletable —
      it must not vanish or be silently rewritten to the first available option

## Phase 3 — Starting a role

- [ ] `--role NAME` on `shipit agent run`: the shim passes the name through, the server resolves
- [ ] `--role NAME` on `shipit session create` (req 11) — resolves **once at creation**, seeds the
      session row with the complete harness/selection/effort tuple, and then routes like any other
      session. It must pass a resolved selection and effort directly rather than through today's
      `agent`/`model` options, which would silently drop the service, billing mode and level
- [ ] The one-shot frozen route must NOT be carried into a child, or failover breaks days later
      under quota exhaustion
- [ ] Immutable `originRoleName` on the child session row (req 14) — a snapshot, not a live link:
      editing or deleting the role afterwards does not alter an existing child
- [ ] `--role NAME` refused together with **any** what-to-run-on parameter (req 10): all five
      explicit flags on the one-shot path — matching what the server already enforces — and
      `--agent`/`--model` on the child-session path
- [ ] The prompt join (req 8): labelled sections, bounded at save, and the combined prompt checked
      against the destination's limit (200k one-shot, 50k child). The no-instructions case returns
      the task unchanged **from the join** — end-to-end byte identity is not claimed, since child
      creation already trims
- [ ] The roles read (req 12) — name plus description, scoped to roles
- [ ] Agent-facing guidance: map the user's intent onto a role, pass an explicitly named role
      through unchanged, and supply no param

## Phase 4 — Documentation split (req 15)

- [ ] The five-parameter shape leaves **every injected surface**: `shipit-docs/agent.md` *and*
      both harness system prompts, which spell it out in full today
- [ ] The repository override stays documented in the human-facing reference, keeping docs/261
      phase 5's line: pass a complete target through unchanged, never assemble one
- [ ] `review-command-callers.test.ts` inverts: add a **negative** `completeExplicitRuns`
      assertion across every `buildAgentSystemInstructions` variant and every injected doc — the
      guard today only rejects *incomplete* runs there, so a complete one passes unnoticed — and
      move the positive "documented somewhere" assertion to the human-facing reference
