# 119 — Codex subscription auth — checklist

## Phase 1 — credential persistence

- [x] Add `ln -s /credentials/.codex /root/.codex` to `docker/Dockerfile.dev`.
- [x] Same for `docker/Dockerfile.prod`.
- [x] Same for `docker/Dockerfile.session-worker.dev`.
- [x] Same for `docker/Dockerfile.session-worker.prod`.
- [x] `CodexAdapter.run()` accepts file-based auth and strips
      `OPENAI_API_KEY` from the spawned child env when fileAuth is present.
- [x] `AgentRegistry.isAuthConfigured("codex")` returns true when either
      `~/.codex/auth.json` or `OPENAI_API_KEY` is configured.
- [x] Unit tests for both above (`agent-registry.test.ts`, dual-mode env
      tests in `codex-adapter.test.ts`).

## Phase 2 — server-side auth manager

- [x] `src/server/orchestrator/codex-auth.ts` — `CodexAuthManager` class.
- [x] `codex-auth.test.ts` covering URL/code parsing, exit handling,
      cancel, sign-out, and timeout.
- [x] `app-di.ts` constructs and exposes `CodexAuthManager`.
- [x] `app-lifecycle.ts:wireEventHandlers` relays
      `codex_auth_pending|complete|failed` to SSE and refreshes the
      agent registry.
- [x] HTTP routes in `api-routes-bootstrap.ts`:
      `POST /api/codex-auth/start`, `POST /api/codex-auth/cancel`,
      `DELETE /api/codex-auth`.
- [x] WS server message types added in
      `src/server/shared/types/ws-server-messages.ts`.
- [x] Integration test driving the full device-flow happy path
      (`integration_tests/codex-auth.test.ts` — faked `codex` spawn,
      asserts SSE `codex_auth_pending` → `codex_auth_complete` →
      `agent_list.authConfigured` flip, plus the non-zero-exit failure
      path and `start` idempotency).

## Phase 3 — UI

- [x] Rewrite `CodexAuthCard.tsx` with subscription-primary layout +
      API-key disclosure.
- [x] Store extension tracking pending state, verification URL, user
      code, and last error (`settings-store.codexDeviceAuth*`).
- [x] Component tests covering idle / pending / complete / error /
      "API key ignored" states.
- [x] Wire OnboardingWizard to surface the Codex sign-in step (carries
      the same device-auth props as Settings).
- [ ] Wire `apiKeyIgnored` banner against a real signal — today the
      bootstrap response doesn't tell the client whether
      `OPENAI_API_KEY` is set in `process.env` independently of the
      file-auth flag, so the banner is plumbed but never lights up.

## Phase 4 — docs + cleanup

- [x] Update `src/server/shipit-docs/environment.md` (mention `~/.codex`
      and billing-path selection).
- [ ] Add a "How is Codex billed?" info popover in Settings.
- [ ] Pin a known-good `@openai/codex` version in the four Dockerfiles
      so the device-auth output regex doesn't break across CLI bumps.
- [ ] Smoke test against a real OpenAI account in a dev container,
      verify `OPENAI_API_KEY` doesn't leak to the spawned process env
      via `/proc/<pid>/environ`.
- [ ] Mark `plan.md` as `status: done` once the open follow-ups above
      are resolved.
