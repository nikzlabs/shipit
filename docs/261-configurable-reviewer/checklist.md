---
issue: planning#349
title: Configurable reviewer — implementation checklist
description: Per-phase build steps for docs/261.
---

# 261 — Configurable reviewer: checklist

The design is [`plan.md`](./plan.md); the contract is [`requirements.md`](./requirements.md).

## Phase 0 — Model identity in the catalogue

- [ ] `canonicalModelKey` (identity) and `family` (lineage) per offering — two fields, because
      one cannot both prove two spellings are the same model and express that Opus and Sonnet
      are siblings
- [ ] Declared once and referenced, not retyped per offering — a copied free-form string makes
      a typo compile and pass
- [ ] Catalogue invariants: every offering declares both; every `canonicalModelKey` group
      agrees on its `family`. NOT "same id across services" — the motivating pair
      (`claude-opus-5` vs `anthropic/claude-opus-5`) has different ids, which is the whole
      point

## Phase 1 — Storage, auto-configuration and the ranking

- [ ] Two reviewer slots in `CredentialStore`, each an optional
      `(serviceId, billingMode, modelId, reasoningEffort)` — unset kept distinct from
      resolved, as `nonTurnModel` already does
- [ ] Auto-configuration resolves at **read time**, never written back, so adding a service
      improves the reviewer with no user action and no migration
- [ ] The derived reviewer is **complete**, reasoning level included (req 5) — a ShipIt-authored
      default effort per harness
- [ ] Pinning is atomic: editing any field pins the whole resolved tuple; a *Reset to auto*
      action returns the slot to derivation
- [ ] ONE ranking function derives both slots — reviewer 2 ranks against reviewer 1 rather than
      filtering by family, so a one-family install still derives a second reviewer
- [ ] Reviewer harness derivation prefers a harness that is NOT the implementer's, rather than
      `harnessForNonTurnSelection`'s arbitrary first-installed
- [ ] Only targets with a usable **route** are ranked; `all_exhausted` falls through to the next
      reviewer instead of failing the review
- [ ] Resolution is captured ONCE at spawn admission and is immutable through retries
- [ ] Unit tests: each ranking tier, the one-family install, both slots unset, a retired pin,
      a gateway-served model with the same `canonicalModelKey` as the implementer, and the
      same-model-different-harness case that must NOT outrank a different model

## Phase 2 — `--role reviewer`, and the fully explicit spawn

- [ ] `--role reviewer`, mutually exclusive with every explicit flag
- [ ] The explicit shape end to end — `--agent`, `--service`, `--billing-mode`, `--model`,
      `--effort` — through the CLI parser, worker relay body, HTTP route schema,
      `RunSubAgentInput`, validation, spawn and attribution
- [ ] **Fix the pre-existing drop**: `--model` is parsed today and never reaches the route
      (`api-routes-agent.ts:122` declares `{ agentId, prompt, depth }`), and no effort flag is
      parsed at all
- [ ] An incomplete explicit call is REFUSED — `fallbackModel` does not survive on this path
- [ ] `sub-agent.ts` reads the role resolution or the explicit arguments, never a stored default
- [ ] `SubAgentDefaults` deleted: store, wire shape, settings route, bootstrap

## Phase 3 — Settings

- [ ] The Reviewer tab: two model pickers grouped by `(service, billing mode)` + reasoning
- [ ] Each slot labelled **Auto-configured** or **Pinned**, with what it currently resolves to
- [ ] The derived default rendered as a labelled option, not a blank
- [ ] The server sends the resolution; the client does not re-derive it
- [ ] The resolution is re-broadcast when a credential, the catalogue or harness availability
      changes, so an open tab does not show a stale answer
- [ ] `SubAgentDefaultsSection`, `ClaudeTab`, `CodexTab` and the Agent nav group removed
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

- [ ] `client/utils/compose-review-body.ts:117` — the UI generates `--agent <reviewerAgentId>`;
      this is ShipIt choosing the reviewer in the product's own words
- [ ] `agents/claude/system-prompt.md:17`, `agents/codex/system-prompt.md:18`
- [ ] `prompts/spec-discipline.md:8` — "prefer a backend other than your own" becomes the role's job
- [ ] `CLAUDE.md`'s review rule names the role, not the backend
- [ ] `src/server/shipit-docs/` updated for the new `agent run` surface
- [ ] A test per product-owned command

