# Checklist — container ↔ browser trust boundary (planning#131)

## Guard
- [x] Add `api-container-guard.ts`: `registerContainerOriginGuard(app, { containerManager })` wiring an `onRequest` hook — normalize source IP (strip `::ffff:`, ignore `X-Forwarded-For`) → `getSessionByContainerIp` → hard-deny backstop → per-route `containerAccessible` check → own-session scope. Plus pure `isHardDeniedGlobal(pathname)`.
- [x] Wire `registerContainerOriginGuard` at the top of `registerApiRoutes` in `api-routes.ts` (no-op when `containerManager` absent).

## Mechanism 2 — per-route opt-in
- [x] Add `containerAccessible?: boolean` to Fastify route `config` type (module augmentation in `api-container-guard.ts`).
- [x] Add `config: { containerAccessible: true }` to exactly the 36 **Allow**-table routes across `api-routes-{github,issues,source,agent,preview,session,voice,bug-report,reviews}.ts`. Every other route left untouched (default-deny).

## Mechanism 3 — hard-deny backstop
- [x] `isHardDeniedGlobal` covers `/api/secrets`, `/api/mcp-servers`, `/api/provider-accounts`, `/api/trackers`, `/api/updates`; evaluated before the allow check, regardless of result.

## Mechanism 1 — executable contract (must-have)
- [x] Golden-route-table test: boot app via `buildApp`, read `app.containerAccessibleRoutes`, assert deep-equal to committed snapshot of 36 routes.

## Other tests
- [x] Hook behavior via `app.inject({ remoteAddress })`: own-session allow route passes; cross-session + non-allowlisted → 403; hard-denied global → 403 even when mis-flagged; non-container origin reaches everything; inert without `containerManager`.
- [x] `isHardDeniedGlobal` + `normalizeRemoteIp` unit tables.

## Docs + close-out
- [x] Update `SECURITY-MODEL.md` (container-vs-browser boundary + revise "No orchestrator-level user auth" note).
- [x] Cross-reference from `docs/172-agent-containment/`.
- [x] `npm run lint:dev` + `npm run typecheck` clean.
- [x] Comment on planning#131 summarizing the doc.
- [x] Open PR with `Closes planning#131`.

## Origin-index latency (2026-09-03 production incident)
- [x] Keep the container-origin IP index warm off the request path; answer a lookup from a snapshot younger than `ORIGIN_INDEX_FRESH_MS` instead of running a `listContainers` per miss.
- [x] `beginContainerTopologyChange()` bracket — opened before Docker is called, freshness stamp withheld while any bracket is open; wired into `ComposeCli.upWithConflictRecovery` (spans the retry, excludes `stop`/`down`), `containComposeServices`, and the Docker proxy's start / restart / network-connect handlers (taken after authorisation, awaiting the daemon exchange).
- [x] `recordSessionNetworkRanges` inspects the Docker-access bridge's TRUNCATED name too, so an agent-created child's subnet is no longer absent from the fail-closed check by construction.
- [x] Split the Docker event stream's chunks into newline-delimited records — one chunk carries several, and parsing it as one object swallowed the whole batch.
- [x] Compare freshness by a monotonic generation, not by wall clock.
- [x] Treat a miss inside a known session subnet as "not proven absent" (deny-side use of `isLikelySessionContainerIp`), never as a pre-gate on the lookup.
- [x] Labelled-container `start` backstop on the Docker event stream, for restarts nobody drives.
- [x] Bound the REQUEST's wait separately from the Docker timeout; stop awaiting `refreshSessionNetworkRanges` on the failure path; drop the negative cache.
- [x] Regression tests: no `listContainers` for a browser IP once warm (past the old 1 s window), boundary unchanged with empty ranges, bracket held across create/start, compose bracket held across every command.
