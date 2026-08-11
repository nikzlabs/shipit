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

- [x] The Reviewer tab: two model pickers grouped by `(service, billing mode)` + reasoning —
      the composer's own grouping, reusing `ModelGroupHeader` and its billing-mode pill rather
      than a second treatment of the same pair
- [x] Each slot labelled **Auto-configured** or **Pinned**, with what it currently resolves to —
      service, mode, model, the derived harness AND the reasoning level, because a reviewer
      missing either of the last two is the half-configured thing this feature replaces
- [x] The derived default rendered as a labelled option, not a blank. Two lines (name over
      resolved value): on one line the resolved value is what truncates, which turns the
      labelled option back into a bare "Auto-configured"
- [x] The server sends the resolution; the client does not re-derive it. Nothing is optimistic —
      one edit legitimately changes BOTH slots (slot 2 ranks against slot 1), so a local guess
      would have to reimplement the ranking to stay honest
- [x] The resolution is re-broadcast when a credential, the catalogue or harness availability
      changes, so an open tab does not show a stale answer — it rides the `agent_list` SSE,
      which is already the funnel every credential change goes through. **Route usability moves
      on transitions that event does not fire for** (a quota-exhaustion stamp, an exhaustion
      deadline expiring, the `authenticating` window); `plan.md` records why those are left —
      the ranking already falls through, and an expiring deadline cannot be pushed at all
- [x] `ClaudeTab`, `CodexTab` and the Agent nav group removed (the Services-card session);
      `SubAgentDefaultsSection` removed with the store, in phase 2
- [x] Driven in the dogfood instance, screenshots against the audit — one-service and
      two-service installs, the pin/reset round trip, and a credential added and removed with
      the tab open

Services-first (audit D1) is **docs/252's**, not this feature's — no requirement here asks for
it.
## Phase 4 — Attribution

- [x] The captured resolved reviewer persisted on the consult card — `SubAgentConsultCard.runOn`,
      copied from the target captured at spawn admission, written onto the PENDING card so a
      backgrounded consult can name its model for the minutes anyone is watching it
- [x] Rendered as model, service/mode, harness and effort; the **model** is the summary's
      subject and the harness moves to the second line, because "Consulted Claude" names a CLI
      and says nothing about which weights reviewed the work
- [x] Transcript-persistence rules followed: typed field, `CARD_MESSAGE_FIELDS` (already
      registered — this is a nested field on an existing card), rehydration, history round-trip
      test. **No column and no migration**: the card serializes to one json column, the same
      exemption `BranchAutoResetCard.forced` records
- [x] Guarded on the hops that can DROP it — each of which merges or rewrites the card, so a
      regression to a replace would lose it silently: the pending → terminal patch in-turn and on
      a finalized row (`updateSubAgentConsultCard`), the boot reconcile's cancel patch, and the
      serve-path wire projection that strips the output. `getSubAgentResult` and the `/agent/result`
      route pass the stored card through verbatim, so a test there could not fail and is
      deliberately absent (cross-backend review named this hop; the honest answer was to fix the
      claim, not to add a check that cannot fail)

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

## Phase 6 — One set of controls, and a service you can choose

- [x] `components/pickers/` holds the shared control — `PickerTrigger` / `Picker` / `PickerOption`
      — and every surface renders it: the composer's model, reasoning and harness selectors, the
      Reviewer tab's three controls, Background work's two. What is shared is the **control**,
      not the state: the composer's optimistic pending pick and the Settings tab's deliberate
      non-optimism stay where they are
- [x] `ServiceSelector` (req 11) on the Reviewer tab and Background work, selecting the
      `(service, billing mode)` PAIR and carrying `BillingModePill` on each row — the same pill
      the service card and the model menu's group header use
- [x] The model menu is scoped to the chosen service (req 12); its group headers go, because a
      header repeating the service on every row answers a question already asked
- [x] Background work's native `<select>` replaced. No reasoning control there — non-turn work
      has no level, and adding one would make docs/261 a second source of requirements for a
      docs/252 setting
- [x] `canonicalModelKey` reaches the client on `EligibleModel`, so changing the service can keep
      the model. An **id** comparison gets the motivating pair wrong (`claude-opus-5` vs
      `anthropic/claude-opus-5`), and re-deriving identity in the browser is a second
      implementation of a rule the catalogue authors
- [x] Pinning stays atomic: the service control writes the whole tuple, and carries the pinned
      level only when the model survives by canonical key — a level the derived harness rejects
      is refused by the server rather than silently replaced (req 5)
- [x] Req 13 is **guarded**, not asserted in prose: `picker-consistency.test.tsx` compares the
      rendered `className` of all eight triggers against `PICKER_TRIGGER_CLASS`, and forbids a
      native `<select>` on either Settings surface. Verified by injecting a divergent class and
      watching it go red — an assertion nobody has seen fail is a claim, not a check.
      **Scope, stated precisely because the first draft of this line overstated it**: the guard
      covers trigger styling and the absence of a native control. Menu rows, icons and wording
      are not covered, so a `PickerOption.className` override could still diverge unseen
- [x] Driven in the dogfood instance: the service switch on both surfaces, and the two controls
      side by side against the reference screenshot
- [x] req 14 — a picker with no options renders nothing (`Picker`, via `Children.toArray`), so
      the Settings surfaces show prose and no dead controls on an install with no service.
      `disabled` was the first attempt and did NOT hold: Radix opens on `pointerdown`, which a
      disabled button does not suppress, so the empty menu opened anyway
- [x] The composer opts into `whenEmpty="readout"` — an inert trigger, still no menu — because
      `main` had just shipped "No model"/"Loading" there deliberately, and that is a status line
      rather than a control claiming a choice
