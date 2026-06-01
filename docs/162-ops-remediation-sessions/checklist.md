# Ops remediation sessions — checklist

## Design

- [x] Document that current Ops source access appears indirect through production Docker/container topology, not a narrow first-class contract.
- [x] Define the split between read-only ShipIt source diagnosis and writable child-session remediation.
- [x] Define the read-only ShipIt source access model for Ops sessions.
- [x] Define the Ops-only ShipIt fix-session spawn flow.
- [x] Capture behavior for users who can inspect ShipIt but cannot write to the upstream repository.
- [x] Document the inspect→spawn TOCTOU window (status re-resolved at spawn time; packet records the actual branched-from ref) and the authz boundary (gated on `kind === "ops"`; ops-session creation gated per docs/128, single-tenant in v1).

## Server

- [x] Add a service that resolves the running ShipIt source ref. (`services/shipit-source.ts`)
- [x] Add read-only ShipIt source snapshot/search access for Ops sessions.
- [x] Refuse source tree/search/cat when no exact deployed ref or current server checkout is available, unless an explicit approximate mode is requested. (`status.available=false` ⇒ tree/search/cat 503; spawn requires `--approximate` for a non-exact ref.)
- [x] Add `shipit source status/tree/search/cat` shim commands.
- [x] Add `shipit source log/blame/show` shim commands for regression diagnosis (read-only `git log`/`blame`/commit-diff at the snapshot ref; `show` diffs are redacted via `filterRedactedDiff`; commit-ish validated).
- [x] Broker read-only source commands through `/agent-ops/*`.
- [x] Redact credentials, `.env` files, and `.git` internals from source access. (`isRedactedSourcePath`)
- [x] Extend child session spawn with Ops-only `--shipit-source` target support.
- [x] Base the spawned fix session on the exact inspected source ref, not default branch head. (`repoUrlOverride` + `base = ref`)
- [x] Add ShipIt source repo write permission checks before fix-session creation. (`checkRepoWriteAccess`)
- [x] Build incident packets for spawned ShipIt fix sessions. (`buildShipitFixPrompt`)
- [x] Enforce a clear failure mode when the operator lacks write access to the ShipIt repo. (403 with a "produce an incident report" hint.)
- [x] Reconcile the fix child's base with the default branch for PR mergeability. (Child branches from the exact deployed commit to reproduce; incident packet instructs it to rebase onto the latest default branch before opening the PR. GitHub's three-dot diff keeps the displayed diff clean since merge-base = deployed commit.)
- [x] Add a lower Ops-specific per-turn quota for `--shipit-source` fix spawns. (`MAX_SHIPIT_FIX_SESSIONS_PER_TURN`, default 2.)
- [ ] Redact raw log excerpts copied into incident packets (the diagnosis prompt is passed through verbatim today). Tracked separately — Open Question 4. NOT done in this pass.

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
- [x] Integration test: Ops spawns a writable ShipIt fix child branched from the exact inspected commit against a seeded ShipIt-source repo + stubbed write-access. (`integration_tests/ops-fix-spawn.test.ts`)
- [x] Integration test: read-only (no write permission) refuses fix-session creation with a clear error. (`ops-fix-spawn.test.ts`)
- [x] Integration test: read-only source `log`/`blame`/`show` against a real checkout, incl. show-diff redaction + invalid commit-ish. (`ops-source-routes.test.ts`)
