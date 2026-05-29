# Checklist — post-turn webhook

## Storage
- [ ] Add `postTurnWebhook` field to `CredentialData` in `credential-store.ts`
- [ ] Add `getPostTurnWebhook` / `setPostTurnWebhook` / `clearPostTurnWebhook` methods
- [ ] Include `postTurnWebhook` (with bearer token redacted) in `getGlobalSettings()` response

## Services
- [ ] Create `services/webhook.ts` with `validatePostTurnWebhookConfig` and redacted-config helper
- [ ] Unit tests for URL validation (https, http to private/loopback, reject invalid)
- [ ] Unit tests for bearer token validation (non-empty, size cap)

## HTTP routes
- [ ] Create `api-routes-webhook.ts` with GET / PUT / DELETE handlers
- [ ] Register from `api-routes.ts`
- [ ] Manual smoke test via curl

## Fire helper
- [ ] Create `ws-handlers/post-turn-webhook.ts` with `firePostTurnWebhook`
- [ ] 10s timeout via `AbortSignal.timeout`
- [ ] Never throws; logs success and failure with timing
- [ ] No-ops if config is absent or `enabled === false`

## Wiring
- [ ] Call `firePostTurnWebhook` after `emitPrLifecycleAfterCommit` in the streaming `agent_result` path
- [ ] Call it in the non-streaming `agent.on("done")` path
- [ ] Both paths use captured session vars, not `ctx.getX()` — see CLAUDE.md WS resilience section

## Tests
- [ ] Integration test: configure webhook, run fake turn, assert payload + bearer header
- [ ] Negative: disabled config → zero outbound requests
- [ ] Negative: receiver returns 500 → turn completes cleanly
- [ ] Negative: receiver hangs → request aborts at ~10s, turn completes cleanly

## UI
- [ ] Settings panel section with URL, bearer token (password), enabled toggle
- [ ] "Send test event" button posts `{"event":"test"}` and renders the response
- [ ] Token shown as `***` once stored; explicit Clear button

## Docs
- [ ] Update `plan.md` status to `in-progress` when work starts
- [ ] Update to `done` when all of the above are checked
- [ ] Update `src/server/shipit-docs/` only if we add anything agent-visible (we shouldn't for this feature)
