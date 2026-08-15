---
issue: planning#363
title: Agent roles — implementation checklist
description: Per-phase build steps for docs/264.
---

# 264 — Agent roles: checklist

The design is [`plan.md`](./plan.md); the contract is [`requirements.md`](./requirements.md).

## Phase 1 — Storage + resolution

- [x] Role record in the credential store, keyed by name: `getRoles` (sorted by name at read time,
      no stored rank), `setRole(name, role | null)`. No reorder, no rename primitive
- [x] **Any name the user types**, with only uniqueness enforced (req 18) — no token shape, case or
      length rule; quoted where a command line needs it
- [x] Params are a discriminator — `{ kind: "pinned", … }` or `{ kind: "auto" }` — so the shipped
      reviewer is a role with automatic params rather than a second kind of object (reqs 2, 7)
- [x] `{ kind: "auto" }` is **rejected for every name but `reviewer`**
- [x] **The reviewer is synthesized in `getRoles()`**, from its two existing `getReviewerPin`
      values plus editable metadata under a reserved key — no seed record, no migration, and it is
      present on a completely empty store (req 2). Reserved key enforces no-rename/no-delete
- [x] **A validator that takes `harnessId` as an input** (reqs 6, 7): the triple exists and the
      named harness is installed and can carry the model, and the level is one *that harness*
      declares. It must NOT be `resolveReviewerPinPatch`, which derives a harness
      (`harnessesForSelection(patch, …)[0]`) and would reproduce the defect the required harness
      removes — pin it with a fabricated dual-harness fixture whose effort sets differ
- [x] Save checks **compatibility only**, never live route availability — a role must remain
      saveable while a subscription is exhausted or a provider is down
- [x] `resolveRoleByName(name, overrides, …)` — `pinned` applies overrides over the role's tuple;
      `auto` with no override delegates to `selectReviewer` unchanged. Both freeze with the role's
      name
- [x] `auto` **with a complete override**: resolve it directly and **do not call `selectReviewer`
      at all**. It can fail when neither slot is routable (`reviewer-model.ts:492-500`), and
      ranking first would reject a fully-specified valid target — reqs 10 and 16 allow *any*
      subset, which includes all of it. Pin this with a fixture where both slots are unroutable
- [x] `auto` **with a partial override**: complete from the ranked winner, which is the only thing
      that supplies the rest — this is what lets a level-only or harness-only override resolve. If
      the ranking fails, the call fails with the ranking's own reason; do not invent a base
- [x] **The distance guarantee is off for any overridden run** (req 10) — do not preserve it, and
      do not refuse the call to protect it
- [x] **A reviewer slot may be user-pinned** (`slotPlans` reads `getReviewerPin`,
      `reviewer-model.ts:317`; a pinned level is preserved, not derived, at `:540`), and docs/261
      req 8 says a pin wins. Treat a pin as a `(service, billing mode, model)` **triple**:
      overriding the *model* re-resolves where that model lives (the triple made no claim about it);
      overriding the *level* or *harness* leaves it untouched. Never drop a pinned field that still
      applies
- [x] What stays incoherent is **refused naming the parameter, on every params kind alike** — no
      re-derivation branch for the reviewer. The earlier asymmetry rested on "ShipIt chose those
      fields anyway", which the pin above disproves
- [x] A test that an **un-overridden** reviewer run still avoids the implementer (req 2 intact) and
      an **overridden** one is allowed to land on the implementer's own model — the second is the
      requirement, not a bug to be fixed later
- [x] **An overridden tuple is validated exactly as a stored one** by the same harness-explicit
      validator, and an invalid override is **refused naming the parameter**, never dropped —
      a dropped override runs something other than what was asked for
- [x] No combination is reachable via override that a role could not have been saved with
- [x] **Three failure states, not two**, because the remedy differs in each: **stranded** (gone
      model/service/harness — needs a Settings edit, never re-pointed through a retirement
      successor, req 7); **disconnected** (`auth_required` — the tuple is valid, the service lost
      its credential, so reconnect the service and do NOT tell the user to edit the role); and
      **quota-exhausted** (`all_exhausted` — says when to retry, keeps the exact tuple)
