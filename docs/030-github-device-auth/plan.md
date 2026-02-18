---
status: paused
---
# 030 — GitHub Device Authorization Flow

> **Paused**: This feature requires deploying a publicly accessible website and registering a new GitHub OAuth App before implementation can proceed.

## Summary

Add GitHub's device authorization flow as an alternative to manual PAT entry. Users click "Sign in with GitHub", see a one-time code, authorize in a browser tab, and are authenticated — no token copy/paste needed.

## Motivation

The current GitHub auth (doc 015) requires users to:
1. Navigate to GitHub → Settings → Developer settings → Personal access tokens
2. Create a token with the correct scopes (`repo`, `read:user`)
3. Copy the token
4. Paste it into the `GitHubAuthOverlay`

This is error-prone (wrong scopes, expired tokens) and unfamiliar to many users. The device authorization flow is the standard OAuth pattern for CLI and headless apps — it's what the Claude CLI itself uses, and what users expect from a modern tool.

## How It Works

### OAuth Device Flow (RFC 8628)

```
┌──────────┐                            ┌──────────┐
│  ShipIt   │  POST /login/device/code   │  GitHub   │
│  Server   │ ─────────────────────────→ │  API      │
│           │ ←───────────────────────── │           │
│           │  { device_code,            │           │
│           │    user_code: "ABCD-1234", │           │
│           │    verification_uri }      │           │
│           │                            │           │
│           │  (user opens browser,      │           │
│           │   enters code)             │           │
│           │                            │           │
│           │  POST /login/oauth/        │           │
│           │    access_token (polling)   │           │
│           │ ─────────────────────────→ │           │
│           │ ←───────────────────────── │           │
│           │  { access_token }          │           │
└──────────┘                            └──────────┘
```

1. **Initiate**: Server sends `POST https://github.com/login/device/code` with `client_id` and `scope=repo,read:user`
2. **Display**: Server receives `user_code` and `verification_uri`, forwards to client
3. **User action**: User opens `https://github.com/login/device` in a new tab and enters the code
4. **Poll**: Server polls `POST https://github.com/login/oauth/access_token` every `interval` seconds until the user approves or the code expires
5. **Complete**: On success, store the access token the same way PATs are stored today

### Prerequisites

- A **GitHub OAuth App** registration (not a GitHub App). This provides a `client_id`. No `client_secret` is needed for the device flow.
- The OAuth App must have the device flow enabled in its settings.

### Server-Side

#### New GitHubAuthManager Methods

```typescript
// src/server/github-auth.ts — additions

/** Start the device authorization flow. Returns code for user to enter. */
async startDeviceAuth(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: "repo read:user",
    }),
  });

  if (!res.ok) throw new Error(`GitHub device code request failed: ${res.status}`);
  const data = await res.json();

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}

/** Poll for the device auth token. Returns token on success, null if still pending. */
async pollDeviceAuth(deviceCode: string): Promise<
  | { status: "success"; token: string }
  | { status: "pending" }
  | { status: "expired" }
  | { status: "error"; message: string }
> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

  if (!res.ok) return { status: "error", message: `GitHub API returned ${res.status}` };
  const data = await res.json();

  if (data.access_token) return { status: "success", token: data.access_token };
  if (data.error === "authorization_pending") return { status: "pending" };
  if (data.error === "slow_down") return { status: "pending" };
  if (data.error === "expired_token") return { status: "expired" };
  return { status: "error", message: data.error_description || data.error };
}
```

#### New WS Message Types

```typescript
// src/server/types.ts — additions

// Client → Server
export interface WsGitHubDeviceAuthStart {
  type: "github_device_auth_start";
}

// Server → Client
export interface WsGitHubDeviceAuthCode {
  type: "github_device_auth_code";
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

export interface WsGitHubDeviceAuthResult {
  type: "github_device_auth_result";
  success: boolean;
  message?: string;
}
```

#### Handler in `src/server/index.ts`

