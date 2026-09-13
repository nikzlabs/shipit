# Agent access to ShipIt settings — checklist

Design only so far. Implementation starts once the design is agreed.

## Design

- [x] `requirements.md` written from the user's words, open questions raised
- [x] Open questions answered and recorded with dated receipts
- [x] `plan.md` written against the numbered requirements
- [ ] Independent review of the design against every numbered requirement
- [ ] Confirm the Project Settings scope question in `plan.md` → "Interpretation to confirm"

## Registry

- [ ] Coverage guard test first — every dialog setting needs a descriptor
- [ ] `settings-registry.ts` descriptors for the scalar global settings
- [ ] Secret non-exposure guard test
- [ ] Collection descriptors: egress hosts, roles, MCP servers, skills
- [ ] Project Settings scope: secret names, agent-merge permission

## Read path

- [ ] Session-scoped orchestrator endpoints
- [ ] `agent-ops-routes.ts` relay
- [ ] `shipit settings list` / `get` in the shim
- [ ] Browser-local snapshot over the per-session WebSocket

## Proposal card

- [ ] `shipit settings propose` with propose-time validation
- [ ] Card compile, with the reason flattened and capped
- [ ] Card type, client handler, card component
- [ ] Persistence: field, column, migration, rehydration, `CARD_MESSAGE_FIELDS`,
      `TRANSCRIPT_SCOPED_MESSAGES`, `EVERY_OPTIONAL_FIELD_MESSAGE`
- [ ] History round-trip and no-duplicate-on-replay tests
- [ ] Decision handler with the re-read staleness check
- [ ] Stale-apply and partial-failure tests
- [ ] Outcome notice into the agent prefix, consumed once

## Docs

- [ ] `src/server/shipit-docs/settings.md`
- [ ] Rewrite the "change it in Settings" lines in `agent.md`, `issues.md`,
      `compose.md`, `android.md`, `github.md`, `environment.md`, `skills.md`
