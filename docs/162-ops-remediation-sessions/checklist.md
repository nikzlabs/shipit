# Ops remediation sessions — checklist

## Design

- [x] Document the split between read-only Ops investigation and writable child-session remediation.
- [x] Define the read-only source access model for Ops sessions.
- [x] Define the Ops-only cross-repo remediation spawn flow.
- [x] Capture ShipIt repo vs ORC/customer repo permission behavior.

## Server

- [ ] Add read-only repo context service for Ops sessions.
- [ ] Add `shipit repo list/attach/search/cat/summary` shim commands.
- [ ] Broker read-only repo commands through `/agent-ops/*`.
- [ ] Add repo read permission checks for source context.
- [ ] Extend child session spawn with Ops-only `--repo` target support.
- [ ] Add repo write permission checks before remediation child creation.
- [ ] Build and redact incident packets for spawned remediation sessions.
- [ ] Enforce clear failure modes when no writable target repo exists.

## Client

- [ ] Render read-only repo attachments/source references in Ops context.
- [ ] Render an Ops remediation spawned-session card with target repo and diagnosis summary.
- [ ] Surface permission failures inline in the Ops transcript.

## Docs

- [ ] Update `src/server/shipit-docs/ops-session.md`.
- [ ] Update `src/server/shipit-docs/sessions.md`.
- [ ] Add prompts for source-aided diagnosis and targeted remediation spawn.

## Tests

- [ ] Shim tests for `shipit repo *` and rejected write commands.
- [ ] Worker broker tests for read-only repo context routes.
- [ ] Service tests for read/write permission gates.
- [ ] Integration test: Ops attaches read-only source, spawns writable remediation child, child opens PR.
- [ ] Integration test: read-only `ship-it` access with no write permission refuses ShipIt remediation and allows a writable ORC repo target.
