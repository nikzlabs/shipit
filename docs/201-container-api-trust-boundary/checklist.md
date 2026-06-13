# Checklist — container ↔ browser trust boundary (SHI-129)

## Guard
- [ ] Add `api-container-guard.ts`: `registerContainerOriginGuard(app, { containerManager })` wiring an `onRequest` hook — normalize source IP (strip `::ffff:`, ignore `X-Forwarded-For`) → `getSessionByContainerIp` → hard-deny backstop → per-route `containerAccessible` check → own-session scope. Plus pure `isHardDeniedGlobal(pathname)`.
- [ ] Wire `registerContainerOriginGuard` at the top of `registerApiRoutes` in `api-routes.ts` (no-op when `containerManager` absent).

## Mechanism 2 — per-route opt-in
- [ ] Add `containerAccessible?: boolean` to Fastify route `config` type (module augmentation).
- [ ] Add `config: { containerAccessible: true }` to exactly the **Allow**-table routes across `api-routes-{github,issues,source,preview,agent,session,voice,bug-report,reviews}.ts`. Leave every other route untouched (default-deny).

## Mechanism 3 — hard-deny backstop
- [ ] `isHardDeniedGlobal` covers `/api/secrets`, `/api/mcp-servers*`, `/api/provider-accounts`, `/api/trackers/*`, `/api/updates/*`; evaluated before the allow check, regardless of result.

## Mechanism 1 — executable contract (must-have)
- [ ] Golden-route-table test: boot app in test mode, enumerate live route table, compute container-reachable `(method, path)` set, assert deep-equal to committed snapshot. (Catches new opt-ins / over-broad matches → red build.)

## Other tests
- [ ] Hook behavior via `app.inject({ remoteAddress })`: own-session allow route passes; global + non-allowlisted + cross-session → 403; hard-denied global → 403 even if mis-flagged; non-container origin reaches everything.
- [ ] `isHardDeniedGlobal` unit truth table.

## Docs + close-out
- [ ] Update `SECURITY-MODEL.md` (container-vs-browser boundary + revise "No orchestrator-level user auth" note).
- [ ] Cross-reference from `docs/172-agent-containment/`.
- [ ] `npm run lint:dev` + `npm run typecheck` clean.
- [ ] Comment on SHI-129 summarizing the doc.
- [ ] Open PR with `Closes SHI-129`.
