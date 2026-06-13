# Checklist — container ↔ browser trust boundary (SHI-129)

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
- [x] Comment on SHI-129 summarizing the doc.
- [x] Open PR with `Closes SHI-129`.
