---
issue: planning#363
title: Agent roles — implementation checklist
description: Per-phase build steps for docs/264.
---

# 264 — Agent roles: checklist

The design is [`plan.md`](./plan.md); the contract is [`requirements.md`](./requirements.md).

## Phase 1 — Storage + resolution

- [ ] Role record in the credential store, keyed by name: `getRoles` (sorted by name at read time,
      no stored rank), `setRole(name, role | null)`. No reorder, no rename primitive
- [ ] **Any name the user types**, with only uniqueness enforced — no token shape, case or length
      rule; quoted where a command line needs it
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
- [ ] `resolveRoleByName(name, overrides, …)` — `pinned` applies overrides over the role's tuple;
      `auto` with no override delegates to `selectReviewer` unchanged. Both freeze with the role's
      name
- [ ] **Blocked on open question 1** — what an override does to `auto` (the reviewer). Ranking then
      swapping a field yields a tuple nobody chose; replacing the ranking outright drops req 2's
      distance guarantee and says nothing about an override naming only a level or only a harness.
      `selectReviewer` ranks whole slot targets (`reviewer-model.ts:265`), so there is no existing
      constrained-partial behaviour to inherit — this has to be designed, not discovered
- [ ] **An overridden tuple is validated exactly as a stored one** by the same harness-explicit
      validator, and an invalid override is **refused naming the parameter**, never dropped —
      a dropped override runs something other than what was asked for
- [ ] No combination is reachable via override that a role could not have been saved with
- [ ] **Three failure states, not two**, because the remedy differs in each: **stranded** (gone
      model/service/harness — needs a Settings edit, never re-pointed through a retirement
      successor, req 7); **disconnected** (`auth_required` — the tuple is valid, the service lost
      its credential, so reconnect the service and do NOT tell the user to edit the role); and
      **quota-exhausted** (`all_exhausted` — says when to retry, keeps the exact tuple)
- [ ] Unknown role name refused, listing the roles that exist (req 13)
- [ ] Settings payload carries the roles, each resolved (server sends the resolution)

## Phase 2 — Settings (the only way a role is created, req 5)

- [ ] Role CRUD through the **existing settings mutation surface**, validated by the
      harness-explicit validator above — not a new set of routes
- [ ] The description (req 9) and the standing instructions (req 8) are separate fields and
      **both optional**; where both are absent, the name is the fallback. Standing instructions
      have a **stored maximum**
- [ ] **A Reviewer section, not a row**: its description and standing instructions above the two
      existing slot cards, unchanged. No rename, no delete, no single model control
- [ ] A separate list of pinned roles, each row a **summary** (name, description, what it resolves
      to) with open / duplicate / delete — not inline controls
- [ ] **A role editor** (req 17): one place editing name, description, standing instructions and
      the parameters together, saving the whole role in one write. The shared service / model /
      reasoning controls live inside it, with the harness beside them
- [ ] Rename happens in the editor, for pinned roles only, with its uniqueness and failure tests;
      the reviewer is explicitly excluded
- [ ] The harness is shown on every pinned role and filled from the single valid option where a
      model has one; it becomes a real picker where a model is carried by more than one
- [ ] **Unresolved-role view**: a role whose stored model, service or harness no longer exists
      renders its raw tuple as text, names the invalid field, and stays editable and deletable —
      it must not vanish or be silently rewritten to the first available option

## Phase 3 — One API surface (reqs 11, 16)

- [ ] **One shared target resolver behind both commands**: a role name or a complete target in, a
      resolved `(harness, selection, effort)` out, with one set of refusals. `sub-agent-target.ts`
      is that function today for the one-shot path; `session create` calls it instead of its own
      `--agent`/`--model` reading
- [ ] `session create` can express a **complete target** — service, billing mode, model, harness
      and level — which it cannot today (it forwards `--agent`/`--model` bare, so a service,
      billing mode and level are unsayable)
- [ ] `--role NAME` on both commands
- [ ] `--role NAME` **plus override flags** on both commands — one parser, one validator, one set
      of refusals (req 16). What stays refused on the **one-shot** path is a call naming no role and
      only *some* parameters: an incomplete target with nothing to complete it from (docs/261 req 7,
      untouched)
- [ ] **Blocked on open question 2** — the resolver's input type cannot be fixed until it is
      answered. The same partial-no-role shape that the one-shot path refuses is *guaranteed* on
      the child path by docs/261 req 10, which calls it deliberately opposite. Either the resolver
      gains a third input shape accepted only where a parent exists, or the child form goes — and
      the second breaks a shipped guarantee. Do not implement the resolver against "one set of
      refusals" as if this were settled
- [ ] A role on `session create` resolves **once at creation**, seeds the session row with the
      complete tuple passed directly (not through `agent`/`model`, which drops service, billing
      mode and level), and then routes like any other session
- [ ] The one-shot frozen route must NOT be carried into a child, or failover breaks days later
      under quota exhaustion
- [ ] Immutable `originRoleName` on the child session row (req 14) — a snapshot, not a live link
- [ ] The prompt join (req 8): labelled sections, bounded at save, and the combined prompt checked
      against the destination's limit (200k one-shot, 50k child). The no-instructions case returns
      the task unchanged **from the join** — end-to-end byte identity is not claimed, since child
      creation already trims
- [ ] **Two reads** (req 12): the roles (name plus description), and the parameters this install
      has (eligible models with service and billing mode, harnesses, per-harness reasoning levels).
      The second is what makes an override name something real — shipping overrides without it
      would have the agent naming models from memory
- [ ] Agent-facing guidance: map the user's intent onto a role; **relay** an override the user
      asked for and never **decide** one; default to a bare role. ShipIt cannot tell a relayed
      value from an invented one, so this rule lives only in the instructions

## Phase 4 — Documentation split (req 15)

- [ ] The five-parameter shape leaves **every injected surface** — `shipit-docs/agent.md`, both
      harness system prompts, *and* `shipit-docs/sandbox-session.md:93-97`, which teaches the same
      five flags in prose. Derive the list from what is actually injected rather than writing it
      out, so the next page added is covered without anyone remembering
- [ ] The repository override stays documented in the human-facing reference, keeping docs/261
      phase 5's line: pass a complete target through unchanged, never assemble one
- [ ] The replacement guidance says a role plus an override does the same job in less — the reason
      the five-parameter form is not taught is no longer that the agent cannot use it
- [ ] `review-command-callers.test.ts` inverts: add a **negative** assertion across every
      `buildAgentSystemInstructions` variant and every injected doc — the guard today only rejects
      *incomplete* runs there, so a complete one passes unnoticed
- [ ] That negative assertion must catch **prose, not only a runnable command line**:
      `completeExplicitRuns` matches an invocation, and `sandbox-session.md` names the five flags
      in a sentence, so a command-shaped matcher would report success on a page that still teaches
      assembly
- [ ] The positive "documented somewhere" assertion gets a **named target** —
      `docs/261-configurable-reviewer/plan.md`, which already addresses whoever writes repository
      policy. Without naming it, the assertion is dropped rather than moved
