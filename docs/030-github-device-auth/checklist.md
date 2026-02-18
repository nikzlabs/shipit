# 030 — GitHub Device Authorization Flow: Checklist

## Prerequisites

- [ ] Register a GitHub OAuth App and obtain `client_id`
- [ ] Enable device flow in OAuth App settings

## Server

- [ ] Add `GITHUB_CLIENT_ID` config (env var `GITHUB_OAUTH_CLIENT_ID`)
- [ ] Add `startDeviceAuth()` to `GitHubAuthManager` in `src/server/github-auth.ts`
- [ ] Add `pollDeviceAuth()` to `GitHubAuthManager` in `src/server/github-auth.ts`
- [ ] Add types to `src/server/types.ts`: `WsGitHubDeviceAuthStart`, `WsGitHubDeviceAuthCode`, `WsGitHubDeviceAuthResult`
- [ ] Add `github_device_auth_start` handler in `src/server/index.ts` (initiate + background polling + cleanup)

## Client

- [ ] Add "Sign in with GitHub" button to `GitHubAuthOverlay.tsx` (above PAT input)
- [ ] Add device code display view (code, copy button, link to github.com/login/device, waiting indicator)
- [ ] Add `deviceAuthCode` state to `App.tsx`
- [ ] Handle `github_device_auth_code` and `github_device_auth_result` messages in `App.tsx`
- [ ] Cancel support — return to initial state, stop polling

## Tests

- [ ] Integration tests: `src/server/integration_tests/github-device-auth.test.ts`
  - [ ] Start flow → receive device code
  - [ ] Successful auth → success result + status update
  - [ ] Expired code → failure result
  - [ ] Poll error → error result
  - [ ] Cleanup on disconnect
- [ ] Component tests: extend `src/client/components/GitHubAuthOverlay.test.tsx`
  - [ ] "Sign in with GitHub" button triggers start
  - [ ] Device code display renders correctly
  - [ ] Copy button copies code
  - [ ] Success closes overlay
  - [ ] Expiry shows error with retry
  - [ ] Cancel returns to initial state
