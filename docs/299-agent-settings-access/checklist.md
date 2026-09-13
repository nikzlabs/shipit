# Agent access to ShipIt settings — checklist

Design only so far. Every open question is answered; implementation can start.

## Design

- [x] `requirements.md` written from the user's words, open questions raised
- [x] Four open questions answered and recorded with dated receipts
- [x] `plan.md` written against the numbered requirements
- [x] Independent design review, with a removal brief
- [x] Review findings folded into `plan.md` — two elements cut, six claims corrected
- [x] Scope resolved: both dialogs, global Settings and per-repo Project Settings

## Registry

- [ ] Control manifest of every settings control, by `data-testid`
- [ ] Coverage guard test first — every control maps to a descriptor or a
      reasoned exclusion
- [ ] Projection allowlist per descriptor, and the credential-shaped-key guard
- [ ] `settings-registry.ts` descriptors for the scalar global settings
- [ ] `propose: { kind: "no" }` reasons: read-only, secret, external flow
- [ ] `alsoChanges` declarations and the dependent-key guard
- [ ] Collection descriptors with domain-specific item operations: egress hosts,
      roles, reviewer slots, MCP servers, skills
- [ ] Project scope descriptors: secret names, deployment config, agent-merge
      permission, repository colour; resolved per repository from the session's
      own binding

## Apply path

- [ ] Extract the egress add-host route body into a shared apply function
      (unsuppress default, SSE broadcast, live reload, fail-closed reporting)
- [ ] Extract the global-settings save into a shared apply function with the
      callbacks the route supplies
- [ ] New: broadcast an applied settings change to open viewers
- [ ] Existing egress and settings route tests pass before and after the extract

## Read path

- [ ] Session-scoped orchestrator endpoints, with `containerAccessible` set
- [ ] `agent-ops-routes.ts` relay
- [ ] `shipit settings list` / `get` in the shim
- [ ] Browser-local settings read as `unknown (browser-local)`

## Proposal card

- [ ] `shipit settings propose` — one change, validated at propose time
- [ ] Card compile, with the reason flattened, capped and rendered as attributed
- [ ] Card type, client handler, card component
- [ ] Browser-scope apply in the client, with a local stale check at click time
- [ ] Persistence: field, column, migration, rehydration, `CARD_MESSAGE_FIELDS`,
      `TRANSCRIPT_SCOPED_MESSAGES`, `EVERY_OPTIONAL_FIELD_MESSAGE`
- [ ] History round-trip and no-duplicate-on-replay tests
- [ ] Decision handler: load from persisted state, claim `pending` → `applying`,
      compare-and-set, revalidate, apply, terminal phase
- [ ] `unknown` phase recovery on restart, with no automatic retry
- [ ] Tests: concurrent decision, stale, refused, saved-but-not-live, broadcast
- [ ] Outcome notice into the agent prefix, consumed once

## Docs

- [ ] `src/server/shipit-docs/settings.md`, including the re-read instruction
- [ ] Rewrite the "change it in Settings" lines in `agent.md`, `issues.md`,
      `compose.md`, `android.md`, `github.md`, `environment.md`, `skills.md`
