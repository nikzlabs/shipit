---
issue: planning#349
title: Configurable reviewer — implementation checklist
description: Per-phase build steps for docs/261.
---

# 261 — Configurable reviewer: checklist

The design is [`plan.md`](./plan.md); the contract is [`requirements.md`](./requirements.md).

## Phase 0 — Model identity in the catalogue

- [x] `canonicalModelKey` (identity) and `family` (lineage) per offering — two fields, because
      one cannot both prove two spellings are the same model and express that Opus and Sonnet
      are siblings
- [x] Declared once and referenced, not retyped per offering — a copied free-form string makes
      a typo compile and pass
- [x] Catalogue invariants: every offering declares both; every `canonicalModelKey` group
      agrees on its `family`. NOT "same id across services" — the motivating pair
      (`claude-opus-5` vs `anthropic/claude-opus-5`) has different ids, which is the whole
      point

## Phase 1 — Storage, auto-configuration and the ranking

- [x] Two reviewer slots in `CredentialStore`, each an optional
      `(serviceId, billingMode, modelId, reasoningEffort)` — unset kept distinct from
      resolved, as `nonTurnModel` already does
- [x] Auto-configuration resolves at **read time**, never written back, so adding a service
      improves the reviewer with no user action and no migration
- [x] The derived reviewer is **complete**, reasoning level included (req 5) — a ShipIt-authored
      default effort per harness
- [x] Pinning is atomic: editing any field pins the whole resolved tuple; a *Reset to auto*
      action returns the slot to derivation — `ReviewerPin` makes a half-pinned slot
      inexpressible (the effort is required) and `setReviewerPin(slot, null)` is the reset.
      The *control* that calls them is phase 3's.
- [x] ONE ranking function derives both slots — reviewer 2 ranks against reviewer 1 rather than
      filtering by family, so a one-family install still derives a second reviewer
- [x] Reviewer harness derivation prefers a harness that is NOT the implementer's, rather than
      `harnessForNonTurnSelection`'s arbitrary first-installed
- [x] Only targets with a usable **route** are ranked; `all_exhausted` falls through to the next
      reviewer instead of failing the review
- [x] Resolution is captured ONCE at spawn admission and is immutable through retries —
      `selectReviewer` returns a frozen target, which is the half phase 1 can deliver. The
      admission call site that captures it is phase 2's, with the spawn.
- [x] Unit tests: each ranking tier, the one-family install, both slots unset, a retired pin,
      a gateway-served model with the same `canonicalModelKey` as the implementer, and the
      same-model-different-harness case that must NOT outrank a different model

## Phase 2 — `--role reviewer`, and the fully explicit spawn

- [x] `--role reviewer`, mutually exclusive with every explicit flag — refused at the shim (for
      the message) and at the HTTP edge (for the guarantee)
- [x] The explicit shape end to end — `--agent`, `--service`, `--billing-mode`, `--model`,
      `--effort` — through the CLI parser, worker relay body, HTTP route schema,
      `RunSubAgentInput`, validation, spawn and attribution
- [x] **Fix the pre-existing drop**: `--model` was parsed and never reached the route, and no
      effort flag was parsed at all. Both now cross every hop, with a per-hop test
- [x] An incomplete explicit call is REFUSED — `fallbackModel` is gone with the store, so the
      spawn has nothing left to fall back to
- [x] `sub-agent.ts` reads the role resolution or the explicit arguments, never a stored default;
      the target is captured once, at admission, and a role arrives already routed
- [x] `SubAgentDefaults` deleted: store, load-time migration, wire shape, settings route,
      bootstrap — and `SubAgentDefaultsSection`, orphaned when the vendor tabs went (its phase 3
      entry moved here, since phase 3 has no reason to touch it now)
- [x] The refusal repeated at the EXECUTION boundary: `SubAgentSpawnRequest.model` is required
      and the worker's `/agent/spawn` refuses a spawn naming none — the orchestrator's edge is
      where an incomplete call is refused, but the worker is where a missing model would be
      filled in by the CLI (added after cross-backend review)
- [x] The reviewer ranks against the resident process's spawn stamp, not the mutable session
      row: `set_model` mid-turn otherwise hands the work back to the model that wrote it
      (added after cross-backend review)
- [x] Caller gates (session, pin, depth, runner, budget) precede target resolution, and the cap
      slot is spent only once every refusal is behind us

## Phase 3 — Settings

- [ ] The Reviewer tab: two model pickers grouped by `(service, billing mode)` + reasoning
- [ ] Each slot labelled **Auto-configured** or **Pinned**, with what it currently resolves to
- [ ] The derived default rendered as a labelled option, not a blank
- [ ] The server sends the resolution; the client does not re-derive it
- [ ] The resolution is re-broadcast when a credential, the catalogue or harness availability
      changes, so an open tab does not show a stale answer
- [x] `ClaudeTab`, `CodexTab` and the Agent nav group removed (the Services-card session);
      `SubAgentDefaultsSection` removed with the store, in phase 2
- [ ] Driven in the dogfood instance, screenshots against the audit

Services-first (audit D1) is **docs/252's**, not this feature's — no requirement here asks for
it.
## Phase 4 — Attribution

- [ ] The captured resolved reviewer persisted on the consult card — today it carries only
      `subAgentId`, duration and cost (`chat.ts:51`), so it cannot say what ran
- [ ] Rendered as model, service/mode, harness and effort; "Consulted Claude" is misleading
      once Claude Code can drive a non-Anthropic model
- [ ] Transcript-persistence rules followed: typed field, column + migration,
      `CARD_MESSAGE_FIELDS`, rehydration, history round-trip test

## Phase 5 — Product-owned callers

- [x] `client/utils/compose-review-body.ts` — the UI generated `--agent <reviewerAgentId>`;
      this was ShipIt choosing the reviewer in the product's own words. It now emits
      `--role reviewer`, and the *registry* check went with it: "is a different backend
      installed?" was the same choice one step earlier
- [x] `agents/claude/system-prompt.md`, `agents/codex/system-prompt.md` — both now teach the
      two shapes (role for a review, all five flags otherwise) and the child-session
      contrast, so the three paths are not collapsed into one rule
- [x] `prompts/spec-discipline.md` — "prefer a backend other than your own" becomes the role's job
- [x] `CLAUDE.md`'s review rule names the role, not the backend
- [x] `src/server/shipit-docs/` updated for the new `agent run` surface — `agent.md`
      (both shapes, and the three-path table), `spec-discipline.md`, `sandbox-session.md`
- [x] A test per product-owned command: `review-command-callers.test.ts` for the prompts and
      the agent-facing pages, `compose-review-body.test.ts` for the generated message. The
      check is "no `shipit agent run --agent VALUE` that does not also name the other four",
      which catches a regression to the old shape without forbidding the documented
      explicit path

