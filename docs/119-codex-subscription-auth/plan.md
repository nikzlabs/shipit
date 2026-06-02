---
description: Add OAuth-based Codex authentication via ChatGPT subscription (codex login) instead of requiring a Platform API key, matching how Claude auth works.
---

# 119 — Codex subscription auth (ChatGPT plan instead of Platform API key)

## Problem

ShipIt currently authenticates the Codex agent with `OPENAI_API_KEY`. That env
var is wired into `process.env`, persisted in `CredentialStore.agentEnv`,
forwarded to the `codex app-server` process by `CodexAdapter`, and surfaced in
the UI by `CodexAuthCard`. See:

- `src/server/session/agents/codex-adapter.ts` — env-key check on `run()`.
- `src/server/orchestrator/services/settings.ts` — `setAgentEnv` allowlists
  `OPENAI_API_KEY`.
- `src/server/orchestrator/credential-store.ts` — `agentEnv` map.
- `src/server/shared/agent-registry.ts` — `AUTH_ENV_KEYS = { codex: "OPENAI_API_KEY" }`.
- `src/client/components/CodexAuthCard.tsx` — "OPENAI_API_KEY" input.

OpenAI is explicit that the two login modes are **not equivalent**:

> `codex login` uses your **ChatGPT plan / Codex credits / subscription
> limits**.
>
> `export OPENAI_API_KEY=…` uses **Platform API billing**, not your ChatGPT
> subscription. Subscription-only features and ChatGPT credits apply only when
> signed in with ChatGPT.

A user on Plus / Pro / Team / Edu / Enterprise / a Codex-credits plan who
already pays OpenAI gets nothing for that money inside ShipIt today — every
turn double-bills against the API key. Heavy users see the cost difference
become 5–20× the subscription price within a week.

The fix is to add a first-class subscription login flow analogous to Claude's
OAuth, route the agent through `codex login`'s persisted credentials, and
demote the API-key path to a fallback for users without a subscription.

## Goals

1. **`Sign in with ChatGPT` flow inside ShipIt** that authenticates Codex
   against the user's existing OpenAI subscription, mirroring the
   `Sign in with Anthropic` flow used for Claude.
2. **Persist credentials on the credentials volume** so login survives session
   container restarts and idle cleanup, matching how `.claude` is mounted.
3. **Agent registry knows about both auth modes** — `authConfigured = true`
   when the user has *either* a stored ChatGPT login *or* `OPENAI_API_KEY`.
4. **API-key path stays as a fallback** for users who don't have a ChatGPT
   subscription or who explicitly want Platform API billing.
5. **Drop `OPENAI_API_KEY` injection when a ChatGPT login exists** — letting
   both coexist would silently route through Platform API billing again,
   which is exactly what we're trying to avoid.

## Non-goals

- Replacing Claude's OAuth — Claude has its own flow and doesn't change.
- Implementing `codex logout` orchestration beyond a "Sign out" button.
- Rotating tokens, refreshing on expiry beyond what the Codex CLI does itself.
- Surfacing remaining Codex credits / subscription usage in the UI (a
  follow-up; OpenAI exposes this on `chatgpt.com/codex` but not on a stable
  CLI surface yet).
- Multi-account switching. One ChatGPT account per ShipIt installation,
  same as Claude.

## Background — how `codex login` works today

The `codex` CLI ships two login subcommands:

### Default (`codex login`)

```
$ codex login
Starting local login server on http://localhost:1455.
If your browser did not open, navigate to this URL to authenticate:

https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=...

On a remote or headless machine? Use `codex login --device-auth` instead.
```

This is **unusable in ShipIt**: the redirect URI is `localhost:1455` *inside
the orchestrator container*, not on the user's machine. The user's browser
can't reach it, and we can't easily port-forward back into the container per
session. The CLI itself recommends `--device-auth` for headless / remote
environments — which is exactly our case.

### Device-auth (`codex login --device-auth`)