```typescript
if (msg.type === "github_device_auth_start") {
  try {
    const { deviceCode, userCode, verificationUri, expiresIn, interval } =
      await githubAuthManager.startDeviceAuth();

    send({
      type: "github_device_auth_code",
      userCode,
      verificationUri,
      expiresIn,
    });

    // Poll in background
    const pollInterval = setInterval(async () => {
      const result = await githubAuthManager.pollDeviceAuth(deviceCode);

      if (result.status === "success") {
        clearInterval(pollInterval);
        await githubAuthManager.setToken(result.token);
        // Configure git credentials for active session
        if (activeSessionDir) {
          await githubAuthManager.configureGitCredentials(activeSessionDir);
        }
        send({ type: "github_device_auth_result", success: true });
        // Also send updated github_status
        const status = await githubAuthManager.getStatus();
        send({ type: "github_status", ...status });
      } else if (result.status === "expired" || result.status === "error") {
        clearInterval(pollInterval);
        send({
          type: "github_device_auth_result",
          success: false,
          message: result.status === "expired"
            ? "Authorization code expired. Please try again."
            : result.message,
        });
      }
      // "pending" → keep polling
    }, interval * 1000);

    // Clean up on disconnect
    socket.on("close", () => clearInterval(pollInterval));

    // Auto-expire after expiresIn
    setTimeout(() => clearInterval(pollInterval), expiresIn * 1000);
  } catch (err) {
    send({ type: "github_device_auth_result", success: false, message: getErrorMessage(err) });
  }
}
```

### Client-Side

#### Updated GitHubAuthOverlay

Add a "Sign in with GitHub" button above the existing PAT input:

```
┌─────────────────────────────────────────┐
│  Connect to GitHub                   [×]│
├─────────────────────────────────────────┤
│                                         │
│  [Sign in with GitHub]                  │
│                                         │
│  ─── or enter a token manually ───      │
│                                         │
│  Personal Access Token:                 │
│  ┌─────────────────────────────────────┐│
│  │ ghp_...                             ││
│  └─────────────────────────────────────┘│
│  Needs repo and read:user scopes.       │
│                                         │
│  [Cancel]                     [Connect] │
└─────────────────────────────────────────┘
```

When "Sign in with GitHub" is clicked → sends `github_device_auth_start`:

```
┌─────────────────────────────────────────┐
│  Connect to GitHub                   [×]│
├─────────────────────────────────────────┤
│                                         │
│  Enter this code on GitHub:             │
│                                         │
│       ┌─────────────────┐              │
│       │   ABCD-1234     │  [Copy]      │
│       └─────────────────┘              │
│                                         │
│  [Open github.com/login/device →]       │
│                                         │
│  Waiting for authorization...           │
│  ●●●                                   │
│                                         │
│  [Cancel]                               │
└─────────────────────────────────────────┘
```

On success → overlay closes, GitHub status updates in header.

#### State in App.tsx

```typescript
// In lastMessage handler:
if (data.type === "github_device_auth_code") {
  setDeviceAuthCode({ userCode: data.userCode, verificationUri: data.verificationUri });
}
if (data.type === "github_device_auth_result") {
  if (data.success) {
    setShowGitHubAuth(false);
    setDeviceAuthCode(null);
  } else {
    setDeviceAuthError(data.message);
  }
}
```

## Configuration

The `GITHUB_CLIENT_ID` should be configurable via environment variable:

```typescript
const GITHUB_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID || "default-client-id";
```

For self-hosted deployments, users can register their own GitHub OAuth App and set this variable.

## Testing

### Integration Tests (`src/server/integration_tests/github-device-auth.test.ts`)
1. **Start flow**: `github_device_auth_start` → receive `github_device_auth_code` with userCode and verificationUri
2. **Successful auth**: Mock poll returning success → receive `github_device_auth_result` with `success: true` + `github_status` update
3. **Expired code**: Mock poll returning expired → receive `github_device_auth_result` with `success: false`
4. **Poll error**: Mock API failure → receive error result
5. **Cleanup on disconnect**: Start flow → close WebSocket → verify polling stops

### Component Tests
1. "Sign in with GitHub" button sends `github_device_auth_start`
2. Device code display renders correctly with copy button
3. "Open github.com" link opens correct URL
4. Success closes overlay
5. Expiry shows error message with retry option
6. Cancel during polling returns to initial state

## Key Files

| File | Change |
|---|---|
| `src/server/github-auth.ts` | Add `startDeviceAuth()`, `pollDeviceAuth()` |
| `src/server/types.ts` | Add `WsGitHubDeviceAuthStart`, `WsGitHubDeviceAuthCode`, `WsGitHubDeviceAuthResult` |
| `src/server/index.ts` | Add `github_device_auth_start` handler with polling loop |
| `src/client/components/GitHubAuthOverlay.tsx` | Add device flow UI (code display, status, cancel) |
| `src/client/components/GitHubAuthOverlay.test.tsx` | Extend with device flow tests |
| `src/client/App.tsx` | Add `deviceAuthCode` state, handle new messages |
| `src/server/integration_tests/github-device-auth.test.ts` | Integration tests |

## Complexity

Low-medium. The server-side is straightforward REST calls + a polling loop. The client-side extends the existing `GitHubAuthOverlay` with a new view state. The main consideration is proper cleanup of the polling interval on disconnect/cancel/expiry. Estimate: ~300-400 lines of new code.
