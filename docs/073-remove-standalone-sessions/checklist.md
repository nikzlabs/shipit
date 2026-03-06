# Remove Standalone Sessions — Checklist

## Fresh main invariant

- [x] Add `refreshWorktreeToLatestMain()` helper — fetch + hard-reset at claim time
- [x] Call helper in all three claim paths (reuse, warm, wait) in `api-routes-session.ts`
- [x] Remove redundant warming-time fetch from `app-lifecycle.ts`

## Server

- [x] Remove `POST /api/sessions` endpoint from `api-routes.ts`
- [x] Remove no-`sessionId` fallback in `send-message.ts` `handleSendMessage`
- [x] Remove missing-workspace recreation path in `send-message.ts`
- [x] Simplify `createSessionDir` in `app-lifecycle.ts` — remove `git.init()` / `skipGitInit` logic
- [x] Empty repo warm sessions: create initial commit in shared repo instead of standalone fallback (`app-lifecycle.ts` `warmSessionForRepo`)
- [x] Empty repo claim: same fix in `api-routes-session.ts` claim-session handler
- [x] Remove `"standalone"` from `sessionType` in `domain-types.ts`
- [x] Audit remaining references to `sessionType === "standalone"` and update

## Client

- [x] Remove `POST /api/sessions` call from `App.tsx` `handleSendMessage` (`!sessionId` branch)
- [x] Verify HomeScreen already enforces repo selection (no functional change expected)

## Tests

- [x] Update/remove standalone session tests in integration tests
- [x] Add test: empty repo → initial commit in shared repo → worktree created successfully
- [x] Run `npm run test:dev` and fix any breakage (265 tests pass)