- [x] Unknown role name refused, listing the roles that exist (req 13)
- [x] Settings payload carries the roles, each resolved (server sends the resolution)

## Phase 2 — Settings (the only way a role is created, req 5)

- [x] Role CRUD through the **existing settings mutation surface**, validated by the
      harness-explicit validator above — not a new set of routes
- [x] The description (req 9) and the standing instructions (req 8) are separate fields and
      **both optional**; where both are absent, the name is the fallback. Standing instructions
      have a **stored maximum**
- [x] **A Reviewer section, not a row**: its description and standing instructions above the two
      existing slot cards, unchanged. No rename, no delete, no single model control
- [x] A separate list of pinned roles, each row a **summary** (name, description, what it resolves
      to) with open / delete — not inline controls
- [x] **A role editor** (req 17): one place editing name, description, standing instructions and
      the parameters together, saving the whole role in one write. The shared service / model /
      reasoning controls live inside it, with the harness beside them
- [x] Rename happens in the editor, for pinned roles only, with its uniqueness and failure tests;
      the reviewer is explicitly excluded
- [x] The harness is shown on every pinned role and filled from the single valid option where a
      model has one; it is a **real picker** where a model is carried by more than one — which is
      **already the case**, not future work: `deepseek-v4-flash` and `deepseek-v4-pro` run on both
      harnesses (`services.ts:250-251`). A read-only readout would leave a DeepSeek role unable to
      say which harness it means. Pin it against those two real rows
- [x] **Unresolved-role view**: a role whose stored model, service or harness no longer exists
      renders its raw tuple as text, names the invalid field, and stays editable and deletable —
      it must not vanish or be silently rewritten to the first available option

## Phase 3 — One API surface (reqs 11, 16)

- [x] **One shared target resolver behind both commands**: a role name or a complete target in, a
      resolved `(harness, selection, effort)` out, with one refusal rule. `sub-agent-target.ts`
      is that function today for the one-shot path; `session create` calls it instead of its own
      `--agent`/`--model` reading
- [x] `session create` can express a **complete target** — service, billing mode, model, harness
      and level — which it cannot today (it forwards `--agent`/`--model` bare, so a service,
      billing mode and level are unsayable)
- [x] `--role NAME` on both commands
- [x] `--role NAME` **plus any subset of the override flags** on both commands — one parser, one
      validator (req 16). Partial is the ordinary case, not a special one
- [x] **The resolver takes a base plus overrides.** Three bases: a **role** (both commands), the
      **parent session** (`session create` only), or **nothing** (both — and then the call must
      name all five itself). The child's existing `--model X` is a partial call over the *parent*
      base, so docs/261 req 10 keeps holding without a carve-out
- [x] **Unify the surface, NOT the completion semantics.** A parent does not complete a call the
      way a role does, and the differences are deliberate: `--model X` inherits no service or
      billing mode (`child-sessions.ts:519`); a harness switch clears the selection (`:521-525`);
      a level carries only where the target harness declares it and is otherwise dropped
      (`:599-604`); the stored child target stays partially optional (`:605`), so a parent may not
      even hold a complete tuple. Same flags, same parser, same refusal rule — existing child
      completion behaviour unchanged, with a regression test per bullet
- [x] The refusal narrows to **a call with no base and only some parameters** — the one shape with
      nothing to complete it from. It must NOT refuse a partial call over a parent; that is the
      shipped behaviour docs/261 req 10 guarantees, and a regression test should pin it
- [x] A role on `session create` resolves **once at creation**, seeds the session row with the
      complete tuple passed directly (not through `agent`/`model`, which drops service, billing
      mode and level), and then routes like any other session
- [x] The one-shot frozen route must NOT be carried into a child, or failover breaks days later
      under quota exhaustion
