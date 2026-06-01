# Ops remediation sessions — checklist

## Design

- [x] Document that current Ops source access appears indirect through production Docker/container topology, not a narrow first-class contract.
- [x] Define the split between read-only ShipIt source diagnosis and writable child-session remediation.
- [x] Define the read-only ShipIt source access model for Ops sessions.
- [x] Define the Ops-only ShipIt fix-session spawn flow.
- [x] Capture behavior for users who can inspect ShipIt but cannot write to the upstream repository.

## Server

- [x] Add a service that resolves the running ShipIt source ref. (`services/shipit-source.ts`)
- [x] Add read-only ShipIt source snapshot/search access for Ops sessions.
- [x] Refuse source tree/search/cat when no exact deployed ref or current server checkout is available, unless an explicit approximate mode is requested. (`status.available=false` ⇒ tree/search/cat 503; spawn requires `--approximate` for a non-exact ref.)
- [x] Add `shipit source status/tree/search/cat` shim commands.
- [x] Broker read-only source commands through `/agent-ops/*`.
- [x] Redact credentials, `.env` files, and `.git` internals from source access. (`isRedactedSourcePath`)
- [x] Extend child session spawn with Ops-only `--shipit-source` target support.
- [x] Base the spawned fix session on the exact inspected source ref, not default branch head. (`repoUrlOverride` + `base = ref`)
- [x] Add ShipIt source repo write permission checks before fix-session creation. (`checkRepoWriteAccess`)
- [x] Build incident packets for spawned ShipIt fix sessions. (`buildShipitFixPrompt`)
- [x] Enforce a clear failure mode when the operator lacks write access to the ShipIt repo. (403 with a "produce an incident report" hint.)
- [ ] Redact raw log excerpts copied into incident packets (the diagnosis prompt is passed through verbatim today).

## Client

- [ ] Render ShipIt source ref/status in Ops context.
- [ ] Render an Ops remediation spawned-session card with source ref and diagnosis summary. (v1 reuses the generic `session_spawned` card.)
- [ ] Surface source/write-permission failures inline in the Ops transcript. (Reuses the generic `session_spawn_failed` card; a dedicated card is follow-up.)

## Docs

- [x] Update `src/server/shipit-docs/ops-session.md`.
- [x] Update `src/server/shipit-docs/sessions.md`.
- [ ] Add prompts for source-aided ShipIt diagnosis and targeted fix-session spawn.

## Tests

- [x] Shim tests for `shipit source *` and rejected write commands.
- [x] Worker broker tests for read-only source context routes.
- [x] Service tests for source redaction and source-ref resolution.
- [x] Service tests for ShipIt repo write permission gates / fix-target resolution. (`resolveShipitFixTarget`, `ensureShipitSourceRepoReady`, `buildShipitFixPrompt`)
- [x] Integration test: Ops reads ShipIt source against a real git checkout; non-ops gets 403; `.env` redacted. (`integration_tests/ops-source-routes.test.ts`)
- [ ] Integration test: Ops spawns a writable ShipIt fix child that opens a PR (needs a seeded ShipIt-source bare repo + stubbed write-access).
- [ ] Integration test: read-only (no write permission) refuses fix-session creation with a clear error.
