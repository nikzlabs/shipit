# Agent access to ShipIt settings — checklist

Design only. **One open question blocks implementation** — how requirement 4
reads in `RUNTIME_MODE=local`, where the click gate is unenforceable for reasons
that predate this feature. See `requirements.md` → Open questions.

## Design

- [x] `requirements.md` written from the user's words, open questions raised
- [x] Scope and posture questions answered, with dated receipts
- [x] `plan.md` written against the numbered requirements
- [x] First review — two elements cut, six claims corrected
- [x] Second review — outcome-notice subsystem and browser-local writes cut,
      inventory corrected, claim and serialization defined
- [x] Requirement 7 added: a declared setting reaches the agent automatically,
      with its description. The hand-maintained mirror replaced by derivation
- [x] Third review — dependents machinery, the proposals command and the test-id
      obligation cut; field-level declarations, server-only baseline, writer
      inventory, restart ordering and reconnect sync added
- [ ] Answer the local-mode question for requirement 4

## Phase 1 — the catalogue and the read path

- [ ] `shared/settings-catalogue/`: `defineSetting`, the `type` constructors
      (`bool`, `enum`, `number`, `text`, `collection`) with defaults and validation
- [ ] Declare the ~15 global scalar settings
- [ ] Derive `GlobalSettings`; delete the hand-written interface
- [ ] Derive the `PUT /api/settings` body type and its validation
- [ ] Derive `CredentialStore` read/write; drop the duplicated defaults and
      validation, keeping a named accessor only where it reads better
- [ ] Render the standard dialog controls from `label` and `description`
- [ ] **Field-level** declarations for the bespoke panels, with each control
      bound to its own field: roles, credential routing, MCP, secrets, egress
- [ ] Declare browser-local settings with `scope: "browser"` and no store
- [ ] **Derivation test**: a setting added to the catalogue and nowhere else is
      readable, described, route-round-tripped and typed, with no other edit
- [ ] Field-level test: a new MCP form field bound to the panel entry fails
- [ ] Residual control-coverage test, exercising conditional and nested forms
- [ ] Projections emit derived values only; `user_text` marks are justified
- [ ] Projection guard: an MCP fixture with a token in `args`, `env`, `headers`
      and the URL leaks none of them anywhere
- [ ] Refusal reasons: `read_only`, `secret`, `external_flow`, `browser_local`,
      `unsafe_to_display`
- [ ] Session-scoped orchestrator endpoints, with `containerAccessible` set
- [ ] `agent-ops-routes.ts` relay
- [ ] `shipit settings list` / `get` in the shim
- [ ] Saved-versus-effective reporting where the two differ
- [ ] Unreadable entries degrade per entry; `list` never aborts
- [ ] Project scope: agent-merge permission, secret names, repository colour

## Phase 2 — the proposal card

- [ ] Extract every writer into the shared apply layer: `PUT /api/settings`,
      the egress routes **and** the egress card handler's global add,
      `/api/updates/channel`, the repo settings route including merge-revoke's
      request cancellation and `repo_list` broadcast, and the MCP writes with
      `refreshAgentEnvForAllSessions`
- [ ] Per-setting-key async lock in the shared layer, used by every writer
- [ ] New: broadcast an applied settings change to open viewers
- [ ] Refetch settings on reconnect; an open editor keeps its draft and warns
- [ ] Existing egress, settings, updates, repo and MCP route tests pass before
      and after the extraction
- [ ] `baseline(ctx)` per declaration — a server-only revision over the whole
      stored value, never emitted
- [ ] Collection item operations as narrow patches, never whole-list replacement
- [ ] `shipit settings propose` — one change, validated at propose time, returns
      the card id without waiting
- [ ] Card compile, with the reason flattened, capped and rendered as attributed
- [ ] Card type, client handler, card component
- [ ] Persistence: field, column, migration, rehydration, `CARD_MESSAGE_FIELDS`,
      `TRANSCRIPT_SCOPED_MESSAGES`, `EVERY_OPTIONAL_FIELD_MESSAGE`
- [ ] History round-trip and no-duplicate-on-replay tests
- [ ] Atomic claim: conditional persisted flip plus recorded-card sync, before
      any await, not via `persistCardTransition`
- [ ] Decision handler: load by owning session plus card id, claim, lock,
      re-read against `baseline`, revalidate, apply, terminal phase
- [ ] Boot recovery converts interrupted claims to `unknown` before the decision
      handler accepts anything; no automatic retry
- [ ] Settlement independent of a surviving runner; take the post-turn work lease
      where a step needs one
- [ ] Frozen project target: a card written against repo A refused after a rebind
- [ ] Tests: concurrent decision, snapshot-during-claim, baseline-not-`from`,
      serialization ordering, saved-not-live, restart at both sides of the side
      effect, unbound session, reconnect, broadcast
- [ ] Outcomes visible to a later `get`

## Docs

- [ ] `src/server/shipit-docs/settings.md` — commands, projections, outcomes,
      saved versus effective
- [ ] Rewrite the "change it in Settings" lines in `agent.md`, `issues.md`,
      `compose.md`, `android.md`, `github.md`, `environment.md`, `skills.md`
- [ ] Document how to declare a setting, so the catalogue is the obvious path
