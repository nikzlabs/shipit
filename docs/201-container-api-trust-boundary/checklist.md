# Checklist — container ↔ browser trust boundary (SHI-129)

- [ ] Add `api-container-guard.ts`: pure `isAllowedContainerRoute(method, pathname, ownSessionId)` with the allowlist table, plus `registerContainerOriginGuard(app, { containerManager })` wiring an `onRequest` hook (normalize source IP, strip `::ffff:`, ignore `X-Forwarded-For`).
- [ ] Wire `registerContainerOriginGuard` at the top of `registerApiRoutes` in `api-routes.ts` (no-op when `containerManager` absent).
- [ ] Unit tests: allowlist matcher truth table (allow own-session callbacks; deny global routes, non-allowlisted session routes, cross-session).
- [ ] Integration tests via `app.inject({ remoteAddress })`: container IP → `/api/secrets` & `/api/mcp-servers` 403; own-session `services`/`pr/agent-create` pass; cross-session 403; non-container origin reaches everything.
- [ ] Update `SECURITY-MODEL.md` (container-vs-browser boundary + revise "No orchestrator-level user auth" note).
- [ ] Cross-reference from `docs/172-agent-containment/`.
- [ ] `npm run lint:dev` + `npm run typecheck` clean.
- [ ] Comment on SHI-129 summarizing the doc.
- [ ] Open PR with `Closes SHI-129`.
