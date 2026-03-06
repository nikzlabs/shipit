# Remove Standalone Sessions — Checklist

## Server

- [ ] Remove `POST /api/sessions` endpoint from `api-routes.ts`
- [ ] Remove no-`sessionId` fallback in `send-message.ts` `handleSendMessage`
- [ ] Remove missing-workspace recreation path in `send-message.ts`
- [ ] Simplify `createSessionDir` in `index.ts` — remove `git.init()` / `skipGitInit` logic
- [ ] Empty repo warm sessions: create initial commit in shared repo instead of standalone fallback (`index.ts` `warmSessionForRepo`)
- [ ] Empty repo claim: same fix in `api-routes.ts` claim-session handler
- [ ] Remove `"standalone"` from `sessionType` in `domain-types.ts`
- [ ] Audit remaining references to `sessionType === "standalone"` and update

## Client

- [ ] Remove `POST /api/sessions` call from `App.tsx` `handleSendMessage` (`!sessionId` branch)
- [ ] Verify HomeScreen already enforces repo selection (no functional change expected)

## Tests

- [ ] Update/remove standalone session tests in integration tests
- [ ] Add test: empty repo → initial commit in shared repo → worktree created successfully
- [ ] Run `npm run test:dev` and fix any breakage