- [x] Immutable `originRoleName` on the child session row (req 14) — a snapshot, not a live link
- [x] The prompt join (req 8): labelled sections, bounded at save, and the combined prompt checked
      against the destination's limit (200k one-shot, 50k child). The no-instructions case returns
      the task unchanged **from the join** — end-to-end byte identity is not claimed, since child
      creation already trims
- [x] **Two reads** (req 12): the roles (name plus description), and the parameters this install
      has (eligible models with service and billing mode, harnesses, per-harness reasoning levels).
      The second is what makes an override name something real — shipping overrides without it
      would have the agent naming models from memory
- [x] Agent-facing guidance: map the user's intent onto a role; **relay** an override the user
      asked for and never **decide** one; default to a bare role. ShipIt cannot tell a relayed
      value from an invented one, so this rule lives only in the instructions — landed on the
      surfaces phase 3 owns (the shim's `--help`, and the footer `shipit agent params` prints
      where the temptation to assemble actually appears). The injected docs and both system
      prompts say it too, and phase 4 owns that edit so the two phases cannot collide in the
      same files

## Phase 4 — Documentation split (req 15)

- [x] The five-parameter shape leaves **every injected surface** — `shipit-docs/agent.md`, both
      harness system prompts, *and* `shipit-docs/sandbox-session.md:93-97`, which teaches the same
      five flags in prose. Derive the list from what is actually injected rather than writing it
      out, so the next page added is covered without anyone remembering
- [x] The repository override stays documented in the human-facing reference, keeping docs/261
      phase 5's line: pass a complete target through unchanged, never assemble one
- [x] The replacement guidance says a role plus an override does the same job in less — the reason
      the five-parameter form is not taught is no longer that the agent cannot use it
- [x] `review-command-callers.test.ts` inverts: add a **negative** assertion across every
      `buildAgentSystemInstructions` variant and every injected doc — the guard today only rejects
      *incomplete* runs there, so a complete one passes unnoticed
- [x] That negative assertion must catch **prose, not only a runnable command line**:
      `completeExplicitRuns` matches an invocation, and `sandbox-session.md` names the five flags
      in a sentence, so a command-shaped matcher would report success on a page that still teaches
      assembly
- [x] The positive "documented somewhere" assertion gets a **named target** —
      `docs/261-configurable-reviewer/plan.md`, which already addresses whoever writes repository
      policy. Without naming it, the assertion is dropped rather than moved

### Added after phase 3 landed

Phase 3 shipped real CLI surface that is documented nowhere, because it was deliberately scoped
out of these files so the two phases could not collide in them. Settling that debt is phase 4's
job, and the bullets above only describe the *removal* half.

- [x] **Document what phase 3 added.** `shipit-docs/sessions.md` and `shipit-docs/agent.md` both
      still described the old surface: `shipit session create` gained `--role`, `--service`,
      `--billing-mode` and `--effort` (`shipit-session.ts:105-110`), with `--agent` / `--model`
      unchanged in meaning; `shipit agent run` gained `--role NAME` plus any subset of the override
      flags; and `shipit agent roles` / `shipit agent params` are entirely new subcommands
      (`shipit-agent.ts:275`, `:328`)
- [x] **Do not quote the old un-runnable-reviewer sentence.** Every role now resolves through one
      path, so that message was replaced by one naming the role (`roles.ts:439`). The old wording is
      deliberately not reproduced anywhere in this repository's markdown — quoting it *here* would
      be the same defect the bullet forbids. No markdown quoted it before; none does now. The
      remedy text — connect a service, or wait for the quota — is unchanged
- [x] **Scope the negative assertion to injected surfaces**, never "anywhere agent-facing".
      `shipit agent params` prints the five flag names in its own output **by design** — that output
      *is* the inventory (req 12). A guard scoped to what ShipIt injects is unaffected; one written
      as "these five words never appear together" would fail on the one place they legitimately
      must appear
