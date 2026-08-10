---
issue: planning#349
title: Configurable reviewer — implementation checklist
description: Per-phase build steps for docs/260.
---

# 260 — Configurable reviewer: checklist

The design is [`plan.md`](./plan.md); the contract is [`requirements.md`](./requirements.md).

## Phase 1 — Storage, defaults and the ranking

- [ ] Two reviewer slots in `CredentialStore`, each an optional
      `(serviceId, billingMode, modelId, reasoningEffort)` — unset kept distinct from
      resolved, as `nonTurnModel` already does
- [ ] `firstEligibleNonTurnSelection` gains a `skipServiceId`, for reviewer 2's derived default
- [ ] The distance ranking, as an ordered predicate list over the resolved implementer
- [ ] A reviewer whose credential or harness went away is skipped, not selected and failed
- [ ] Unit tests: each ranking tier, the one-service install, both slots unset, a retired pin

## Phase 2 — `--role reviewer`, and the explicit-only spawn

- [ ] `--role reviewer` on `shipit agent run`, mutually exclusive with `--agent`/`--model`/effort
- [ ] `sub-agent.ts` reads the role resolution or the explicit flags, never a stored default
- [ ] `SubAgentDefaults` deleted: store, wire shape, settings route, bootstrap
- [ ] `--agent X` keeps working, and an omitted `--agent` stays a hard error
- [ ] Usage attribution for a review is unchanged (req 9)

## Phase 3 — Settings

- [ ] The Reviewer tab: two model pickers grouped by `(service, billing mode)` + reasoning
- [ ] The derived default rendered as a labelled option, not a blank
- [ ] `SubAgentDefaultsSection`, `ClaudeTab`, `CodexTab` and the Agent nav group removed
- [ ] Services is the first tab and the default (audit D1)
- [ ] Driven in the dogfood instance, screenshots against the audit

## Phase 4 — Docs

- [ ] `CLAUDE.md`'s review rule names the role, not the backend
- [ ] `src/server/shipit-docs/` updated for the new `agent run` surface
- [ ] Cross-backend review, findings applied
