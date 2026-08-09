---
issue: planning#321
title: Custom models — implementation checklist
description: Per-phase build steps for docs/252. Phases 1 and 2 are done.
---

# 252 — Custom models: checklist

The design is [`plan.md`](./plan.md); the contract is
[`requirements.md`](./requirements.md). One section per phase in that plan's
table — a phase is checked off when its PR has merged.

## Phase 1 — Catalogue and identities

- [x] `shared/catalogue/` — types, harnesses, services, derived view
- [x] Launch rows for req 15's set, with real prices and context windows
- [x] `ModelSelection` triple through types, persistence and the picker's plumbing
- [x] Migrate the three persisted selections (session, `vibe-model-id`, sub-agent defaults)
- [x] Catalogue invariants under test

## Phase 2 — Credentials and Settings

- [x] `CredentialRoute` — credential storage keyed by `(service, billing mode)`
- [x] Several credential instances per string-delivered subscription (req 12)
- [x] Per-instance secret storage, with no secret on the returned record
- [x] `ProviderAccount` becomes a projection over routes (phase 3 deletes it)
- [x] Compile-time env-key name per `(service, billing mode)`, driving `ALLOWED_ENV_KEYS`
- [x] `/api/credential-routes` CRUD + reorder, with the catalogue's rules enforced server-side
- [x] Settings → Services add-flow (service → billing mode → credential)
- [x] Re-key `accountSelectionMode` / `failoverCutoffs` to `(service, mode)`
- [x] Close the compose delivery gap, and propagate a credential change to live sessions
- [x] One writer per credential — `setApiKey` and `set_agent_env` write through
- [x] Onboarding still connects a credential and reaches a runnable model
- [ ] GLM's `zai-plan-usage` quota reader — needs phase 6's per-`(service, mode)` quota
      machinery to report into, so req 15 is unmet on quota until then

## Phase 3 — Spawn shaping and eligibility

- [ ] Base URL + credential at both spawn sites, after the scrub
- [ ] Eligibility per `(service, billing mode)` credential, replacing `hasAnyAuthForProvider`
- [ ] Resident spawn identity widened to the whole spawn-relevant tuple
- [ ] `UsageRow` gains `service_id`, `billing_mode` and the four unit rates
- [ ] `cost_usd` written under its final rule from day one
- [ ] Sub-agent usage writer widened; Codex token semantics established
- [ ] Delete `nativeModelIdsForHarness` and the `ProviderAccount` projection
- [ ] Replace phase 2's first-credential delivery with per-turn resolution

## Phases 4–9

Not started. See [`plan.md`](./plan.md)'s phase table.