```
$ codex login --device-auth
Welcome to Codex [v0.128.0]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   K8RE-8MIGC

Device codes are a common phishing target. Never share this code.
```

This is the OAuth 2.0 Device Authorization Grant (RFC 8628) — same family of
flow we already designed for GitHub in doc 030. The CLI prints a URL and a
short user code, then polls until the user approves the request in their
browser. On success it writes credentials to `~/.codex/auth.json` and exits
with status 0.

### Where `codex` reads its credentials

After a successful `codex login`, the CLI persists tokens to `~/.codex/`
(`auth.json`, plus optional `config.toml`). On the very next invocation
`codex app-server` picks them up automatically — the adapter does **not**
need to set `OPENAI_API_KEY`. `codex login status` reports authentication
state without needing the env var either.

This is the same shape as Claude: the CLI owns the credential file, ShipIt
just provides the authentication UX and persists the file across container
lifecycles.

## Design

### Architecture parallel: Claude OAuth → Codex device auth

| Concern | Claude (existing) | Codex (this doc) |
|---|---|---|
| Manager class | `AuthManager` (`auth.ts`) | `CodexAuthManager` (new file) |
| Subprocess | `claude /login` via `node-pty` | `codex login --device-auth` via `child_process.spawn` |
| Credential file | `/credentials/.claude/.credentials.json` | `/credentials/.codex/auth.json` |
| Container symlink | `ln -s /credentials/.claude /root/.claude` | `ln -s /credentials/.codex /root/.codex` |
| URL/code surface | parses URL out of PTY buffer | parses URL + user code out of stdout |
| User completes flow | pastes 8-char code back into ShipIt | opens URL, types code there, no copy-back |
| Polling | watches credentials file for appearance | the CLI process exits when done; we watch its exit code + the credentials file |
| WS / SSE event | `auth_url`, `auth_complete`, `auth_failed` | `codex_auth_pending`, `codex_auth_complete`, `codex_auth_failed` |
| HTTP endpoints | `POST /api/auth/{start,code}` | `POST /api/codex-auth/{start,cancel}` |
| API-key fallback | `POST /api/auth/api-key` (`sk-ant-…`) | existing `POST /api/agents/codex/env` (`OPENAI_API_KEY`) |

### 1. Container image — persist `.codex` like `.claude`

Update both session-worker images and the dev/prod orchestrator images:

```dockerfile
# docker/Dockerfile.session-worker.{dev,prod}, Dockerfile.{dev,prod}

RUN mkdir -p /workspace /credentials \
 && ln -s /credentials/.claude       /root/.claude       \
 && ln -sf /credentials/.claude.json /root/.claude.json  \
 && ln -s /credentials/.codex        /root/.codex            # NEW
```

The first time `codex login` runs it creates `/credentials/.codex/`
(via the symlink) — same `mkdirSync` + `readlinkSync` dance that
`auth.ts:ensureOnboardingComplete()` already does for `.claude`. The
credentials volume is shared across all session containers and the
orchestrator, so the login persists across container rebuilds and idle
cleanup.

`codex` does not have an equivalent of `~/.claude.json` (the trust /
onboarding sidecar). The `~/.codex/config.toml` is opt-in and we do not
need to seed it.

### 2. New file: `src/server/orchestrator/codex-auth.ts`

A `CodexAuthManager` that mirrors `AuthManager` (Claude). Different shape
because device auth doesn't need PTY scraping — the CLI prints a clean URL +
code on stdout/stderr, then exits when the user approves.

```ts
export class CodexAuthManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private _authenticated = false;

  /** True if /credentials/.codex/auth.json exists and is non-empty. */
  checkCredentials(): boolean { /* fs.existsSync + size > 0 */ }

  /** Spawn `codex login --device-auth`. Emits codex_auth_pending with
   *  { verificationUri, userCode } once the CLI prints them. Emits
   *  codex_auth_complete when the process exits 0 and credentials are on
   *  disk. Emits codex_auth_failed on non-zero exit or 15-minute timeout. */
  startDeviceFlow(): void { /* spawn, regex stdout, on('close') resolve */ }

  /** SIGTERM the login process if it's still running. */
  cancel(): void { /* this.proc?.kill('SIGTERM') */ }

  /** Drop on-disk credentials so the next turn falls back to API key
   *  (or to no auth at all). */
  signOut(): Promise<void> { /* fs.rm(/credentials/.codex/auth.json) */ }
}
```

