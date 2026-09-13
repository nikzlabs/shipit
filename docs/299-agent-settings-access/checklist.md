# Agent access to ShipIt settings — checklist

Design only so far. Every open question is answered; implementation can start.

## Design

- [x] `requirements.md` written from the user's words, open questions raised
- [x] Five open questions answered and recorded with dated receipts
- [x] `plan.md` written against the numbered requirements
- [x] First design review, with a removal brief — two elements cut, six claims corrected
- [x] Second design review — outcome-notice subsystem and browser-local writes cut,
      inventory corrected, claim and serialization defined

## Registry

- [ ] Control manifest built by rendering each tab and enumerating interactive
      elements, not by collecting test ids
- [ ] Coverage guard test first — every control is a descriptor or a reasoned
      exclusion, including controls with no test id
- [ ] Add test ids to the untagged settings controls (MCP env/header editor)
- [ ] Projections emit derived values only; `user_text` marks are justified
- [ ] Projection guard: an MCP fixture with a token in `args`, `env`, `headers`
      and the URL leaks none of them anywhere
- [ ] `settings-registry.ts` descriptors for the scalar global settings
- [ ] Refusal reasons: `read_only`, `secret`, `external_flow`, `browser_local`,
      `unsafe_to_display`
- [ ] `dependents()` returning computed before/after values
- [ ] Collection descriptors as narrow patches: egress hosts, roles, reviewer
      slots, MCP servers, skills
- [ ] Project scope: agent-merge permission, secret names, repository colour,
      resolved from the session's binding and frozen into the card

## Apply path

- [ ] Extract the egress add-host route body into a shared apply function
      (unsuppress default, broadcast, session-only live reload, fail-closed)
- [ ] Extract the global-settings save, with the callbacks the route supplies
- [ ] Extract the MCP writes, including `refreshAgentEnvForAllSessions`
- [ ] Per-setting-key async lock in the shared layer, used by routes and cards
- [ ] New: broadcast an applied settings change to open viewers
- [ ] Existing egress, settings and MCP route tests pass before and after

## Read path

- [ ] Session-scoped orchestrator endpoints, with `containerAccessible` set
- [ ] `agent-ops-routes.ts` relay
- [ ] `shipit settings list` / `get` / `proposals` in the shim
- [ ] Saved-versus-effective reporting where the two differ
- [ ] Browser-local settings named, with `browser_local` as read and propose

## Proposal card

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
- [ ] Tests: concurrent decision, snapshot-during-claim, per-key serialization,
      stale, moved dependent, saved-not-live, frozen project target, broadcast

## Docs

- [ ] `src/server/shipit-docs/settings.md` — commands, projections, outcomes,
      saved versus effective
- [ ] Rewrite the "change it in Settings" lines in `agent.md`, `issues.md`,
      `compose.md`, `android.md`, `github.md`, `environment.md`, `skills.md`
