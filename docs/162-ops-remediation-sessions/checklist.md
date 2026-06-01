# Ops remediation sessions — checklist

## Design

- [x] Document that current Ops source access appears indirect through production Docker/container topology, not a narrow first-class contract.
- [x] Define the split between read-only ShipIt source diagnosis and writable child-session remediation.
- [x] Define the read-only ShipIt source access model for Ops sessions.
- [x] Define the Ops-only ShipIt fix-session spawn flow.
- [x] Capture behavior for users who can inspect ShipIt but cannot write to the upstream repository.

## Server

- [ ] Add a service that resolves the running ShipIt source ref.
- [ ] Add read-only ShipIt source snapshot/search access for Ops sessions.
- [ ] Add `shipit source status/tree/search/cat` shim commands.
- [ ] Broker read-only source commands through `/agent-ops/*`.
- [ ] Redact credentials, `.env` files, and `.git` internals from source access.
- [ ] Extend child session spawn with Ops-only `--shipit-source` target support.
- [ ] Add ShipIt source repo write permission checks before fix-session creation.
- [ ] Build and redact incident packets for spawned ShipIt fix sessions.
- [ ] Enforce a clear failure mode when the operator lacks write access to the ShipIt repo.

## Client

- [ ] Render ShipIt source ref/status in Ops context.
- [ ] Render an Ops remediation spawned-session card with source ref and diagnosis summary.
- [ ] Surface source/write-permission failures inline in the Ops transcript.

## Docs

- [ ] Update `src/server/shipit-docs/ops-session.md`.
- [ ] Update `src/server/shipit-docs/sessions.md`.
- [ ] Add prompts for source-aided ShipIt diagnosis and targeted fix-session spawn.

## Tests

- [ ] Shim tests for `shipit source *` and rejected write commands.
- [ ] Worker broker tests for read-only source context routes.
- [ ] Service tests for source redaction and source-ref resolution.
- [ ] Service tests for ShipIt repo write permission gates.
- [ ] Integration test: Ops reads ShipIt source, spawns writable ShipIt fix child, child opens PR.
- [ ] Integration test: read-only ShipIt source access with no write permission refuses fix-session creation and produces a clear error.