Three regexes are sufficient against ANSI-stripped stdout:

- URL: `/https:\/\/auth\.openai\.com\/codex\/device/` — emit when matched.
- User code: `/^\s+([A-Z0-9]{4}-[A-Z0-9]{5})\s*$/m` — emit alongside the URL.
- Failure: process exit with non-zero status, or 15-minute timer expires.

The CLI prints both lines together and then blocks on its own polling. We
do *not* need to parse JSON or follow OAuth state ourselves — the CLI owns
the polling loop.

### 3. Agent registry: dual-mode auth detection

`src/server/shared/agent-registry.ts` currently only checks
`process.env.OPENAI_API_KEY` for Codex. Extend `isAuthConfigured` so Codex
returns true when **either** path is set up:

```ts
private isAuthConfigured(id: AgentId): boolean {
  if (id === "claude") return this.checkClaudeAuth();
  if (id === "codex") {
    return this.checkCodexAuth() || hasEnvKey("OPENAI_API_KEY");
  }
  …
}
```

`checkCodexAuth` is injected the same way `checkClaudeAuth` is — defaults to
checking that `/credentials/.codex/auth.json` exists and is non-empty, and is
overridable in tests.

`refreshAuth("codex")` is called from two places after this change:

- `setAgentEnv` after a user pastes an `OPENAI_API_KEY` (existing).
- `CodexAuthManager.on("codex_auth_complete")` after a successful device
  flow (new, wired in `app-lifecycle.ts:wireEventHandlers`).

### 4. `CodexAdapter` — drop the env-key requirement

`CodexAdapter.run()` currently aborts with `auth_required` when
`OPENAI_API_KEY` is missing. Change the check to:

```ts
const hasFileAuth = existsSync("/root/.codex/auth.json");
const hasEnvAuth  = !!env.OPENAI_API_KEY;

if (!hasFileAuth && !hasEnvAuth) {
  this.emit("auth_required");
  return;
}

// If both are present, prefer the subscription path: strip the env key from
// the spawned child so codex doesn't silently route through Platform API.
if (hasFileAuth) delete env.OPENAI_API_KEY;
```

The "prefer subscription" branch is the whole point of the feature — without
it a user who logs in with ChatGPT but still has a stale `OPENAI_API_KEY` in
`CredentialStore.agentEnv` would keep paying the API rate.

The orchestrator records the choice once at spawn time and emits a `log`
event (`"codex"`, `"using ChatGPT subscription"` vs `"using OPENAI_API_KEY"`)
so the user can see in the agent log which billing path they're on.

### 5. WebSocket / SSE messages

Add to `src/server/shared/types/ws-server-messages.ts`:

```ts
| { type: "codex_auth_pending"; verificationUri: string; userCode: string;
    expiresInSec: number }
| { type: "codex_auth_complete" }
| { type: "codex_auth_failed"; reason: "timeout" | "denied" | "error";
    message?: string }
```

These are SSE-broadcast (orchestrator-wide), not per-session: like
`auth_required` for Claude, they describe global agent auth state, not a
session turn.

### 6. HTTP endpoints

In `api-routes-bootstrap.ts`, alongside the existing Claude auth routes:

```
POST   /api/codex-auth/start    → CodexAuthManager.startDeviceFlow()
POST   /api/codex-auth/cancel   → CodexAuthManager.cancel()
DELETE /api/codex-auth          → CodexAuthManager.signOut()
                                  + agentRegistry.refreshAuth("codex")
                                  + sseBroadcast("agent_list", …)
```

