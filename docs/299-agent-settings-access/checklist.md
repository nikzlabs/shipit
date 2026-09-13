# Agent access to ShipIt settings — checklist

Design only so far. Every open question is answered; implementation can start.

## Design

- [x] `requirements.md` written from the user's words, open questions raised
- [x] Open questions answered and recorded with dated receipts
- [x] `plan.md` written against the numbered requirements
- [x] First design review, with a removal brief — two elements cut, six claims corrected
- [x] Second design review — outcome-notice subsystem and browser-local writes cut,
      inventory corrected, claim and serialization defined
- [x] Requirement 7 added: a declared setting reaches the agent automatically,
      with its description. The hand-maintained mirror is replaced by derivation
- [ ] Third design review of the revised design

## Phase 1 — the catalogue and the read path

- [ ] `shared/settings-catalogue/`: `defineSetting`, the `type` constructors
      (`bool`, `enum`, `number`, `text`, `collection`) with defaults and validation
- [ ] Declare the ~15 global scalar settings
- [ ] Derive `GlobalSettings` from the catalogue; delete the hand-written interface
- [ ] Derive the `PUT /api/settings` body type and its validation
- [ ] Derive `CredentialStore` read/write; delete the per-setting accessor pairs
- [ ] Render the standard dialog controls from `label` and `description`
- [ ] Bespoke panels bind to their catalogue entry: roles, credential routing,
      MCP, secrets, egress
- [ ] Declare browser-local settings with `scope: "browser"` and no store
- [ ] **Derivation test**: a setting added to the catalogue and nowhere else is
      readable, described, route-round-tripped and typed, with no other edit
- [ ] Residual control-coverage test: render each tab, enumerate interactive
      elements, fail on any that is neither a declaration nor a reasoned exclusion
- [ ] Add test ids to the untagged settings controls (MCP env/header editor)
- [ ] Projections emit derived values only; `user_text` marks are justified
- [ ] Projection guard: an MCP fixture with a token in `args`, `env`, `headers`
      and the URL leaks none of them anywhere
- [ ] Refusal reasons: `read_only`, `secret`, `external_flow`, `browser_local`,
      `unsafe_to_display`
- [ ] Session-scoped orchestrator endpoints, with `containerAccessible` set
- [ ] `agent-ops-routes.ts` relay
- [ ] `shipit settings list` / `get` in the shim
- [ ] Saved-versus-effective reporting where the two differ
- [ ] Project scope: agent-merge permission, secret names, repository colour,
      resolved from the session's binding

## Phase 2 — the proposal card

- [ ] Extract the egress add-host route body into a shared apply function
      (unsuppress default, broadcast, session-only live reload, fail-closed)
- [ ] Extract the global-settings save, with the callbacks the route supplies
- [ ] Extract the MCP writes, including `refreshAgentEnvForAllSessions`
- [ ] Per-setting-key async lock in the shared layer, used by routes and cards
- [ ] New: broadcast an applied settings change to open viewers
- [ ] Existing egress, settings and MCP route tests pass before and after
- [ ] `dependents()` returning computed before/after values
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
- [ ] Decision handler: load from persisted state, claim, lock, re-read,
      recompute dependents, revalidate, apply, terminal phase
- [ ] `unknown` phase recovery on restart, with no automatic retry
- [ ] Apply completes without a viewer attached
- [ ] Frozen project target: a card written against repo A refused after a rebind
- [ ] Tests: concurrent decision, snapshot-during-claim, per-key serialization,
      stale, moved dependent, saved-not-live, broadcast
- [ ] `shipit settings proposals`, and outcomes visible to a later `get`

## Docs

- [ ] `src/server/shipit-docs/settings.md` — commands, projections, outcomes,
      saved versus effective
- [ ] Rewrite the "change it in Settings" lines in `agent.md`, `issues.md`,
      `compose.md`, `android.md`, `github.md`, `environment.md`, `skills.md`
- [ ] Document how to declare a setting, so the catalogue is the obvious path
