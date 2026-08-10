---
issue: planning#349
title: Configurable reviewer — implementation checklist
description: Per-phase build steps for docs/260.
---

# 260 — Configurable reviewer: checklist

The design is [`plan.md`](./plan.md); the contract is [`requirements.md`](./requirements.md).

## Phase 0 — Model family in the catalogue

- [ ] `family` on `ModelDef`, authored per model (it is derivable from neither the service nor
      the id — see `plan.md`)
- [ ] Catalogue invariant: every model declares a family, and one model id offered by two
      services declares the same family in both

## Phase 1 — Storage, auto-configuration and the ranking

- [ ] Two reviewer slots in `CredentialStore`, each an optional
      `(serviceId, billingMode, modelId, reasoningEffort)` — unset kept distinct from
      resolved, as `nonTurnModel` already does
- [ ] Auto-configuration resolves at **read time**, never written back, so adding a service
      improves the reviewer with no user action and no migration
- [ ] `firstEligibleNonTurnSelection` gains a `skipFamily`, for reviewer 2's derived default
- [ ] The distance ranking, as an ordered predicate list over the resolved implementer
- [ ] A reviewer whose credential or harness went away is skipped, not selected and failed
- [ ] Unit tests: each ranking tier, the one-family install, both slots unset, a retired pin,
      and a gateway-served model of the same family as the implementer (the case family exists
      to catch)

## Phase 2 — `--role reviewer`, and the explicit-only spawn

- [ ] `--role reviewer` on `shipit agent run`, mutually exclusive with `--agent`/`--model`/effort
- [ ] `sub-agent.ts` reads the role resolution or the explicit flags, never a stored default
- [ ] `SubAgentDefaults` deleted: store, wire shape, settings route, bootstrap
- [ ] `--agent X` keeps working, and an omitted `--agent` stays a hard error
- [ ] Usage attribution for a review is unchanged (req 9)

## Phase 3 — Settings

- [ ] The Reviewer tab: two model pickers grouped by `(service, billing mode)` + reasoning
- [ ] Each slot labelled **Auto-configured** or **Pinned**, with what it currently resolves to
- [ ] The derived default rendered as a labelled option, not a blank
- [ ] The server sends the resolution; the client does not re-derive it
- [ ] `SubAgentDefaultsSection`, `ClaudeTab`, `CodexTab` and the Agent nav group removed
- [ ] Services is the first tab and the default (audit D1)
- [ ] Driven in the dogfood instance, screenshots against the audit

## Phase 4 — Docs

- [ ] `CLAUDE.md`'s review rule names the role, not the backend
- [ ] `src/server/shipit-docs/` updated for the new `agent run` surface
- [ ] Cross-backend review, findings applied