We could also add a `GET /api/codex-auth/status` returning
`{ subscription: bool, apiKey: bool }`, but `agent_list` already conveys
`authConfigured`, so we keep the API minimal until a UI consumer needs more
detail.

### 7. UI — replace `CodexAuthCard` body

Today `CodexAuthCard` shows only the API-key input. Restructure it into two
sections, with subscription as the primary affordance:

```
┌──────────────────────────────────────────────┐
│  Codex                                       │
│  ● Authenticated with ChatGPT (Plus)         │   ← when fileAuth
│  ○ Not authenticated                         │   ← otherwise
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │  Sign in with ChatGPT                  │  │   ← primary
│  │  Uses your ChatGPT plan / Codex        │  │
│  │  credits — recommended.                │  │
│  │  [Sign in]                             │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ▾ Use API key instead                       │   ← collapsed by default
│    OPENAI_API_KEY: [_______________] [Save]  │
│    Bills against your OpenAI Platform        │
│    account, not your ChatGPT subscription.   │
└──────────────────────────────────────────────┘
```

When the user clicks **Sign in**:

1. Client `POST /api/codex-auth/start`.
2. Server spawns `codex login --device-auth`, emits SSE
   `codex_auth_pending` with the URL + user code.
3. Card swaps to a "Step 1: open this link / Step 2: enter this code" view.
   The verification URL renders as a button that opens in a new tab — this
   falls under product principle §3 (auth flows are a legitimate external
   tab) and matches Claude's behavior.
4. Card auto-copies the user code on first render and shows a toast:
   "Code copied — paste it on the OpenAI page". Same mechanic as the
   existing GitHub device auth design (doc 030).
5. On `codex_auth_complete`, card collapses to the green "Authenticated"
   state and the agent picker re-evaluates `authConfigured`.
6. On `codex_auth_failed`, the inline error appears with a "Try again"
   button.

The "Use API key instead" disclosure remains so users without a
subscription can still configure Codex — but it is no longer the primary
affordance.

