# 030 — GitHub Device Authorization Flow: Checklist

## Prerequisites

- [x] Register a GitHub OAuth App and obtain `client_id`
- [x] Enable device flow in OAuth App settings

## Server

- [x] Add `GITHUB_CLIENT_ID` config (env var `GITHUB_OAUTH_CLIENT_ID`)
- [x] Add `startDeviceAuth()` to `GitHubAuthManager` in `src/server/github-auth.ts`
- [x] Add `pollDeviceAuth()` to `GitHubAuthManager` in `src/server/github-auth.ts`
- [x] Add types to `src/server/types.ts`: `WsGitHubDeviceAuthStart`, `WsGitHubDeviceAuthCode`, `WsGitHubDeviceAuthResult`
- [x] Add `github_device_auth_start` handler in `src/server/index.ts` (initiate + background polling + cleanup)

## Client

- [x] Add "Sign in with GitHub" button to `GitHubAuthOverlay.tsx` (above PAT input)
- [x] Add device code display view (code, copy button, link to github.com/login/device, waiting indicator)
- [x] Add `deviceAuthCode` state to `App.tsx`
- [x] Handle `github_device_auth_code` and `github_device_auth_result` messages in `App.tsx`
- [x] Cancel support — return to initial state, stop polling

## Tests

- [x] Integration tests: `src/server/integration_tests/github-device-auth.test.ts`
  - [x] Start flow → receive device code
  - [x] Successful auth → success result + status update
  - [x] Expired code → failure result
  - [x] Poll error → error result
  - [x] Start flow error → failure result
- [x] Component tests: extend `src/client/components/GitHubAuthOverlay.test.tsx`
  - [x] "Sign in with GitHub" button triggers start
  - [x] Device code display renders correctly
  - [x] Copy button renders
  - [x] Success closes overlay
  - [x] Expiry shows error with retry
  - [x] Cancel returns to initial state
