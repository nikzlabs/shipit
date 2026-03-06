# 072 — Large File Splits — Checklist

## Tier 1 — High Priority

- [ ] Split `api-routes.ts` (1500 lines) into domain-specific route files
- [ ] Split `container-session-runner.ts` (1064 lines) — extract SSE client, HTTP helpers, terminal buffer, ProxyAgentProcess
- [ ] Split `MessageList.tsx` (908 lines) — extract tool, markdown, editor, media sub-components
- [ ] Split `send-message.ts` (843 lines) — extract agent listeners, claude execution, post-turn ops

## Tier 2 — Good Candidates

- [ ] Split `index.ts` (1420 lines) — extract DI setup and lifecycle management
- [ ] Split `docker-proxy.ts` (955 lines) — extract auth checks, sanitization, HTTP helpers
- [ ] Split `session-container.ts` (832 lines) — extract lifecycle, discovery, health modules
- [ ] Split `github-auth.ts` (785 lines) — extract repo, PR, and CI-check API modules
- [ ] Split `services/github.ts` (705 lines) — extract CI-fix logic

## Tier 3 — Lower Priority

- [ ] Split `templates.ts` (1187 lines) — extract template data by category
- [ ] Split `App.tsx` (847 lines) — extract layout and auth overlay components

## Per-Split Verification

For each completed split:

- [ ] `npm run typecheck` passes
- [ ] `npm run test:dev` passes
- [ ] `npm run lint` passes
- [ ] No circular imports introduced
- [ ] Original file re-exports moved symbols for backwards compatibility
- [ ] Existing tests updated to import from new locations