When the user has *both* a ChatGPT login and a stored API key, surface a
banner: "Using ChatGPT subscription. API key ignored. [Remove key]". This
is the user-facing twin of step 4 in the adapter ("strip env key when
fileAuth is present") so the cost benefit is visible.

### 8. Settings → Agents tab parity

The Settings dialog (`src/client/components/Settings.tsx`) embeds
`CodexAuthCard` in its Agents tab. The same card is used in both places —
no separate code path. The onboarding wizard (`OnboardingWizard.tsx`) also
embeds `CodexAuthCard` and inherits the new flow for free.

### 9. Sign-out

A "Sign out of Codex" button in the Settings card sends
`DELETE /api/codex-auth`. The handler:

1. Calls `CodexAuthManager.signOut()` (rm `/credentials/.codex/auth.json`).
2. `agentRegistry.refreshAuth("codex")`.
3. SSE-broadcasts `agent_list` so the picker repaints.

We do *not* run `codex logout` because that subcommand has rotated naming
across CLI versions and `rm`-ing the auth file is sufficient and idempotent.

## Key files

| File | Change |
|---|---|
| `docker/Dockerfile.dev` | add `ln -s /credentials/.codex /root/.codex` |
| `docker/Dockerfile.prod` | same |
| `docker/Dockerfile.session-worker.dev` | same |
| `docker/Dockerfile.session-worker.prod` | same |
| `src/server/orchestrator/codex-auth.ts` | new — `CodexAuthManager` |
| `src/server/orchestrator/codex-auth.test.ts` | new — unit tests |
| `src/server/orchestrator/app-di.ts` | construct `CodexAuthManager`, add to `AppDeps` |
| `src/server/orchestrator/app-lifecycle.ts` | wire `codex_auth_*` events into SSE + `agentRegistry.refreshAuth` |
| `src/server/orchestrator/api-routes-bootstrap.ts` | `POST /api/codex-auth/start`, `/cancel`, `DELETE /api/codex-auth` |
| `src/server/shared/agent-registry.ts` | dual-mode `isAuthConfigured("codex")`, optional `checkCodexAuth` injection |
| `src/server/session/agents/codex-adapter.ts` | accept fileAuth OR envAuth; strip env when fileAuth present |
| `src/server/shared/types/ws-server-messages.ts` | add `codex_auth_pending`, `codex_auth_complete`, `codex_auth_failed` |
| `src/client/components/CodexAuthCard.tsx` | rewrite — subscription primary, API key collapsed |
| `src/client/components/CodexAuthCard.test.tsx` | new tests for both auth states |
| `src/client/hooks/useServerEvents.ts` | listen for `codex_auth_*` SSE events, route to a new `codex-auth-store.ts` (or extend `settings-store`) |
| `src/server/shipit-docs/environment.md` | document `~/.codex` mount and how the agent's billing is selected |

## WebSocket / HTTP message summary

```
                      ┌─────────────────┐
                      │  CodexAuthCard   │
                      └────────┬────────┘
                               │ POST /api/codex-auth/start
                               ▼
┌────────────────────────────────────────────────────────────┐
│                     Orchestrator                            │
│  ┌──────────────────┐                                       │
│  │ CodexAuthManager  │  spawn codex login --device-auth     │
│  │                  │  parse stdout for URL + user code     │
│  └────────┬─────────┘                                       │
│           │ emit "codex_auth_pending" {url, code}           │
│           │                                                 │
│           ▼                                                 │
│      sseBroadcast("codex_auth_pending", …)                  │
│           │                                                 │
│           │ user opens URL, enters code on auth.openai.com  │
│           │ codex CLI polls + writes /credentials/.codex/   │
│           │ codex CLI exits 0                               │
│           │                                                 │
│           ▼                                                 │
│      "close" → checkCredentials() → emit "codex_auth_       │
│       complete" → agentRegistry.refreshAuth("codex")        │
│           │                                                 │
│           ▼                                                 │
│      sseBroadcast("codex_auth_complete")                    │
│      sseBroadcast("agent_list", { agents: …, defaultAgentId})│
└────────────────────────────────────────────────────────────┘
```

## Migration plan

### Phase 1 — credential persistence (safe, no UX change)

1. Add the `~/.codex` symlink to all four Dockerfiles.
2. Update `CodexAdapter` so that when `~/.codex/auth.json` exists, it
   skips the env-key check and **strips `OPENAI_API_KEY`** from the
   spawned child env.
3. Update `AgentRegistry.isAuthConfigured("codex")` to return true if
   either auth file or env key is present.
4. Ship: nothing user-visible changes, but a power-user who SSH's into a
   container and runs `codex login` manually now has their login
   persisted across container restarts and prefers the subscription path.

### Phase 2 — server-side auth manager

1. Implement `CodexAuthManager` with unit tests around stdout parsing
   (URL regex, user code regex, exit-code translation).
2. Wire HTTP routes + SSE events.
3. Add integration test — fake `codex` shim that prints the canonical
   URL + code, then exits 0; assert `agent_list.codex.authConfigured`
   flips and the device-flow events are broadcast in order.

### Phase 3 — UI

1. Rebuild `CodexAuthCard` with the two-section layout.
2. Add a small `useCodexAuth` hook (or extend `settings-store`) that
   tracks `pending`, `verificationUri`, `userCode`, `error`, and
   `authenticatedAt`.
3. Component tests covering the three states (idle, pending, error) and
   the "API key ignored" banner when both modes are present.
4. Wire the OnboardingWizard to surface Codex auth as the third step
   alongside Claude auth and GitHub auth (currently it only shows the
   API-key input).

### Phase 4 — cleanup + docs

1. Update `src/server/shipit-docs/environment.md` to document
   `~/.codex` and how billing is selected.
2. Add a one-paragraph "How is Codex billed?" entry to the Settings dialog
   info popover, explaining subscription vs API.
3. Mark this doc `status: done` and check off the `checklist.md` items.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `codex login --device-auth` output format changes between CLI versions and our regex breaks. | Pin a known-good `@openai/codex` version in the Dockerfiles (already done — bump deliberately). Keep the regex tolerant: ANSI-strip first, match URL by host (`auth.openai.com`), match code by shape (`[A-Z0-9]{4}-[A-Z0-9]{5}`). Log full stdout when no URL is detected after 5 s so regressions are visible. |
| Two simultaneous device flows step on each other. | `CodexAuthManager.startDeviceFlow()` is a no-op when `this.proc` is set — same guard `AuthManager.startOAuthFlow` uses. The card disables its button while `pending`. |
| User cancels the modal but the codex process keeps polling. | The cancel HTTP endpoint sends SIGTERM. `onClose` shutdown hook also kills any in-flight auth process. |
| User has both a stale `OPENAI_API_KEY` and a ChatGPT login → silently bills the wrong way. | `CodexAdapter` strips env key when fileAuth is present (mandatory, not opt-in). UI banner makes the precedence visible. |
| Credential file leaks across users when ShipIt is multi-tenant. | Same trust model as Claude OAuth today — the credentials volume is per-installation, not per-end-user. Multi-tenant isolation is out of scope and tracked separately. |
| `codex login` in a future CLI version requires a TTY. | Today it works under plain `spawn` because the `--device-auth` path skips the localhost callback server. If a future version reintroduces a TTY check, fall back to `node-pty` (we already use it for Claude). The adapter abstraction is the same either way. |
| Subscription expires mid-turn. | `codex app-server` will surface a 401-equivalent. `CodexAdapter` already detects `unauthorized` / `authentication` strings on stderr and emits `auth_required`. The UI re-shows the sign-in card. |

## Open questions

1. **Refresh tokens.** Does `~/.codex/auth.json` contain a refresh token that
   the CLI rotates on each invocation, or is it a long-lived bearer? If the
   former, we must keep the credentials volume writable from every session
   container so each `codex app-server` can rewrite it. (Today it is — the
   bind mount is `:rw` — but worth confirming.)
2. **Per-session vs global auth.** Claude OAuth is global per ShipIt
   installation. Codex's `~/.codex/auth.json` is naturally scoped the same
   way because of the symlink. If a future product decision is "different
   sessions / different OpenAI accounts", that's a separate design.
3. **Onboarding ordering.** Should we ask for ChatGPT auth before, after,
   or in parallel with Claude auth in `OnboardingWizard`? Current default
   agent is Claude, so probably "Claude first, Codex offered as optional
   second step". Decide before Phase 3.
4. **Headless / API-only mode.** A self-hosted ShipIt without a GUI (e.g.
   the inner orchestrator in dogfood mode, doc 118) cannot complete a
   browser flow. The fallback is "agent.install runs `codex login
   --with-api-key` against the env var" — but that defeats the purpose.
   Document this limitation; it's not a regression from today's behavior.

## Testing

- **Unit (`codex-auth.test.ts`)**: spawn a fake `codex` shim that emits
  controlled stdout (good URL+code, malformed output, immediate exit code 1,
  delayed exit code 0). Assert events fire in the right order with the
  right payloads.
- **Unit (`agent-registry.test.ts` extension)**: `isAuthConfigured("codex")`
  returns true when only fileAuth, only envAuth, both, or neither.
- **Unit (`codex-adapter.test.ts` extension)**: env-key stripping happens
  iff fileAuth is present. `auth_required` only when both are missing.
- **Integration (`integration_tests/codex-auth.test.ts`, new)**: install a
  shim `codex` on `$PATH`, drive the full HTTP → SSE → `agent_list` cycle,
  assert the auth file ends up under the temp credentials dir.
- **Component (`CodexAuthCard.test.tsx`)**: idle → click Sign in → pending
  state → simulated `codex_auth_complete` → green badge. Plus the
  "API key ignored" banner when both are configured.
- **Smoke (manual)**: in a dev container, click Sign in, complete the flow
  on a real OpenAI account, confirm a Codex turn runs without
  `OPENAI_API_KEY` set, confirm no `OPENAI_API_KEY` appears in the
  spawned process env (verify via `/proc/<pid>/environ`).

## Out of scope (follow-ups)

- Surfacing remaining Codex credits / monthly limits in the UI.
- Per-session billing-mode override (force API key for one session even
  with a ChatGPT login present).
- Auto-refreshing tokens before they expire (the CLI handles this; we'd
  only need to react if the CLI ever stops doing so).

## Implementation status

All four phases described above have landed. The current state:

### Phase 1 — credential persistence (shipped)

- `~/.codex → /credentials/.codex` symlink added to all four Dockerfiles
  (`docker/Dockerfile.{dev,prod}` and `docker/Dockerfile.session-worker.{dev,prod}`).
- `CodexAdapter` (`src/server/session/agents/codex-adapter.ts`) now
  resolves auth as `hasFileAuth || hasEnvAuth`. When `~/.codex/auth.json`
  is present and non-empty, it strips `OPENAI_API_KEY` from the spawned
  child env so codex routes through the subscription path.
- `AgentRegistry` (`src/server/shared/agent-registry.ts`) accepts a
  `checkCodexAuth` injection (defaulting to "no file auth"). The registry's
  `isAuthConfigured("codex")` now returns true for either path.

### Phase 2 — server-side auth manager (shipped)

- New `CodexAuthManager` (`src/server/orchestrator/codex-auth.ts`) wraps
  `codex login --device-auth`. Emits `codex_auth_pending` /
  `codex_auth_complete` / `codex_auth_failed`; supports `cancel()` and
  `signOut()`. Spawn function and credential-file probe are injectable
  for unit tests (`codex-auth.test.ts`).
- Wired into DI as `mgrs.codexAuthManager`; `AgentRegistry.checkCodexAuth`
  is bound to its `checkCredentials()`.
- `wireEventHandlers` (`app-lifecycle.ts`) re-broadcasts the manager's
  events over SSE and refreshes the agent registry on completion.
- Three HTTP endpoints added in `api-routes-bootstrap.ts`:
  - `POST /api/codex-auth/start` → start a device flow
  - `POST /api/codex-auth/cancel` → cancel an in-flight flow
  - `DELETE /api/codex-auth` → sign out (rm `auth.json` + refresh registry)
- Three new WS-server message types: `codex_auth_pending`,
  `codex_auth_complete`, `codex_auth_failed`.

### Phase 3 — UI (shipped)

- `CodexAuthCard` rebuilt with the two-section layout from the design.
  Subscription is primary; API key is collapsed behind a disclosure.
  The card surfaces a banner when both auth modes are configured (the
  user-facing twin of the env-strip behavior). New tests in
  `CodexAuthCard.test.tsx` cover idle / pending / error states, the
  disclosure toggle, the sign-out affordance, and the banner.
- `useServerEvents` listens for `codex_auth_*` SSE events and routes
  them into a new `codexDeviceAuth` slice on `settings-store`.
- `Settings.tsx` and `OnboardingWizard.tsx` both pass the new
  device-auth props through to `CodexAuthCard`.
- `App.tsx` wires the HTTP endpoints to the card callbacks
  (`POST /api/codex-auth/start` / `cancel`, `DELETE /api/codex-auth`).

### Phase 4 — docs (shipped)

- `src/server/shipit-docs/environment.md` documents the `~/.codex` mount
  and how the agent's billing path is selected.

### Open follow-ups (not blocking)

- "API key ignored" banner currently relies on the caller setting
  `apiKeyIgnored` explicitly. Today nothing wires this — surfacing it
  needs an extra bit of info in `agent_list` (whether `OPENAI_API_KEY`
  is in `process.env`). Tracked separately.
- Smoke test against a real OpenAI account in a dev container.
- Pin a known-good `@openai/codex` version in the Dockerfiles. Currently
  the latest tag floats; a future CLI version that changes the
  `--device-auth` stdout shape would break the regex.
