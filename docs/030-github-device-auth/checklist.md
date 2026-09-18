# 030 — GitHub Device Authorization Flow: Checklist

> **None of this is built.** The feature is paused (see `plan.md`), so every
> symbol named below — `startDeviceAuth()`, `pollDeviceAuth()`, and the
> `github_device_auth_*` messages — is a **proposed** name for work not yet
> done, not a reference to existing code. Grep finds none of them in `src/`.
>
> The paths were written against the old flat `src/server/` layout, which no
> longer exists; they are restated below against today's
> `orchestrator/` / `session/` / `shared/` split. GitHub sign-in today is
> personal-access-token only, submitted over HTTP to `POST /api/github/token`
> (`src/server/orchestrator/api-routes-github.ts`) rather than over the
> WebSocket, so the transport for the device flow is an open choice, not a
> settled one.

## Prerequisites

- [ ] Register a GitHub OAuth App and obtain `client_id`
- [ ] Enable device flow in OAuth App settings

## Server

- [ ] Add `GITHUB_CLIENT_ID` config (env var `GITHUB_OAUTH_CLIENT_ID`)
- [ ] Add a device-flow start method (`startDeviceAuth()` in `plan.md`) to
      `GitHubAuthManager` in `src/server/orchestrator/github-auth.ts`
- [ ] Add a device-flow poll method (`pollDeviceAuth()` in `plan.md`) to the
      same class
- [ ] Add the message types — `WsGitHubDeviceAuthStart`,
      `WsGitHubDeviceAuthCode`, `WsGitHubDeviceAuthResult` — under
      `src/server/shared/types/ws-server-messages/` (`auth.ts` holds the
      auth-flow messages), if the flow lands on the WebSocket
- [ ] Add the start handler (initiate + background polling + cleanup), either as
      a `github_device_auth_start` WS handler in
      `src/server/orchestrator/ws-handlers/` or as an HTTP route beside the
      existing token route in `src/server/orchestrator/api-routes-github.ts`

## Client

- [ ] Add "Sign in with GitHub" button to `src/client/components/GitHubTokenForm.tsx`
      (the PAT input, rendered by `GitHubGate.tsx`; the `GitHubAuthOverlay`
      named in `plan.md` no longer exists)
- [ ] Add device code display view (code, copy button, link to github.com/login/device, waiting indicator)
- [ ] Add `deviceAuthCode` state to `App.tsx`
- [ ] Handle the device-code and device-result messages in `App.tsx`
- [ ] Cancel support — return to initial state, stop polling

## Tests

- [ ] Integration tests: `src/server/orchestrator/integration_tests/github-device-auth.test.ts`
  - [ ] Start flow → receive device code
  - [ ] Successful auth → success result + status update
  - [ ] Expired code → failure result
  - [ ] Poll error → error result
  - [ ] Cleanup on disconnect
- [ ] Component tests: extend `src/client/components/GitHubTokenForm.test.tsx`
  - [ ] "Sign in with GitHub" button triggers start
  - [ ] Device code display renders correctly
  - [ ] Copy button copies code
  - [ ] Success closes the gate
  - [ ] Expiry shows error with retry
  - [ ] Cancel returns to initial state
