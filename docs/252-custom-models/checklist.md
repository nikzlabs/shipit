---
issue: planning#321
title: Custom models — implementation checklist
description: Per-phase build steps for docs/252. Phases 1, 2, 3, 8 and 9 are done.
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
- [x] Cross-backend review, findings applied (see `plan.md`)
- [ ] GLM's `zai-plan-usage` quota reader — needs phase 6's per-`(service, mode)` quota
      machinery to report into, so req 15 is unmet on quota until then

## Phase 5 — Credential-failure policy (carried from phase 2)

- [ ] Routing controls for a **string-backed** subscription group. `zai:sub` already
      carries cutoffs and a selection mode in the settings payload; the controls live
      inside `ProviderAccountsCard` keyed by provider and need extracting. Deferred
      because they do nothing until failover is real for these credentials — the
      fallback *order*, which does change delivery today, already ships.

## Phase 3 — Spawn shaping and eligibility

- [x] Base URL + credential at both Claude spawn sites, after the scrub
- [x] Codex pointed at a service through a written `model_providers` block
- [x] The resolver as a callable component (`service-routing.ts`), for phase 7's second caller
- [x] Eligibility per `(service, billing mode)` credential, replacing `hasAnyAuthForProvider`
- [x] Turn routing scoped to the selected mode, closing the `sub` → `claude-api-key` leak
- [x] Resident spawn identity widened to the whole spawn-relevant tuple
- [x] `UsageRow` gains `service_id`, `billing_mode` and the four unit rates *(landed early — see `plan.md`)*
- [x] `cost_usd` written under its final rule from day one, by both producers
- [x] Sub-agent usage writer widened; Codex token semantics measured and normalized
- [x] Composer picker split into harness and model, model rows grouped by service
- [x] Delete `nativeModelIdsForHarness` and the hand-kept `METERED_MODELS` set
- [x] Cross-backend review, findings applied (see `plan.md`)
- [ ] Delete the `ProviderAccount` projection. Still load-bearing: the docs/150 account
      machinery — the quota-aware walk, cutoffs, benching, failover — is keyed by `AgentId`
      and phase 3 delegates to it rather than reimplementing it. Retiring the projection
      means re-keying that machinery, which is **phase 6**'s work (`(service, mode) → route`).
- [ ] Replace the first-credential delivery within one mode. Delivery hands the worker the
      first credential in order and the turn now authenticates with exactly that one, so the
      two agree; choosing a *different* one is req 12's failover and belongs to **phase 5**.
- [ ] The **sub-agent defaults** picker still has no service axis. Its list is now
      credential-filtered (it reads the same eligible ids), and the store re-resolves a
      written id to a real triple biased toward the harness's own vendor — so it cannot
      store a row that names nothing. What it cannot yet express is "this id, from THAT
      service", which follows the session picker in **phase 4**.
- [ ] `authConfigured` leaves `AgentInfo`. Its MEANING moved here — "this harness has at least
      one eligible model" — which is the part req 2 needed; the rename across its six call
      sites is churn with no behaviour change and was not taken.

## Phases 4–9

Not started. See [`plan.md`](./plan.md)'s phase table.
