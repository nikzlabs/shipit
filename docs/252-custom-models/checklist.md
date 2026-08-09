---
issue: planning#321
title: Custom models — implementation checklist
description: Per-phase build steps for docs/252. Phases 1, 2, 3, 5, 7, 8 and 9 are done.
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

## Phase 5 — Credential-failure policy

- [x] `credential-failure-policy.ts` — req 12's branch, asked by every gate
- [x] The `auth_required` handler stops a key-authenticated turn instead of entering
      vendor re-auth: no token heal, no refresher nudge, no "sign in" copy
- [x] The same-turn quota retry gated on the billing mode, as account benching already was
- [x] Codex coverage established and closed — a `turn/start` quota rejection arrives as an
      adapter `error`, which neither the retry nor the exhaustion stamp watched
- [x] Benching widened to a string-delivered subscription credential; a metered key refused
- [x] Which of a subscription's string credentials a turn takes — order, selection mode,
      benched skipped, `all_exhausted` when none is left
- [x] An already-pinned session moves off a spent credential and the move is **persisted**
      (which phase 3's stale-route drop asserted and did not do)
- [x] Per-credential env delivery, so the credential a turn authenticates with is the one
      it is attributed to
- [x] Routing controls for a **string-backed** subscription group — the selection mode, on
      the card. Carried from phase 2.
- [x] Cross-backend review, findings applied (see `plan.md`)
- [ ] **Failover cutoffs** for a string-backed subscription. A cutoff is a percentage of a
      reported quota and nothing reports one for these credentials until phase 6 builds
      `zai-plan-usage`, so the control would be inert. Belongs with the quota reader,
      not with failover.

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
- [x] Cross-backend review — nine findings, eight fixed (see `plan.md`)
- [ ] Delete the `ProviderAccount` projection. Still load-bearing: the docs/150 account
      machinery — the quota-aware walk, cutoffs, benching, failover — is keyed by `AgentId`
      and phase 3 delegates to it rather than reimplementing it. Retiring the projection
      means re-keying that machinery, which is **phase 6**'s work (`(service, mode) → route`).
- [x] Replace the first-credential delivery within one mode. Closed in **phase 5**: every
      stored credential is delivered under a name of its own and spawn shaping sources the
      pinned route's, so choosing a different one no longer means authenticating with the
      group's first.
- [ ] The **sub-agent defaults** picker still has no service axis. Its list is
      credential-filtered, and the service layer now tells the store which `(service, mode)`
      the id was chosen from, so a key-only install no longer stores an unreachable `sub`
      triple. What it still cannot express is a deliberate choice *between* two services
      offering the same id, which follows the session picker in **phase 4**.
- [ ] The new-session picker reads the globally-active session for its **harness** display.
      Pre-existing (the combined picker did the same); found by review and recorded rather
      than fixed here, since untangling it is composer work with no bearing on billing.
- [ ] `authConfigured` leaves `AgentInfo`. Its MEANING moved here — "this harness has at least
      one eligible model" — which is the part req 2 needed; the rename across its six call
      sites is churn with no behaviour change and was not taken.

## Phase 7 — Non-turn work

- [x] `CredentialStore.nonTurnModel` — the pinned `(service, billing mode, model)`, with
      unset kept as a distinct state rather than filled in with the resolved answer
- [x] `non-turn-model.ts` — the resolver: req 9's derived default (first service, first
      billing mode, first model), the derived harness (first installed harness offering it),
      and the credential route + spawn shaping for it
- [x] A retired pin resolves through its successor at read time (req 13), so one retirement
      cannot fire req 9's notice on every session forever
- [x] `applyServiceRouting` / `codexProviderArgs` moved to `shared/spawn-routing.ts` so the
      orchestrator's own CLI shell-out shapes a spawn from the same source as a turn
- [x] `session-namer.ts` takes the resolved target, forwards the model, shapes the
      environment, and returns telemetry instead of discarding it
- [x] `services/non-turn-work.ts` — the brokered generation over `runner.spawnSubAgent`,
      wired as the production `generateText` (an injected one still wins)
- [x] A blank PR-description generation normalizes into the generic fallback (req 9's
      *change*), with the rejection path and the blank-success path tested separately
- [x] Usage rows for both halves, with their own attribution, through `turn-attribution.ts`
- [x] The dismissible failure notice: typed card, `messages.non_turn_failure` column +
      migration, `emitChatCard`, `CARD_MESSAGE_FIELDS`, `TRANSCRIPT_SCOPED_MESSAGES`,
      dismiss endpoint, history round-trip test
- [x] Settings → Services → **Background work**: the visible setting, with the derived
      default labelled and the derived harness shown as a fact rather than a control
- [x] Cross-backend review — nine findings, eight fixed (see `plan.md`)
- [ ] **Codex-harness non-turn work spends money and records no usage row.** `codex exec`
      reports no telemetry through the orchestrator's shell-out, and an all-zero row priced
      from the catalogue's rates would assert "this was free" — a wrong number rather than a
      missing one. Closing it means either measuring `codex exec --json`'s event stream
      (unverified here) or narrowing req 16's label. **Phase 6** owns the usage view and the
      decision.

## Phases 4 and 6

Not started. See [`plan.md`](./plan.md)'s phase table. (Phases 8 and 9 have landed; their
notes are in `plan.md` rather than here, since both landed ahead of this checklist's
per-phase sections.)
