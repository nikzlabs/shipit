# 119 — Codex subscription auth — checklist

## Phase 1 — credential persistence

- [ ] Add `ln -s /credentials/.codex /root/.codex` to `docker/Dockerfile.dev`.
- [ ] Same for `docker/Dockerfile.prod`.
- [ ] Same for `docker/Dockerfile.session-worker.dev`.
- [ ] Same for `docker/Dockerfile.session-worker.prod`.
- [ ] `CodexAdapter.run()` accepts file-based auth and strips
      `OPENAI_API_KEY` from the spawned child env when fileAuth is present.
- [ ] `AgentRegistry.isAuthConfigured("codex")` returns true when either
      `~/.codex/auth.json` or `OPENAI_API_KEY` is configured.
- [ ] Unit tests for both above.

## Phase 2 — server-side auth manager

- [ ] `src/server/orchestrator/codex-auth.ts` — `CodexAuthManager` class.
- [ ] `codex-auth.test.ts` covering URL/code parsing and exit handling.
- [ ] `app-di.ts` constructs and exposes `CodexAuthManager`.
- [ ] `app-lifecycle.ts:wireEventHandlers` relays
      `codex_auth_pending|complete|failed` to SSE and refreshes the
      agent registry.
- [ ] HTTP routes in `api-routes-bootstrap.ts`:
      `POST /api/codex-auth/start`, `POST /api/codex-auth/cancel`,
      `DELETE /api/codex-auth`.
- [ ] WS server message types added in
      `src/server/shared/types/ws-server-messages.ts`.
- [ ] Integration test driving the full device-flow happy path.

## Phase 3 — UI

- [ ] Rewrite `CodexAuthCard.tsx` with subscription-primary layout +
      API-key disclosure.
- [ ] `useCodexAuth` hook (or store extension) tracking pending state,
      verification URL, user code, and last error.
- [ ] Component tests covering idle / pending / complete / error /
      "API key ignored" states.
- [ ] Wire OnboardingWizard to surface the Codex sign-in step.

## Phase 4 — docs + cleanup

- [ ] Update `src/server/shipit-docs/environment.md` (mention `~/.codex`
      and billing-path selection).
- [ ] Add a "How is Codex billed?" info popover in Settings.
- [ ] Mark `plan.md` as `status: done`.
